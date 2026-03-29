CREATE TABLE IF NOT EXISTS coverage_cells (
  geohash      VARCHAR(10)  PRIMARY KEY,
  shard_prefix VARCHAR(3)   NOT NULL,
  received     FLOAT        NOT NULL DEFAULT 0,
  lost         FLOAT        NOT NULL DEFAULT 0,
  samples      INTEGER      NOT NULL DEFAULT 0,
  repeaters    JSONB        NOT NULL DEFAULT '{}',
  first_seen   TIMESTAMPTZ,
  last_update  TIMESTAMPTZ  NOT NULL,
  app_version  VARCHAR(20)  DEFAULT 'unknown'
);

CREATE INDEX IF NOT EXISTS idx_coverage_shard      ON coverage_cells (shard_prefix);
CREATE INDEX IF NOT EXISTS idx_coverage_last_update ON coverage_cells (last_update);
CREATE INDEX IF NOT EXISTS idx_coverage_repeaters   ON coverage_cells USING GIN (repeaters);

CREATE TABLE IF NOT EXISTS shard_index (
  prefix      VARCHAR(3)  PRIMARY KEY,
  cells       INTEGER     NOT NULL DEFAULT 0,
  samples     INTEGER     NOT NULL DEFAULT 0,
  last_update TIMESTAMPTZ,
  version     INTEGER     NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS global_version (
  id      INTEGER PRIMARY KEY DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 0
);

INSERT INTO global_version (id, version) VALUES (1, 0) ON CONFLICT DO NOTHING;
