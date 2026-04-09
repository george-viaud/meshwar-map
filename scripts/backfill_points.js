#!/usr/bin/env node
'use strict';

// Backfill historical points from user_contributions.
//
// For each geohash, contributors are ranked by updated_at (earliest = first).
// Points awarded per contributor rank:
//   1st: 10 pts  (new territory)
//   2–9: 5 pts   (sparse)
//   10–49: 2 pts (moderate)
//   50+:  0 pts  (dense)
// +2 bonus if coverage_cells.received > 0 (confirmed signal in that cell)
//
// Updates admin_users.total_points in place.
// Does NOT insert point_events rows (backfill is all-time only; weekly/monthly
// periods start from the deploy date).
//
// Safe to re-run: resets total_points to 0 first, then recomputes from scratch.
//
// Usage (from repo root on apollo):
//   node scripts/backfill_points.js

require('dotenv').config();
const db = require('../lib/db');

async function run() {
  console.log('Backfilling historical points...\n');

  // 1. Load all contributions ordered by (geohash, updated_at)
  const contribs = await db.query(`
    SELECT uc.user_id, uc.geohash, uc.updated_at,
           cc.received
    FROM user_contributions uc
    LEFT JOIN coverage_cells cc ON cc.geohash = uc.geohash
    ORDER BY uc.geohash, uc.updated_at ASC
  `);

  // 2. Calculate points per user
  const userPoints = {}; // user_id → total points

  let currentHash = null;
  let rank = 0;

  for (const row of contribs.rows) {
    if (row.geohash !== currentHash) {
      currentHash = row.geohash;
      rank = 0;
    }
    rank++;

    let basePts;
    if      (rank === 1) basePts = 10;
    else if (rank <= 9)  basePts = 5;
    else if (rank <= 49) basePts = 2;
    else                 basePts = 0;

    const bonus = (parseFloat(row.received) > 0) ? 2 : 0;
    const pts = basePts + bonus;

    userPoints[row.user_id] = (userPoints[row.user_id] || 0) + pts;
  }

  // 3. Reset all total_points, then apply computed values
  await db.query('UPDATE admin_users SET total_points = 0');

  let updated = 0;
  for (const [userId, pts] of Object.entries(userPoints)) {
    await db.query(
      'UPDATE admin_users SET total_points = $1 WHERE id = $2',
      [pts, parseInt(userId)]
    );
    updated++;
  }

  // 4. Report
  const result = await db.query(
    `SELECT username, total_points
     FROM admin_users
     WHERE total_points > 0
     ORDER BY total_points DESC`
  );

  console.log('Done. Points awarded:\n');
  console.log('  Username         Points');
  console.log('  ---------------  ------');
  for (const row of result.rows) {
    console.log(`  ${row.username.padEnd(17)}${row.total_points}`);
  }
  console.log(`\n  ${updated} user(s) updated.`);
  console.log(`  ${contribs.rows.length} contribution records processed.`);
}

run()
  .then(() => process.exit(0))
  .catch(err => { console.error('Backfill failed:', err); process.exit(1); });
