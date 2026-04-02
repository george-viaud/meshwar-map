'use strict';

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../lib/db');
const { requireAuth, generateInviteCode, internalError } = require('../lib/auth');

// ── GET /api/admin/contributors ───────────────────────────────────────────────

router.get('/contributors', async (req, res) => {
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
    internalError(res, err, 'GET /api/admin/contributors');
  }
});

// ── PATCH /api/admin/contributors/:id ────────────────────────────────────────

router.patch('/contributors/:id', async (req, res) => {
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
    internalError(res, err, 'PATCH /api/admin/contributors/:id');
  }
});

// ── GET /api/admin/token-search ───────────────────────────────────────────────

router.get('/token-search', async (req, res) => {
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
    internalError(res, err, 'GET /api/admin/token-search');
  }
});

// ── GET /api/admin/invites ────────────────────────────────────────────────────

router.get('/invites', async (req, res) => {
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
    internalError(res, err, 'GET /api/admin/invites');
  }
});

// ── POST /api/admin/invites ───────────────────────────────────────────────────

router.post('/invites', async (req, res) => {
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
    internalError(res, err, 'POST /api/admin/invites');
  }
});

// ── DELETE /api/admin/invites/:id ─────────────────────────────────────────────

router.delete('/invites/:id', async (req, res) => {
  if (!requireAuth(req, res, ['admin'])) return;
  try {
    const result = await db.query('DELETE FROM invite_links WHERE id = $1', [parseInt(req.params.id)]);
    if (!result.rowCount) return res.status(404).json({ error: 'Invite not found' });
    res.json({ success: true });
  } catch (err) {
    internalError(res, err, 'DELETE /api/admin/invites/:id');
  }
});

// ── GET /api/admin/users ──────────────────────────────────────────────────────

router.get('/users', async (req, res) => {
  if (!requireAuth(req, res, ['admin'])) return;
  try {
    const result = await db.query(
      'SELECT id, username, role, enabled, created_at FROM admin_users ORDER BY created_at ASC'
    );
    res.json({ users: result.rows });
  } catch (err) {
    internalError(res, err, 'GET /api/admin/users');
  }
});

// ── POST /api/admin/users ─────────────────────────────────────────────────────

router.post('/users', async (req, res) => {
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
    internalError(res, err, 'POST /api/admin/users');
  }
});

// ── PATCH /api/admin/users/:id ────────────────────────────────────────────────

router.patch('/users/:id', async (req, res) => {
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
    internalError(res, err, 'PATCH /api/admin/users');
  }
});

// ── DELETE /api/admin/users/:id ───────────────────────────────────────────────

router.delete('/users/:id', async (req, res) => {
  const caller = requireAuth(req, res, ['admin']);
  if (!caller) return;
  const id = parseInt(req.params.id);
  if (caller.userId === id) return res.status(400).json({ error: 'Cannot delete your own account' });
  try {
    const result = await db.query('DELETE FROM admin_users WHERE id = $1', [id]);
    if (!result.rowCount) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true });
  } catch (err) {
    internalError(res, err, 'DELETE /api/admin/users');
  }
});

// ── GET /api/admin/geofence ───────────────────────────────────────────────────

router.get('/geofence', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'viewer'])) return;
  try {
    const result = await db.query("SELECT value FROM server_config WHERE key = 'geofence'");
    res.json(result.rows.length ? result.rows[0].value : null);
  } catch (err) {
    internalError(res, err, 'GET /api/admin/geofence');
  }
});

// ── PUT /api/admin/geofence ───────────────────────────────────────────────────

router.put('/geofence', async (req, res) => {
  if (!requireAuth(req, res, ['admin'])) return;
  const { polygon } = req.body || {};
  if (!Array.isArray(polygon) || polygon.length < 3) {
    return res.status(400).json({ error: 'polygon must be an array of at least 3 {lat,lng} points' });
  }
  try {
    await db.query(
      `INSERT INTO server_config (key, value) VALUES ('geofence', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify({ polygon })]
    );
    res.json({ success: true });
  } catch (err) {
    internalError(res, err, 'PUT /api/admin/geofence');
  }
});

// ── DELETE /api/admin/geofence ────────────────────────────────────────────────

router.delete('/geofence', async (req, res) => {
  if (!requireAuth(req, res, ['admin'])) return;
  try {
    await db.query("DELETE FROM server_config WHERE key = 'geofence'");
    res.json({ success: true });
  } catch (err) {
    internalError(res, err, 'DELETE /api/admin/geofence');
  }
});

module.exports = router;
