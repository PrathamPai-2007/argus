-- Quality-driven token discovery. Candidates are persisted but are not live watches.
CREATE TABLE token_candidates (
  chain_id          INTEGER NOT NULL,
  address           TEXT NOT NULL,
  discovery_source  TEXT NOT NULL CHECK (discovery_source IN ('factory','ranked','wallet_cohort')),
  status            TEXT NOT NULL CHECK (status IN ('discovered','evaluating','promoted','rejected','expired')),
  score             INTEGER NOT NULL DEFAULT 0,
  evidence_json     TEXT NOT NULL DEFAULT '{}',
  first_seen_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  last_evaluated_at INTEGER,
  expires_at        INTEGER NOT NULL,
  PRIMARY KEY (chain_id, address)
);
CREATE INDEX idx_candidates_status ON token_candidates (chain_id, status, expires_at);

-- SQLite cannot alter the original CHECK constraint; rebuild the small token table.
CREATE TABLE tokens_new (
  chain_id     INTEGER NOT NULL,
  address      TEXT NOT NULL,
  symbol       TEXT,
  decimals     INTEGER,
  total_supply TEXT,
  source       TEXT NOT NULL CHECK (source IN ('manual','factory','ranked','candidate')),
  added_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at   INTEGER,
  PRIMARY KEY (chain_id, address)
);
INSERT INTO tokens_new SELECT chain_id, address, symbol, decimals, total_supply, source, added_at, expires_at FROM tokens;
DROP TABLE tokens;
ALTER TABLE tokens_new RENAME TO tokens;
