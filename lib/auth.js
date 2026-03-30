'use strict';

const jwt = require('jsonwebtoken');

function jwtSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET environment variable is required');
  return s;
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

function internalError(res, err, context) {
  console.error(`${context}:`, err.message);
  res.status(500).json({ error: 'Internal server error' });
}

module.exports = { jwtSecret, requireAuth, generateKey, generateInviteCode, internalError };
