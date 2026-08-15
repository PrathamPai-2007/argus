import { loadConfig } from "../config.ts";
import * as db from "../db.ts";
import { GraphEngine, DEFAULT_GRAPH_TUNING } from "../graph/engine.ts";
import { applyPreset, type PresetName } from "../presets.ts";
import { RULES } from "../rules/index.ts";
import { seedLabels } from "../seeds.ts";
import { PERFORMANCE_STOP_BPS, PERFORMANCE_TARGET_BPS, PERFORMANCE_WINDOW_SECS, priceFromSwap, thresholds, updateSession, type PerformanceSession } from "../performance.ts";
import type { RuleId, Signal, SwapEvent } from "../types.ts";

// `replay` — offline backtest / threshold tuning (PLAN.md §10, Phase 5).
// Replays recorded events through a FRESH graph + rules. Writes nothing:
// no signals, no alerts, no Telegram — prints what would have fired, plus
// per-rule fire stats and suggested thresholds.

export interface ReplayArgs {
  chainId: number;
  from: number;
  to: number;
  token?: string;
  preset?: string;
  configPath?: string;
}

interface RuleStats {
  fires: number;
  values: number[];
}

export async function runReplay(args: ReplayArgs): Promise<number> {
  const cfg = await loadConfig(args.configPath);
  db.openDb(cfg.dbPath);
  seedLabels([args.chainId]);

  const preset = (args.preset ?? "default") as PresetName;
  applyPreset(cfg, preset);
  console.log(`preset: ${preset} (R1 ${cfg.rules.R1.supplyPct}%, R2 ${cfg.rules.R2.volumeSpikePct}%, R4 warn ${cfg.rules.R4.warnPct}%, R5 ${cfg.rules.R5.minBuyers}, R8 ${cfg.rules.R8.minWallets})`);

  const events = db.loadEvents(args.chainId, args.from, args.to, { finalizedOnly: true });
  console.log(`replaying ${events.length} finalized events on chain ${args.chainId} blocks [${args.from}..${args.to}]`);

  const graph = new GraphEngine(DEFAULT_GRAPH_TUNING);
  graph.setLabels(db.loadLabels(args.chainId));
  for (const t of db.listWatchedTokens(args.chainId, Math.floor(Date.now() / 1000) + 10 * 365 * 86_400)) {
    if (t.totalSupply !== null) graph.setTotalSupply(t.address, t.totalSupply);
  }
  for (const p of db.listPools(args.chainId)) {
    graph.registerPool(p.poolAddress, p.createdBlock, p.createdTs ?? undefined);
  }

  const signals: Signal[] = [];
  const stats = new Map<string, RuleStats>();
  const bestWeights = new Map<string, Map<string, number>>();
  const watches = new Map<string, PerformanceSession>();
  const outcomes = new Map<string, number>();
  let applied = 0;
  for (const evt of events) {
    graph.applyEvent(evt);
    applied++;
    if (evt.kind === "swap") {
      const watch = watches.get(evt.tokenAddress);
      const price = priceFromSwap(evt);
      if (watch && price !== null && watch.pool_address === evt.poolAddress) {
        const result = updateSession(watch, price, evt.timestamp);
        watch.current_price = result.currentPrice;
        watch.min_price = result.minPrice;
        watch.max_price = result.maxPrice;
        watch.last_block = evt.blockNumber;
        watch.outcome = result.outcome;
        if (result.closedAt !== null) {
          watch.closed_at = result.closedAt;
          outcomes.set(result.outcome, (outcomes.get(result.outcome) ?? 0) + 1);
        }
      }
    }
    if (evt.kind !== "transfer" && evt.kind !== "swap") continue;
    if (args.token && evt.tokenAddress !== args.token.toLowerCase()) continue;
    for (const [id, rule] of Object.entries(RULES)) {
      const ruleCfg = cfg.rules[id as keyof typeof cfg.rules];
      if (!ruleCfg?.enabled) continue;
      const s = rule(evt, graph, cfg.rules);
      if (s) {
        signals.push(s);
        const st = stats.get(id) ?? { fires: 0, values: [] };
        st.fires++;
        const v = signalValue(s);
        if (v !== null) st.values.push(v);
        stats.set(id, st);
        const weights = bestWeights.get(s.tokenAddress) ?? new Map<string, number>();
        weights.set(s.ruleId, Math.max(weights.get(s.ruleId) ?? 0, s.weight));
        bestWeights.set(s.tokenAddress, weights);
        if (evt.kind === "swap" && !watches.has(s.tokenAddress)) {
          const score = Math.min(100, [...weights.values()].reduce((a, b) => a + b, 0));
          if (score >= cfg.scoring.info) openReplayWatch(watches, s.tokenAddress, evt, score);
        }
        console.log(`  [block ${evt.blockNumber}] ${s.ruleId} w=${s.weight} ${JSON.stringify(s.evidence).slice(0, 220)}`);
      }
    }
  }

  for (const watch of watches.values()) {
    if (watch.outcome === "active") {
      watch.outcome = "expired";
      watch.closed_at = watch.expires_at;
      outcomes.set("expired", (outcomes.get("expired") ?? 0) + 1);
    }
  }

  const tokens = args.token ? [args.token.toLowerCase()] : [...new Set(signals.map((s) => s.tokenAddress))];
  console.log(`\napplied ${applied} events; ${signals.length} raw signal(s)`);
  if (watches.size > 0) {
    console.log(`\n--- alert performance (${PERFORMANCE_WINDOW_SECS / 3600}h, +${(PERFORMANCE_TARGET_BPS - 10_000) / 100}% / -${(10_000 - PERFORMANCE_STOP_BPS) / 100}%) ---`);
    console.log(`  sessions: ${watches.size} | targets: ${outcomes.get("target_hit") ?? 0} | stops: ${outcomes.get("stop_hit") ?? 0} | expired: ${outcomes.get("expired") ?? 0}`);
  }
  for (const token of tokens) {
    const tokenSignals = signals.filter((s) => s.tokenAddress === token);
    if (tokenSignals.length === 0) continue;
    // offline scoring: best weight per rule over the whole replay (no DB writes)
    const best = new Map<string, number>();
    for (const s of tokenSignals) best.set(s.ruleId, Math.max(best.get(s.ruleId) ?? 0, s.weight));
    const score = Math.min(100, [...best.values()].reduce((a, b) => a + b, 0));
    console.log(`\n${token}: score ${score}/100 (rules: ${[...best.keys()].join(", ")})`);
    const severity = score >= cfg.scoring.critical ? "critical" : score >= cfg.scoring.alert ? "alert" : score >= cfg.scoring.info ? "info" : "none";
    console.log(`  severity: ${severity}`);
  }

  // per-rule tuning summary (Phase 5)
  if (stats.size > 0) {
    console.log("\n--- per-rule fire stats (evidence value distribution) ---");
    for (const [id, st] of [...stats.entries()].sort((a, b) => b[1].fires - a[1].fires)) {
      const v = [...st.values].sort((a, b) => a - b);
      const pct = (q: number) => v[Math.min(v.length - 1, Math.floor(v.length * q))]!;
      const line =
        v.length > 0 ? `values: min=${v[0]!.toFixed(2)} p25=${pct(0.25).toFixed(2)} med=${pct(0.5).toFixed(2)} p75=${pct(0.75).toFixed(2)} max=${v[v.length - 1]!.toFixed(2)}` : "no numeric evidence";
      console.log(`  ${id}: ${st.fires} fire(s) | ${line}`);
    }
    console.log("\nsuggestion: raise thresholds to ~p75 to cut noise, or drop to p25 to catch earlier (see presets).");
  }
  db.closeDb();
  return 0;
}

