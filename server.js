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

function generateKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function generateInviteCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 24 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
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
app.options('/api/samples/:key', (req, res) => res.set(CORS_HEADERS).end());

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

// ── POST /api/samples (legacy — reject with helpful message) ──────────────────

app.post('/api/samples', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.status(401).json({
    error: 'This endpoint requires a contributor token. Use POST /api/samples/YOUR_TOKEN instead.',
  });
});

// ── POST /api/samples/:key ────────────────────────────────────────────────────

app.post('/api/samples/:key', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');

  const key = req.params.key?.toUpperCase();
  const authResult = await db.query(
    `SELECT ct.user_id, ct.active, u.enabled
     FROM contributor_tokens ct
     JOIN admin_users u ON ct.user_id = u.id
     WHERE ct.key = $1`,
    [key]
  );
  const authRow = authResult.rows[0];
  if (!authRow || !authRow.active || !authRow.enabled) {
    return res.status(401).json({ error: 'Invalid or disabled token' });
  }
  const userId = authRow.user_id;

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

    // Record which geohashes this user contributed to
    const affectedHashes = Object.keys(newCoverage);
    if (affectedHashes.length) {
      const ph = affectedHashes.map((_, i) => `($1, $${i + 2}, NOW())`).join(',');
      await db.query(
        `INSERT INTO user_contributions (user_id, geohash, updated_at) VALUES ${ph}
         ON CONFLICT (user_id, geohash) DO UPDATE SET updated_at = NOW()`,
        [userId, ...affectedHashes]
      );
    }

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
    console.error('POST /api/samples/:key:', err.message);
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

// ── GET /api/invite/:code — validate invite ───────────────────────────────────

app.get('/api/invite/:code', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT note, uses_remaining FROM invite_links WHERE code = $1',
      [req.params.code]
    );
    const row = result.rows[0];
    if (!row || row.uses_remaining <= 0) {
      return res.json({ valid: false });
    }
    res.json({ valid: true, note: row.note, uses_remaining: row.uses_remaining });
  } catch (err) {
    console.error('GET /api/invite/:code:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/invite/:code — register via invite ──────────────────────────────

app.post('/api/invite/:code', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const inviteResult = await client.query(
      'SELECT id, uses_remaining FROM invite_links WHERE code = $1 FOR UPDATE',
      [req.params.code]
    );
    const invite = inviteResult.rows[0];
    if (!invite || invite.uses_remaining <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invite link is invalid or exhausted' });
    }
    const hash = await bcrypt.hash(password, 10);
    const userResult = await client.query(
      `INSERT INTO admin_users (username, password_hash, role, invite_id)
       VALUES ($1, $2, 'contributor', $3)
       RETURNING id, username, role`,
      [username, hash, invite.id]
    );
    const user = userResult.rows[0];
    let key, attempts = 0;
    do {
      key = generateKey();
      attempts++;
    } while (attempts < 10 && (await client.query('SELECT 1 FROM contributor_tokens WHERE key = $1', [key])).rows.length);
    await client.query(
      'INSERT INTO contributor_tokens (user_id, key) VALUES ($1, $2)',
      [user.id, key]
    );
    await client.query(
      'UPDATE invite_links SET uses_remaining = uses_remaining - 1 WHERE id = $1',
      [invite.id]
    );
    await client.query('COMMIT');
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({ token: key, url: `${baseUrl}/api/samples/${key}` });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Username already exists' });
    console.error('POST /api/invite/:code:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── GET /api/me ───────────────────────────────────────────────────────────────

app.get('/api/me', async (req, res) => {
  const caller = requireAuth(req, res);
  if (!caller) return;
  try {
    const result = await db.query(
      'SELECT id, username, role, enabled, created_at FROM admin_users WHERE id = $1',
      [caller.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('GET /api/me:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/me/password ────────────────────────────────────────────────────

app.patch('/api/me/password', async (req, res) => {
  const caller = requireAuth(req, res);
  if (!caller) return;
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword and newPassword required' });
  }
  try {
    const result = await db.query('SELECT password_hash FROM admin_users WHERE id = $1', [caller.userId]);
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    const match = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
    if (!match) return res.status(401).json({ error: 'Current password is incorrect' });
    const newHash = await bcrypt.hash(newPassword, 10);
    await db.query('UPDATE admin_users SET password_hash = $1 WHERE id = $2', [newHash, caller.userId]);
    res.json({ success: true });
  } catch (err) {
    console.error('PATCH /api/me/password:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/me/token ─────────────────────────────────────────────────────────

app.get('/api/me/token', async (req, res) => {
  const caller = requireAuth(req, res);
  if (!caller) return;
  if (caller.role !== 'contributor') return res.json({ token: null });
  try {
    const result = await db.query(
      'SELECT key, created_at FROM contributor_tokens WHERE user_id = $1 AND active = TRUE ORDER BY created_at DESC LIMIT 1',
      [caller.userId]
    );
    if (!result.rows.length) return res.json({ token: null });
    const { key, created_at } = result.rows[0];
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({ key, url: `${baseUrl}/api/samples/${key}`, created_at });
  } catch (err) {
    console.error('GET /api/me/token:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/me/token/refresh ────────────────────────────────────────────────

app.post('/api/me/token/refresh', async (req, res) => {
  const caller = requireAuth(req, res, ['contributor']);
  if (!caller) return;
  try {
    await db.query('UPDATE contributor_tokens SET active = FALSE WHERE user_id = $1', [caller.userId]);
    let key, attempts = 0;
    do {
      key = generateKey();
      attempts++;
    } while (attempts < 10 && (await db.query('SELECT 1 FROM contributor_tokens WHERE key = $1', [key])).rows.length);
    await db.query('INSERT INTO contributor_tokens (user_id, key) VALUES ($1, $2)', [caller.userId, key]);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({ key, url: `${baseUrl}/api/samples/${key}` });
  } catch (err) {
    console.error('POST /api/me/token/refresh:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/contributions/:key — my data map filter ─────────────────────────

app.get('/api/contributions/:key', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const key = req.params.key?.toUpperCase();
  try {
    const authResult = await db.query(
      'SELECT ct.user_id FROM contributor_tokens ct JOIN admin_users u ON ct.user_id = u.id WHERE ct.key = $1 AND u.enabled = TRUE',
      [key]
    );
    if (!authResult.rows.length) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    const userId = authResult.rows[0].user_id;
    const contribs = await db.query(
      'SELECT geohash FROM user_contributions WHERE user_id = $1',
      [userId]
    );
    res.json({ geohashes: contribs.rows.map(r => r.geohash) });
  } catch (err) {
    console.error('GET /api/contributions/:key:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/contributors ───────────────────────────────────────────────

app.get('/api/admin/contributors', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'viewer'])) return;
  try {
    const result = await db.query(
      `SELECT u.id, u.username, u.enabled, u.created_at,
              i.note AS invite_note
       FROM admin_users u
       LEFT JOIN invite_links i ON u.invite_id = i.id
       WHERE u.role = 'contributor'
       ORDER BY u.created_at DESC`
    );
    res.json({ contributors: result.rows });
  } catch (err) {
    console.error('GET /api/admin/contributors:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/admin/contributors/:id ────────────────────────────────────────

app.patch('/api/admin/contributors/:id', async (req, res) => {
  if (!requireAuth(req, res, ['admin'])) return;
  const { enabled } = req.body || {};
  if (enabled === undefined) return res.status(400).json({ error: 'enabled required' });
  try {
    const result = await db.query(
      `UPDATE admin_users SET enabled = $1 WHERE id = $2 AND role = 'contributor'
       RETURNING id, username, enabled`,
      [enabled, parseInt(req.params.id)]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Contributor not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PATCH /api/admin/contributors/:id:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/token-search ───────────────────────────────────────────────

app.get('/api/admin/token-search', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'viewer'])) return;
  const q = (req.query.q || '').toUpperCase().trim();
  if (!q) return res.json({ results: [] });
  try {
    const result = await db.query(
      `SELECT ct.key, ct.active, ct.created_at,
              u.id AS user_id, u.username, u.enabled AS user_enabled
       FROM contributor_tokens ct
       JOIN admin_users u ON ct.user_id = u.id
       WHERE ct.key LIKE $1
       ORDER BY ct.created_at DESC
       LIMIT 20`,
      [`${q}%`]
    );
    res.json({
      results: result.rows.map(r => ({
        key: r.key,
        active: r.active,
        created_at: r.created_at,
        user: { id: r.user_id, username: r.username, enabled: r.user_enabled },
      })),
    });
  } catch (err) {
    console.error('GET /api/admin/token-search:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/invites ────────────────────────────────────────────────────

app.get('/api/admin/invites', async (req, res) => {
  if (!requireAuth(req, res, ['admin'])) return;
  try {
    const result = await db.query(
      `SELECT i.id, i.code, i.note, i.uses_allowed, i.uses_remaining, i.created_at,
              u.username AS created_by_username
       FROM invite_links i
       LEFT JOIN admin_users u ON i.created_by = u.id
       ORDER BY i.created_at DESC`
    );
    res.json({ invites: result.rows });
  } catch (err) {
    console.error('GET /api/admin/invites:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/invites ───────────────────────────────────────────────────

app.post('/api/admin/invites', async (req, res) => {
  const caller = requireAuth(req, res, ['admin']);
  if (!caller) return;
  const { note, uses_allowed } = req.body || {};
  if (!uses_allowed || uses_allowed < 1) {
    return res.status(400).json({ error: 'uses_allowed must be at least 1' });
  }
  try {
    const code = generateInviteCode();
    const result = await db.query(
      `INSERT INTO invite_links (code, note, uses_allowed, uses_remaining, created_by)
       VALUES ($1, $2, $3, $3, $4)
       RETURNING id, code, note, uses_allowed, uses_remaining, created_at`,
      [code, note || '', parseInt(uses_allowed), caller.userId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('POST /api/admin/invites:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/admin/invites/:id ─────────────────────────────────────────────

app.delete('/api/admin/invites/:id', async (req, res) => {
  if (!requireAuth(req, res, ['admin'])) return;
  try {
    const result = await db.query('DELETE FROM invite_links WHERE id = $1', [parseInt(req.params.id)]);
    if (!result.rowCount) return res.status(404).json({ error: 'Invite not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/admin/invites/:id:', err.message);
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
  if (!['admin', 'viewer', 'contributor'].includes(role)) return res.status(400).json({ error: 'role must be admin, viewer, or contributor' });
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
    if (!['admin', 'viewer', 'contributor'].includes(role)) return res.status(400).json({ error: 'role must be admin, viewer, or contributor' });
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

// ── /invite/:code — serve registration page ───────────────────────────────────

app.get('/invite/:code', (req, res) =>
  res.sendFile(path.join(__dirname, 'invite.html')));

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
