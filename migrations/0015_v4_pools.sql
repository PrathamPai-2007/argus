-- Uniswap V4: pools are bytes32 ids inside the PoolManager, and dex may be 'v4'.
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt.

CREATE TABLE pools_v4 (
  chain_id      INTEGER NOT NULL,
  address       TEXT    NOT NULL,   -- pool contract, or the bytes32 pool id for V4
  dex           TEXT    NOT NULL CHECK (dex IN ('v2', 'v3', 'v4')),
  token0        TEXT    NOT NULL,
  token1        TEXT    NOT NULL,
  token         TEXT    NOT NULL,
  quote         TEXT    NOT NULL,
  created_block INTEGER,
  PRIMARY KEY (chain_id, address)
);
INSERT INTO pools_v4 SELECT chain_id, address, dex, token0, token1, token, quote, created_block FROM pools;
DROP TABLE pools;
ALTER TABLE pools_v4 RENAME TO pools;
CREATE INDEX idx_pools_token ON pools (chain_id, token);
