import type { Address } from "./model.ts";
import type { TokenMetrics } from "./state.ts";

// Signal catalog. Every rule is a pure function (metrics, config) → Signal | null
// (invariant 5): no I/O, no state. Opportunity rules add to the score; risk
// rules subtract (warn) or veto outright (critical). Each signal carries the
// exact numbers that triggered it (invariant 4: no alert without evidence).

export type SignalId =
  | "organic_demand" | "smart_money" | "holder_retention" | "liquidity_growth" | "momentum"
  | "bundled_launch" | "cluster_concentration" | "liquidity_pull" | "honeypot" | "insider_dump" | "wash_trading";

export type SignalKind = "opportunity" | "risk";
export type SignalSeverity = "info" | "warn" | "critical";

export interface Signal {
  id: SignalId;
  kind: SignalKind;
  severity: SignalSeverity;
  /** Points contributed to (opportunity) or removed from (risk) the score. */
  points: number;
  title: string;
  evidence: Record<string, number | string | boolean | string[] | null>;
}

export interface SignalsConfig {
  minLiquidityUsd: number;
  alertScore: number;
  highConvictionScore: number;
  minOpportunitySignals: number;
  warnPenalty: number;
  organic: { minBuyers: number; minNetBuyUsd: number; minBuySellRatio: number; weight: number };
  smartMoney: { minWallets: number; strongWallets: number; weight: number };
  retention: { minEarlyBuyers: number; minHoldingPct: number; minAgeMin: number; weight: number };
  liquidityGrowth: { minGrowthPct: number; weight: number };
  momentum: { minSwaps: number; minTraders: number; minVolumeUsd: number; minGrowthX: number; weight: number };
  bundledLaunch: { warnSupplyPct: number; critSupplyPct: number; minClusterWallets: number };
  concentration: { warnPct: number; critPct: number };
  liquidityPull: { warnFraction: number; critFraction: number };
  honeypot: { minBuyers: number; minAgeMin: number };
  insiderDump: { warnSoldPct: number; critSoldPct: number };
  wash: { maxTopTraderShare: number; minVolumeUsd: number };
}

