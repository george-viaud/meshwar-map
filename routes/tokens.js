'use strict';

const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const { requireAuth, generateKey, internalError } = require('../lib/auth');

// ── GET /api/me/token ─────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
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
    internalError(res, err, 'GET /api/me/token');
  }
});

// ── POST /api/me/token/refresh ────────────────────────────────────────────────

router.post('/refresh', async (req, res) => {
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
    internalError(res, err, 'POST /api/me/token/refresh');
  }
});

module.exports = router;
