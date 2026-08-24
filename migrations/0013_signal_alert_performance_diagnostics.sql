-- Explainable signal decisions and alert-to-performance lifecycle.
CREATE TABLE IF NOT EXISTS signal_evaluations (
  signal_id       INTEGER PRIMARY KEY REFERENCES signals(id) ON DELETE CASCADE,
  score           INTEGER NOT NULL,
  severity        TEXT,
  outcome         TEXT NOT NULL,
  reason          TEXT,
  alert_id        INTEGER REFERENCES alerts(id),
  evaluated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_signal_evaluations_outcome
  ON signal_evaluations (outcome, evaluated_at);

ALTER TABLE alerts ADD COLUMN performance_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE alerts ADD COLUMN performance_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_alerts_performance_status
  ON alerts (performance_status, created_at DESC);
