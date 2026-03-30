'use strict';

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../lib/db');
const { requireAuth, internalError } = require('../lib/auth');

// ── GET /api/me ───────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
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
    internalError(res, err, 'GET /api/me');
  }
});

// ── PATCH /api/me/password ────────────────────────────────────────────────────

router.patch('/password', async (req, res) => {
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
    internalError(res, err, 'PATCH /api/me/password');
  }
});

module.exports = router;
