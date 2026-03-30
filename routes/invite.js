'use strict';

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../lib/db');
const { generateKey, generateInviteCode, internalError } = require('../lib/auth');

// ── GET /api/invite/:code — validate invite ───────────────────────────────────

router.get('/:code', async (req, res) => {
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
    internalError(res, err, 'GET /api/invite/:code');
  }
});

// ── POST /api/invite/:code — register via invite ──────────────────────────────

router.post('/:code', async (req, res) => {
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
    internalError(res, err, 'POST /api/invite/:code');
  } finally {
    client.release();
  }
});

module.exports = router;
