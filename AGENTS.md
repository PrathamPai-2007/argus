# AGENTS.md — Argus

On-chain opportunity scanner for new tokens on **Ethereum and Base** (Uniswap V2 + V3 + V4).
It watches launches from their first block, scores independent demand, vetoes rugs and
honeypots, alerts on the dashboard and Telegram, and paper-trades every alert against a
baseline so its edge is measured, not claimed. See `README.md` for usage.

## Stack & constraints

- **Bun + TypeScript**, one process. Runtime APIs: `bun:sqlite`, `Bun.serve` (routes + HTML import), `bun test`.
- **Backend runtime dependency: `viem` only** (ABI encode/decode). JSON-RPC is raw `fetch`.
- **Frontend** (`web/`, bundled by Bun's HTML import with `bun-plugin-tailwind`): React 19, Tailwind v4,
  shadcn-style components on Radix, `motion`, `@xyflow/react`, `lightweight-charts`, `recharts`, `cmdk`,
  `lucide-react`. Frontend packages never get imported by `src/` (types flow web ← src only).
- Everything local: SQLite in `data/`, logs in `logs/`, secrets in `.env` (never commit).
- Commits: small conventional commits with a "why" body, no AI attribution trailers.

## Commands

```bash
bun install
bun test               # unit + integration tests (bun:test, in-memory SQLite, fake chains)
bun run typecheck      # tsc --noEmit (strict, exactOptionalPropertyTypes, noUncheckedIndexedAccess)
bun run doctor         # config, DB, HTTP/WS endpoints, explorer keys, Telegram, disk
bun run start          # live engine + dashboard on http://127.0.0.1:3737
bun run src/index.ts run --rewind 2000   # start 2000 blocks back; catches up through the live path
bun run replay --chain 8453              # re-score stored events offline with the current config
```

## Layout

```
argus.config.ts          chains (http/ws), watchlist, discovery, signal overrides, alerts
migrations/              plain .sql applied in order (0014 = v2 schema, v1 DBs are backed up first; 0015 = V4 pools)
src/
  index.ts               CLI: run | doctor | replay; config hot-reload
  config.ts              hand-rolled validation; ${VAR} interpolation; signal overrides deep-merged
  chains.ts              verified per-chain registry: quotes, factories (incl. V4 PoolManagers), price references (WETH/ZORA/VIRTUAL vs USDC)
  model.ts               ChainEvent union (transfer, swap, reserves, liquidity, pool_created, funding)
  ingest/rpc.ts          RpcPool: per-host limits, token bucket, failover/cooldown, coalescing, settle()
  ingest/sync.ts         ChainSync: block-cursor loop (headers → filtered getLogs → signers → emit),
                         reorg walk-back, launch capture, resume/rewind, pruned-range skip
  ingest/heads.ts        newHeads over native WebSocket (wake-up signal only)
  ingest/decode.ts       pure log decoder (V2/V3/V4/ERC-20), oriented by registered pools; V4 pools keyed by bytes32 id
  ingest/reads.ts        batched eth_call: token metadata, pool discovery, pool balances
  ingest/funders.ts      first-funder resolver (Etherscan for ETH, Blockscout PRO for Base)
  state.ts               ChainState: rewindable market state + TokenMetrics snapshots
  signals.ts             opportunity + risk rules (pure) and assess() → verdict
  positions.ts           paper positions, horizons, cohort stats (pure)
  engine.ts              orchestrator: persist → apply → assess → log/alert/positions; finality; reorgs
  db.ts                  bun:sqlite repos
  alerts/                format (text), manager (delivery policy), telegram (sink)
  webhooks.ts            HMAC-signed outbound webhooks (SSRF-safe)
  dashboard/server.ts    JSON API, SSE stream, SPA (web/index.html)
web/src/                 React app: pages/, components/, lib/ (api, live SSE store, router, format)
tests/                   decoder fixtures (real mainnet logs), fake-chain sync, state rewind, signals, API
```

## Uniswap V4 notes

- The PoolManager is a singleton: every pool's logs come from one address and carry a `bytes32` pool id
  (the `pools.address` value for `dex = 'v4'`). `poolKey()` maps a log to its pool id; `addresses()` in
  sync excludes V4 ids from `eth_getLogs` address filters.
- A V4 pool is created by `Initialize`. Currency `0x0` is native ETH (a quote). `PoolCreated` carries
  `sqrtPriceX96` and `hooks`.
- `Swap` deltas are from the *swapper's* perspective (verified on live Base logs), the opposite sign of V3,
  so the decoder negates them. `ModifyLiquidity` has no amounts: `rangeAmounts()` derives them from
  `liquidity`, the tick range and the current price.
- Fixtures: `tests/fixtures/v4-logs.json` (real Base logs). Not yet soak-tested over a long live run.

## Invariants — do not break

1. **Events are facts, state is derived.** Every normalized event lands in `events` with `finalized` 0/1.
   `ChainState` has no I/O and is rebuildable by replaying finalized events (`restore`, `replay`).
2. **Unfinalized state is rewindable.** Every `ChainState` mutation pushes an undo closure tagged with its
   block; `rewindTo(block)` restores exact prior state (tested). Non-block facts (token metadata, funders,
   labels, smart-wallet set) enter only through setters.
3. **Pools are oriented once, against `chains.ts`.** `token` is the traded side, `quote` is a known
   quote token. Decoders never infer orientation from address order.
4. **Trades belong to signers.** Swaps are attributed to `tx.from` with its nonce, never to routers or recipients.
5. **Exchange/service funders never merge wallets.** Cluster keys stop at labeled CEX/bridges and at
   funders with ≥1000 txs.
6. **No alert without evidence.** Every signal carries the numbers that fired it; alerts need ≥2
   opportunity signals, the liquidity floor, and no critical risk. Alerts on unfinalized blocks are
   unconfirmed; reorgs retract them (and their positions) explicitly.
7. **Rules stay pure:** `(TokenMetrics, SignalsConfig) → Signal | null`. No state access, no I/O.
8. **USD values come from quote amounts** (stables = 1, wrapped native via the reference pool), so they
   never depend on token decimals. Returns are price ratios; decimals only affect display.
9. **Live startup never waits on history.** Sync resumes from the persisted finalized cursor only within
   the recovery window, else from the head. Recovery is best-effort: pruned or unservable ranges are skipped.
10. **New schema → new `migrations/NNNN_name.sql`;** never edit an applied migration.
11. **Outbound safety:** webhook targets reject private/loopback/metadata hosts and credentials; delivery
    refuses redirects and has timeouts.
12. **Dashboard exposure is deliberate:** bound to 127.0.0.1; with `ARGUS_DASHBOARD_TOKEN` set, all API and
    stream routes require Bearer/Basic or the HttpOnly session cookie.
13. **Failed event work is durable** in `failed_events`; successful application clears the row.
14. **Track records are durable projections:** `wallet_positions` takes finalized swaps only; `positions`
    (alerts + baseline) are a journal and survive restarts.

## Status

- [x] v2 ingestion: block-cursor sync, launch capture, reorgs, resume/rewind, provider failover
- [x] V2 + V3 + V4 decoding, ETH + Base, signer attribution, USD from on-chain reference pools (ETH, ZORA, VIRTUAL)
- [x] Market state, 5 opportunity + 6 risk signals, verdicts with explicit gates
- [x] Funder clustering (ETH via Etherscan; Base needs `BLOCKSCOUT_API_KEY`)
- [x] Paper-traded track record vs baseline; wallet track records; smart-money signal
- [x] Telegram + webhooks; React dashboard (opportunities, token, track record, activity, wallets, system)
- [x] Route-level code splitting for the dashboard (token and track-record views)
- [ ] V4/V3-aware pool discovery for hand-added `watchlist` tokens (`ingest/reads.ts` finds V2/V3 only)
- [ ] Base Flashblocks fast path (`pendingLogs` on `wss://mainnet-preconf.base.org`) for sub-block alerts
