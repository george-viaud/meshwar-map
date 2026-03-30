'use strict';

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../lib/db');
const redis = require('../lib/redis');
const { jwtSecret, requireAuth, internalError } = require('../lib/auth');
const { createRateLimiter } = require('../lib/rateLimit');

const loginRateLimit = createRateLimiter(redis, { max: 10, window: 60, keyPrefix: 'login_rl' });

// ── POST /api/auth/login ──────────────────────────────────────────────────────

router.post('/login', loginRateLimit, async (req, res) => {
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
    internalError(res, err, 'POST /api/auth/login');
  }
});

module.exports = router;
