-- Argus v2: opportunity scanner schema.
-- v1 risk-flag tables are dropped (openDb backs up a v1 database file first).

DROP TABLE IF EXISTS signal_evaluations;
DROP TABLE IF EXISTS signals;
DROP TABLE IF EXISTS performance_sessions;
DROP TABLE IF EXISTS alerts;
DROP TABLE IF EXISTS cluster_members;
DROP TABLE IF EXISTS clusters;
DROP TABLE IF EXISTS funding_edges;
DROP TABLE IF EXISTS wallets;
DROP TABLE IF EXISTS token_candidates;
DROP TABLE IF EXISTS backfill_jobs;
DROP TABLE IF EXISTS checkpoints;
DROP TABLE IF EXISTS failed_events;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS pools;
DROP TABLE IF EXISTS tokens;
DROP TABLE IF EXISTS labels;

-- Facts: normalized chain events. Graph state is rebuildable from finalized rows.
CREATE TABLE events (
  chain_id     INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  tx_index     INTEGER NOT NULL,
  log_index    INTEGER NOT NULL,
  kind         TEXT    NOT NULL,
  token        TEXT,
  timestamp    INTEGER NOT NULL,
  payload      TEXT    NOT NULL,
  finalized    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chain_id, block_number, tx_index, log_index)
) WITHOUT ROWID;
CREATE INDEX idx_events_token ON events (chain_id, token, block_number);
CREATE INDEX idx_events_unfinalized ON events (chain_id, finalized, block_number);
CREATE INDEX idx_events_timestamp ON events (timestamp);

-- Durable sync position: the last block whose events are all persisted and final.
CREATE TABLE sync_cursors (
  chain_id        INTEGER PRIMARY KEY,
  finalized_block INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE tokens (
  chain_id     INTEGER NOT NULL,
  address      TEXT    NOT NULL,
  symbol       TEXT,
  name         TEXT,
  decimals     INTEGER,
  total_supply TEXT,
  source       TEXT    NOT NULL CHECK (source IN ('launch', 'manual', 'pool')),
  first_seen_at INTEGER NOT NULL,
  launch_block INTEGER,
  launch_at    INTEGER,
  watch_until  INTEGER,            -- NULL = forever (manual)
  PRIMARY KEY (chain_id, address)
);
CREATE INDEX idx_tokens_watch ON tokens (chain_id, watch_until);

CREATE TABLE pools (
  chain_id      INTEGER NOT NULL,
  address       TEXT    NOT NULL,
  dex           TEXT    NOT NULL CHECK (dex IN ('v2', 'v3')),
  token0        TEXT    NOT NULL,
  token1        TEXT    NOT NULL,
  token         TEXT    NOT NULL,
  quote         TEXT    NOT NULL,
  created_block INTEGER,
  PRIMARY KEY (chain_id, address)
);
CREATE INDEX idx_pools_token ON pools (chain_id, token);

CREATE TABLE labels (
  chain_id INTEGER NOT NULL,
  address  TEXT    NOT NULL,
  label    TEXT    NOT NULL,
  kind     TEXT    NOT NULL,
  PRIMARY KEY (chain_id, address)
);

-- First-funder lookups: permanent facts, resolved once per wallet.
CREATE TABLE wallet_funding (
  chain_id           INTEGER NOT NULL,
  wallet             TEXT    NOT NULL,
  funder             TEXT,
  funded_block       INTEGER,
  funder_is_service  INTEGER NOT NULL DEFAULT 0,
  resolved_at        INTEGER NOT NULL,
  PRIMARY KEY (chain_id, wallet)
);
CREATE INDEX idx_wallet_funding_funder ON wallet_funding (chain_id, funder);

-- Latest assessment per token (the live opportunity board).
CREATE TABLE token_scores (
  chain_id   INTEGER NOT NULL,
  token      TEXT    NOT NULL,
  at         INTEGER NOT NULL,
  block      INTEGER NOT NULL,
  score      INTEGER NOT NULL,
  verdict    TEXT    NOT NULL,
  gate       TEXT,
  signals    TEXT    NOT NULL,
  metrics    TEXT    NOT NULL,
  finalized  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chain_id, token)
);
CREATE INDEX idx_token_scores_rank ON token_scores (verdict, score DESC);

