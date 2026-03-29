-- Migration 002: Invite links and contributor tokens

CREATE TABLE IF NOT EXISTS invite_links (
  id             SERIAL       PRIMARY KEY,
  code           VARCHAR(32)  UNIQUE NOT NULL,
  note           TEXT         NOT NULL DEFAULT '',
  uses_allowed   INTEGER      NOT NULL,
  uses_remaining INTEGER      NOT NULL,
  created_by     INTEGER      REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contributor_tokens (
  id         SERIAL       PRIMARY KEY,
  user_id    INTEGER      NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  key        VARCHAR(16)  NOT NULL UNIQUE,
  active     BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contributor_tokens_user ON contributor_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_contributor_tokens_key  ON contributor_tokens(key);

CREATE TABLE IF NOT EXISTS user_contributions (
  user_id     INTEGER      NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  geohash     VARCHAR(10)  NOT NULL,
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, geohash)
);

CREATE INDEX IF NOT EXISTS idx_user_contributions_user ON user_contributions(user_id);

ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS invite_id INTEGER
  REFERENCES invite_links(id) ON DELETE SET NULL;
