-- Live-first mode does not persist historical backfill cursors or graph snapshots.
DROP TABLE IF EXISTS backfill_jobs;
DROP TABLE IF EXISTS checkpoints;

-- Ranked tokens are discovered from the external live-volume provider and expire
-- when they fall out of the ranking window.
CREATE TABLE tokens_new (
  chain_id     INTEGER NOT NULL,
  address      TEXT NOT NULL,
  symbol       TEXT,
  decimals     INTEGER,
  total_supply TEXT,
  source       TEXT NOT NULL CHECK (source IN ('manual','factory','ranked')),
  added_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at   INTEGER,
  PRIMARY KEY (chain_id, address)
);
INSERT INTO tokens_new (chain_id, address, symbol, decimals, total_supply, source, added_at, expires_at)
SELECT chain_id, address, symbol, decimals, total_supply,
       CASE WHEN source IN ('manual', 'factory') THEN source ELSE 'factory' END,
       added_at, expires_at
FROM tokens;
DROP TABLE tokens;
ALTER TABLE tokens_new RENAME TO tokens;
