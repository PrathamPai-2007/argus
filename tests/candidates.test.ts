import { describe, expect, test } from "bun:test";
import { scoreCandidate } from "../src/candidates.ts";

const base = {
  liquidityUsd: 250_000,
  volumeUsd: 20_000,
  poolAgeHours: 8,
  earlyBuyerCount: 5,
  retainedBuyerCount: 4,
  independentBuyerCount: 4,
  exchangeBuyerCount: 0,
  commonFunderRatio: 0.1,
  minimumLiquidityUsd: 100_000,
  minimumIndependentBuyers: 3,
};

describe("candidate scoring", () => {
  test("promotes independent retained early buyers", () => {
    const result = scoreCandidate(base);
    expect(result.eligible).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(65);
  });

  test("does not let volume overcome common-funder concentration", () => {
    const result = scoreCandidate({ ...base, volumeUsd: 50_000_000, commonFunderRatio: 1, independentBuyerCount: 1 });
    expect(result.eligible).toBe(false);
  });
});