-- Signal state changes (fired / severity changed / cleared): the activity log.
CREATE TABLE signal_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id  INTEGER NOT NULL,
  token     TEXT    NOT NULL,
  signal_id TEXT    NOT NULL,
  kind      TEXT    NOT NULL,
  severity  TEXT    NOT NULL,
  change    TEXT    NOT NULL CHECK (change IN ('fired', 'escalated', 'cleared')),
  title     TEXT    NOT NULL,
  evidence  TEXT    NOT NULL,
  block     INTEGER NOT NULL,
  at        INTEGER NOT NULL,
  finalized INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_signal_log_token ON signal_log (chain_id, token, id);
CREATE INDEX idx_signal_log_block ON signal_log (chain_id, block);

CREATE TABLE alerts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id   INTEGER NOT NULL,
  token      TEXT    NOT NULL,
  kind       TEXT    NOT NULL CHECK (kind IN ('opportunity', 'exit')),
  verdict    TEXT    NOT NULL,
  score      INTEGER NOT NULL,
  block      INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  confirmed  INTEGER NOT NULL DEFAULT 0,
  retracted  INTEGER NOT NULL DEFAULT 0,
  payload    TEXT    NOT NULL
);
CREATE INDEX idx_alerts_token ON alerts (chain_id, token, id);
CREATE INDEX idx_alerts_created ON alerts (created_at);

-- Paper positions (alerts + baseline control cohort).
CREATE TABLE positions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id       INTEGER NOT NULL,
  token          TEXT    NOT NULL,
  kind           TEXT    NOT NULL CHECK (kind IN ('alert', 'baseline')),
  alert_id       INTEGER REFERENCES alerts(id),
  score          INTEGER,
  entry_unit_usd REAL    NOT NULL,
  entry_at       INTEGER NOT NULL,
  entry_block    INTEGER NOT NULL,
  last_unit_usd  REAL    NOT NULL,
  last_at        INTEGER NOT NULL,
  peak_unit_usd  REAL    NOT NULL,
  trough_unit_usd REAL   NOT NULL,
  r_m15 REAL, r_h1 REAL, r_h6 REAL, r_h24 REAL,
  closed_at      INTEGER,
  retracted      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_positions_open ON positions (closed_at, chain_id, token);
CREATE UNIQUE INDEX idx_positions_baseline ON positions (chain_id, token) WHERE kind = 'baseline';

-- Wallet track record on watched tokens, from finalized swaps only.
CREATE TABLE wallet_positions (
  chain_id     INTEGER NOT NULL,
  wallet       TEXT    NOT NULL,
  token        TEXT    NOT NULL,
  bought       REAL    NOT NULL DEFAULT 0,
  sold         REAL    NOT NULL DEFAULT 0,
  cost_usd     REAL    NOT NULL DEFAULT 0,
  proceeds_usd REAL    NOT NULL DEFAULT 0,
  buys         INTEGER NOT NULL DEFAULT 0,
  sells        INTEGER NOT NULL DEFAULT 0,
  first_at     INTEGER NOT NULL,
  last_at      INTEGER NOT NULL,
  PRIMARY KEY (chain_id, wallet, token)
);

-- A trade is "closed" once >= 90% of the bought amount is sold; realized PnL
-- prorates cost to the sold share so partial exits are judged fairly.
CREATE VIEW wallet_stats AS
SELECT chain_id, wallet,
  COUNT(*) AS tokens_traded,
  SUM(CASE WHEN sold >= bought * 0.9 AND bought > 0 THEN 1 ELSE 0 END) AS closed_trades,
  SUM(CASE WHEN sold >= bought * 0.9 AND bought > 0 AND proceeds_usd > cost_usd * MIN(1.0, sold / bought) THEN 1 ELSE 0 END) AS wins,
  SUM(CASE WHEN bought > 0 THEN proceeds_usd - cost_usd * MIN(1.0, sold / bought) ELSE 0 END) AS realized_pnl_usd,
  SUM(cost_usd) AS volume_usd,
  MAX(last_at) AS last_at
FROM wallet_positions
GROUP BY chain_id, wallet;

-- Event application failures are durable (invariant 12).
CREATE TABLE failed_events (
  chain_id     INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  tx_index     INTEGER NOT NULL,
  log_index    INTEGER NOT NULL,
  kind         TEXT    NOT NULL,
  payload      TEXT    NOT NULL,
  error        TEXT    NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 1,
  failed_at    INTEGER NOT NULL,
  PRIMARY KEY (chain_id, block_number, tx_index, log_index)
);
