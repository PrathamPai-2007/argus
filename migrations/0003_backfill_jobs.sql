CREATE TABLE IF NOT EXISTS backfill_jobs (
  chain_id      INTEGER PRIMARY KEY,
  from_block    INTEGER NOT NULL,
  to_block      INTEGER NOT NULL,
  phase         TEXT NOT NULL,
  next_block    INTEGER NOT NULL,
  provider      TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('running', 'paused', 'complete', 'failed')),
  last_error    TEXT,
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
