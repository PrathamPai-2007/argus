# AGENTS.md — Argus

Real-time on-chain intelligence pipeline. Detects wallet clustering, funding-source links,
and liquidity anomalies in real time. See `README.md` for architecture, CLI, and configuration.

## Stack & constraints

- **Bun + TypeScript**, one process. Runtime APIs used: `bun:sqlite`, `Bun.serve` (Phase 4), `bun test`.
- **Only runtime dependency: `viem`.** TypeScript/Bun packages are dev dependencies; do not add runtime packages without a strong reason (no Redis/Docker/Postgres/ORMs/web frameworks/notification SDKs — build in-process instead).
- Everything local: SQLite file in `data/`, logs in `logs/`, secrets in `.env` (never commit).

## Commands

```bash
bun install            # install deps
bun test               # unit tests (bun:test)
bun run typecheck      # tsc --noEmit (must stay clean; strict + exactOptionalPropertyTypes)
bun run doctor         # pre-flight: config, DB, RPC endpoints (incl. trace API), telegram, disk
bun run start          # live engine (src/index.ts run)
bun run replay --chain 1 --from N --to M [--token 0x...] [--preset name]   # offline backtest from events table
bun run backfill --chain 1 --from N --to M                   # historical ingest (RPC or configured providers)
```

## Layout

```
argus.config.ts        typed config (validated in src/config.ts); secrets as ${ENV_VAR}
migrations/            plain .sql, applied in filename order, tracked in _migrations
src/
  index.ts             CLI router: run | doctor | replay | backfill
  config.ts            hand-rolled validation (no zod) + .env loader + hot reload
  db.ts                bun:sqlite repos (WAL), projections, failed-event recovery. Tests use openDb(":memory:")
  types.ts             StandardEvent union, Signal, AlertPayload
  queue.ts             weighted ring buffer, drop-oldest + dropped counter (never block ingestion)
  ingest/evm.ts        ChainAdapter: WS subscribe, failover, heartbeat/stale, reorg walk-back,
                       HTTP-routed getLogs queries (dedicated HTTP client pool avoiding WS getLogs errors),
                       gap backfill (per-gap provider selection: tiny gaps <=64 blocks on RPC,
                       larger on Etherscan/BigQuery; bounded per-address fan-out, throttle
                       retries + endpoint failover, archive-unsupported detection -> Etherscan),
                       funding extraction (native transfers + Disperse calldata), deferred head-gap and parent-hash recovery
  ingest/etherscan.ts  Etherscan getLogs provider: 256-block ranges, split-on-demand recursive
                       splitting, rate-limit backoff (5 retries), pagination
  ingest/bigquery.ts   optional BigQuery logs provider (service-account JWT, no SDK)
  ingest/normalizer.ts raw logs → StandardEvents (pure functions, fixture-tested)
  ingest/dexscreener.ts DexScreener stablecoin-volume ranking for targeted enrichment
  candidates.ts       bounded quality score for candidate-token promotion
  ingest/probe.ts      endpoint probing shared by adapter + doctor
  graph/dsu.ts         RollbackDSU: union by size, NO path compression, op-stack rollback
  graph/engine.ts      GraphEngine: wallets, funding edges, balance ledgers, clusters;
                       every mutation records an undo closure → rewindTo(block) for reorgs;
                       finalize(boundary) prunes stale rolling windows (>24h)
  rules/index.ts       R1–R8 pure functions (event, graphView, config) → Signal | null
  scorer.ts            best-weight-per-rule sum → 0–100 → severity
  alerts/manager.ts    cooldown / configurable score escalation / global rate limit / retractions
  performance.ts       pool-relative alert watches (12h, +50% target, -20% stop)
  alerts/telegram.ts   one fetch POST; no SDK
  webhooks.ts          outbound HTTP delivery of alerts/signals/retractions (HMAC-signed, SSRF-safe, plain fetch)
  engine.ts            orchestrator: queue drain → persist → graph → rules → score → alerts;
                       serialized control operations, bounded retries, overflow recovery, shutdown drain,
                       finalized projection rebuilds
tests/                 bun:test; adapter/dashboard/config/security regressions; golden fixtures for normalizer; in-memory SQLite
```

## Invariants — do not break

1. **Events are facts, state is derived.** Every normalized event lands in `events` with `finalized` 0/1.
   Graph state must be rebuildable by replaying finalized events (`GraphEngine` has no other I/O).
2. **Unfinalized state must be rewindable.** Every graph mutation pushes an undo closure onto
   `history`; `rewindTo(fromBlock)` must restore exact prior state (tests assert this).
   DSU: never add path compression (destroys rollback).
3. **CEX-funded wallets are never hard-merged** into clusters (weak edge only, feeds R8).
4. **No alert without evidence** (rule IDs, member addresses, exact numbers). Alerts on unfinalized
   state are tagged unconfirmed; reorgs issue explicit retractions.
5. **Rules stay pure**: `(event, view, config) → Signal | null`, no graph mutation, no I/O.
6. New tables/columns → new `migrations/NNNN_name.sql` file; never edit applied migrations.
7. **Live startup is independent of history**: startup begins at the current head and never waits
   for historical backfill or restores a previous graph snapshot. Recovery state is in-process only.
   Provider choice is per-gap (`chooseBackfillProvider`): gaps <= `TINY_GAP_RPC_BLOCKS` (64)
   stay on free HTTP RPC (PublicNode / httpRpcs pool) to preserve primary WS quotas; larger gaps estimate request cost and pick Etherscan / BigQuery / RPC.
8. **Recovery is best-effort.** Factory/LP/swap log queries may be skipped on transient provider
   errors; optional enrichment/recovery failures never block live ingestion.
