import { beforeEach, describe, expect, test } from "bun:test";
import { closeDb, getCandidate, getToken, insertEvents, insertSignal, listCandidates, listSignals, listSignalsForToken, listWatchedTokens, loadEvents, openDb, promoteCandidate, recentSignals, updateCandidateScore, upsertCandidate, upsertToken } from "../src/db.ts";
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
});
