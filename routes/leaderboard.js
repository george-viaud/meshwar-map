'use strict';

const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const { internalError } = require('../lib/auth');

const VALID_PERIODS = { all: null, monthly: '30 days', weekly: '7 days' };

// Resolve a token key to a user_id, or null if invalid
async function resolveToken(key) {
  if (!key) return null;
  try {
    const r = await db.query(
      `SELECT ct.user_id FROM contributor_tokens ct
       JOIN admin_users u ON ct.user_id = u.id
       WHERE ct.key = $1 AND ct.active = TRUE AND u.enabled = TRUE`,
      [key.toUpperCase()]
    );
    return r.rows[0]?.user_id ?? null;
  } catch (_) {
    return null;
  }
}

// ── GET /api/leaderboard?period=all|monthly|weekly[&token=KEY] ────────────────

router.get('/', async (req, res) => {
  const period = req.query.period || 'all';
  if (!(period in VALID_PERIODS)) {
    return res.status(400).json({ error: 'period must be all, monthly, or weekly' });
  }

  const myUserId = await resolveToken(req.query.token);

  try {
    let rows;

    if (period === 'all') {
      const r = await db.query(`
        SELECT u.id,
               COALESCE(u.display_name, SUBSTRING(u.username, 1, 8)) AS display_name,
               u.total_points                                          AS points,
               COUNT(uc.geohash)                                       AS unique_cells
        FROM admin_users u
        LEFT JOIN user_contributions uc ON uc.user_id = u.id
        WHERE u.enabled = TRUE AND u.total_points > 0
        GROUP BY u.id, u.display_name, u.username, u.total_points
        ORDER BY u.total_points DESC
        LIMIT 50
      `);
      rows = r.rows;
    } else {
      const interval = VALID_PERIODS[period];
      const r = await db.query(`
        SELECT u.id,
               COALESCE(u.display_name, SUBSTRING(u.username, 1, 8)) AS display_name,
               SUM(pe.points)                                          AS points,
               COUNT(DISTINCT uc.geohash)                             AS unique_cells
        FROM admin_users u
        JOIN point_events pe ON pe.user_id = u.id
                             AND pe.earned_at > NOW() - INTERVAL '${interval}'
        LEFT JOIN user_contributions uc ON uc.user_id = u.id
        WHERE u.enabled = TRUE
        GROUP BY u.id, u.display_name, u.username
        HAVING SUM(pe.points) > 0
        ORDER BY points DESC
        LIMIT 50
      `);
      rows = r.rows;
    }

    const entries = rows.map((row, i) => ({
      rank:        i + 1,
      displayName: row.display_name,
      points:      parseInt(row.points),
      uniqueCells: parseInt(row.unique_cells),
      isMe:        myUserId !== null && parseInt(row.id) === myUserId,
    }));

    // If caller is authenticated but not in the top 50, fetch their own position
    let myEntry = null;
    if (myUserId && !entries.some(e => e.isMe)) {
      if (period === 'all') {
        const r = await db.query(`
          SELECT COALESCE(u.display_name, SUBSTRING(u.username, 1, 8)) AS display_name,
                 u.total_points AS points,
                 COUNT(uc.geohash) AS unique_cells,
                 (SELECT COUNT(*) + 1 FROM admin_users u2
                  WHERE u2.enabled = TRUE AND u2.total_points > u.total_points) AS rank
          FROM admin_users u
          LEFT JOIN user_contributions uc ON uc.user_id = u.id
          WHERE u.id = $1
          GROUP BY u.id, u.display_name, u.username, u.total_points
        `, [myUserId]);
        if (r.rows.length) {
          const row = r.rows[0];
          myEntry = {
            rank:        parseInt(row.rank),
            displayName: row.display_name,
            points:      parseInt(row.points),
            uniqueCells: parseInt(row.unique_cells),
            isMe:        true,
          };
        }
      } else {
        const interval = VALID_PERIODS[period];
        const r = await db.query(`
          SELECT COALESCE(u.display_name, SUBSTRING(u.username, 1, 8)) AS display_name,
                 COALESCE(SUM(pe.points), 0) AS points,
                 COUNT(DISTINCT uc.geohash)  AS unique_cells
          FROM admin_users u
          LEFT JOIN point_events pe ON pe.user_id = u.id
                                    AND pe.earned_at > NOW() - INTERVAL '${interval}'
          LEFT JOIN user_contributions uc ON uc.user_id = u.id
          WHERE u.id = $1
          GROUP BY u.id, u.display_name, u.username
        `, [myUserId]);
        if (r.rows.length) {
          const row = r.rows[0];
          const pts = parseInt(row.points);
          const rankR = await db.query(`
            SELECT COUNT(*) + 1 AS rank
            FROM (
              SELECT SUM(pe2.points) AS pts
              FROM admin_users u2
              JOIN point_events pe2 ON pe2.user_id = u2.id
                                    AND pe2.earned_at > NOW() - INTERVAL '${interval}'
              WHERE u2.enabled = TRUE
              GROUP BY u2.id
              HAVING SUM(pe2.points) > $1
            ) sub
          `, [pts]);
          myEntry = {
            rank:        parseInt(rankR.rows[0]?.rank ?? 1),
            displayName: row.display_name,
            points:      pts,
            uniqueCells: parseInt(row.unique_cells),
            isMe:        true,
          };
        }
      }
    }

    res.json({ period, entries, myEntry });

  } catch (err) {
    internalError(res, err, 'GET /api/leaderboard');
  }
});

module.exports = router;
