# Quality-Driven Token Discovery

Argus is token-first by design. It does not attempt to observe every wallet on
Ethereum. Instead, it finds a bounded set of token candidates, examines the
wallets entering those tokens, and promotes only tokens with useful evidence.

## Why volume is insufficient

Gross DEX volume includes market makers, arbitrage, bots, recycled capital, and
wash trading. It is useful for finding activity, but it is not evidence of
conviction. Argus therefore treats volume as a candidate-source and a capped
score component, never as a promotion decision.

## Lifecycle

```text
discovered -> evaluating -> promoted
                       \-> rejected / expired
```

Candidates are stored in `token_candidates`. A matching `tokens` row has source
`candidate`, which explicitly excludes it from live subscriptions and alert
rules. Promotion changes that source to `ranked` or `factory` and refreshes the
adapter subscription.

## Candidate sources

- Factory `PairCreated` events identify new pools early. Their candidates are evaluated once market metadata is available.
- DexScreener stablecoin-quoted pairs identify active markets.
- Manual watchlist entries bypass candidate evaluation and remain permanent.
- Alerted tokens remain active according to the existing alert lifecycle.

The current DexScreener integration is a bounded source, not a global market
firehose. `maxCandidatesPerCycle` limits how many results can enter evaluation.

## Promotion evidence

The score in `src/candidates.ts` combines:

- Liquidity quality: logarithmic, so very large pools do not dominate.
- Volume: capped contribution, 10% of the score.
- Early buyers: wallets that entered during the evaluation window.
- Retention: early buyers that still hold a positive balance.
- Independence: distinct direct funding groups plus unfunded wallets.
- Pool age: newer pools receive a bounded early-discovery bonus.
- Penalties: exchange-funded buyers and common-funder concentration.

Hard gates require minimum liquidity, minimum independent buyers, and a maximum
common-funder ratio. A token cannot pass by having high volume alone.

## Current limits

The first implementation uses behavioral evidence from the current process and
targeted backfill. It does not claim realized PnL or permanent smart-wallet
reputation. This is intentional: PnL requires durable entry/exit accounting,
pricing normalization, and careful reorg handling.

The next reputation phase can add finalized wallet-token outcome records, but
those records must remain recomputable from event facts and must not turn a
single lucky trade into a trusted-wallet classification.

## Provider budget

Candidate evaluation reuses the existing serialized enrichment queue and
Etherscan rate limiter. Candidates are evaluated only after cheap market
metadata is available, and they expire after `candidateTtlHours`. Small reorg
gaps continue to use RPC; Etherscan remains a targeted historical provider.

Operationally, monitor:

- candidate count by status;
- promotion and rejection reasons;
- independent-buyer and common-funder evidence;
- enrichment queue depth;
- Etherscan requests and rate-limit retries.

The dashboard `/api/metrics` endpoint exposes the complete funnel: discovered,
evaluated, eligible, promoted, rejected, expired, promotion rate, evaluation
completion rate, and rejection reasons. A zero-promotion period is actionable
only after checking provider health and evaluation completion first.

## Tuning workflow

1. Run Argus with the default candidate settings.
2. Inspect `/api/candidates` and compare promoted versus rejected evidence.
3. Use replay fixtures to test threshold changes before lowering `promotionScore`.
4. Lower liquidity or buyer thresholds only when provider budget and false-positive rates are understood.
5. Add realized outcome learning only after enough candidate outcomes are persisted.
