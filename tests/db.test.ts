import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as db from "../src/db.ts";
import type { SwapEvent, TransferEvent } from "../src/model.ts";
import { openPosition } from "../src/positions.ts";

const TOKEN = "0x" + "11".repeat(20);
const base = (block: number, logIndex = 0) => ({ chainId: 1, blockNumber: block, transactionIndex: 0, logIndex, txHash: "0x" + block.toString(16).padStart(64, "0"), timestamp: 1_700_000_000 + block });
const transfer = (block: number): TransferEvent => ({ kind: "transfer", ...base(block), token: TOKEN, from: "0x" + "aa".repeat(20), to: "0x" + "bb".repeat(20), amount: 10n ** 30n });
const swap = (block: number): SwapEvent => ({ kind: "swap", ...base(block, 1), pool: "0x" + "cc".repeat(20), dex: "v3", token: TOKEN, quote: "0x" + "dd".repeat(20), side: "buy", tokenAmount: 5n, quoteAmount: 7n, trader: "0x" + "ee".repeat(20), traderNonce: 0, recipient: "0x" + "ee".repeat(20), sqrtPriceX96: 2n ** 96n });

beforeEach(() => db.openDb(":memory:"));
afterEach(() => db.closeDb());

describe("events", () => {
  test("insert is idempotent and bigints round-trip", () => {
    expect(db.insertEvents([transfer(1), swap(1)])).toHaveLength(2);
    expect(db.insertEvents([transfer(1)])).toHaveLength(0);
    const [t, s] = db.loadEvents(1);
    expect(t).toEqual(transfer(1));
    expect(s).toEqual(swap(1));
  });

  test("finalize advances the cursor; reorg deletes only unfinalized rows", () => {
    db.insertEvents([transfer(1), transfer(2), transfer(3)]);
    db.markFinalized(1, 2);
    expect(db.finalizedCursor(1)).toBe(2);
    db.deleteUnfinalizedFrom(1, 1);
    expect(db.loadEvents(1).map((e) => e.blockNumber)).toEqual([1, 2]);
    expect(db.loadEvents(1, { finalizedOnly: true, tokens: [TOKEN] })).toHaveLength(2);
    db.markFinalized(1, 1); // cursor never moves backwards
    expect(db.finalizedCursor(1)).toBe(2);
  });
});

describe("alerts and positions", () => {
  const payload: db.AlertPayload = { chainId: 1, token: TOKEN, kind: "opportunity", verdict: "alert", score: 70, symbol: "T", headline: "h", signals: [], priceUsd: 1, liquidityUsd: 1, ageSec: 1, links: {} };

  test("reorg retracts unconfirmed alerts and their positions; confirmed ones survive", () => {
    const early = db.insertAlert(payload, 10, false);
    const late = db.insertAlert(payload, 20, false);
    db.insertPosition(openPosition({ chainId: 1, token: TOKEN, kind: "alert", alertId: late, score: 70, entryUnitUsd: 1, entryAt: 1, entryBlock: 20 }));
    db.markFinalized(1, 10);
    expect(db.retractAlertsFrom(1, 5)).toEqual([late]);
    expect(db.getAlert(early)?.confirmed).toBe(true);
    expect(db.listPositions()).toHaveLength(0);
    expect(db.lastAlert(1, TOKEN, "opportunity")?.id).toBe(early);
  });

  test("only one baseline position per token", () => {
    const p = openPosition({ chainId: 1, token: TOKEN, kind: "baseline", alertId: null, score: 20, entryUnitUsd: 1, entryAt: 1, entryBlock: 1 });
    expect(db.insertPosition(p)).toBeGreaterThan(0);
    expect(db.insertPosition(p)).toBe(0);
  });
});

describe("wallet track records", () => {
  test("closed trades, wins and prorated realized PnL", () => {
    const W = "0x" + "ab".repeat(20);
    db.applyWalletTrades(1, [
      // token A: bought $100, sold 95% for $300 → closed win
      { wallet: W, token: "0xa", side: "buy", tokenAmount: 100, usd: 100, at: 1 },
      { wallet: W, token: "0xa", side: "sell", tokenAmount: 95, usd: 300, at: 2 },
      // token B: bought $100, sold all for $40 → closed loss
      { wallet: W, token: "0xb", side: "buy", tokenAmount: 10, usd: 100, at: 3 },
      { wallet: W, token: "0xb", side: "sell", tokenAmount: 10, usd: 40, at: 4 },
      // token C: half sold for $80 of a $100 entry → open, +$30 realized on the sold half
      { wallet: W, token: "0xc", side: "buy", tokenAmount: 10, usd: 100, at: 5 },
      { wallet: W, token: "0xc", side: "sell", tokenAmount: 5, usd: 80, at: 6 },
    ]);
    const [s] = db.walletLeaderboard({ minClosedTrades: 1 });
    expect(s).toMatchObject({ closedTrades: 2, wins: 1, tokensTraded: 3 });
    expect(s!.realizedPnlUsd).toBeCloseTo(205 - 60 + 30, 6);
    expect(db.smartWallets(1, { minClosedTrades: 2, minWinRate: 0.5, minPnlUsd: 0 }).has(W)).toBe(true);
    expect(db.smartWallets(1, { minClosedTrades: 3, minWinRate: 0.5, minPnlUsd: 0 }).has(W)).toBe(false);
  });
});

test("manual tokens stay watched forever; launches expire", () => {
  db.upsertToken({ chainId: 1, address: TOKEN, source: "launch", firstSeenAt: 1, watchUntil: 100 });
  expect(db.listWatchedTokens(1, 50)).toHaveLength(1);
  expect(db.listWatchedTokens(1, 150)).toHaveLength(0);
  db.upsertToken({ chainId: 1, address: TOKEN, source: "manual", firstSeenAt: 1 });
  expect(db.getToken(1, TOKEN)).toMatchObject({ source: "manual", watchUntil: null });
  db.upsertToken({ chainId: 1, address: TOKEN, source: "launch", firstSeenAt: 1, watchUntil: 5 });
  expect(db.getToken(1, TOKEN)?.source).toBe("manual");
});
