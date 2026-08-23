# Argus

**Real-time on-chain intelligence pipeline.** Argus watches Ethereum (and BNB Chain / Base) for wallet clustering, funding-source links, and liquidity anomalies, and pushes Telegram alerts with evidence.

- **Single process, zero infra.** Bun + TypeScript, SQLite on disk, logs to files. The only runtime dependency is [`viem`](https://viem.sh).
- **Events are facts, state is derived.** Every normalized on-chain event is persisted, and the wallet graph is a pure replay of finalized events — safe to rebuild, rewind, and backtest.
- **Evidence-first alerts.** Every alert carries rule IDs, addresses, and exact numbers, so you can verify a signal before acting on it.

---

## Features

- **Live ingestion** — WebSocket subscription with automatic RPC failover, 5s–60s Infura rate-limit backoff, heartbeat/staleness detection, and watchdog recovery.
- **Dual-RPC parallel catch-up** — when falling behind the live head, block chunks are fetched in parallel across the configured HTTP RPC pool to catch up at 2x speed before resuming the live WebSocket stream.
- **Quota-aware RPC backfilling** — standard historical RPC backfills automatically route to Public ETH RPCs (or Etherscan/BigQuery), preserving Infura API credits exclusively for real-time streaming and catch-up.
- **Live-first startup** — connects and processes new blocks immediately; historical enrichment never gates ingestion.
- **Reorg-safe state** — a rollback-friendly union-find graph (`RollbackDSU`, no path compression) rewinds to any block when the chain reorgs; confirmed alerts are confirmed, unfinalized ones are retracted.
- **Gap recovery** — startup begins at the current head, while bounded reconnect, queue-overflow, and parent-hash reorg recovery run in-process. DexScreener results create bounded token candidates; only candidates with independent early-buyer evidence are promoted to live watches.
- **Funding extraction** — native ETH transfers, `Disperse` calldata decoding, and internal calls via trace APIs when the endpoint exposes them (graceful degradation otherwise).
- **Candidate-driven discovery** — tracks new factory pools and stablecoin-quoted DEX activity as candidates, evaluates liquidity, early buyers, retention, funding independence, and exchange exposure, then promotes qualifying tokens for live monitoring.
- **8 heuristic rules** (R1–R8) with tunable thresholds, weights, and replay presets.
- **Webhook push** — POST alerts, signals, and reorg retractions to validated HTTP(S) endpoints (Discord/Slack/n8n/your own server); HMAC-signed when a secret is set.
- **Graph API & SQL Materialization** — per-token wallet clusters and funding edges as JSON and materialized SQL tables (`clusters`, `cluster_members`), ready to feed your own visualizations.
- **Alert performance journal & TP/SL tracking** — pool-relative watches start on real alerts, auto-register pool subscriptions, resolve quote-aligned prices via DexScreener fallback, poll DEX prices every 15 seconds, track a 12-hour `+50% / -20%` target/stop window with single-tick anomaly guards ($>20\times$), format sub-micro prices without `$0.000000` truncation, and send Telegram outcome alerts (`🎯 TP HIT`, `🛑 SL HIT`).
- **Selective cross-session persistence** — alerts, alert history, active performance tracking sessions, and alerted tokens persist cleanly across engine restarts.
- **Real-time WebSocket dashboard** — `Bun.serve` + native WebSockets (`ws://127.0.0.1:3737/ws`) + SSE on `127.0.0.1:3737`, zero dependencies; optionally protected with `ARGUS_DASHBOARD_TOKEN`.
- **Hot-reloadable config** — edit `argus.config.ts` and rule/scoring/alert/auto-watch/webhook settings apply without a restart.
- **Secrets stay out of logs & test isolation** — RPC keys and URL credentials are redacted centrally in the logger; test runs use timestamped `logs/argus-test-*.log` files; log level is configurable with `ARGUS_LOG_LEVEL`.
- **Quality prioritization** — DexScreener volume is only a bounded candidate source and a capped score component. It cannot promote a token without enough independent early buyers.

## How it works

```
candidate sources ──► candidate table ──► targeted enrichment ──► quality score ──► active token watch
                                                                        │
evm adapter ──► event queue ──► SQLite (facts) ──► graph engine ──► rules R1–R8 ──► scorer ──► alerts
   │                                          │      (derived state)     │                          │
   └─ WS subscribe, failover,                 └── rewindTo(block)         └─ pure functions           └─ Telegram / webhooks / SSE
      reorg walk-back, backfill                     on reorg                   (event, view, config)      cooldown / retraction
```

1. **Discover** (`src/engine.ts`, `src/ingest/dexscreener.ts`) — records new pools and stablecoin-quoted DEX results as candidates. Candidate rows are not active watches and do not produce alerts.
2. **Evaluate** (`src/candidates.ts`, `src/graph/engine.ts`) — targeted history measures liquidity, early buyer count, retained buyers, independent funding groups, exchange-funded buyers, and common-funder concentration. Volume is capped at 10% of the score.
3. **Promote** — candidates must pass both the score threshold and hard evidence gates before entering `tokens` as a live `ranked` or `factory` watch. Evaluation is bounded by candidate count, TTL, and the existing provider limiter.
4. **Ingest** (`src/ingest/evm.ts`) — subscribes to watched-token `Transfer`s, factory `PairCreated`s, pool LP `Transfer`s and `Swap`s, and native-funding txs of followed wallets. Raw logs are normalized to `StandardEvent`s (`transfer`, `swap`, `pool_created`, `funding`).
5. **Persist** (`src/db.ts`) — every event lands in the `events` table with a `finalized` flag; candidate state and evidence are persisted separately from facts.
6. **Graph** (`src/graph/engine.ts`) — wallets, funding edges, balance ledgers, and clusters via a rollback DSU. Every mutation records an undo closure so `rewindTo(block)` restores exact prior state on reorg. Finalization (`finalize(boundary)`) prunes stale rolling windows (>24h).
7. **Rules** (`src/rules/index.ts`) — pure functions `(event, graphView, config) → Signal | null`.
8. **Score** (`src/scorer.ts`) — best-weight-per-rule sum mapped to 0–100 and `info` / `alert` / `critical` severity.
9. **Alert** (`src/alerts/`) — cooldown, escalation, global rate limit, Telegram delivery, and explicit retractions for reorged alerts. Live (unfinalized) signals are tagged **unconfirmed** until the block finalizes.

## Detection rules

| Rule | What it detects |
|------|-----------------|
| **R1** | Fresh-wallet accumulation: wallets < *N* days old bought > *X*% of supply within a window |
| **R2** | Volume spike: swap volume in a window vs. the equal-length prior window |
| **R3** | Sybil fan-out: one sender pays identical amounts to many sub-wallets in a short window |
| **R4** | Cluster concentration: a single cluster controls > *X*% of supply (warn vs. critical thresholds) |
| **R5** | Bundled buys: ≥ *N* fresh wallets receive the token in the same block |
| **R6** | Deployer linkage: an accumulating cluster is funded within *N* hops of the token deployer |
| **R7** | LP-lock safety: a pool's LP token is being burned such that locked LP falls below *X*% (rug / liquidity-exit risk) |
| **R8** | Exchange fan-out: *N* wallets funded with identical amounts from the same CEX hot wallet |

All thresholds, windows, and weights are configurable per rule in `argus.config.ts` (or via `--preset` on `replay`).

## Project layout

```
argus.config.ts        typed config; secrets as ${ENV_VAR} placeholders
migrations/            plain .sql applied in filename order, tracked in _migrations
data/                  SQLite DB (gitignored)
logs/                  UTC timestamped session log files (gitignored)
src/
  index.ts             CLI router: run | doctor | replay | backfill
  config.ts            hand-rolled config validation + .env loader + hot reload
  db.ts                bun:sqlite repositories (WAL)
  types.ts             StandardEvent union, Signal, AlertPayload
  queue.ts              weighted ring buffer (drop-oldest, never blocks ingestion)
  engine.ts            orchestrator: queue → persist → graph → rules → score → alerts
  scorer.ts            per-rule weight sum → 0–100 → severity
  seeds.ts             starter labels (CEX hot wallets, routers, Disperse)
  ingest/evm.ts        EVM adapter: WS, failover, heartbeat, reorg walk-back, backfill, funding
  candidates.ts       bounded quality score for token promotion
  ingest/dexscreener.ts stablecoin-quoted candidate source and market metadata
  ingest/etherscan.ts  Etherscan getLogs provider: pagination, rate limit, recursive range splitting
  ingest/bigquery.ts   optional BigQuery logs provider (service-account JWT, no SDK)
  ingest/normalizer.ts raw logs → StandardEvents (pure, fixture-tested)
  ingest/probe.ts      endpoint probing shared by adapter + doctor
  graph/dsu.ts         RollbackDSU: union by size, no path compression, op-stack rollback
  graph/engine.ts      wallets, funding edges, ledgers, clusters; rewindTo(block)
  rules/index.ts       R1–R8 pure functions
  alerts/manager.ts    cooldown / escalation / rate limit / retractions
  alerts/telegram.ts   single fetch POST; no SDK
  webhooks.ts          HMAC-signed outbound POST of alerts/signals/retractions (plain fetch)
  dashboard/server.ts   local Bun.serve + SSE + JSON API + graph API + optional auth
  dashboard/page.ts     single-page dashboard HTML
  cli/                 doctor, replay, backfill entrypoints
tests/                 bun:test suites (adapter, graph, dsu, db, rules, scorer, alerts, config, queue, dashboard, performance, normalizer)
```

## Requirements

- [Bun](https://bun.sh) ≥ 1.1
- A WebSocket RPC endpoint per enabled chain. Free tiers work for development:
  - `wss://ethereum-rpc.publicnode.com` — reliable for smoke tests, but rejects archive `eth_getLogs` (Argus detects this and switches the backfill to Etherscan automatically)
  - Infura/Alchemy free tiers — fast but rate-limit `eth_getLogs` (Argus retries and fails over automatically)
- An Etherscan API key (`ETHERSCAN_API_KEY`, free at etherscan.io) is optional for targeted enrichment or explicit historical CLI backfills.
- For production, put keyed endpoints in `.env` (see below).

## Quick start

```bash
bun install                  # install deps (viem + TypeScript toolchain)
cp .env.example .env         # add your secrets
bun run doctor               # pre-flight: config, DB, RPCs (incl. trace API), Telegram, disk
bun run start                # live engine + dashboard on http://127.0.0.1:3737
```

Smoke test without a paid RPC: add USDT to the watchlist, or rely on `autoWatch` against the factory.

```ts
watchlist: [{ chainId: 1, address: "0xdac17f958d2ee523a2206206994597c13d831ec7" }],
```

A high-velocity token exercises the whole pipeline (ingest → graph → rules → alerts) in seconds. Expect noisy signals on liquid majors until per-token tuning exists.

### Environment

```bash
# .env  (never commit)
TELEGRAM_BOT_TOKEN=...       # via @BotFather
TELEGRAM_CHAT_ID=...         # via @userinfobot
RPC_ETH_MAINNET=wss://mainnet.infura.io/ws/v3/<key>
# RPC_ETH_HTTP=https://mainnet.infura.io/v3/<key>
# RPC_ETH_BACKUP=wss://ethereum-rpc.publicnode.com
# RPC_ETH_BACKUP_HTTP=https://ethereum-rpc.publicnode.com
# ANKR_API_KEY=...            # primary keyed HTTP RPC: https://rpc.ankr.com/eth/<key>
# ETHERSCAN_API_KEY=...       # required by the enabled sample Etherscan config
# ARGUS_DASHBOARD_TOKEN=...  # optional Basic/Bearer token for dashboard/API access
# ARGUS_LOG_LEVEL=info        # optional: debug | info | warn | error

# Optional — BigQuery historical provider (disabled by default in argus.config.ts)
# BIGQUERY_PROJECT_ID=...
# GOOGLE_APPLICATION_CREDENTIALS=C:\path\to\service-account.json
```

Secrets referenced from `argus.config.ts` as `${VAR_NAME}` placeholders are interpolated at load time. RPC keys are redacted from all log output.

### Logging

Logs are written to `logs/` with UTC timestamps in `YYYY-MM-DD-HH-MM-SS` format. Each process creates a timestamped session file, for example `argus-2026-08-16-06-12-31.log`; the same timestamp is included in every console and JSON log entry. Sessions started within the same second share a filename.

## CLI

```text
bun run start [--config path] [--no-dashboard] [--verbose]   # live engine
bun run doctor [--config path]                               # pre-flight checks
bun run replay --chain 1 --from N --to M [--token 0x...] [--preset name]
bun run backfill --chain 1 --from N --to M                   # historical ingest (RPC or configured providers)
bun test                                                       # unit tests
bun run typecheck                                               # tsc --noEmit (strict)
```

- **replay** — offline backtest over the `events` table; apply a tuning preset (`default` | `cautious` | `strict`) without touching config. Add `--config path` to use a non-default config.
- **backfill** — ingest a historical block range into `events` for later replay. Uses the same provider selection as gap backfill (Etherscan if configured, otherwise the RPC). Add `--config path` to use a non-default config.
- **doctor** — validates config, DB, RPC reachability (including `debug_traceTransaction` capability), Telegram credentials, and disk space.

The live engine is intentionally not a historical replay service: it starts from the current
head and processes new blocks immediately. Startup may schedule a deferred bounded backfill for
the small head gap observed while the WebSocket subscription is being established, but that work
never blocks live ingestion.

## Dashboard

Served on `127.0.0.1:3737` (local-only). The page is a single HTML file with SSE live updates and JSON endpoints. If `ARGUS_DASHBOARD_TOKEN` is set, every dashboard, API, and SSE request requires either `Authorization: Bearer <token>` or Basic authentication using the token as the password.

| Endpoint | Description |
|----------|-------------|
| `/` | dashboard page |
| `/events/stream` | SSE push of alerts + 5s status ticks |
| `/api/status` | per-chain adapter status, checkpoint, queue depth, and candidate lifecycle counts |
| `/api/tokens` | promoted/live watched tokens (with `?chain=` filter) |
| `/api/candidates` | candidate tokens, score, evidence, lifecycle status (with optional `?chain=` filter) |
| `/api/alerts` | alert history |
| `/api/signals` | recent signals (`?chain=`, `?limit=`) |
| `/api/performance` | alert outcome sessions (`?chain=`, `?token=`, `?active=1`, `?limit=`) |
| `/api/token/:chain/:address` | signals, alerts, pools for one token |
| `/api/graph/token/:chain/:address` | wallet clusters (members, balances, labels, % of supply) + funding edges for a token |
| `/api/graph/wallet/:chain/:address` | a wallet's cluster, funder chain, and in/out funding edges |
| `/api/events/recent` | last 100 raw events |

The overview page is a bento grid: a compressed **Watched tokens** table, the **Live alerts**
stream, and the **Alert performance** journal share the top row, with recent signals and events
below. Click a token to open its detail view (metadata, performance, funding constellation,
supply concentration, cluster members, pools, alert/signal history).

Performance sessions are observational, not executed trades. Prices are derived from the alert's
reference pool and remain quote-denominated; sessions close at `+50%`, `-20%`, or 12 hours.

## Configuration

All tuning lives in `argus.config.ts` (validated in `src/config.ts`, no schema lib):

- **chains** — per-chain WebSocket RPC list (`rpcs`, used in order with automatic failover), HTTP RPC pool (`httpRpcs`, Ankr first and PublicNode second by default), Infura recovery cooldown (`infuraRetryMinutes`, default 5), finality depth, and staleness timeout (`staleAfterMs`, default 30s). All stateless `eth_getLogs` queries are routed via cached HTTP RPC clients to prevent provider WS errors.
- **chains.backfill** — optional historical-log providers for bounded recovery and targeted enrichment; never required for startup.
  - `etherscan` (enabled in the sample config) — API key + rate limit. Handles pagination, throttling, and recursive range splitting to stay under Etherscan's per-address 10,000-row window. Disable it or provide `ETHERSCAN_API_KEY` before starting.
  - `bigquery` (disabled by default) — needs a Google service-account JSON and project; only selected when the estimated range exceeds `bigqueryThresholdHours`, and protected by `maxBytesBilled`.
- **watchlist** — permanent tokens to watch.
- **autoWatch** — `enabled`, `factories` (Uniswap V2-style; each entry is a raw `0x` address or a known name like `"uniswap-v2"` — names expand to the chain's canonical factory), `watchHours` (how long factory-discovered tokens stay watched; `NULL` = permanent).
- **candidateDiscovery** — `enabled`, `maxCandidatesPerCycle`, `evaluationMinutes`, `candidateTtlHours`, `promotionScore`, `minimumLiquidityUsd`, and `minimumIndependentBuyers`. Candidates are persisted but excluded from live subscriptions and alert rules until promoted. Factory candidates enter the candidate table immediately and are evaluated when market metadata is available; disabling this setting restores direct factory/ranked auto-watch behavior.
- **rules** — per-rule `enabled`, thresholds, and `weight`.
- **scoring** — `info < alert < critical` thresholds + signal window.
- **alerts** — Telegram on/off, cooldown, escalation delta, per-minute rate limit.
- **webhooks** — outbound POST targets. Each: `url`, `events` (`"alert"` and/or `"signal"`), optional `secret` (signs the body as `x-argus-signature: sha256=<hex>`; keep it in `.env`), `timeoutMs`, `retries`. Alerts, reorg retractions, and (optionally) signals are delivered as JSON.
- **retention** — how long raw events are kept.
- **volumeRanking** — DexScreener poll interval, candidate-source count, and targeted enrichment window. The ranking is not a quality ranking by itself.
- **dbPath** — SQLite storage location.

Changes to rules/scoring/autoWatch/candidateDiscovery/volumeRanking/webhooks hot-reload on save; alert settings, chain, and watchlist changes require a restart. Webhook delivery is fire-and-forget, uses request timeouts and bounded exponential retries, rejects redirects, and refuses loopback/private/link-local/metadata destinations.

## Design invariants

1. **Events are facts, state is derived.** Every event lands in `events` with a `finalized` flag; the graph is rebuildable by replaying stored events (`GraphEngine` has no other I/O).
2. **Unfinalized state is rewindable.** Every mutation pushes an undo closure; `rewindTo(fromBlock)` restores exact prior state. The DSU never uses path compression (it would destroy rollback).
3. **CEX-funded wallets are never hard-merged** into clusters (weak edge only, feeds R8).
4. **No alert without evidence** (rule IDs, member addresses, exact numbers). Alerts on unfinalized state are tagged unconfirmed; reorgs issue explicit retractions.
5. **Rules stay pure** — `(event, view, config) → Signal | null`, no graph mutation, no I/O.
6. **Migrations are append-only** — new schema changes are new `NNNN_name.sql` files; applied migrations are never edited.
7. **Live startup is independent of history** — startup begins at the current head and never waits for historical backfill or restores a previous graph snapshot.
8. **Recovery is best-effort and in-process** — bounded startup, reconnect, queue-overflow, and reorg ranges may be re-ingested, but no backfill cursor is persisted across sessions and recovery failure never prevents live operation.
9. **Candidates are not watches** — candidate rows and candidate-source tokens are excluded from live subscriptions and rules; promotion requires configured hard gates plus a score threshold.
10. **Volume is not conviction** — volume may generate or prioritize candidates, but is capped in promotion scoring and cannot bypass independent-buyer and liquidity gates.

## Tests

```bash
bun test
bun run typecheck
```

The test suite (`bun:test`) covers adapter startup/reorg behavior, the rollback DSU, graph rewinds, funding extraction, rule functions, scorer, alert manager/cooldowns/retractions, config and webhook validation, weighted queue behavior, dashboard auth/SSE, performance tracking, logger redaction, DexScreener ranking, and golden normalizer fixtures.

## Status

- **Ingestion (Phase 1)** — done: live-first WS startup, deferred head-gap recovery, failover, heartbeat, parent-hash reorg detection, queue-overflow recovery, and bounded in-process backfill. Historical providers remain optional for targeted enrichment and explicit CLI backfills.
- **Graph (Phase 2)** — done: rollback DSU, funding extraction incl. Disperse, labels, ledgers, snapshots.
- **Heuristics + alerts (Phase 3)** — done: R1–R8, scorer, alert manager, Telegram.
- **Dashboard (Phase 4)** — done: Bun.serve + SSE on `127.0.0.1:3737`.
- **Replay tuning (Phase 5)** — done: `cautious` / `strict` presets.
- **Output layer** — done: HMAC-signed webhook push (alerts/signals/retractions) with SSRF/redirect/timeout/retry safeguards + graph API endpoints (clusters, funding edges) with optional dashboard authentication.
- **Multi-chain + polish (Phase 6)** — auto-watch is live; BNB Chain / Base configuration scaffolding remains commented. Internal-call funding probes trace capability and degrades gracefully when the endpoint doesn't expose `debug_traceTransaction`.
- **Phase 7** — candidate-driven discovery is live: bounded candidates, targeted enrichment, independent early-buyer gates, and explainable promotion evidence. Wallet reputation currently uses behavioral/current-window evidence; realized PnL learning and broader cohort discovery remain follow-up work.

## Notes & limitations

- Free-tier RPCs throttle or reject `eth_getLogs`. Argus adapts: routine historical backfilling bypasses the live WebSocket in favor of configured HTTP RPCs (or Etherscan/BigQuery) to preserve WebSocket quotas; Infura rate-limit throttling uses an exponential backoff starting at 5s up to 60s max; when falling behind the live head during recovery, chunk backfills execute across the configured HTTP RPC pool in parallel before resuming the live WebSocket stream.
- Multi-address queries fan out per-address with bounded concurrency, throttle/timeout errors retry then fail over to the next endpoint, and archive-unsupported errors (e.g. PublicNode's "archive requests require a personal token") switch the backfill to Etherscan automatically. `doctor` verifies endpoint health including trace API availability.
- Some endpoints (Infura free tier) intermittently reject `eth_getLogs` with `-32603`/`"internal error"`. Argus classifies these as transient, retries and fails over where possible, and keeps live ingestion independent of optional enrichment/recovery failures.
- Etherscan provides historical logs only; native and trace-based funding still depends on RPC coverage and is reported as degraded when unavailable.
- Etherscan's free tier caps each address/topic result window at 10,000 rows and ~3 requests/sec. Argus starts every query at a 256-block range and recursively splits only when Etherscan reports "Result window is too large", backs off on rate limits (5 retries), and sleeps between requests. Preferring the historical provider for larger gaps keeps the RPC's archive limits out of the picture; the watchdog uses per-request heartbeats rather than a fixed stall timeout.
- Candidate discovery deliberately does not attempt a chain-wide wallet firehose. DexScreener and factory events provide a bounded candidate set; Etherscan/RPC history is queried only for those candidates. This keeps provider use affordable while still selecting tokens through wallet quality, capital retention, and funding independence.
- BigQuery is optional and disabled by default. Enabling it requires a Google service-account JSON and project; queries are protected by `maxBytesBilled`. It is not a live data source.
- Internal-tx funding (method `internal_call`) requires `debug_traceTransaction`, which free endpoints rarely expose — extraction degrades gracefully by design.
- If a key is ever printed to a log, **rotate it immediately** — logs are only redacted going forward.
- Webhook URLs must be public HTTP(S) endpoints; local/private destinations are intentionally rejected to reduce SSRF risk.
