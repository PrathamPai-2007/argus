CREATE TABLE IF NOT EXISTS failed_events (
  chain_id INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  log_index INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  graph_applied INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (chain_id, block_number, log_index, type)
);
