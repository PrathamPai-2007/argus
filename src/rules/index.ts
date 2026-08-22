import type { RulesConfig } from "../config.ts";
import type { GraphEngine } from "../graph/engine.ts";
import type { Address, Signal, StandardEvent, StandardTransferEvent, SwapEvent } from "../types.ts";
import { DEAD_ADDRESSES, ZERO_ADDRESS } from "../types.ts";

// Heuristics (PLAN.md §7). Each rule is a PURE function:
//   (event, graphView, config) → Signal | null
// Rules never mutate graph state; dedup/cooldown live in the alert layer.

export type RuleFn = (evt: StandardEvent, view: GraphEngine, cfg: RulesConfig) => Signal | null;

function pct(amount: bigint, circ: bigint): number {
  return circ > 0n ? Number((amount * 10_000n) / circ) / 100 : 0;
}

function lpIsPool(view: GraphEngine, token: Address): boolean {
  return view.isPool(token);
}

/** R1 — fresh-wallet accumulation: >supplyPct% of supply bought by wallets <walletAgeDays old within windowHours. */
export const R1: RuleFn = (evt, view, cfg) => {
  const c = cfg.R1;
  if (!c.enabled || evt.kind !== "transfer") return null;
  const t = evt as StandardTransferEvent;
  if (t.receiver === ZERO_ADDRESS || view.isInfra(t.receiver) || lpIsPool(view, t.tokenAddress)) return null;
  const circ = view.circulatingSupply(t.tokenAddress);
  if (circ === null || circ <= 0n) return null;
  const windowStart = t.timestamp - c.windowHours * 3600;
  const acc = view.freshAccumulation(t.tokenAddress, windowStart, t.timestamp, c.walletAgeDays);
  const p = pct(acc.amount, circ);
  if (p < c.supplyPct) return null;
  return {
    chainId: t.chainId,
    tokenAddress: t.tokenAddress,
    ruleId: "R1",
    weight: c.weight,
    blockNumber: t.blockNumber,
    timestamp: t.timestamp,
    evidence: {
      freshWalletPct: round2(p),
      windowHours: c.windowHours,
      walletAgeDays: c.walletAgeDays,
      freshWalletCount: acc.wallets.length,
      topWallets: topEntries(acc.perWallet, circ, 10),
    },
  };
};

/** R2 — volume spike vs prior window (Swap events, PLAN.md §7). Buy/sell volume
 *  in the current window is compared to the preceding window of equal length.
 *  A spike >= volumeSpikePct on either direction flags anomalous activity. */
export const R2: RuleFn = (evt, view, cfg) => {
  const c = cfg.R2;
  if (!c.enabled || evt.kind !== "swap") return null;
  const s = evt as SwapEvent;
  const windowSecs = c.windowMinutes * 60;
  const now = s.timestamp;
  const cur = view.swapVolumeBetween(s.tokenAddress, now - windowSecs, now + 1);
  const prev = view.swapVolumeBetween(s.tokenAddress, now - 2 * windowSecs, now - windowSecs);
  const curTot = cur.buy + cur.sell;
  const prevTot = prev.buy + prev.sell;
  if (prevTot <= 0n) return null; // no baseline yet
  const spikePct = Number((curTot * 10_000n) / prevTot) / 100 - 100;
  if (spikePct < c.volumeSpikePct) return null;
  return {
    chainId: s.chainId,
    tokenAddress: s.tokenAddress,
    ruleId: "R2",
    weight: c.weight,
    blockNumber: s.blockNumber,
    timestamp: s.timestamp,
    evidence: {
      pool: s.poolAddress,
      windowMinutes: c.windowMinutes,
      spikePct: round2(spikePct),
      thresholdPct: c.volumeSpikePct,
      currentVolume: curTot.toString(),
      priorVolume: prevTot.toString(),
      currentBuy: cur.buy.toString(),
      currentSell: cur.sell.toString(),
    },
  };
};

