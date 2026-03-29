-- Migration 001: API key auth and admin user management

CREATE TABLE IF NOT EXISTS api_keys (
  key        VARCHAR(16)  PRIMARY KEY,
  note       TEXT         NOT NULL DEFAULT '',
  enabled    BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_users (
  id            SERIAL       PRIMARY KEY,
  username      VARCHAR(64)  UNIQUE NOT NULL,
  password_hash TEXT         NOT NULL,
  role          VARCHAR(20)  NOT NULL DEFAULT 'viewer',
  enabled       BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
