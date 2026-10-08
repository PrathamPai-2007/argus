import { describe, expect, test } from "bun:test";
import { cohort, expire, observe, openPosition, peakMultiple, trackRecord, type Position } from "../src/positions.ts";

const T = 1_700_000_000;
const pos = (over: Partial<Position> = {}) => ({ ...openPosition({ chainId: 1, token: "0xt", kind: "alert", alertId: 1, score: 70, entryUnitUsd: 1, entryAt: T, entryBlock: 1 }), ...over });

describe("positions", () => {
  test("stamps horizons with the first observation past them and tracks extremes", () => {
    let p = pos();
    p = observe(p, 1.5, T + 600);
    p = observe(p, 0.8, T + 1_000); // first print past 15m
    p = observe(p, 3, T + 3_700); // first print past 1h
    expect(p.returns.m15).toBeCloseTo(-0.2);
    expect(p.returns.h1).toBeCloseTo(2);
    expect(p.returns.h6).toBeNull();
    expect(peakMultiple(p)).toBe(3);
    expect(p.troughUnitUsd).toBe(0.8);
  });

  test("a gap spanning a horizon uses the last price before the gap (no look-ahead)", () => {
    let p = observe(pos(), 2, T + 1_000);
    p = observe(p, 10, T + 30_000); // jumped past 1h and 6h
    expect(p.returns.h1).toBe(9);
    expect(p.returns.h6).toBe(9);
  });

  test("closes at 24h and ignores bad or stale prices", () => {
    let p = observe(pos(), 2, T + 100);
    expect(observe(p, 0, T + 200)).toBe(p);
    expect(observe(p, Number.NaN, T + 200)).toBe(p);
    expect(observe(p, 5, T + 50)).toBe(p);
    p = observe(p, 1.2, T + 86_400);
    expect(p.closedAt).toBe(T + 86_400);
    expect(observe(p, 9, T + 90_000)).toBe(p);
  });

  test("expire fills missing horizons from the last known price", () => {
    const p = expire(observe(pos(), 0.5, T + 100), T + 90_000);
    expect(p.closedAt).toBe(T + 90_000);
    expect(p.returns.h24).toBeCloseTo(-0.5);
  });
});

describe("track record", () => {
  test("cohort medians, win rate and 2x hit rate", () => {
    const ps = [0.5, -0.3, 1.2].map((r, i) => ({ ...pos({ id: i }), returns: { m15: r, h1: r, h6: null, h24: null }, peakUnitUsd: 1 + Math.max(r, 0) }));
    const c = cohort(ps);
    expect(c.median.h1).toBe(0.5);
    expect(c.winRate1h).toBeCloseTo(2 / 3);
    expect(c.hit2x).toBeCloseTo(1 / 3);
  });

  test("separates alerts from the baseline control and buckets by score", () => {
    const tr = trackRecord([pos({ id: 1, score: 85 }), pos({ id: 2, kind: "baseline", alertId: null, score: null })]);
    expect(tr.alerts.count).toBe(1);
    expect(tr.baseline.count).toBe(1);
    expect(tr.byScore.find((b) => b.bucket === "80+")?.stats.count).toBe(1);
  });
});
