-- Phase 6: pool metadata (swap/LP tracking for R2/R7) + block-scoped alert confirmation.

ALTER TABLE pools ADD COLUMN token0 TEXT;
ALTER TABLE pools ADD COLUMN token1 TEXT;
ALTER TABLE pools ADD COLUMN created_ts INTEGER;

ALTER TABLE alerts ADD COLUMN block_number INTEGER;
