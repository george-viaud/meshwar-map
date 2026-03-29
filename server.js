require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const Redis = require('ioredis');
const ngeohash = require('ngeohash');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json({ limit: '10mb' }));

// ── Database ──────────────────────────────────────────────────────────────────

const db = new Pool({
  host: process.env.PG_HOST || 'postgres',
  port: parseInt(process.env.PG_PORT || '5432'),
  database: process.env.PG_DB || 'wardrive',
  user: process.env.PG_USER || 'wardrive',
  password: process.env.PG_PASSWORD,
});

const redis = new Redis({
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD || undefined,
  lazyConnect: true,
});

const EXPIRY_DAYS = 90;
const CACHE_TTL = 10; // seconds
const DEDUP_TTL = 60 * 60 * 24 * 90; // 90 days

// ── Helpers ───────────────────────────────────────────────────────────────────

function shardPrefix(hash) {
  return hash.substring(0, 3);
}

function ageInDays(timestamp) {
  return Math.floor((Date.now() - new Date(timestamp).getTime()) / (1000 * 60 * 60 * 24));
}

function decayFactor(timestamp) {
  const age = ageInDays(timestamp);
  if (age > 90) return 0.2;
  if (age > 30) return 0.5;
  if (age > 14) return 0.7;
  if (age > 7)  return 0.85;
  return 1.0;
}

function computeSampleId(sample) {
  if (sample.id) return String(sample.id);
  const lat = sample.latitude ?? sample.lat;
  const lng = sample.longitude ?? sample.lng;
  const key = `${lat?.toFixed?.(6)}|${lng?.toFixed?.(6)}|${sample.timestamp || ''}|${sample.nodeId || ''}`;
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) - h) + key.charCodeAt(i);
    h |= 0;
  }
  return `h${Math.abs(h)}`;
}

function aggregateSamples(samples) {
  const coverage = {};
  const now = new Date().toISOString();

  for (const sample of samples) {
    const lat = sample.latitude ?? sample.lat;
    const lng = sample.longitude ?? sample.lng;
    if (!lat || !lng) continue;

    const hash = ngeohash.encode(lat, lng, 7);
    const success = sample.pingSuccess === true || (sample.nodeId && sample.nodeId !== 'Unknown');
    const failed  = sample.pingSuccess === false || sample.nodeId === 'Unknown';

    if (!coverage[hash]) {
      coverage[hash] = {
        received: 0, lost: 0, samples: 0,
        repeaters: {},
        firstSeen:  sample.timestamp || now,
        lastUpdate: sample.timestamp || now,
        appVersion: sample.appVersion || 'unknown',
      };
    }

    const cell = coverage[hash];

    if (success) {
      cell.received += 1;
      if (sample.nodeId && sample.nodeId !== 'Unknown') {
        const t = new Date(sample.timestamp || now).getTime();
        if (!cell.repeaters[sample.nodeId] ||
            new Date(cell.repeaters[sample.nodeId].lastSeen).getTime() < t) {
          cell.repeaters[sample.nodeId] = {
            name: sample.repeaterName || sample.nodeId,
            rssi: sample.rssi ?? null,
            snr:  sample.snr  ?? null,
            lastSeen: sample.timestamp || now,
          };
        }
      }
    } else if (failed) {
      cell.lost += 1;
    }

    cell.samples += 1;
    if ((sample.timestamp || '') > cell.lastUpdate) cell.lastUpdate = sample.timestamp;
    if (sample.appVersion && sample.appVersion !== 'unknown') cell.appVersion = sample.appVersion;
  }

  return coverage;
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

function jwtSecret() {
  return process.env.JWT_SECRET || process.env.ADMIN_TOKEN;
}

function requireAuth(req, res, roles = []) {
  const auth = req.headers['authorization'];
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) { res.status(401).json({ error: 'Login required' }); return null; }
  try {
    const payload = jwt.verify(token, jwtSecret());
    if (roles.length && !roles.includes(payload.role)) {
      res.status(403).json({ error: 'Insufficient permissions' }); return null;
    }
    return payload;
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' }); return null;
  }
}