9. **Outbound safety is enforced.** Webhook validation rejects loopback/private/link-local/metadata
   targets; delivery rejects redirects, uses abortable timeouts, and stops retry timers on shutdown.
10. **Dashboard exposure is deliberate.** The server binds to `127.0.0.1`; when
     `ARGUS_DASHBOARD_TOKEN` is set, page/API/SSE requests require Bearer or Basic auth.
11. **Candidates are not watches.** `token_candidates` and `tokens.source = 'candidate'`
    hold bounded evaluation state; they are excluded from live subscriptions and alert rules
    until promotion passes hard evidence gates and the configured score threshold.
12. **Failed event work is durable.** Event application failures are recorded in
    `failed_events` with their payload and retry metadata; successful application removes the row.
13. **Session reset is explicit.** Restart cleanup removes session-scoped unfinalized facts and
    derived outputs, while finalized facts and the closed-trade journal remain durable.

## Status

- [x] Phase 0 scaffold (config, migrations, logger, doctor)
- [x] Phase 1 EVM ingestion (WS, reconnect/failover, heartbeat, deferred head-gap recovery, parent-hash reorg detection, queue-overflow recovery, bounded backfill)
- [x] Phase 2 graph engine (rollback DSU, funding extraction incl. Disperse, labels, ledgers, snapshots)
- [x] Phase 3 heuristics R1–R8 + scorer + alert manager + Telegram
- [x] Phase 4 dashboard (Bun.serve + SSE on 127.0.0.1:3737)
- [x] Dashboard polish: bento overview (Watched tokens | Live alerts | Alert performance on the
  top row, signals/events below), compressed watched-token and performance tables (TP/SL outcome
  notation), token detail views (constellation, concentration, members)
- [x] Phase 5 replay tuning presets (`default` | `cautious` | `strict`)
- [x] Output layer: webhook push (`src/webhooks.ts`, HMAC-signed POST of alerts/signals/
  retractions) + graph API endpoints on the dashboard (clusters, funding edges)
- Phase 6 multi-chain + auto-watch live fire: auto-watch is live; BNB Chain / Base configuration scaffolding remains commented
- Phase 7 stretch: more chain support, per-token tuning
- Historical backfill: provider choice is per-gap — tiny reorg gaps (<=64 blocks) stay on RPC;
  larger gaps pick Etherscan (default), BigQuery (optional, long ranges), or RPC from an
  estimated request cost. Etherscan queries start at 256-block ranges and split recursively only
  on "Result window is too large", with rate-limit backoff (5 retries) and pagination. RPC log
  queries fan out per-address with bounded concurrency (`BACKFILL_CONCURRENCY`); throttle/timeout
  errors retry + fail over between endpoints, and archive-unsupported errors (e.g. PublicNode's
  "archive requests require a personal token") switch the backfill back to Etherscan automatically.
- Internal-tx funding via trace APIs: capability probed by doctor/adapter; extraction stubbed
  (free endpoints rarely expose `debug_traceTransaction` — graceful degradation is by design).
- Security hardening: URL credentials are redacted from logs, dashboard auth is opt-in, and
  webhook requests have SSRF, redirect, timeout, retry, and shutdown safeguards.
- Quality-driven discovery: factory and DexScreener activity creates bounded candidates;
  targeted enrichment scores liquidity, early buyer retention, funding independence, and
  exchange/common-funder risk before promotion. Volume is capped and cannot bypass buyer gates.
- Real-time performance & graph integrity: Fast concurrent on-chain RPC polling for pool reserves eliminates DexScreener HTTP limits. Hub-degree limits (in-degree/out-degree > 25) prevent routers/infra from collapsing disjoint wallets into mega-clusters. Synthetic rule evaluations strictly filter out candidates and expired watches to preserve Inv 11.
- RPC multicall & batching: Explicit `multicall` for ERC-20 metadata (`totalSupply`, `decimals`, `symbol`) and global JSON-RPC HTTP transport batching reduce RPC round-trips by up to 75%.
- Memory retention & graph garbage collection: `GraphEngine.prune(activeTokens)` runs during the hourly `retentionSweep`, safely evicting un-watched token ledgers, stale rolling send/buy buffers, and inactive wallets to prevent unbounded memory growth.
- O(1) cluster balance tracking: `GraphEngine` incrementally maintains `clusterBalances` and `clusterTokens` on every transfer and DSU merge. `clusterBreakdown` is pre-computed in O(clusters) rather than O(holders * depth), while full member arrays are resolved lazily only when an alert fires.
- Reliability hardening: provider identity and log-shape validation, canonical transaction ordering,
  serialized ingestion handoffs, queue-drop attribution, durable failed-event recovery, and finalized
  projection rebuilds are covered by regression tests.
- Dashboard investigation: `/api/token/:chain/:address` reports metadata, history, recent persisted
  events, and availability flags instead of silently presenting an empty result for a valid deep link.
- Detection lifecycle: `signal_evaluations` records score, severity, alert outcome, and suppression
  reason; alerts record performance-watch status and reason; dashboard exposes Activity Log and Positions.
- Aggressive live tuning: candidate evaluation is bounded at 10/cycle, promotion uses a `$5k` liquidity
  floor and score `25`, sensitive rule thresholds are enabled, and alert scoring starts at `info: 25`.

## Verification

The current repository passes the strict typecheck and full Bun test suite:

```text
bun run typecheck  PASS
bun test           150 pass, 0 fail
```

## Smoke testing without a paid RPC

`wss://ethereum-rpc.publicnode.com` works for dev. Watching a high-velocity token
(e.g. USDT `0xdac17f...ec7`) exercises the whole pipeline in seconds. Expect noisy R5 signals
on majors until per-token tuning exists (Phase 7) — that's why replay+tuning matters.
