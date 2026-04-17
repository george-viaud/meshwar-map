-- Migration 005: raw upload storage for replayability

CREATE TABLE IF NOT EXISTS raw_uploads (
  id               BIGSERIAL    PRIMARY KEY,
  contributor_key  CHAR(8)      NOT NULL,
  uploaded_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  sample_count     INTEGER      NOT NULL,
  payload          JSONB        NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_raw_uploads_contributor ON raw_uploads(contributor_key);
CREATE INDEX IF NOT EXISTS idx_raw_uploads_uploaded_at ON raw_uploads(uploaded_at);