async function checkApiKey(req, res) {
  const auth = req.headers['authorization'];
  const key = auth?.startsWith('Bearer ') ? auth.slice(7).toUpperCase() : null;
  if (!key) { res.status(401).json({ error: 'API key required' }); return false; }
  const result = await db.query('SELECT enabled FROM api_keys WHERE key = $1', [key]);
  if (!result.rows.length || !result.rows[0].enabled) {
    res.status(401).json({ error: 'Invalid or disabled API key' }); return false;
  }
  return true;
}

function generateKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

async function getGlobalVersion() {
  const cached = await redis.get('global_version');
  if (cached) return parseInt(cached);
  const res = await db.query('SELECT version FROM global_version WHERE id = 1');
  return res.rows[0]?.version || 0;
}

async function invalidateCaches(prefixes) {
  const keys = ['index', 'global_version', ...prefixes.map(p => `shard:${p}`)];
  await redis.del(...keys);
}

// ── CORS headers ──────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

app.options('/api/samples', (req, res) => res.set(CORS_HEADERS).end());

// ── GET /api/samples ──────────────────────────────────────────────────────────

app.get('/api/samples', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');

  try {
    const version = await getGlobalVersion();
    const etag = `"v${version}"`;
    const commonHeaders = {
      'Content-Type': 'application/json',
      ETag: etag,
      'Cache-Control': 'public, max-age=10',
    };

    if (req.headers['if-none-match'] === etag) {
      return res.status(304).set({ ETag: etag, 'Cache-Control': 'public, max-age=10' }).end();
    }

    // ── Shard data request ──
    const prefixParam = req.query.prefixes;
    if (prefixParam) {
      const prefixList = prefixParam.split(',').filter(Boolean);
      const coverage = {};
      const toFetch = [];

      // Check Redis cache per shard
      const cached = await Promise.all(prefixList.map(p => redis.get(`shard:${p}`)));
      prefixList.forEach((p, i) => {
        if (cached[i]) Object.assign(coverage, JSON.parse(cached[i]));
        else toFetch.push(p);
      });

      if (toFetch.length > 0) {
        const ph = toFetch.map((_, i) => `$${i + 1}`).join(',');
        const rows = await db.query(
          `SELECT geohash, received, lost, samples, repeaters,
                  first_seen, last_update, app_version
           FROM coverage_cells
           WHERE shard_prefix IN (${ph})
             AND last_update > NOW() - INTERVAL '${EXPIRY_DAYS} days'`,
          toFetch
        );

        const byPrefix = {};
        for (const row of rows.rows) {
          const p = shardPrefix(row.geohash);
          if (!byPrefix[p]) byPrefix[p] = {};
          byPrefix[p][row.geohash] = {
            received:   parseFloat(row.received),
            lost:       parseFloat(row.lost),
            samples:    row.samples,
            repeaters:  row.repeaters,
            firstSeen:  row.first_seen,
            lastUpdate: row.last_update,
            appVersion: row.app_version,
          };
          Object.assign(coverage, byPrefix[p]);
        }

        // Cache each fetched shard
        await Promise.all(
          Object.entries(byPrefix).map(([p, data]) =>
            redis.setex(`shard:${p}`, CACHE_TTL, JSON.stringify(data))
          )
        );
      }

      return res.set(commonHeaders).json({ coverage });
    }

    // ── Shard index request ──
    const cachedIndex = await redis.get('index');
    if (cachedIndex) return res.set(commonHeaders).send(cachedIndex);

    const rows = await db.query(
      'SELECT prefix, cells, samples, last_update, version FROM shard_index'
    );

    const shards = {};
    let totalCells = 0, totalSamples = 0;
    for (const row of rows.rows) {
      shards[row.prefix] = {
        cells:      row.cells,
        samples:    row.samples,
        lastUpdate: row.last_update,
        version:    row.version,
      };
      totalCells   += row.cells;
      totalSamples += row.samples;
    }

    const body = JSON.stringify({ shards, version, totalCells, totalSamples });
    await redis.setex('index', CACHE_TTL, body);
    return res.set(commonHeaders).send(body);

  } catch (err) {
    console.error('GET /api/samples:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/samples ─────────────────────────────────────────────────────────

app.post('/api/samples', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');

  if (!await checkApiKey(req, res)) return;

  try {
    const { samples } = req.body;
    if (!Array.isArray(samples)) {
      return res.status(400).json({ error: 'samples array required' });
    }

    // Deduplicate via Redis
    const withIds = samples.map(s => ({ ...s, __id: computeSampleId(s) }));
    const seenFlags = await Promise.all(withIds.map(s => redis.exists(`seen:${s.__id}`)));
    const deduped = withIds.filter((_, i) => !seenFlags[i]);

    if (deduped.length === 0) {
      return res.json({
        success: true,
        samplesReceived: samples.length,
        samplesDeduped: samples.length,
        samplesProcessed: 0,
        cellsUpdated: 0, cellsCreated: 0, cellsPruned: 0, totalCells: 0,
      });
    }

    const newCoverage = aggregateSamples(deduped);
    const affectedPrefixes = [...new Set(Object.keys(newCoverage).map(shardPrefix))];

    // Load existing cells for affected prefixes
    const ph = affectedPrefixes.map((_, i) => `$${i + 1}`).join(',');
    const existingRows = await db.query(
      `SELECT geohash, received, lost, samples, repeaters, first_seen, last_update, app_version
       FROM coverage_cells WHERE shard_prefix IN (${ph})`,
      affectedPrefixes
    );

    const existing = {};
    for (const row of existingRows.rows) {
      existing[row.geohash] = {
        received:   parseFloat(row.received),
        lost:       parseFloat(row.lost),
        samples:    row.samples,
        repeaters:  row.repeaters,
        firstSeen:  row.first_seen,
        lastUpdate: row.last_update,
        appVersion: row.app_version,
      };
    }

    let cellsUpdated = 0, cellsCreated = 0;
    const upserts = [];

    for (const [hash, newCell] of Object.entries(newCoverage)) {
      const old = existing[hash];
      if (old) {
        const decay = decayFactor(old.lastUpdate);
        upserts.push({
          hash,
          prefix:    shardPrefix(hash),
          received:  old.received * decay + newCell.received,
          lost:      old.lost * decay + newCell.lost,
          samples:   old.samples + newCell.samples,
          repeaters: { ...old.repeaters, ...newCell.repeaters },
          firstSeen: old.firstSeen,
          lastUpdate: newCell.lastUpdate > old.lastUpdate ? newCell.lastUpdate : old.lastUpdate,
          appVersion: newCell.appVersion !== 'unknown' ? newCell.appVersion : old.appVersion,
        });
        cellsUpdated++;
      } else {
        upserts.push({ hash, prefix: shardPrefix(hash), ...newCell });
        cellsCreated++;
      }
    }

    // Upsert coverage cells
    for (const cell of upserts) {
      await db.query(
        `INSERT INTO coverage_cells
           (geohash, shard_prefix, received, lost, samples, repeaters,
            first_seen, last_update, app_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (geohash) DO UPDATE SET
           received   = EXCLUDED.received,
           lost       = EXCLUDED.lost,
           samples    = EXCLUDED.samples,
           repeaters  = EXCLUDED.repeaters,
           last_update = EXCLUDED.last_update,
           app_version = EXCLUDED.app_version`,
        [
          cell.hash, cell.prefix,
          cell.received, cell.lost, cell.samples,
          JSON.stringify(cell.repeaters),
          cell.firstSeen, cell.lastUpdate, cell.appVersion,
        ]
      );
    }

    // Prune expired cells
    const pruned = await db.query(
      `DELETE FROM coverage_cells WHERE last_update < NOW() - INTERVAL '${EXPIRY_DAYS} days'`
    );

    // Rebuild shard index for affected prefixes
    for (const prefix of affectedPrefixes) {
      const stats = await db.query(
        `SELECT COUNT(*) AS cells, COALESCE(SUM(samples),0) AS samples, MAX(last_update) AS last_update
         FROM coverage_cells WHERE shard_prefix = $1`,
        [prefix]
      );
      const { cells, samples: s, last_update } = stats.rows[0];
      await db.query(
        `INSERT INTO shard_index (prefix, cells, samples, last_update, version)
         VALUES ($1,$2,$3,$4,1)
         ON CONFLICT (prefix) DO UPDATE SET
           cells      = EXCLUDED.cells,
           samples    = EXCLUDED.samples,
           last_update = EXCLUDED.last_update,
           version    = shard_index.version + 1`,
        [prefix, parseInt(cells), parseInt(s), last_update]
      );
    }

    // Bump global version
    await db.query(
      `INSERT INTO global_version (id, version) VALUES (1,1)
       ON CONFLICT (id) DO UPDATE SET version = global_version.version + 1`
    );

    await invalidateCaches(affectedPrefixes);

    // Mark samples as seen
    await Promise.all(deduped.map(s => redis.setex(`seen:${s.__id}`, DEDUP_TTL, '1')));

    const totals = await db.query('SELECT COALESCE(SUM(cells),0) AS total FROM shard_index');
    const totalCells = parseInt(totals.rows[0].total);

    res.json({
      success: true,
      samplesReceived:  samples.length,
      samplesDeduped:   samples.length - deduped.length,
      samplesProcessed: deduped.length,
      cellsUpdated,
      cellsCreated,
      cellsPruned: pruned.rowCount,
      totalCells,
    });

  } catch (err) {
    console.error('POST /api/samples:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/samples ───────────────────────────────────────────────────────

app.delete('/api/samples', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');

  const auth = req.headers['authorization'];
  if (!auth || auth !== `Bearer ${process.env.ADMIN_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    await db.query('DELETE FROM coverage_cells');
    await db.query('DELETE FROM shard_index');
    await db.query('UPDATE global_version SET version = 0 WHERE id = 1');

    const keys = await redis.keys('shard:*');
    if (keys.length > 0) await redis.del(...keys);
    await redis.del('index', 'global_version');

    res.json({ success: true, message: 'All data cleared' });
  } catch (err) {
    console.error('DELETE /api/samples:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }
  try {
    const result = await db.query(
      'SELECT id, username, password_hash, role, enabled FROM admin_users WHERE username = $1',
      [username]
    );
    const user = result.rows[0];
    if (!user || !user.enabled) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign(
      { userId: user.id, username: user.username, role: user.role },
      jwtSecret(),
      { expiresIn: '24h' }
    );
    res.json({ token, username: user.username, role: user.role });
  } catch (err) {
    console.error('POST /api/auth/login:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/keys ─────────────────────────────────────────────────────────────

app.get('/api/keys', async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const result = await db.query('SELECT key, note, enabled, created_at FROM api_keys ORDER BY created_at DESC');
    res.json({ keys: result.rows });
  } catch (err) {
    console.error('GET /api/keys:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/keys ────────────────────────────────────────────────────────────

app.post('/api/keys', async (req, res) => {
  if (!requireAuth(req, res, ['admin'])) return;
  const note = req.body?.note || '';
  try {
    let key, attempts = 0;
    do {
      key = generateKey();
      attempts++;
    } while (attempts < 10 && (await db.query('SELECT 1 FROM api_keys WHERE key = $1', [key])).rows.length);

    await db.query('INSERT INTO api_keys (key, note) VALUES ($1, $2)', [key, note]);
    res.json({ key, note, enabled: true });
  } catch (err) {
    console.error('POST /api/keys:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/keys/:key ──────────────────────────────────────────────────────

app.patch('/api/keys/:key', async (req, res) => {
  if (!requireAuth(req, res, ['admin'])) return;
  const { note, enabled } = req.body || {};
  const fields = [], values = [];
  if (note !== undefined) { fields.push(`note = $${fields.length + 1}`); values.push(note); }
  if (enabled !== undefined) { fields.push(`enabled = $${fields.length + 1}`); values.push(enabled); }
  if (!fields.length) return res.status(400).json({ error: 'nothing to update' });
  values.push(req.params.key.toUpperCase());
  try {
    const result = await db.query(
      `UPDATE api_keys SET ${fields.join(', ')} WHERE key = $${values.length} RETURNING key, note, enabled, created_at`,
      values
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Key not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PATCH /api/keys:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/keys/:key ─────────────────────────────────────────────────────

app.delete('/api/keys/:key', async (req, res) => {
  if (!requireAuth(req, res, ['admin'])) return;
  try {
    const result = await db.query('DELETE FROM api_keys WHERE key = $1', [req.params.key.toUpperCase()]);
    if (!result.rowCount) return res.status(404).json({ error: 'Key not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/keys:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/users ──────────────────────────────────────────────────────

app.get('/api/admin/users', async (req, res) => {
  if (!requireAuth(req, res, ['admin'])) return;
  try {
    const result = await db.query(
      'SELECT id, username, role, enabled, created_at FROM admin_users ORDER BY created_at ASC'
    );
    res.json({ users: result.rows });
  } catch (err) {
    console.error('GET /api/admin/users:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/users ─────────────────────────────────────────────────────

app.post('/api/admin/users', async (req, res) => {
  if (!requireAuth(req, res, ['admin'])) return;
  const { username, password, role } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  if (!['admin', 'viewer'].includes(role)) return res.status(400).json({ error: 'role must be admin or viewer' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await db.query(
      'INSERT INTO admin_users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, username, role, enabled, created_at',
      [username, hash, role]
    );
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username already exists' });
    console.error('POST /api/admin/users:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/admin/users/:id ────────────────────────────────────────────────

app.patch('/api/admin/users/:id', async (req, res) => {
  const caller = requireAuth(req, res, ['admin']);
  if (!caller) return;
  const { password, role, enabled } = req.body || {};
  const id = parseInt(req.params.id);
  const fields = [], values = [];
  if (password !== undefined) {
    fields.push(`password_hash = $${fields.length + 1}`);
    values.push(await bcrypt.hash(password, 10));
  }
  if (role !== undefined) {
    if (!['admin', 'viewer'].includes(role)) return res.status(400).json({ error: 'role must be admin or viewer' });
    fields.push(`role = $${fields.length + 1}`);
    values.push(role);
  }
  if (enabled !== undefined) {
    if (caller.userId === id && enabled === false) {
      return res.status(400).json({ error: 'Cannot disable your own account' });
    }
    fields.push(`enabled = $${fields.length + 1}`);
    values.push(enabled);
  }
  if (!fields.length) return res.status(400).json({ error: 'nothing to update' });
  values.push(id);
  try {
    const result = await db.query(
      `UPDATE admin_users SET ${fields.join(', ')} WHERE id = $${values.length} RETURNING id, username, role, enabled, created_at`,
      values
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PATCH /api/admin/users:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/admin/users/:id ───────────────────────────────────────────────

app.delete('/api/admin/users/:id', async (req, res) => {
  const caller = requireAuth(req, res, ['admin']);
  if (!caller) return;
  const id = parseInt(req.params.id);
  if (caller.userId === id) return res.status(400).json({ error: 'Cannot delete your own account' });
  try {
    const result = await db.query('DELETE FROM admin_users WHERE id = $1', [id]);
    if (!result.rowCount) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/admin/users:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Static frontend ───────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname), { extensions: ['html'] }));

// ── Migrations ────────────────────────────────────────────────────────────────

async function runMigrations() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);

  const migrationsDir = path.join(__dirname, 'db', 'migrations');
  if (!fs.existsSync(migrationsDir)) return;

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  const applied = new Set(
    (await db.query('SELECT name FROM schema_migrations')).rows.map(r => r.name)
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await db.query('BEGIN');
    try {
      await db.query(sql);
      await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await db.query('COMMIT');
      console.log(`Migration applied: ${file}`);
    } catch (err) {
      await db.query('ROLLBACK');
      throw new Error(`Migration failed (${file}): ${err.message}`);
    }
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

async function start() {
  // Wait for Redis
  await redis.connect();
  console.log('Redis connected');

  // Wait for Postgres
  let retries = 10;
  while (retries > 0) {
    try {
      await db.query('SELECT 1');
      console.log('PostgreSQL connected');
      break;
    } catch (e) {
      retries--;
      if (retries === 0) throw e;
      console.log(`Waiting for PostgreSQL... (${retries} retries left)`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Run pending database migrations
  await runMigrations();

  // Bootstrap: create default admin user if none exist
  const adminCount = await db.query('SELECT COUNT(*) FROM admin_users');
  if (parseInt(adminCount.rows[0].count) === 0) {
    const hash = await bcrypt.hash(process.env.ADMIN_TOKEN, 10);
    await db.query(
      `INSERT INTO admin_users (username, password_hash, role) VALUES ('admin', $1, 'admin')`,
      [hash]
    );
    console.log('Bootstrap: no admin users found — created user "admin" with password set to ADMIN_TOKEN');
  }

  const PORT = parseInt(process.env.PORT || '3000');
  app.listen(PORT, () => console.log(`Wardrive map server listening on port ${PORT}`));
}

start().catch(err => {
  console.error('Startup failed:', err);
  process.exit(1);
});
