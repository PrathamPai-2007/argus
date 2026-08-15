-- Alert outcome journal: pool-relative performance after a persisted alert.
CREATE TABLE IF NOT EXISTS performance_sessions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id       INTEGER NOT NULL UNIQUE REFERENCES alerts(id),
  chain_id       INTEGER NOT NULL,
  token_address  TEXT NOT NULL,
  pool_address   TEXT NOT NULL,
  quote_token    TEXT,
  entry_price    TEXT NOT NULL,
  current_price  TEXT NOT NULL,
  target_price   TEXT NOT NULL,
  stop_price     TEXT NOT NULL,
  opened_at      INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  closed_at      INTEGER,
  outcome        TEXT NOT NULL CHECK (outcome IN ('active','target_hit','stop_hit','expired','retracted','invalid_price')),
  entry_block   INTEGER NOT NULL,
  last_block    INTEGER NOT NULL,
  min_price     TEXT NOT NULL,
  max_price     TEXT NOT NULL,
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_performance_active
  ON performance_sessions (chain_id, token_address, outcome, pool_address);
CREATE INDEX IF NOT EXISTS idx_performance_expiry
  ON performance_sessions (outcome, expires_at);
