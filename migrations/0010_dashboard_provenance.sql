-- Durable provenance for derived dashboard records and reorg-safe signal state.
ALTER TABLE funding_edges ADD COLUMN tx_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE funding_edges ADD COLUMN log_index INTEGER NOT NULL DEFAULT -1;
ALTER TABLE signals ADD COLUMN source_tx_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE signals ADD COLUMN source_log_index INTEGER NOT NULL DEFAULT -1;
ALTER TABLE signals ADD COLUMN finalized INTEGER NOT NULL DEFAULT 0;
ALTER TABLE signals ADD COLUMN retracted INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX idx_funding_event_identity
  ON funding_edges (chain_id, block_number, tx_hash, log_index, method)
  WHERE tx_hash <> '';
CREATE UNIQUE INDEX idx_signal_event_identity
  ON signals (chain_id, token_address, rule_id, block_number, source_tx_hash, source_log_index)
  WHERE source_tx_hash <> '';
CREATE INDEX idx_signals_state
  ON signals (chain_id, token_address, finalized, retracted, created_at);
