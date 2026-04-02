-- Migration 003: Server config table for geofence and future settings
CREATE TABLE IF NOT EXISTS server_config (
  key   VARCHAR(64) PRIMARY KEY,
  value JSONB       NOT NULL
);
