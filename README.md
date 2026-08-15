# Argus

**Real-time on-chain intelligence pipeline.** Argus watches Ethereum (and BNB Chain / Base) for wallet clustering, funding-source links, and liquidity anomalies, and pushes Telegram alerts with evidence.

- **Single process, zero infra.** Bun + TypeScript, SQLite on disk, logs to files. The only runtime dependency is [`viem`](https://viem.sh).
- **Events are facts, state is derived.** Every normalized on-chain event is persisted, and the wallet graph is a pure replay of finalized events — safe to rebuild, rewind, and backtest.
- **Evidence-first alerts.** Every alert carries rule IDs, addresses, and exact numbers, so you can verify a signal before acting on it.

---

## Features

- **Live ingestion** — WebSocket subscription with automatic RPC failover, heartbeat/staleness detection, and watchdog recovery.
- **Reorg-safe state** — a rollback-friendly union-find graph (`RollbackDSU`, no path compression) rewinds to any block when the chain reorgs; confirmed alerts are confirmed, unfinalized ones are retracted.
- **Gap backfill** — acknowledged, resumable chunks with live-first startup. Provider choice is per-gap: tiny reorg gaps (≤64 blocks) stay on the RPC, larger gaps go to Etherscan (with optional BigQuery for very long ranges), and RPC timeouts / archive-unsupported errors fail over automatically.
- **Funding extraction** — native ETH transfers, `Disperse` calldata decoding, and internal calls via trace APIs when the endpoint exposes them (graceful degradation otherwise).
- **Auto-watch** — tracks Uniswap V2-style factories, registers every new pool, and auto-watches newly minted tokens for a configurable window.
- **8 heuristic rules** (R1–R8) with tunable thresholds, weights, and replay presets.
- **Webhook push** — POST alerts, signals, and reorg retractions to any HTTP endpoint (Discord/Slack/n8n/your own server); HMAC-signed when a secret is set.
- **Graph API** — per-token wallet clusters and funding edges as JSON, ready to feed your own visualizations.
- **Alert performance journal** — persisted pool-relative watches start on real alerts, track a 12-hour `+50% / -20%` target/stop window, and remain reorg-auditable.
- **Local dashboard** — `Bun.serve` + SSE on `127.0.0.1:3737`, zero dependencies.
- **Hot-reloadable config** — edit `argus.config.ts` and rule/scoring/alert/auto-watch/webhook settings apply without a restart.
- **Secrets stay out of logs** — RPC keys are redacted centrally in the logger.

## How it works

```
evm adapter ──► event queue ──► SQLite (facts) ──► graph engine ──► rules R1–R8 ──► scorer ──► alerts
   │                                          │      (derived state)     │                          │
   └─ WS subscribe, failover,                 └── rewindTo(block)         └─ pure functions           └─ Telegram / webhooks / SSE
      reorg walk-back, backfill                     on reorg                   (event, view, config)      cooldown / retraction
```

1. **Ingest** (`src/ingest/evm.ts`) — subscribes to watched-token `Transfer`s, factory `PairCreated`s, pool LP `Transfer`s and `Swap`s, and native-funding txs of followed wallets. Raw logs are normalized to `StandardEvent`s (`transfer`, `swap`, `pool_created`, `funding`).
2. **Persist** (`src/db.ts`) — every event lands in the `events` table with a `finalized` flag; the queue is a ring buffer that drops oldest rather than blocking ingestion.
3. **Graph** (`src/graph/engine.ts`) — wallets, funding edges, balance ledgers, and clusters via a rollback DSU. Every mutation records an undo closure so `rewindTo(block)` restores exact prior state on reorg. Finalization (`finalize(boundary)`) prunes stale rolling windows (>24h).
4. **Rules** (`src/rules/index.ts`) — pure functions `(event, graphView, config) → Signal | null`.
5. **Score** (`src/scorer.ts`) — best-weight-per-rule sum mapped to 0–100 and `info` / `alert` / `critical` severity.
6. **Alert** (`src/alerts/`) — cooldown, escalation, global rate limit, Telegram delivery, and explicit retractions for reorged alerts. Live (unfinalized) signals are tagged **unconfirmed** until the block finalizes.

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
data/                  SQLite DB + graph snapshot (gitignored)
logs/                  per-day log files (gitignored)
src/
  index.ts             CLI router: run | doctor | replay | backfill
  config.ts            hand-rolled config validation + .env loader + hot reload
  db.ts                bun:sqlite repositories (WAL)
  types.ts             StandardEvent union, Signal, AlertPayload
  queue.ts             ring buffer (drop-oldest, never blocks ingestion)
  engine.ts            orchestrator: queue → persist → graph → rules → score → alerts
  scorer.ts            per-rule weight sum → 0–100 → severity
  seeds.ts             starter labels (CEX hot wallets, routers, Disperse)
  ingest/evm.ts        EVM adapter: WS, failover, heartbeat, reorg walk-back, backfill, funding
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
  dashboard/server.ts  local Bun.serve + SSE + JSON API + graph API
  dashboard/page.ts    single-page dashboard HTML
  cli/                 doctor, replay, backfill entrypoints
tests/                 bun:test suites (graph, dsu, db, rules, scorer, alerts, config, queue, normalizer)
```

## Requirements

- [Bun](https://bun.sh) ≥ 1.1
- A WebSocket RPC endpoint per enabled chain. Free tiers work for development:
  - `wss://ethereum-rpc.publicnode.com` — reliable for smoke tests, but rejects archive `eth_getLogs` (Argus detects this and switches the backfill to Etherscan automatically)
  - Infura/Alchemy free tiers — fast but rate-limit `eth_getLogs` (Argus retries and fails over automatically)
- An Etherscan API key (`ETHERSCAN_API_KEY`, free at etherscan.io) to backfill historical gaps without hammering the RPC.
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
ETHERSCAN_API_KEY=...        # historical gap backfill (free tier ~3 req/s)

# Optional — BigQuery historical provider (disabled by default in argus.config.ts)
# BIGQUERY_PROJECT_ID=...
# GOOGLE_APPLICATION_CREDENTIALS=C:\path\to\service-account.json
```

Secrets referenced from `argus.config.ts` as `${VAR_NAME}` placeholders are interpolated at load time. RPC keys are redacted from all log output.

## CLI

```text
bun run start [--config path] [--no-dashboard] [--verbose]   # live engine
bun run doctor [--config path]                               # pre-flight checks
bun run replay --chain 1 --from N --to M [--token 0x...] [--preset name]
bun run backfill --chain 1 --from N --to M                   # historical ingest (RPC or configured providers)
bun run test                                                 # unit tests
bun run typecheck                                            # tsc --noEmit (strict)
```

- **replay** — offline backtest over the `events` table; apply a tuning preset (`default` | `cautious` | `strict`) without touching config.
- **backfill** — ingest a historical block range into `events` for later replay. Uses the same provider selection as gap backfill (Etherscan if configured, otherwise the RPC).
- **doctor** — validates config, DB, RPC reachability (including `debug_traceTransaction` capability), Telegram credentials, and disk space.

## Dashboard

Served on `127.0.0.1:3737` (local-only). The page is a single HTML file with SSE live updates and JSON endpoints:

| Endpoint | Description |
|----------|-------------|
| `/` | dashboard page |
| `/events/stream` | SSE push of alerts + 5s status ticks |
| `/api/status` | per-chain adapter status, checkpoint, queue depth |
| `/api/tokens` | watched tokens (with `?chain=` filter) |
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

- **chains** — per-chain RPC list (used in order with automatic failover), finality depth, staleness timeout.
- **chains.backfill** — historical-log providers for gap backfill.
  - `etherscan` (enabled by default) — API key + rate limit. Handles pagination, throttling, and recursive range splitting to stay under Etherscan's per-address 10,000-row window.
  - `bigquery` (disabled by default) — needs a Google service-account JSON and project; only selected when the estimated range exceeds `bigqueryThresholdHours`, and protected by `maxBytesBilled`.
- **watchlist** — permanent tokens to watch.
- **autoWatch** — `enabled`, `factories` (Uniswap V2-style; each entry is a raw `0x` address or a known name like `"uniswap-v2"` — names expand to the chain's canonical factory), `watchHours` (how long factory-discovered tokens stay watched; `NULL` = permanent).
- **rules** — per-rule `enabled`, thresholds, and `weight`.
- **scoring** — `info < alert < critical` thresholds + signal window.
- **alerts** — Telegram on/off, cooldown, escalation delta, per-minute rate limit.
- **webhooks** — outbound POST targets. Each: `url`, `events` (`"alert"` and/or `"signal"`), optional `secret` (signs the body as `x-argus-signature: sha256=<hex>`; keep it in `.env`), `timeoutMs`, `retries`. Alerts, reorg retractions, and (optionally) signals are delivered as JSON.
- **retention** — how long raw events are kept.
- **dbPath / snapshotPath** — storage locations.

Changes to rules/scoring/alerts/autoWatch/webhooks hot-reload on save; chain/watchlist changes require a restart.

## Design invariants

1. **Events are facts, state is derived.** Every event lands in `events` with a `finalized` flag; the graph is rebuildable by replaying stored events (`GraphEngine` has no other I/O).
2. **Unfinalized state is rewindable.** Every mutation pushes an undo closure; `rewindTo(fromBlock)` restores exact prior state. The DSU never uses path compression (it would destroy rollback).
3. **CEX-funded wallets are never hard-merged** into clusters (weak edge only, feeds R8).
4. **No alert without evidence** (rule IDs, member addresses, exact numbers). Alerts on unfinalized state are tagged unconfirmed; reorgs issue explicit retractions.
5. **Rules stay pure** — `(event, view, config) → Signal | null`, no graph mutation, no I/O.
6. **Migrations are append-only** — new schema changes are new `NNNN_name.sql` files; applied migrations are never edited.
7. **Backfill is resumable** — phase + cursor persist in `backfill_jobs`; startup and recovery resume from that cursor, never from a stale in-memory head.
8. **Non-critical backfill phases are best-effort** — factory/LP/swap log queries may be skipped on transient provider errors (log + advance cursor + continue); only the tokens phase is fatal. `start()`/`recover()` go live even if a gap backfill fails — the durable cursor resumes the gap.

## Tests

```bash
bun test
bun run typecheck
```

The test suite (`bun:test`) covers the rollback DSU, graph rewinds, funding extraction, the rule functions, the scorer, alert manager/cooldowns, config validation, the queue, and golden fixtures for the normalizer.

## Status

- **Ingestion (Phase 1)** — done: WS, live-first startup, failover, heartbeat, reorg walk-back, acknowledged resumable backfill (Etherscan/BigQuery historical providers), checkpoints. Provider choice is per-gap — tiny reorg gaps (≤64 blocks) on RPC, larger gaps on the historical provider, with automatic switching when an endpoint can't serve archive logs. Recovery resumes from the persisted backfill cursor, and the watchdog tracks per-request provider heartbeats so slow Etherscan chunks are never mistaken for a stalled backfill.
- **Graph (Phase 2)** — done: rollback DSU, funding extraction incl. Disperse, labels, ledgers, snapshots.
- **Heuristics + alerts (Phase 3)** — done: R1–R8, scorer, alert manager, Telegram.
- **Dashboard (Phase 4)** — done: Bun.serve + SSE on `127.0.0.1:3737`.
- **Replay tuning (Phase 5)** — done: `cautious` / `strict` presets.
- **Output layer** — done: HMAC-signed webhook push (alerts/signals/retractions) + graph API endpoints (clusters, funding edges).
- **Multi-chain + polish (Phase 6)** — scaffolding in place (BNB Chain / Base configs commented); internal-call funding via trace APIs probes capability and degrades gracefully when the endpoint doesn't expose `debug_traceTransaction`.
- **Phase 7** — stretch: more chain support, per-token tuning.

## Notes & limitations

- Free-tier RPCs throttle or reject `eth_getLogs`. Argus adapts: multi-address queries fan out per-address with bounded concurrency, throttle/timeout errors retry then fail over to the next endpoint, and archive-unsupported errors (e.g. PublicNode's "archive requests require a personal token") switch the backfill to Etherscan automatically. `doctor` verifies endpoint health including trace API availability.
- Some endpoints (Infura free tier) intermittently reject `eth_getLogs` with `-32603`/`"internal error"`. Argus classifies these as transient — it retries and fails over to the next RPC first, and only then falls back to skipping the non-critical factory/LP/swap backfill phases (the durable `backfill_jobs` cursor resumes the gap). The tokens phase remains fatal. `start()`/`recover()` go live even when a gap backfill fails, so a flaky provider can't wedge the engine in an `error` state.
- Etherscan provides historical logs only; native and trace-based funding still depends on RPC coverage and is reported as degraded when unavailable.
- Etherscan's free tier caps each address/topic result window at 10,000 rows and ~3 requests/sec. Argus starts every query at a 256-block range and recursively splits only when Etherscan reports "Result window is too large", backs off on rate limits (5 retries), and sleeps between requests. Preferring the historical provider for larger gaps keeps the RPC's archive limits out of the picture; the watchdog uses per-request heartbeats rather than a fixed stall timeout.
- BigQuery is optional and disabled by default. Enabling it requires a Google service-account JSON and project; queries are protected by `maxBytesBilled`. It is not a live data source.
- Internal-tx funding (method `internal_call`) requires `debug_traceTransaction`, which free endpoints rarely expose — extraction degrades gracefully by design.
- If a key is ever printed to a log, **rotate it immediately** — logs are only redacted going forward.
