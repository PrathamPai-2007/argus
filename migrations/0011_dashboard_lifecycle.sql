-- Provenance for the latest performance observation.
ALTER TABLE performance_sessions ADD COLUMN entry_source TEXT NOT NULL DEFAULT 'swap';
ALTER TABLE performance_sessions ADD COLUMN last_observation_source TEXT;
ALTER TABLE performance_sessions ADD COLUMN last_observation_block INTEGER;

CREATE INDEX idx_alerts_active ON alerts (chain_id, retracted, created_at DESC);
