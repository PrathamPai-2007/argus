ALTER TABLE performance_sessions ADD COLUMN last_poll_at INTEGER;
ALTER TABLE performance_sessions ADD COLUMN missing_observations INTEGER NOT NULL DEFAULT 0;
ALTER TABLE performance_sessions ADD COLUMN close_reason TEXT;