function openReplayWatch(watches: Map<string, PerformanceSession>, token: string, evt: SwapEvent, _score: number): void {
  const entryPrice = priceFromSwap(evt);
  if (entryPrice === null) return;
  const { targetPrice, stopPrice } = thresholds(entryPrice);
  watches.set(token, {
    id: 0,
    alert_id: 0,
    chain_id: evt.chainId,
    token_address: token,
    pool_address: evt.poolAddress,
    quote_token: null,
    entry_price: entryPrice,
    current_price: entryPrice,
    target_price: targetPrice,
    stop_price: stopPrice,
    opened_at: evt.timestamp,
    expires_at: evt.timestamp + PERFORMANCE_WINDOW_SECS,
    closed_at: null,
    outcome: "active",
    entry_block: evt.blockNumber,
    last_block: evt.blockNumber,
    min_price: entryPrice,
    max_price: entryPrice,
    updated_at: evt.timestamp,
  });
}

function signalValue(s: Signal): number | null {
  const e = s.evidence;
  const v =
    e["freshWalletPct"] ??
    e["pctOfSupply"] ??
    e["clusterPctOfSupply"] ??
    e["recipientCount"] ??
    e["freshBuyerCount"] ??
    e["walletCount"] ??
    e["spikePct"] ??
    e["lockedPct"];
  return typeof v === "number" ? v : null;
}
