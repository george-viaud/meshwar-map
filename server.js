'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const db = require('./lib/db');
const redis = require('./lib/redis');

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── Routes ────────────────────────────────────────────────────────────────────

app.use('/api/samples',       require('./routes/samples'));
app.use('/api/auth',          require('./routes/auth'));
app.use('/api/me/token',      require('./routes/tokens'));
app.use('/api/me',            require('./routes/me'));
app.use('/api/invite',        require('./routes/invite'));
app.use('/api/admin',         require('./routes/admin'));
app.use('/api/contributions', require('./routes/contributions'));

// ── Static frontend ───────────────────────────────────────────────────────────

app.get('/invite/:code', (req, res) =>
  res.sendFile(path.join(__dirname, 'invite.html')));

app.use(express.static(path.join(__dirname), { extensions: ['html'] }));

// ── Migrations ────────────────────────────────────────────────────────────────

async function runMigrations() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);

  const migrationsDir = path.join(__dirname, 'db', 'migrations');
  if (!fs.existsSync(migrationsDir)) return;

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  const applied = new Set(
    (await db.query('SELECT name FROM schema_migrations')).rows.map(r => r.name)
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await db.query('BEGIN');
    try {
      await db.query(sql);
      await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await db.query('COMMIT');
      console.log(`Migration applied: ${file}`);
    } catch (err) {
      await db.query('ROLLBACK');
      throw new Error(`Migration failed (${file}): ${err.message}`);
    }
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

async function start() {
  await redis.connect();
  console.log('Redis connected');

  let retries = 10;
  while (retries > 0) {
    try {
      await db.query('SELECT 1');
      console.log('PostgreSQL connected');
      break;
    } catch (e) {
      retries--;
      if (retries === 0) throw e;
      console.log(`Waiting for PostgreSQL... (${retries} retries left)`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  await runMigrations();

  const adminCount = await db.query('SELECT COUNT(*) FROM admin_users');
  if (parseInt(adminCount.rows[0].count) === 0) {
    const hash = await bcrypt.hash(process.env.ADMIN_TOKEN, 10);
    await db.query(
      `INSERT INTO admin_users (username, password_hash, role) VALUES ('admin', $1, 'admin')`,
      [hash]
    );
    console.log('Bootstrap: no admin users found — created user "admin" with password set to ADMIN_TOKEN');
  }

  const PORT = parseInt(process.env.PORT || '3000');
  app.listen(PORT, () => console.log(`Wardrive map server listening on port ${PORT}`));
}

start().catch(err => {
  console.error('Startup failed:', err);
  process.exit(1);
});
