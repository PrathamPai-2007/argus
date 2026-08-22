-- Speed up latestSwapForToken which queries by json_extract(payload_json, '$.tokenAddress')
CREATE INDEX IF NOT EXISTS idx_events_swap_token 
  ON events (chain_id, json_extract(payload_json, '$.tokenAddress'), block_number DESC, log_index DESC) 
  WHERE type = 'swap';

-- Speed up pruneEvents which scans all finalized events to prune by timestamp
CREATE INDEX IF NOT EXISTS idx_events_finalized_timestamp 
  ON events (chain_id, finalized, CAST(json_extract(payload_json, '$.timestamp') AS INTEGER));
