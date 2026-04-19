'use strict';

const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const redis = require('../lib/redis');
const { internalError } = require('../lib/auth');
const { shardPrefix, decayFactor, computeSampleId, aggregateSamples } = require('../lib/aggregation');
const { createRateLimiter } = require('../lib/rateLimit');

const EXPIRY_DAYS = 90;
const CACHE_TTL = 10;
const DEDUP_TTL = 60 * 60 * 24 * 90;

const validateRateLimit = createRateLimiter(redis, { max: 10, window: 60, keyPrefix: 'validate_rl' });

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

// ── GET /api/samples ──────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
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

    const prefixParam = req.query.prefixes;
    if (prefixParam) {
      const prefixList = prefixParam.split(',').filter(Boolean);
      const coverage = {};
      const toFetch = [];

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
            lastUpdate: row.last_update?.toISOString(),
            appVersion: row.app_version,
          };
          Object.assign(coverage, byPrefix[p]);
        }

        await Promise.all(
          Object.entries(byPrefix).map(([p, data]) =>
            redis.setex(`shard:${p}`, CACHE_TTL, JSON.stringify(data))
          )
        );
      }

      return res.set(commonHeaders).json({ coverage });
    }

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
    internalError(res, err, 'GET /api/samples');
  }
});

// ── POST /api/samples (legacy — reject with helpful message) ──────────────────

router.post('/', (req, res) => {
  res.status(401).json({
    error: 'This endpoint requires a contributor token. Use POST /api/samples/YOUR_TOKEN instead.',
  });
});

// ── GET /api/samples/:key/validate ───────────────────────────────────────────

router.get('/:key/validate', validateRateLimit, async (req, res) => {
  const key = req.params.key?.toUpperCase();
  try {
    const result = await db.query(
      `SELECT ct.active, u.enabled
       FROM contributor_tokens ct
       JOIN admin_users u ON ct.user_id = u.id
       WHERE ct.key = $1`,
      [key]
    );
    const row = result.rows[0];
    if (!row || !row.active || !row.enabled) {
      return res.status(401).json({ valid: false, error: 'Invalid or disabled token' });
    }

    const [cfgResult, msgResult] = await Promise.all([
      db.query(`SELECT value FROM server_config WHERE key = 'min_app_version'`),
      db.query(`SELECT id, title, body FROM admin_messages WHERE active = TRUE ORDER BY created_at ASC`),
    ]);

    const minVersion = cfgResult.rows[0]?.value?.version ?? null;
    const messages = msgResult.rows.map(m => ({ id: m.id, title: m.title ?? null, body: m.body }));

    res.json({
      valid: true,
      min_version: minVersion,
      messages,
    });
  } catch (err) {
    internalError(res, err, 'GET /api/samples/:key/validate');
  }
});

// ── POST /api/samples/:key ────────────────────────────────────────────────────

router.post('/:key', async (req, res) => {
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

    await db.query(
      `INSERT INTO raw_uploads (contributor_key, sample_count, payload)
       VALUES ($1, $2, $3)`,
      [key, samples.length, JSON.stringify(samples)]
    );

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
        lastUpdate: row.last_update?.toISOString(),
        appVersion: row.app_version,
      };
    }

    let cellsUpdated = 0, cellsCreated = 0, pointsEarned = 0, scoredNewCells = 0;
    const upserts = [];

    for (const [hash, newCell] of Object.entries(newCoverage)) {
      const old = existing[hash];

      // Score this cell based on how well-mapped it already is
      let basePts;
      if (!old) {
        basePts = 10;
        scoredNewCells++;
      } else if (old.samples < 10) {
        basePts = 5;
      } else if (old.samples < 50) {
        basePts = 2;
      } else {
        basePts = 0;
      }
      pointsEarned += basePts + (newCell.received > 0 ? 2 : 0);

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

    const pruned = await db.query(
      `DELETE FROM coverage_cells WHERE last_update < NOW() - INTERVAL '${EXPIRY_DAYS} days'`
    );

    await db.query(
      `INSERT INTO shard_index (prefix, cells, samples, last_update, version)
       SELECT shard_prefix,
              COUNT(*)                    AS cells,
              COALESCE(SUM(samples), 0)   AS samples,
              MAX(last_update)            AS last_update,
              1
       FROM coverage_cells
       WHERE shard_prefix = ANY($1)
       GROUP BY shard_prefix
       ON CONFLICT (prefix) DO UPDATE SET
         cells       = EXCLUDED.cells,
         samples     = EXCLUDED.samples,
         last_update = EXCLUDED.last_update,
         version     = shard_index.version + 1`,
      [affectedPrefixes]
    );

    await db.query(
      `INSERT INTO global_version (id, version) VALUES (1,1)
       ON CONFLICT (id) DO UPDATE SET version = global_version.version + 1`
    );

    await invalidateCaches(affectedPrefixes);
    await Promise.all(deduped.map(s => redis.setex(`seen:${s.__id}`, DEDUP_TTL, '1')));

    const affectedHashes = Object.keys(newCoverage);
    if (affectedHashes.length) {
      const ph2 = affectedHashes.map((_, i) => `($1, $${i + 2}, NOW())`).join(',');
      await db.query(
        `INSERT INTO user_contributions (user_id, geohash, updated_at) VALUES ${ph2}
         ON CONFLICT (user_id, geohash) DO UPDATE SET updated_at = NOW()`,
        [userId, ...affectedHashes]
      );
    }

    // Award points
    if (pointsEarned > 0) {
      await db.query(
        'UPDATE admin_users SET total_points = total_points + $1 WHERE id = $2',
        [pointsEarned, userId]
      );
      await db.query(
        'INSERT INTO point_events (user_id, points, new_cells) VALUES ($1, $2, $3)',
        [userId, pointsEarned, scoredNewCells]
      );
    }
    const ptRow = await db.query('SELECT total_points FROM admin_users WHERE id = $1', [userId]);
    const totalPoints = ptRow.rows[0]?.total_points || 0;

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
      pointsEarned,
      newCells: scoredNewCells,
      totalPoints,
    });

  } catch (err) {
    internalError(res, err, 'POST /api/samples/:key');
  }
});

// ── PATCH /api/samples/:key/display-name ─────────────────────────────────────

router.patch('/:key/display-name', async (req, res) => {
  const key = req.params.key?.toUpperCase();
  try {
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

    const { displayName } = req.body || {};
    if (typeof displayName !== 'string') {
      return res.status(400).json({ error: 'displayName string required' });
    }
    const trimmed = displayName.trim().substring(0, 64);

    await db.query(
      'UPDATE admin_users SET display_name = $1 WHERE id = $2',
      [trimmed || null, authRow.user_id]
    );
    res.json({ success: true, displayName: trimmed || null });
  } catch (err) {
    internalError(res, err, 'PATCH /api/samples/:key/display-name');
  }
});

// ── DELETE /api/samples ───────────────────────────────────────────────────────

router.delete('/', async (req, res) => {
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
    internalError(res, err, 'DELETE /api/samples');
  }
});

module.exports = router;
