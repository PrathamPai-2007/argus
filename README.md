# Argus

Argus watches every new Uniswap V2/V3 token on **Ethereum and Base** from its first block and tells you
which ones have real, independent demand — and which ones are rugs, honeypots or insider plays dressed up
as demand. It runs locally on free public RPC endpoints, alerts on a dashboard and Telegram, and
paper-trades every alert against a baseline so you can see whether it actually has an edge.

## Quick start

```bash
bun install
cp .env.example .env        # optional keys: Telegram, Etherscan, Blockscout, private RPCs
bun run doctor              # checks endpoints, keys and the database
bun run start               # engine + dashboard at http://127.0.0.1:3737
```

No keys are required: keyless PublicNode endpoints are configured with dRPC as fallback. Start with
`bun run src/index.ts run --rewind 2000` to catch up on recent launches before going live.

## How a token gets scored

Argus registers every pool a factory creates against WETH or a stablecoin, captures same-block snipes,
and attributes each trade to the wallet that signed it. Every block, touched tokens are re-assessed.

**Opportunity signals** (add points)

| Signal | Fires when |
|---|---|
| Organic demand | ≥12 independent buyers in 15 min (MEV and shared-funder wallets collapse to one), net inflow ≥ $5k, buy/sell ≥ 1.3 |
| Smart money | a wallet with ≥5 closed trades, ≥55% wins and positive realized PnL on watched tokens buys |
| Holder retention | ≥70% of the first 30 buyers still hold after 30 min |
| Liquidity growth | pool liquidity up ≥50% since launch with no removals |
| Momentum | 15-min volume ≥2.5× the prior window, ≥15 swaps, ≥8 traders, more buying than selling |

**Risk signals** (warn subtracts 15 points; critical vetoes)

| Signal | Critical when |
|---|---|
| Bundled launch | buyers in the first 3 blocks still hold ≥35% of supply |
| Cluster concentration | commonly-funded wallets hold ≥30% of supply |
| Liquidity pull | ≥50% of the pool removed in one transaction |
| Honeypot | ≥15 buyers and no successful sell from anyone but the creator |
| Insider dump | the creator has sold ≥60% of their position |
| Wash trading | (warn only) one wallet drives ≥40% of hourly volume |

A token alerts only when **two or more** opportunity signals agree, liquidity is at least $10k and no
critical risk is present. Score ≥60 is "worth a look", ≥80 "high conviction". If a critical risk appears on
a token that already alerted, Argus sends an **exit warning**. Every threshold is configurable under
`signals` in `argus.config.ts` (hot-reloaded).

## Does it work?

Every alert opens a paper position at the spot price; every liquid launch that never alerts opens a
**baseline** position. The Track record page compares their median returns at 15 minutes, 1 hour,
6 hours and 24 hours, the share that were up after an hour, and the share that ever doubled. Trust the
alerts only as far as that gap goes.

## Configuration notes

- **Clustering** needs first-funder lookups: Ethereum uses `ETHERSCAN_API_KEY` (free). Base needs a free
  `BLOCKSCOUT_API_KEY` — Etherscan's Base coverage is paid-only. Without it, Base still works but
  shared-funder signals are weaker (the dashboard shows funder coverage).
- **Telegram**: set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. Opportunity, exit, retraction and 24-hour
  result messages are sent.
- **Dashboard auth**: set `ARGUS_DASHBOARD_TOKEN`; the dashboard asks for it once and keeps a session cookie.
- **Webhooks**: `webhooks: [{ url, events: ["alert", "exit"], secret }]` — HMAC-signed JSON POSTs.
- **Replay**: `bun run replay --chain 1` re-scores stored events with the current config to tune thresholds.

## Limits

- Uniswap V4 is not decoded yet, and most Base launches (Clanker, Zora) now use V4.
- Free endpoints serve roughly the last 9k blocks of logs; older history needs a keyed archive RPC.
- Smart-money detection learns from tokens Argus watched, so it improves the longer it runs.

See `AGENTS.md` for architecture, invariants and contributor notes.
