-- Migration 004: scoring and leaderboard

ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS display_name VARCHAR(64);
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS total_points INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS point_events (
  id         SERIAL       PRIMARY KEY,
  user_id    INTEGER      NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  points     INTEGER      NOT NULL,
  new_cells  INTEGER      NOT NULL DEFAULT 0,
  earned_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_point_events_user   ON point_events(user_id);
CREATE INDEX IF NOT EXISTS idx_point_events_earned ON point_events(earned_at);
