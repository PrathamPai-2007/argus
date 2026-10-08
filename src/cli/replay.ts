import { chainInfo, priceRefPool } from "../chains.ts";
import { loadConfig } from "../config.ts";
import * as db from "../db.ts";
import type { Address } from "../model.ts";
import { assess, type Verdict } from "../signals.ts";
import { ChainState } from "../state.ts";

// `replay` — offline re-scoring of stored events with the current config.
// Writes nothing. Use it to tune signal thresholds before going live.

export interface ReplayArgs {
  chainId: number;
  from?: number;
  to?: number;
  configPath?: string;
}

export async function runReplay(args: ReplayArgs): Promise<number> {
  const cfg = await loadConfig(args.configPath);
  db.openDb(cfg.dbPath);
  const info = chainInfo(args.chainId);
  const state = new ChainState(args.chainId);
  const labels = db.loadLabels(args.chainId);
  state.setServiceLabels(new Map([...labels].filter(([, l]) => ["cex", "router", "bridge"].includes(l.kind)).map(([a, l]) => [a, l.label])));
  for (const f of db.loadFunding(args.chainId)) state.setFunding(f.wallet, { funder: f.funder, funderIsService: f.funderIsService });
  state.setSmartWallets(db.smartWallets(args.chainId, cfg.smartMoney));
  for (const r of info.priceRefs) state.registerPool(priceRefPool(r));
  for (const p of db.listPools(args.chainId)) state.registerPool(p, p.createdBlock);
  for (const t of db.listWatchedTokens(args.chainId, 0)) state.setTokenMeta(t.address, { symbol: t.symbol, name: t.name, decimals: t.decimals, totalSupply: t.totalSupply });

  const events = db.loadEvents(args.chainId, { ...(args.from !== undefined ? { fromBlock: args.from } : {}), ...(args.to !== undefined ? { toBlock: args.to } : {}) });
  console.log(`replaying ${events.length} events on ${info.name}${args.from ? ` from ${args.from}` : ""}${args.to ? ` to ${args.to}` : ""}`);

  const verdicts = new Map<Verdict, number>();
  const fired = new Map<string, number>();
  const best = new Map<Address, { score: number; verdict: Verdict; signals: string[]; block: number }>();
  let block = -1;
  const touched = new Set<Address>();
  const flush = (now: number) => {
    for (const token of touched) {
      const m = state.metrics(token, now);
      if (!m) continue;
      const a = assess(m, cfg.signals);
      verdicts.set(a.verdict, (verdicts.get(a.verdict) ?? 0) + 1);
      for (const s of a.signals) fired.set(s.id, (fired.get(s.id) ?? 0) + 1);
      const prev = best.get(token);
      if (!prev || a.score > prev.score) best.set(token, { score: a.score, verdict: a.verdict, signals: a.signals.map((s) => s.id), block });
    }
    touched.clear();
  };
  let lastTs = 0;
  for (const e of events) {
    if (e.blockNumber !== block) {
      flush(lastTs);
      block = e.blockNumber;
    }
    state.apply(e);
    lastTs = e.timestamp;
    if ((e.kind === "swap" || e.kind === "transfer" || e.kind === "liquidity" || e.kind === "reserves") && !info.priceRefs.some((r) => r.base === e.token)) touched.add(e.token);
  }
  flush(lastTs);

  console.log("\nassessments by verdict:", Object.fromEntries(verdicts));
  console.log("signal activations:", Object.fromEntries([...fired].sort((a, b) => b[1] - a[1])));
  const top = [...best].filter(([, b]) => b.verdict === "alert" || b.verdict === "high_conviction").sort((a, b) => b[1].score - a[1].score);
  console.log(`\n${top.length} token(s) would have alerted:`);
  for (const [token, b] of top.slice(0, 30)) {
    console.log(`  ${state.tokenMeta(token)?.symbol ?? token.slice(0, 10)} ${token} · ${b.verdict} ${b.score} at block ${b.block} · ${b.signals.join(", ")}`);
  }
  db.closeDb();
  return 0;
}
