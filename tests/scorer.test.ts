import { beforeEach, describe, expect, test } from "bun:test";
import { closeDb, insertSignal, openDb } from "../src/db.ts";
import { scoreToken, severityFor } from "../src/scorer.ts";
import type { Signal } from "../src/types.ts";

const CFG = { info: 40, alert: 60, critical: 80, signalWindowHours: 6 };
const TOKEN = "0x" + "aa".repeat(20);
const NOW = 1_700_000_000;

function sig(ruleId: Signal["ruleId"], weight: number, ts = NOW): Signal {
  return { chainId: 1, tokenAddress: TOKEN, ruleId, weight, evidence: {}, blockNumber: 100, timestamp: ts };
}

describe("scorer", () => {
  beforeEach(() => {
    closeDb();
    openDb(":memory:");
  });

  test("severity mapping", () => {
    expect(severityFor(39, CFG)).toBeNull();
    expect(severityFor(40, CFG)).toBe("info");
    expect(severityFor(60, CFG)).toBe("alert");
    expect(severityFor(80, CFG)).toBe("critical");
    expect(severityFor(100, CFG)).toBe("critical");
  });

  test("best weight per rule, summed, capped at 100", () => {
    insertSignal(sig("R1", 35));
    insertSignal(sig("R1", 30)); // lower re-fire doesn't stack
    insertSignal(sig("R4", 45));
    insertSignal(sig("R5", 25));
    const res = scoreToken(1, TOKEN, CFG, NOW);
    expect(res.score).toBe(100); // 35+45+25 = 105 → capped
    expect(res.severity).toBe("critical");
    expect(res.signals.length).toBe(3);
  });

  test("old signals outside window are ignored", () => {
    insertSignal(sig("R1", 35, NOW - 7 * 3600)); // 7h ago, window 6h
    const res = scoreToken(1, TOKEN, CFG, NOW);
    expect(res.score).toBe(0);
    expect(res.severity).toBeNull();
  });

  test("partial score maps to severity", () => {
    insertSignal(sig("R1", 35));
    insertSignal(sig("R3", 30));
    const res = scoreToken(1, TOKEN, CFG, NOW);
    expect(res.score).toBe(65);
    expect(res.severity).toBe("alert");
  });
});
