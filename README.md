# Argus

Argus watches every new token launched on **Ethereum and Base** (Uniswap V2, V3 and V4) from its first
block and tells you which ones have real, independent demand, and which ones are rugs, honeypots or
insider plays dressed up as demand. It runs locally on free public RPC endpoints, alerts on a dashboard
and Telegram, and paper-trades every alert against a baseline so you can see whether it has an edge.

- **One process, one SQLite file.** Bun + TypeScript, no external services required.
- **Evidence, not vibes.** Every signal carries the numbers that fired it; every alert is journaled and scored later.
- **Honest scoreboard.** Alerts are compared with a baseline cohort of launches that never alerted.

## Quick start

```bash
bun install
cp .env.example .env        # everything is optional: Telegram, Etherscan, Blockscout, private RPCs
bun run doctor              # checks endpoints, explorer keys, Telegram and the database
bun run start               # engine + dashboard at http://127.0.0.1:3737
```

No keys are required: keyless PublicNode endpoints are configured with dRPC as a fallback. To catch up on
recent launches before going live:

```bash
bun run src/index.ts run --rewind 2000     # start 2000 blocks back, through the live code path
```

## What it covers

| | Ethereum | Base |
|---|---|---|
| Uniswap V2 / V3 | yes | yes |
| Uniswap V4 (PoolManager) | yes | yes |
| Quote tokens | WETH, native ETH, USDC, USDT, DAI | WETH, native ETH, USDC, ZORA, VIRTUAL |
| First-funder lookups | Etherscan (free key) | Blockscout PRO (free key) |

Most current Base launches (Clanker, Zora coins, Virtuals agents) are V4 pools or are quoted in ZORA or
VIRTUAL rather than ETH. Those are priced in USD from on-chain reference pools, so a trade's value never
depends on a third-party price API.

## How a token gets scored

Argus registers every pool a factory creates against a known quote token, captures same-block snipes, and
attributes each trade to the wallet that signed it (not the router). Every block, touched tokens are
re-assessed.

**Opportunity signals** (add points)

| Signal | Fires when |
|---|---|
| Organic demand | ≥12 independent buyers in 15 min (MEV and shared-funder wallets collapse to one), net inflow ≥ $5k, buy/sell ≥ 1.3 |
| Smart money | a wallet with ≥5 closed trades, ≥55% wins and positive realized PnL on watched tokens buys |
| Holder retention | ≥70% of the first 30 buyers still hold after 30 min |
| Liquidity growth | pool liquidity up ≥50% since launch with no removals |
| Momentum | 15-min volume ≥2.5× the prior window, ≥15 swaps, ≥8 traders, more buying than selling |

**Risk signals** (a warning subtracts 15 points; a critical risk vetoes)

| Signal | Critical when |
|---|---|
| Bundled launch | buyers in the first 3 blocks still hold ≥35% of supply |
| Cluster concentration | commonly-funded wallets hold ≥30% of supply |
| Liquidity pull | ≥50% of the pool removed in one transaction |
| Honeypot | ≥15 buyers and no successful sell from anyone but the creator |
| Insider dump | the creator has sold ≥60% of their position |
| Wash trading | (warn only) one wallet drives ≥40% of hourly volume |

**Verdicts:** `quiet` → `watch` → `alert` (score ≥60) → `high_conviction` (score ≥80), or `avoid` when a
critical risk is present. A token alerts only when **two or more** opportunity signals agree, liquidity is
at least $10k and no critical risk is present. If a critical risk appears on a token that already alerted,
Argus sends an **exit warning**; if a reorg removes the evidence, the alert is **retracted**.

Every threshold is configurable under `signals` in `argus.config.ts` and hot-reloads.

## Does it work?

Every alert opens a paper position at the spot price; every liquid launch that never alerts opens a
**baseline** position. The Track record page compares median returns at 15 minutes, 1 hour, 6 hours and
24 hours, the share that were up after an hour, and the share that ever doubled. Trust the alerts only as
far as that gap goes. Wallet track records are built the same way, from finalized swaps only.

## Dashboard

| Page | Shows |
|---|---|
| Opportunities | live-ranked tokens with score, verdict, liquidity, buyers, smart wallets and risk chips; `⌘K` search |
| Token | price chart with alert markers, score breakdown, signal timeline, risk checklist, funding graph |
| Track record | alerts vs baseline outcomes, hit rate by score |
| Activity | signal and alert feed |
| Wallets | smart-money leaderboard and per-wallet positions |
| System | chain heads, provider health, queue depth, funder coverage |

The dashboard binds to `127.0.0.1`. Set `ARGUS_DASHBOARD_TOKEN` to require a token (asked once, then kept
as a session cookie); API clients may send `Authorization: Bearer <token>`.

## Configuration

Secrets live in `.env` (see `.env.example`); behaviour lives in `argus.config.ts`, which supports
`${VAR}` and `${VAR:-default}` interpolation. An endpoint whose variable is unset is skipped.

| Variable | Purpose |
|---|---|
| `ETHERSCAN_API_KEY` | first-funder lookups on Ethereum (free) |
| `BLOCKSCOUT_API_KEY` | first-funder lookups on Base (free PRO key; Etherscan's Base access is paid-only) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Telegram delivery of alerts, exits, retractions and 24h results |
| `RPC_ETH_HTTP`, `RPC_ETH_WS`, `RPC_BASE_HTTP`, `RPC_BASE_WS` | preferred endpoints, tried before the public ones |
| `ARGUS_DASHBOARD_TOKEN` | dashboard / API auth |
| `ARGUS_LOG_LEVEL` | `debug`, `info`, `warn`, `error` |

Without a funder key, Ethereum or Base still work but shared-funder (cluster) signals are weaker; the System
page shows funder coverage. `bun run doctor` reports exactly which keys are missing.

Other config blocks: `watchlist` (tokens watched forever), `discovery` (watch windows and caps), `signals`
(any threshold), `smartMoney`, `alerts` (cooldown, rescore delta, hourly cap), and `webhooks`
(`{ url, events: ["alert", "exit"], secret }`, HMAC-signed JSON POSTs; private and loopback targets rejected).

## Commands

```bash
bun test                                  # unit + integration tests (in-memory SQLite, fake chains)
bun run typecheck                         # strict tsc
bun run doctor                            # environment and endpoint check
bun run replay --chain 8453               # re-score stored events with the current config; tune thresholds offline
bun run dev                               # hot-reloading engine
```

## Limits

- Free endpoints serve roughly the last 9k blocks of logs; older history needs a keyed archive RPC.
  Pruned ranges are skipped, not retried.
- Pool discovery for tokens added by hand to `watchlist` covers V2 and V3 only; launches seen live are
  captured on all three versions.
- Alerts arrive per block (about 12 s on Ethereum, 2 s on Base). A sub-block Base fast path via Flashblocks
  is not built.
- Smart-money detection learns from tokens Argus watched, so it improves the longer it runs.
- Paper returns use pool price, not executable price: they ignore slippage, gas and MEV.

See [`AGENTS.md`](AGENTS.md) for architecture, invariants and contributor notes.
