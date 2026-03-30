'use strict';

const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const { internalError } = require('../lib/auth');

// ── GET /api/contributions/:key ───────────────────────────────────────────────

router.get('/:key', async (req, res) => {
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
    internalError(res, err, 'GET /api/contributions/:key');
  }
});

module.exports = router;