export const DEFAULT_SIGNALS: SignalsConfig = {
  minLiquidityUsd: 10_000,
  alertScore: 60,
  highConvictionScore: 80,
  minOpportunitySignals: 2,
  warnPenalty: 15,
  organic: { minBuyers: 12, minNetBuyUsd: 5_000, minBuySellRatio: 1.3, weight: 30 },
  smartMoney: { minWallets: 1, strongWallets: 3, weight: 35 },
  retention: { minEarlyBuyers: 15, minHoldingPct: 70, minAgeMin: 30, weight: 20 },
  liquidityGrowth: { minGrowthPct: 50, weight: 15 },
  momentum: { minSwaps: 15, minTraders: 8, minVolumeUsd: 10_000, minGrowthX: 2.5, weight: 20 },
  bundledLaunch: { warnSupplyPct: 15, critSupplyPct: 35, minClusterWallets: 3 },
  concentration: { warnPct: 15, critPct: 30 },
  liquidityPull: { warnFraction: 0.25, critFraction: 0.5 },
  honeypot: { minBuyers: 15, minAgeMin: 10 },
  insiderDump: { warnSoldPct: 25, critSoldPct: 60 },
  wash: { maxTopTraderShare: 0.4, minVolumeUsd: 5_000 },
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const usd = (n: number) => `$${n >= 1_000_000 ? `${r2(n / 1_000_000)}M` : n >= 1_000 ? `${r2(n / 1_000)}k` : Math.round(n)}`;

/** Weight scaled by how far a value clears its threshold: half at the bar, full at 2×. */
function scaled(weight: number, value: number, threshold: number): number {
  if (threshold <= 0) return weight;
  return Math.round(weight * Math.min(1, 0.5 + 0.5 * Math.max(0, value / threshold - 1)));
}

type Rule = (m: TokenMetrics, c: SignalsConfig) => Signal | null;

// ---- opportunity ----------------------------------------------------------------------

export const organicDemand: Rule = (m, c) => {
  const w = m.w15m;
  const net = w.buyUsd - w.sellUsd;
  const ratio = w.sellUsd > 0 ? w.buyUsd / w.sellUsd : w.buyUsd > 0 ? Infinity : 0;
  if (w.organicBuyers < c.organic.minBuyers || net < c.organic.minNetBuyUsd || ratio < c.organic.minBuySellRatio) return null;
  return {
    id: "organic_demand", kind: "opportunity", severity: "info",
    points: scaled(c.organic.weight, w.organicBuyers, c.organic.minBuyers),
    title: `${w.organicBuyers} independent buyers, ${usd(net)} net inflow in 15m`,
    evidence: { independentBuyers: w.organicBuyers, buyers: w.buyers, netBuyUsd: Math.round(net), buyUsd: Math.round(w.buyUsd), sellUsd: Math.round(w.sellUsd), buySellRatio: Number.isFinite(ratio) ? r2(ratio) : null, freshBuyers: w.freshBuyers },
  };
};

export const smartMoney: Rule = (m, c) => {
  const n = m.smartBuyers.length;
  if (n < c.smartMoney.minWallets) return null;
  return {
    id: "smart_money", kind: "opportunity", severity: "info",
    points: n >= c.smartMoney.strongWallets ? c.smartMoney.weight : scaled(c.smartMoney.weight, n, c.smartMoney.minWallets) ,
    title: `${n} proven wallet${n === 1 ? "" : "s"} bought in the last hour`,
    evidence: { smartWallets: n, wallets: m.smartBuyers.slice(0, 10) },
  };
};

export const holderRetention: Rule = (m, c) => {
  if (m.ageSec < c.retention.minAgeMin * 60 || m.earlyBuyers < c.retention.minEarlyBuyers) return null;
  const pct = (m.earlyBuyersHolding / m.earlyBuyers) * 100;
  if (pct < c.retention.minHoldingPct) return null;
  return {
    id: "holder_retention", kind: "opportunity", severity: "info",
    points: scaled(c.retention.weight, pct, c.retention.minHoldingPct),
    title: `${Math.round(pct)}% of the first ${m.earlyBuyers} buyers still hold`,
    evidence: { earlyBuyers: m.earlyBuyers, stillHolding: m.earlyBuyersHolding, holdingPct: r2(pct), ageMin: Math.round(m.ageSec / 60) },
  };
};

export const liquidityGrowth: Rule = (m, c) => {
  if (m.initialLiquidityUsd === null || m.initialLiquidityUsd <= 0 || m.maxRemovalFraction > 0.05) return null;
  const growth = (m.liquidityUsd / m.initialLiquidityUsd - 1) * 100;
  if (growth < c.liquidityGrowth.minGrowthPct || m.liquidityUsd < c.minLiquidityUsd) return null;
  return {
    id: "liquidity_growth", kind: "opportunity", severity: "info",
    points: scaled(c.liquidityGrowth.weight, growth, c.liquidityGrowth.minGrowthPct),
    title: `Liquidity up ${Math.round(growth)}% to ${usd(m.liquidityUsd)}`,
    evidence: { liquidityUsd: Math.round(m.liquidityUsd), initialLiquidityUsd: Math.round(m.initialLiquidityUsd), growthPct: r2(growth) },
  };
};

export const momentum: Rule = (m, c) => {
  const cur = m.w15m;
  const prev = m.prev15m;
  const vol = cur.buyUsd + cur.sellUsd;
  if (cur.buys + cur.sells < c.momentum.minSwaps || cur.traders < c.momentum.minTraders || vol < c.momentum.minVolumeUsd) return null;
  // A token younger than two windows has no honest baseline: compare against the floor instead.
  const prevVol = Math.max(prev.buyUsd + prev.sellUsd, c.momentum.minVolumeUsd / c.momentum.minGrowthX);
  const x = vol / prevVol;
  if (x < c.momentum.minGrowthX || cur.buyUsd <= cur.sellUsd) return null;
  return {
    id: "momentum", kind: "opportunity", severity: "info",
    points: scaled(c.momentum.weight, x, c.momentum.minGrowthX),
    title: `Volume ${r2(x)}× the prior 15m (${usd(vol)}, ${cur.traders} traders)`,
    evidence: { volumeUsd: Math.round(vol), priorVolumeUsd: Math.round(prev.buyUsd + prev.sellUsd), growthX: r2(x), swaps: cur.buys + cur.sells, traders: cur.traders },
  };
};

// ---- risk ---------------------------------------------------------------------------

export const bundledLaunch: Rule = (m, c) => {
  if (!m.launchObserved || m.launchSupplyPct === null) return null;
  const cfg = c.bundledLaunch;
  const clustered = m.launchLargestCluster >= cfg.minClusterWallets;
  if (m.launchSupplyPct < cfg.warnSupplyPct && !clustered) return null;
  // Snipers that already dumped are a smaller ongoing risk than ones still holding.
  const stillHeld = m.launchBuyersSoldPct === null ? 1 : 1 - m.launchBuyersSoldPct / 100;
  const held = m.launchSupplyPct * stillHeld;
  const severity: SignalSeverity = held >= cfg.critSupplyPct ? "critical" : "warn";
  return {
    id: "bundled_launch", kind: "risk", severity, points: 0,
    title: `Launch block buyers took ${r2(m.launchSupplyPct)}% of supply${clustered ? `, ${m.launchLargestCluster} share a funder` : ""}`,
    evidence: { launchSupplyPct: m.launchSupplyPct, launchBuyers: m.launchBuyers, freshLaunchBuyers: m.launchFreshBuyers, largestFundedGroup: m.launchLargestCluster, soldPct: m.launchBuyersSoldPct, stillHeldPct: r2(held) },
  };
};

export const clusterConcentration: Rule = (m, c) => {
  if (m.topClusterPct === null || m.topClusterPct < c.concentration.warnPct) return null;
  return {
    id: "cluster_concentration", kind: "risk",
    severity: m.topClusterPct >= c.concentration.critPct ? "critical" : "warn", points: 0,
    title: `${m.topClusterSize} commonly-funded wallets hold ${r2(m.topClusterPct)}% of supply`,
    evidence: { clusterPct: m.topClusterPct, clusterWallets: m.topClusterSize, topHolderPct: m.topHolderPct, funderCoverage: r2(m.funderCoverage) },
  };
};

export const liquidityPull: Rule = (m, c) => {
  if (m.maxRemovalFraction < c.liquidityPull.warnFraction) return null;
  return {
    id: "liquidity_pull", kind: "risk",
    severity: m.maxRemovalFraction >= c.liquidityPull.critFraction ? "critical" : "warn", points: 0,
    title: `${Math.round(m.maxRemovalFraction * 100)}% of pool liquidity removed in one transaction`,
    evidence: { removedPct: r2(m.maxRemovalFraction * 100), liquidityUsd: Math.round(m.liquidityUsd), peakLiquidityUsd: Math.round(m.peakLiquidityUsd), lastRemovalTs: m.lastRemovalTs },
  };
};

export const honeypot: Rule = (m, c) => {
  if (m.distinctBuyersTotal < c.honeypot.minBuyers || m.nonCreatorSellers > 0) return null;
  if (m.firstTradeTs === null || m.now - m.firstTradeTs < c.honeypot.minAgeMin * 60) return null;
  return {
    id: "honeypot", kind: "risk", severity: "critical", points: 0,
    title: `${m.distinctBuyersTotal} buyers and not one successful sell`,
    evidence: { distinctBuyers: m.distinctBuyersTotal, nonCreatorSellers: 0, minutesSinceFirstTrade: Math.round((m.now - m.firstTradeTs) / 60) },
  };
};

export const insiderDump: Rule = (m, c) => {
  const sold = m.creatorSoldPct;
  if (sold === null || sold < c.insiderDump.warnSoldPct) return null;
  return {
    id: "insider_dump", kind: "risk",
    severity: sold >= c.insiderDump.critSoldPct ? "critical" : "warn", points: 0,
    title: `Creator has sold ${Math.round(sold)}% of their position`,
    evidence: { creator: m.creator, creatorSoldPct: sold },
  };
};

export const washTrading: Rule = (m, c) => {
  const w = m.w1h;
  if (w.buyUsd + w.sellUsd < c.wash.minVolumeUsd || w.topTraderShare < c.wash.maxTopTraderShare) return null;
  return {
    id: "wash_trading", kind: "risk", severity: "warn", points: 0,
    title: `One wallet drives ${Math.round(w.topTraderShare * 100)}% of hourly volume`,
    evidence: { topTraderSharePct: r2(w.topTraderShare * 100), volumeUsd: Math.round(w.buyUsd + w.sellUsd), mevTraders: m.mevTraders },
  };
};

export const OPPORTUNITY_RULES: Rule[] = [organicDemand, smartMoney, holderRetention, liquidityGrowth, momentum];
export const RISK_RULES: Rule[] = [bundledLaunch, clusterConcentration, liquidityPull, honeypot, insiderDump, washTrading];

// ---- assessment -----------------------------------------------------------------------

export type Verdict = "quiet" | "watch" | "alert" | "high_conviction" | "avoid";

export interface Assessment {
  chainId: number;
  token: Address;
  at: number;
  score: number;
  opportunityPoints: number;
  penalty: number;
  verdict: Verdict;
  signals: Signal[];
  /** Why the verdict is not higher, for the activity log. */
  gate: string | null;
}

export function assess(m: TokenMetrics, c: SignalsConfig): Assessment {
  const signals: Signal[] = [];
  for (const rule of [...RISK_RULES, ...OPPORTUNITY_RULES]) {
    const s = rule(m, c);
    if (s) signals.push(s);
  }
  const opps = signals.filter((s) => s.kind === "opportunity");
  const risks = signals.filter((s) => s.kind === "risk");
  const opportunityPoints = Math.min(100, opps.reduce((n, s) => n + s.points, 0));
  const penalty = risks.filter((s) => s.severity === "warn").length * c.warnPenalty;
  for (const r of risks) if (r.severity === "warn") r.points = -c.warnPenalty;
  const score = Math.max(0, Math.min(100, opportunityPoints - penalty));

  let verdict: Verdict = score > 0 ? "watch" : "quiet";
  let gate: string | null = null;
  if (risks.some((s) => s.severity === "critical")) {
    verdict = "avoid";
    gate = `critical risk: ${risks.filter((s) => s.severity === "critical").map((s) => s.id).join(", ")}`;
  } else if (m.liquidityUsd < c.minLiquidityUsd) {
    gate = `liquidity ${usd(m.liquidityUsd)} below ${usd(c.minLiquidityUsd)}`;
  } else if (opps.length < c.minOpportunitySignals) {
    gate = `${opps.length}/${c.minOpportunitySignals} independent opportunity signals`;
  } else if (score >= c.highConvictionScore) {
    verdict = "high_conviction";
  } else if (score >= c.alertScore) {
    verdict = "alert";
  } else {
    gate = `score ${score} below ${c.alertScore}`;
  }
  return { chainId: m.chainId, token: m.token, at: m.now, score, opportunityPoints, penalty, verdict, signals, gate };
}
