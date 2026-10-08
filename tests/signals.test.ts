import { describe, expect, test } from "bun:test";
import { assess, DEFAULT_SIGNALS as C, bundledLaunch, honeypot, liquidityPull, momentum, organicDemand } from "../src/signals.ts";
import type { TokenMetrics, WindowStats } from "../src/state.ts";

const W0: WindowStats = { buys: 0, sells: 0, buyUsd: 0, sellUsd: 0, buyers: 0, sellers: 0, organicBuyers: 0, freshBuyers: 0, traders: 0, topTraderShare: 0 };

function metrics(over: Partial<TokenMetrics> = {}): TokenMetrics {
  return {
    chainId: 1, token: "0x" + "11".repeat(20), now: 10_000, symbol: "MEME", ageSec: 3_600, launchObserved: true, launchBlock: 100, creator: "0x" + "de".repeat(20),
    totalSupply: 10n ** 24n, priceUnitUsd: 1e-18, liquidityUsd: 50_000, initialLiquidityUsd: 40_000, peakLiquidityUsd: 50_000, maxRemovalFraction: 0, lastRemovalTs: null,
    w5m: W0, w15m: W0, prev15m: W0, w1h: W0, trades: 0, firstTradeTs: 1_000, earlyBuyers: 0, earlyBuyersHolding: 0, launchBuyers: 0, launchFreshBuyers: 0,
    launchSupplyPct: 2, launchLargestCluster: 1, topClusterPct: 3, topClusterSize: 2, topHolderPct: 4, funderCoverage: 0.8, creatorSoldPct: null, launchBuyersSoldPct: 0,
    distinctBuyersTotal: 0, nonCreatorSellers: 5, smartBuyers: [], mevTraders: 0, ...over,
  };
}

const busy: WindowStats = { buys: 40, sells: 12, buyUsd: 30_000, sellUsd: 9_000, buyers: 30, sellers: 10, organicBuyers: 24, freshBuyers: 3, traders: 36, topTraderShare: 0.08 };

describe("opportunity rules", () => {
  test("organic demand requires independent buyers AND net inflow", () => {
    expect(organicDemand(metrics({ w15m: busy }), C)?.points).toBe(30);
    expect(organicDemand(metrics({ w15m: { ...busy, organicBuyers: 5 } }), C)).toBeNull();
    expect(organicDemand(metrics({ w15m: { ...busy, sellUsd: 29_000 } }), C)).toBeNull();
  });

  test("momentum needs a real prior baseline, not a dust window", () => {
    // prior window had $5 of volume: growth is measured against the configured floor
    const s = momentum(metrics({ w15m: busy, prev15m: { ...W0, buyUsd: 5 } }), C);
    expect(s?.evidence["growthX"]).toBeLessThan(20);
    expect(momentum(metrics({ w15m: { ...busy, traders: 3 } }), C)).toBeNull();
  });
});

describe("risk rules", () => {
  test("bundled launch is critical only while snipers still hold", () => {
    expect(bundledLaunch(metrics({ launchSupplyPct: 50, launchBuyersSoldPct: 0 }), C)?.severity).toBe("critical");
    expect(bundledLaunch(metrics({ launchSupplyPct: 50, launchBuyersSoldPct: 80 }), C)?.severity).toBe("warn");
    expect(bundledLaunch(metrics({ launchSupplyPct: 50, launchObserved: false }), C)).toBeNull();
  });

  test("honeypot: many buyers, zero non-creator sells, after a grace period", () => {
    expect(honeypot(metrics({ distinctBuyersTotal: 20, nonCreatorSellers: 0 }), C)?.severity).toBe("critical");
    expect(honeypot(metrics({ distinctBuyersTotal: 20, nonCreatorSellers: 0, firstTradeTs: 9_900 }), C)).toBeNull();
  });

  test("liquidity pull severity scales with the removed fraction", () => {
    expect(liquidityPull(metrics({ maxRemovalFraction: 0.3 }), C)?.severity).toBe("warn");
    expect(liquidityPull(metrics({ maxRemovalFraction: 0.9 }), C)?.severity).toBe("critical");
  });
});

describe("assess", () => {
  const strong = metrics({ w15m: busy, earlyBuyers: 30, earlyBuyersHolding: 27, smartBuyers: ["0x" + "aa".repeat(20), "0x" + "bb".repeat(20), "0x" + "cc".repeat(20)] });

  test("multiple independent opportunity signals reach high conviction", () => {
    const a = assess(strong, C);
    expect(a.signals.map((s) => s.id).sort()).toEqual(["holder_retention", "momentum", "organic_demand", "smart_money"]);
    expect(a.verdict).toBe("high_conviction");
  });

  test("a single opportunity signal never alerts on its own", () => {
    const a = assess(metrics({ smartBuyers: ["0x" + "aa".repeat(20), "0x" + "bb".repeat(20), "0x" + "cc".repeat(20)] }), C);
    expect(a.verdict).toBe("watch");
    expect(a.gate).toContain("1/2");
  });

  test("a critical risk vetoes regardless of score", () => {
    const a = assess({ ...strong, maxRemovalFraction: 0.9 }, C);
    expect(a.verdict).toBe("avoid");
    expect(a.gate).toContain("liquidity_pull");
  });

  test("thin liquidity gates alerts", () => {
    expect(assess({ ...strong, liquidityUsd: 2_000 }, C).gate).toContain("liquidity");
  });

  test("warn risks subtract points", () => {
    const a = assess({ ...strong, topClusterPct: 20, topClusterSize: 4 }, C);
    expect(a.penalty).toBe(C.warnPenalty);
    expect(a.score).toBe(a.opportunityPoints - C.warnPenalty);
  });
});
