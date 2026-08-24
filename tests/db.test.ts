import { beforeEach, describe, expect, test } from "bun:test";
import { closeDb, dashboardMetrics, getCandidate, getToken, insertEvents, insertSignal, listCandidates, listSignals, listSignalsForToken, listWatchedTokens, loadEvents, openDb, promoteCandidate, recentSignals, recordSignalEvaluation, updateCandidateScore, upsertCandidate, upsertToken } from "../src/db.ts";
import type { FundingEvent, Signal, StandardTransferEvent, SwapEvent } from "../src/types.ts";

// Regression: payload_json round-trips bigints to strings; loadEvents must revive them
// so replay / rebuild-from-events never hit "Invalid mix of BigInt and other type".

describe("db.loadEvents", () => {
  beforeEach(() => {
    closeDb();
    openDb(":memory:");
  });

  test("revives bigint amount fields by event kind", () => {
    const transfer: StandardTransferEvent = {
      kind: "transfer", chainId: 1, blockNumber: 10, logIndex: 0, txHash: "0x" + "11".repeat(32),
      tokenAddress: "0x" + "aa".repeat(20), sender: "0x" + "bb".repeat(20), receiver: "0x" + "cc".repeat(20),
      amount: 123_456_789n, timestamp: 1_700_000_000,
    };
    const swap: SwapEvent = {
      kind: "swap", chainId: 1, blockNumber: 11, logIndex: 0, txHash: "0x" + "22".repeat(32),
      poolAddress: "0x" + "dd".repeat(20), tokenAddress: "0x" + "aa".repeat(20), buyer: "0x" + "ee".repeat(20),
      direction: "buy", tokenAmount: 50n, quoteAmount: 10n, timestamp: 1_700_000_012,
    };
    const funding: FundingEvent = {
      kind: "funding", chainId: 1, blockNumber: 12, logIndex: 0, txHash: "0x" + "33".repeat(32),
      funder: "0x" + "f1".repeat(20), funded: "0x" + "f2".repeat(20), amount: 7n, method: "native_transfer",
      timestamp: 1_700_000_024,
    };
    insertEvents([transfer, swap, funding], true);

    const loaded = loadEvents(1, 0, 1_000_000, { finalizedOnly: true });
    expect(loaded).toHaveLength(3);
    const t = loaded[0] as StandardTransferEvent;
    const s = loaded[1] as SwapEvent;
    const f = loaded[2] as FundingEvent;
    expect(t.amount).toBe(123_456_789n);
    expect(s.tokenAmount).toBe(50n);
    expect(s.quoteAmount).toBe(10n);
    expect(f.amount).toBe(7n);
    expect(typeof t.timestamp).toBe("number");
  });

  test("returns only newly inserted event facts", () => {
    const event: StandardTransferEvent = {
      kind: "transfer", chainId: 1, blockNumber: 10, logIndex: 0, txHash: "0x" + "44".repeat(32),
      tokenAddress: "0x" + "aa".repeat(20), sender: "0x" + "bb".repeat(20), receiver: "0x" + "cc".repeat(20), amount: 1n, timestamp: 1,
    };
    expect(insertEvents([event], false)).toHaveLength(1);
    expect(insertEvents([event], false)).toHaveLength(0);
  });

  test("loads same-block events in transaction then log order", () => {
    const make = (transactionIndex: number, logIndex: number): StandardTransferEvent => ({
      kind: "transfer", chainId: 1, blockNumber: 10, transactionIndex, logIndex,
      txHash: `0x${String(transactionIndex).padStart(64, "0")}`, tokenAddress: "0x" + "aa".repeat(20),
      sender: "0x" + "bb".repeat(20), receiver: "0x" + "cc".repeat(20), amount: 1n, timestamp: 1,
    });
    insertEvents([make(2, 0), make(1, 9), make(1, 2)], true);
    expect(loadEvents(1, 10, 10).map((event) => [event.transactionIndex, event.logIndex])).toEqual([[1, 2], [1, 9], [2, 0]]);
  });

  test("upsertToken updates expires_at on conflict and preserves it when omitted", () => {
    const addr = "0x" + "ab".repeat(20);
    upsertToken({ chainId: 1, address: addr, symbol: null, decimals: null, totalSupply: null, source: "factory", expiresAt: 1000 });
    expect(getToken(1, addr)?.expires_at).toBe(1000);
    // sliding auto-watch window: a later upsert extends it
    upsertToken({ chainId: 1, address: addr, symbol: null, decimals: null, totalSupply: null, source: "factory", expiresAt: 2000 });
    expect(getToken(1, addr)?.expires_at).toBe(2000);
    // metadata-only refresh must NOT clobber the expiry back to NULL
    upsertToken({ chainId: 1, address: addr, symbol: "TST", decimals: 18, totalSupply: 10n, source: "factory" });
    expect(getToken(1, addr)?.expires_at).toBe(2000);
    expect(getToken(1, addr)?.symbol).toBe("TST");
  });

  test("maps signal rows consistently across signal queries", () => {
    const signal: Signal = {
      chainId: 1,
      tokenAddress: "0x" + "aa".repeat(20),
      ruleId: "R1",
      weight: 35,
      evidence: { freshWalletPct: 12.5 },
      blockNumber: 10,
      timestamp: 1_700_000_000,
    };
    insertSignal(signal);

    expect(recentSignals(1, signal.tokenAddress, 1_600_000_000)).toEqual([signal]);
    expect(listSignals(1)).toEqual([signal]);
    expect(listSignalsForToken(1, signal.tokenAddress)).toEqual([signal]);
  });

  test("exposes durable signal evaluation outcomes", () => {
    const signal: Signal = {
      chainId: 1, tokenAddress: "0x" + "aa".repeat(20), ruleId: "R2", weight: 25,
      evidence: { spikePct: 150 }, blockNumber: 10, timestamp: 1_700_000_000,
    };
    const id = insertSignal(signal);
    recordSignalEvaluation({ signalId: id, score: 25, severity: null, outcome: "below_threshold", reason: "below_info_threshold" });
    expect(listSignals(1)[0]).toMatchObject({ score: 25, severity: null, outcome: "below_threshold", outcomeReason: "below_info_threshold" });
    expect(dashboardMetrics().signalOutcomes).toEqual({ below_threshold: 1 });
  });

  test("deduplicates a signal from the same source event", () => {
    const signal: Signal = {
      chainId: 1, tokenAddress: "0x" + "aa".repeat(20), ruleId: "R1", weight: 35,
      evidence: {}, blockNumber: 10, timestamp: 1_700_000_000,
    };
    const source = { txHash: "0x" + "11".repeat(32), logIndex: 4 };
    expect(insertSignal(signal, source)).toBeGreaterThan(0);
    expect(insertSignal(signal, source)).toBe(0);
    expect(listSignals(1)).toHaveLength(1);
    expect(listSignals(1)[0]?.sourceTxHash).toBe(source.txHash);
  });

  test("uses signal provenance when no separate source argument is supplied", () => {
    const signal: Signal = { chainId: 1, tokenAddress: "0x" + "aa".repeat(20), ruleId: "R2", weight: 20, evidence: {}, blockNumber: 11, timestamp: 1_700_000_001, sourceTxHash: "0x" + "22".repeat(32), sourceLogIndex: 3 };
    expect(insertSignal(signal)).toBeGreaterThan(0);
    expect(listSignals(1)[0]?.sourceLogIndex).toBe(3);
  });

  test("keeps candidates out of active watches until promotion", () => {
    const addr = "0x" + "cd".repeat(20);
    upsertCandidate({ chainId: 1, address: addr, source: "ranked", firstSeenAt: 10, expiresAt: 1000 });
    upsertToken({ chainId: 1, address: addr, symbol: null, decimals: null, totalSupply: null, source: "candidate", expiresAt: 1000 });
    expect(listWatchedTokens(1, 20).some((t) => t.address === addr)).toBe(false);
    updateCandidateScore(1, addr, 80, { independentBuyerCount: 4 }, "promoted");
    promoteCandidate(1, addr, "ranked", 2000);
    expect(getCandidate(1, addr)?.status).toBe("promoted");
    expect(getToken(1, addr)?.source).toBe("ranked");
    expect(listWatchedTokens(1, 20).some((t) => t.address === addr)).toBe(true);
    expect(listCandidates(1)).toHaveLength(1);
  });

  test("updates an existing token when it enters the candidate state", () => {
    const addr = "0x" + "ef".repeat(20);
    upsertToken({ chainId: 1, address: addr, symbol: null, decimals: null, totalSupply: null, source: "ranked", expiresAt: 1000 });
    upsertToken({ chainId: 1, address: addr, symbol: null, decimals: null, totalSupply: null, source: "candidate", expiresAt: 2000 });
    expect(getToken(1, addr)?.source).toBe("candidate");
    expect(listWatchedTokens(1, 20).some((t) => t.address === addr)).toBe(false);
  });

  test("reports truthful dashboard aggregates and candidate funnel metrics", () => {
    const addr = "0x" + "ab".repeat(20);
    upsertCandidate({ chainId: 1, address: addr, source: "ranked", firstSeenAt: 1, expiresAt: 5000 });
    updateCandidateScore(1, addr, 70, { eligible: true }, "promoted");
    promoteCandidate(1, addr, "ranked", 5000);
    const metrics = dashboardMetrics(1000);
    expect(metrics.candidates.evaluated).toBe(1);
    expect(metrics.candidates.promoted).toBe(1);
    expect(metrics.candidates.promotionRate).toBe(100);
  });
});