/** R3 — sybil fan-out: central wallet sends identical token amounts to >minRecipients sub-wallets in windowMinutes. */
export const R3: RuleFn = (evt, view, cfg) => {
  const c = cfg.R3;
  if (!c.enabled || evt.kind !== "transfer") return null;
  const t = evt as StandardTransferEvent;
  if (view.isInfra(t.sender) || lpIsPool(view, t.tokenAddress)) return null;
  const recent = view.recentFanout(t.sender, t.tokenAddress, t.amount, c.windowMinutes * 60, t.timestamp);
  const receivers = [...new Set(recent.map((s) => s.to))].filter((a) => !view.isInfra(a));
  if (receivers.length < c.minRecipients) return null;
  return {
    chainId: t.chainId,
    tokenAddress: t.tokenAddress,
    ruleId: "R3",
    weight: c.weight,
    blockNumber: t.blockNumber,
    timestamp: t.timestamp,
    evidence: {
      sender: t.sender,
      identicalAmount: t.amount.toString(),
      recipientCount: receivers.length,
      recipients: receivers.slice(0, 25),
      windowMinutes: c.windowMinutes,
    },
  };
};

/** R4 — cluster concentration: one cluster holds >warnPct% (weight) or >critPct% (critWeight) of supply. */
export const R4: RuleFn = (evt, view, cfg) => {
  const c = cfg.R4;
  if (!c.enabled || evt.kind !== "transfer") return null;
  const t = evt as StandardTransferEvent;
  if (lpIsPool(view, t.tokenAddress)) return null;
  const breakdown = view.clusterBreakdown(t.tokenAddress);
  const top = breakdown.find((b) => b.memberCount > 1);
  if (!top || top.pctOfSupply < c.warnPct) return null;
  const crit = top.pctOfSupply >= c.critPct;
  return {
    chainId: t.chainId,
    tokenAddress: t.tokenAddress,
    ruleId: "R4",
    weight: crit ? c.critWeight : c.weight,
    blockNumber: t.blockNumber,
    timestamp: t.timestamp,
    evidence: {
      clusterId: top.clusterId,
      memberCount: top.memberCount,
      pctOfSupply: round2(top.pctOfSupply),
      threshold: crit ? c.critPct : c.warnPct,
      members: top.members.slice(0, 25),
    },
  };
};

/** R5 — bundled same-block buys: ≥minBuyers fresh wallets receive the token in the same block. */
export const R5: RuleFn = (evt, view, cfg) => {
  const c = cfg.R5;
  if (!c.enabled || evt.kind !== "transfer") return null;
  const t = evt as StandardTransferEvent;
  if (lpIsPool(view, t.tokenAddress)) return null;
  const receivers = view.freshReceiversInBlock(t.tokenAddress, t.blockNumber, t.timestamp, c.walletAgeDays);
  if (receivers.length < c.minBuyers) return null;
  return {
    chainId: t.chainId,
    tokenAddress: t.tokenAddress,
    ruleId: "R5",
    weight: c.weight,
    blockNumber: t.blockNumber,
    timestamp: t.timestamp,
    evidence: { block: t.blockNumber, freshBuyerCount: receivers.length, buyers: receivers.slice(0, 25) },
  };
};

/** R6 — deployer linkage: accumulating cluster is funded (≤maxHops) by the token deployer. */
export const R6: RuleFn = (evt, view, cfg) => {
  const c = cfg.R6;
  if (!c.enabled || evt.kind !== "transfer") return null;
  const t = evt as StandardTransferEvent;
  if (lpIsPool(view, t.tokenAddress)) return null;
  const deployer = view.deployerOf(t.tokenAddress);
  if (!deployer) return null;
  const circ = view.circulatingSupply(t.tokenAddress);
  if (circ === null || circ <= 0n) return null;

  // check the cluster of the receiver (or the receiver alone)
  const members = view.clusterOf(t.receiver);
  const targets = members.length > 0 ? members : [t.receiver];
  const linked: Address[] = [];
  for (const m of targets) {
    const chain = view.funderChain(m, c.maxHops);
    if (chain.includes(deployer)) linked.push(m);
  }
  if (linked.length === 0) return null;
  const clusterBalance = targets.reduce((acc, m) => acc + view.balanceOf(t.tokenAddress, m), 0n);
  const p = pct(clusterBalance, circ);
  if (p < c.minClusterPct) return null;
  return {
    chainId: t.chainId,
    tokenAddress: t.tokenAddress,
    ruleId: "R6",
    weight: c.weight,
    blockNumber: t.blockNumber,
    timestamp: t.timestamp,
    evidence: {
      deployer,
      linkedWallets: linked,
      linkedCount: linked.length,
      clusterSize: targets.length,
      clusterPctOfSupply: round2(p),
      maxHops: c.maxHops,
    },
  };
};

