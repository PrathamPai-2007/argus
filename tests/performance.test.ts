import { beforeEach, describe, expect, test } from "bun:test";
import { closeDb, createPerformanceSession, getPerformanceSession, insertAlert, listPerformanceSessions, openDb, retractPerformanceForAlerts, updatePerformanceSession } from "../src/db.ts";
import { PERFORMANCE_WINDOW_SECS, priceFromSwap, thresholds, updateSession } from "../src/performance.ts";
import type { AlertPayload, SwapEvent } from "../src/types.ts";

const TOKEN = "0x" + "aa".repeat(20);
const POOL = "0x" + "bb".repeat(20);

function swap(tokenAmount: bigint, quoteAmount: bigint, timestamp = 1_000): SwapEvent {
  return {
    kind: "swap", chainId: 1, blockNumber: timestamp, logIndex: 0, txHash: "0x" + "11".repeat(32), timestamp,
    poolAddress: POOL, tokenAddress: TOKEN, buyer: "0x" + "cc".repeat(20), direction: "buy", tokenAmount, quoteAmount,
  };
}

function alertPayload(): AlertPayload {
  return { chainId: 1, tokenAddress: TOKEN, score: 80, severity: "critical", signals: [], headline: "test", lines: [], links: { dexscreener: "", bubblemaps: "", dashboard: "" } };
}

describe("alert performance", () => {
  beforeEach(() => {
    closeDb();
    openDb(":memory:");
  });

  test("derives an exact pool-relative price and thresholds", () => {
    const p = priceFromSwap(swap(100n, 50n));
    expect(p).toBe(500_000_000_000_000_000n);
    expect(thresholds(p as bigint)).toEqual({ targetPrice: 750_000_000_000_000_000n, stopPrice: 400_000_000_000_000_000n });
  });

  test("normalizes ERC-20 decimals in both orientations", () => {
    expect(priceFromSwap(swap(1_000_000n, 1_000_000_000_000_000_000n), 6, 18)).toBe(1_000_000_000_000_000_000n);
    expect(priceFromSwap(swap(1_000_000_000_000_000_000n, 1_000_000n), 18, 6)).toBe(1_000_000_000_000_000_000n);
  });

  test("closes at stop, target, and twelve-hour expiry", () => {
    const entry = priceFromSwap(swap(100n, 100n)) as bigint;
    const t = thresholds(entry);
    const base = { entry_price: entry, target_price: t.targetPrice, stop_price: t.stopPrice, min_price: entry, max_price: entry, expires_at: 1_000 + PERFORMANCE_WINDOW_SECS, outcome: "active" as const };
    expect(updateSession(base, t.stopPrice, 1_001).outcome).toBe("stop_hit");
    expect(updateSession(base, t.targetPrice, 1_001).outcome).toBe("target_hit");
    expect(updateSession(base, entry, 1_000 + PERFORMANCE_WINDOW_SECS).outcome).toBe("expired");
  });

  test("persists and retracts a session linked to an alert", () => {
    const alertId = insertAlert(alertPayload(), false, 100);
    const entry = priceFromSwap(swap(100n, 100n)) as bigint;
    const t = thresholds(entry);
    const id = createPerformanceSession({
      alertId, chainId: 1, tokenAddress: TOKEN, poolAddress: POOL, quoteToken: null,
      entryPrice: entry, targetPrice: t.targetPrice, stopPrice: t.stopPrice,
      openedAt: 1_000, expiresAt: 1_000 + PERFORMANCE_WINDOW_SECS, entryBlock: 100,
    });
    expect(getPerformanceSession(id)?.entry_price).toBe(entry);
    updatePerformanceSession({ id, outcome: "stop_hit", currentPrice: t.stopPrice, minPrice: t.stopPrice, maxPrice: entry, lastBlock: 101, updatedAt: 1_001, closedAt: 1_001 });
    expect(listPerformanceSessions({ tokenAddress: TOKEN })[0]?.outcome).toBe("stop_hit");
    expect(retractPerformanceForAlerts([alertId])).toEqual([id]);
    expect(getPerformanceSession(id)?.outcome).toBe("retracted");
  });

  test("invalid swaps do not produce a price", () => {
    expect(priceFromSwap(swap(0n, 1n))).toBeNull();
    expect(priceFromSwap(swap(1n, 0n))).toBeNull();
  });

  test("extreme single-step price jump returns invalid_price outcome", () => {
    const entry = 1_000_000_000n; // 1e9
    const t = thresholds(entry);
    const base = { entry_price: entry, target_price: t.targetPrice, stop_price: t.stopPrice, min_price: entry, max_price: entry, expires_at: 1_000 + PERFORMANCE_WINDOW_SECS, outcome: "active" as const };
    // Price jump of 2,000x (USD vs Native scale mismatch) returns invalid_price
    expect(updateSession(base, entry * 2000n, 1_001).outcome).toBe("invalid_price");
  });
});
