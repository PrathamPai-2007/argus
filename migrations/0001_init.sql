-- Argus initial schema (PLAN.md §5)

CREATE TABLE IF NOT EXISTS wallets (
  address         TEXT NOT NULL,
  chain_id        INTEGER NOT NULL,
  first_seen_block INTEGER NOT NULL,
  first_seen_at   INTEGER NOT NULL,
  funder_address  TEXT,
  cluster_id      TEXT,
  PRIMARY KEY (address, chain_id)
);

CREATE TABLE IF NOT EXISTS funding_edges (
  funder      TEXT NOT NULL,
  funded      TEXT NOT NULL,
  chain_id    INTEGER NOT NULL,
  amount      TEXT NOT NULL,          -- bigint serialized as decimal string
  block_number INTEGER NOT NULL,
  method      TEXT NOT NULL CHECK (method IN ('native_transfer','disperse','internal_call')),
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_funding_funded ON funding_edges (funded, chain_id);
CREATE INDEX IF NOT EXISTS idx_funding_funder ON funding_edges (funder, chain_id);

CREATE TABLE IF NOT EXISTS clusters (
  id           TEXT PRIMARY KEY,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  member_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cluster_members (
  cluster_id TEXT NOT NULL REFERENCES clusters(id),
  address    TEXT NOT NULL,
  PRIMARY KEY (cluster_id, address)
);

CREATE TABLE IF NOT EXISTS tokens (
  chain_id     INTEGER NOT NULL,
  address      TEXT NOT NULL,
  symbol       TEXT,
  decimals     INTEGER,
  total_supply TEXT,                  -- bigint serialized as decimal string
  source       TEXT NOT NULL CHECK (source IN ('manual','factory')),
  added_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at   INTEGER,               -- auto-watch expiry (NULL = permanent)
  PRIMARY KEY (chain_id, address)
);

CREATE TABLE IF NOT EXISTS pools (
  chain_id     INTEGER NOT NULL,
  pool_address TEXT NOT NULL,
  token_address TEXT NOT NULL,
  quote_token  TEXT,
  factory      TEXT NOT NULL,
  created_block INTEGER NOT NULL,
  PRIMARY KEY (chain_id, pool_address)
);

CREATE TABLE IF NOT EXISTS events (
  chain_id     INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  log_index    INTEGER NOT NULL,
  tx_hash      TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('transfer','swap','pool_created','funding')),
  payload_json TEXT NOT NULL,
  finalized    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chain_id, block_number, log_index, type)
);
CREATE INDEX IF NOT EXISTS idx_events_finalized ON events (chain_id, finalized, block_number);

CREATE TABLE IF NOT EXISTS signals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id      INTEGER NOT NULL,
  token_address TEXT NOT NULL,
  rule_id       TEXT NOT NULL,
  weight        INTEGER NOT NULL,
  evidence_json TEXT NOT NULL,
  block_number  INTEGER NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_signals_token ON signals (chain_id, token_address, created_at);

CREATE TABLE IF NOT EXISTS alerts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id      INTEGER NOT NULL,
  token_address TEXT NOT NULL,
  score         INTEGER NOT NULL,
  severity      TEXT NOT NULL CHECK (severity IN ('info','alert','critical')),
  payload_json  TEXT NOT NULL,
  confirmed     INTEGER NOT NULL DEFAULT 0,
  retracted     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_alerts_token ON alerts (chain_id, token_address, created_at);

CREATE TABLE IF NOT EXISTS labels (
  address  TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  label    TEXT NOT NULL,
  kind     TEXT NOT NULL DEFAULT 'generic' CHECK (kind IN ('cex','disperse','router','bridge','instant_swap','deployer','generic')),
  PRIMARY KEY (address, chain_id)
);

CREATE TABLE IF NOT EXISTS checkpoints (
  chain_id   INTEGER PRIMARY KEY,
  last_block INTEGER NOT NULL
);