/**
 * R7 — LP-lock safety. Fires when less than minLockedPct of a pool's LP token
 * supply has been burned to a dead address. A pool with little permanently
 * locked liquidity is a liquidity-exit (rug) risk once it has been live for
 * minPoolAgeHours. PURE: reads graph lp-status after the burn was applied.
 */
export const R7: RuleFn = (evt, view, cfg) => {
  const c = cfg.R7;
  if (!c.enabled || evt.kind !== "transfer") return null;
  const t = evt as StandardTransferEvent;
  if (!lpIsPool(view, t.tokenAddress)) return null;
  if (!DEAD_ADDRESSES.has(t.receiver)) return null; // only LP burns matter
  const lp = view.lpStatus(t.tokenAddress);
  if (!lp || lp.lpMinted <= 0n || lp.createdTs <= 0) return null;
  const ageHours = (t.timestamp - lp.createdTs) / 3600;
  if (ageHours < c.minPoolAgeHours) return null;
   const lockedPct = Number((lp.lpBurned * 10_000n) / lp.lpMinted) / 100;
  if (lockedPct >= c.minLockedPct) return null;
  return {
    chainId: t.chainId,
    tokenAddress: t.tokenAddress,
    ruleId: "R7",
    weight: c.weight,
    blockNumber: t.blockNumber,
    timestamp: t.timestamp,
    evidence: {
      pool: t.tokenAddress,
      poolAgeHours: round2(ageHours),
      minPoolAgeHours: c.minPoolAgeHours,
      lpMinted: lp.lpMinted.toString(),
      lpBurned: lp.lpBurned.toString(),
      lockedPct: round2(lockedPct),
      minLockedPct: c.minLockedPct,
    },
  };
};

/** R8 — exchange fan-out: N wallets funded same-size from the same CEX hot wallet within windowMinutes. */
export const R8: RuleFn = (evt, view, cfg) => {
  const c = cfg.R8;
  if (!c.enabled || evt.kind !== "transfer") return null;
  const t = evt as StandardTransferEvent;
  if (lpIsPool(view, t.tokenAddress)) return null;
  const funding = view.exchangeFundingOf(t.receiver);
  if (!funding) return null;
  const group = view.exchangeFanout(funding.funder, funding.amount, c.windowMinutes * 60, t.timestamp);
  const wallets = [...new Set(group.map((g) => g.funded))].filter((a) => !view.isInfra(a));
  if (!wallets.includes(t.receiver) || wallets.length < c.minWallets) return null;
  return {
    chainId: t.chainId,
    tokenAddress: t.tokenAddress,
    ruleId: "R8",
    weight: c.weight,
    blockNumber: t.blockNumber,
    timestamp: t.timestamp,
    evidence: {
      exchangeFunder: funding.funder,
      exchangeLabel: view.labelOf(funding.funder)?.label ?? "cex",
      identicalAmount: funding.amount.toString(),
      walletCount: wallets.length,
      wallets: wallets.slice(0, 25),
      windowMinutes: c.windowMinutes,
    },
  };
};

export const RULES: Record<string, RuleFn> = { R1, R2, R3, R4, R5, R6, R7, R8 };

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function topEntries(perWallet: Map<string, bigint>, circ: bigint, n: number): { address: string; pct: number }[] {
  return [...perWallet.entries()]
    .sort((a, b) => (b[1] > a[1] ? 1 : -1))
    .slice(0, n)
    .map(([address, amount]) => ({ address, pct: round2(pct(amount, circ)) }));
}
