-- Migration 006: admin messages for app startup notifications.
-- min_app_version uses the existing server_config table (no schema change needed).

CREATE TABLE IF NOT EXISTS admin_messages (
  id         SERIAL       PRIMARY KEY,
  title      VARCHAR(128),
  body       TEXT         NOT NULL,
  active     BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
