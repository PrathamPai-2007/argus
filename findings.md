The live bot (logs/argus-2026-08-16-07-31-13.log) is operating in a healthy state:
Metric	Value
Events processed	20,617
Wallets in graph	6,274
Pools registered	51 (auto-watched via Uniswap factory)
Tokens watched	51
Signals generated	55
Alerts	15 (6 critical, 2 alert, 7 info)
Queue depth	0 (no backpressure)
Dropped events	0
RPC endpoint	Infura mainnet WS (live)
Trace APIs	Unavailable (degraded to log-only funding — expected)
Signal breakdown by rule:
Rule	Signals
R1 (fresh wallet accumulation)	12
R2 (volume spike)	1
R3 (sybil fan-out)	10
R4 (cluster concentration)	17
R5 (bundled fresh buys)	15
R6 (deployer-linked funding)	0
R7 (LP-lock safety)	0
R8 (exchange fan-out)	0
Performance tracking is working: 6 target hits, 4 stop hits, 1 still active.
Issues & Recommendations
1. Test logs are polluting the production log directory
The files argus-2026-08-16-07-36-18.log and argus-2026-08-16-07-36-24.log are from bun test runs — they contain test tokens (0xt2, 0xt3) and mock errors (Error: boom). Tests should write to a separate log file.
Fix: In src/logger.ts, route test output to a separate log file like logs/argus-test-{timestamp}.log or suppress logging in tests.
2. Clusters table is empty (0 rows)
R4 fires 17 signals detecting clusters in-memory via the DSU, but clusters and cluster_members DB tables have zero rows. The buildAlertPayload method in src/engine.ts:577 reads clusters from the in-memory graph (graph.clusterBreakdown()), which works for alerts. But the dashboard graph API endpoints likely query the DB clusters table and would return nothing. Cluster membership is never persisted from the in-memory DSU to the database.
Fix: Add a periodic persistence step (or persist on alert creation) that materializes cluster groups from GraphEngine.clusterBreakdown() into the clusters and cluster_members tables.
3. Volume ranking returns empty
The log shows "volume ranking refreshed","tokens":[] — rankStablecoinVolume in src/ingest/dexscreener.ts returns no tokens. This starves R2/R7/R8 of context. Check if the DexScreener API call is failing silently or if the parsing is broken.
Fix: Add error logging in refreshVolumeRankings() (engine.ts:700-746) to surface DexScreener API errors, and verify the response parsing.
4. R6/R7/R8 never fire
- R6 (deployer-linked funding): Needs deployer labels to propagate funder chains. Verify the deployer heuristic in applyTransfer (engine.ts:247) and R6 rule logic.
- R7 (LP-lock safety): Needs LP token tracking. Pools are registered (51 rows in pools table) but lpMinted/burned tracking may not be receiving data. Check if LP token transfers are being subscribed.
- R8 (exchange fan-out): Needs CEX labels in the graph. Only 26 labels exist. The CEX label set may be too sparse, or trace API unavailability prevents exchange-deposit detection.
5. Alert escalation happens too quickly
Token 0x0e35fe64... went from info(55) → critical(100) in 16 blocks (~7 minutes), then a second critical(100) 2 hours later. The escalation logic (alerts/manager.ts) escalates by +20 points but the significance filter (engine.ts:486-498) only blocks re-fires of the same (token, rule) pair. When a different rule fires and pushes the score higher, a new alert is created even if the token was just alerted.
Fix: Consider a per-token alert cooldown (not just per-token-per-rule) to avoid alerting escalation spam on the same token within a short window.