import { describe, expect, test } from "bun:test";
import type { Hex } from "viem";
import { CHAINS, NATIVE, orientPair, priceRefPool } from "../src/chains.ts";
import * as db from "../src/db.ts";
import { decodeLog, poolKey, type DecodeContext, type PoolRef, type RawLog } from "../src/ingest/decode.ts";
import type { LiquidityEvent, PoolCreatedEvent, SwapEvent } from "../src/model.ts";
import { ChainState, rangeAmounts } from "../src/state.ts";
import fx from "./fixtures/v4-logs.json";

// Real Base logs from one native-ETH V4 pool (fixtures/v4-logs.json): its
// Initialize, a buy whose transaction sent ETH, and a ModifyLiquidity.

const PM = CHAINS[8453]!.factories.find((f) => f.dex === "v4")!.address;
const raw = (l: typeof fx.initialize): RawLog => ({ ...l, topics: l.topics as Hex[], data: l.data as Hex, transactionHash: l.transactionHash as Hex });
const POOL_ID = fx.initialize.topics[1]!;
const TOKEN = ("0x" + fx.initialize.topics[3]!.slice(26)).toLowerCase();
const Q96 = 2n ** 96n;

function ctx(pools: PoolRef[], tx?: { from: string; nonce: number }): DecodeContext {
  return {
    chainId: 8453,
    timestamp: 1_700_000_000,
    pool: (a) => pools.find((p) => p.address === a),
    factory: (a) => CHAINS[8453]!.factories.find((f) => f.address === a),
    isWatchedToken: () => false,
    tx: () => tx,
  };
}

const pool: PoolRef = { address: POOL_ID, dex: "v4", token0: NATIVE, token1: TOKEN, ...orientPair(8453, NATIVE, TOKEN)! };

describe("V4 decoding (real Base logs)", () => {
  test("pool logs are keyed by pool id, not the PoolManager address", () => {
    expect(poolKey(raw(fx.swapBuy), (a) => CHAINS[8453]!.factories.find((f) => f.address === a))).toBe(POOL_ID);
    expect(pool).toMatchObject({ token: TOKEN, quote: NATIVE });
  });

  test("Initialize becomes pool_created with the pool id, currencies, hooks and initial price", () => {
    const evt = decodeLog(raw(fx.initialize), ctx([])) as PoolCreatedEvent;
    expect(evt).toMatchObject({ kind: "pool_created", dex: "v4", pool: POOL_ID, factory: PM, token0: NATIVE, token1: TOKEN });
    expect(evt.sqrtPriceX96).toBeGreaterThan(0n);
    expect(evt.hooks).toMatch(/^0x[0-9a-f]{40}$/);
  });

  test("a swap whose tx sent ETH decodes as a buy paid in ETH (V4 deltas are swapper-perspective)", () => {
    const evt = decodeLog(raw(fx.swapBuy), ctx([pool], fx.buyTx)) as SwapEvent;
    expect(evt.side).toBe("buy");
    expect(evt.trader).toBe(fx.buyTx.from);
    expect(evt.quoteAmount).toBeGreaterThan(0n);
    expect(evt.quoteAmount).toBeLessThanOrEqual(BigInt(fx.buyTx.value));
    expect(evt.tokenAmount).toBeGreaterThan(0n);
  });

  test("ModifyLiquidity carries the position range for amount derivation", () => {
    const evt = decodeLog(raw(fx.modifyLiquidity), ctx([pool])) as LiquidityEvent;
    expect(evt.kind).toBe("liquidity");
    expect(evt.range!.liquidity).toBeGreaterThan(0n);
    expect(evt.range!.tickLower).toBeLessThan(evt.range!.tickUpper);
  });
});

describe("concentrated-liquidity amounts", () => {
  test("in range at price 1 splits by the distance to each bound", () => {
    const L = 10n ** 18n;
    const [a0, a1] = rangeAmounts(Q96, L, -600, 600);
    const sa = 1.0001 ** -300;
    const sb = 1.0001 ** 300;
    expect(Number(a0)).toBeCloseTo(1e18 * (sb - 1) / sb, -6);
    expect(Number(a1)).toBeCloseTo(1e18 * (1 - sa), -6);
  });

  test("out of range is single-sided", () => {
    expect(rangeAmounts(Q96, 10n ** 18n, 600, 1200)[1]).toBe(0n); // price below range → all token0
    expect(rangeAmounts(Q96, 10n ** 18n, -1200, -600)[0]).toBe(0n); // price above range → all token1
  });
});

describe("V4 market state", () => {
  const base = (block: number, logIndex: number) => ({ chainId: 8453, blockNumber: block, transactionIndex: 0, logIndex, txHash: "0x" + block.toString(16).padStart(64, "0"), timestamp: 1_700_000_000 + block * 2 });
  const WETH = CHAINS[8453]!.wrappedNative;
  const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const ZORA = "0x1111111111166b7fe7bd91427724b487980afc69";
  // sqrtPriceX96 for a USD price per whole base token (18-dec base, 6-dec USDC, base = token0)
  const sqrtFor = (usd: number) => BigInt(Math.floor(Math.sqrt((usd * 1e6) / 1e18) * 2 ** 96));
  const refSwap = (refIdx: number, usd: number, block: number): SwapEvent => {
    const r = CHAINS[8453]!.priceRefs[refIdx]!;
    return { kind: "swap", ...base(block, 0), pool: r.address, dex: "v3", token: r.base, quote: USDC, side: "buy", tokenAmount: 1n, quoteAmount: 1n, trader: "0x" + "ee".repeat(20), traderNonce: 1, recipient: "0x" + "ee".repeat(20), sqrtPriceX96: sqrtFor(usd) };
  };

  test("prices ETH and ZORA from reference pool sqrtPrice, then values V4 trades in each", () => {
    const s = new ChainState(8453);
    for (const r of CHAINS[8453]!.priceRefs) s.registerPool(priceRefPool(r));
    s.apply(refSwap(0, 2500, 1)); // WETH
    s.apply(refSwap(1, 0.02, 1)); // ZORA
    expect(s.nativeUsd).toBeCloseTo(2500, 6);
    expect(s.refPrice(ZORA)).toBeCloseTo(0.02, 9);

    const ZCOIN = "0x" + "77".repeat(20);
    const zoraPool: PoolRef = { address: "0x" + "ab".repeat(32), dex: "v4", token0: ZORA, token1: ZCOIN, ...orientPair(8453, ZORA, ZCOIN)! };
    s.registerPool(zoraPool, 2);
    s.apply({ kind: "swap", ...base(3, 1), pool: zoraPool.address, dex: "v4", token: ZCOIN, quote: ZORA, side: "buy", tokenAmount: 10n ** 21n, quoteAmount: 500n * 10n ** 18n, trader: "0x" + "aa".repeat(20), traderNonce: 0, recipient: "0x" + "aa".repeat(20), sqrtPriceX96: Q96 });
    expect(s.tradesOf(ZCOIN)[0]!.usd).toBeCloseTo(10, 6); // 500 ZORA × $0.02
    expect(WETH).toBe(CHAINS[8453]!.priceRefs[0]!.base);
  });

  test("initial price, range-derived liquidity and launch detection for a native-ETH pool", () => {
    const s = new ChainState(8453);
    for (const r of CHAINS[8453]!.priceRefs) s.registerPool(priceRefPool(r));
    s.apply(refSwap(0, 2000, 1));
    s.registerPool(pool, 5);
    const init = decodeLog(raw(fx.initialize), ctx([])) as PoolCreatedEvent;
    s.apply({ ...init, blockNumber: 5 });
    const add = decodeLog(raw(fx.modifyLiquidity), ctx([pool])) as LiquidityEvent;
    s.apply({ ...add, blockNumber: 5, timestamp: 1_700_000_010 });
    const m = s.metrics(TOKEN, 1_700_000_100)!;
    expect(m.launchObserved).toBe(true);
    expect(m.priceUnitUsd).toBeGreaterThan(0);
    const buy = decodeLog(raw(fx.swapBuy), ctx([pool], fx.buyTx)) as SwapEvent;
    s.apply({ ...buy, blockNumber: 6, timestamp: 1_700_000_050 });
    expect(s.tradesOf(TOKEN)[0]!.usd).toBeCloseTo((Number(buy.quoteAmount) / 1e18) * 2000, 6);
  });
});

test("stored V4 liquidity events revive their nested bigint", () => {
  db.openDb(":memory:");
  try {
    const evt = decodeLog(raw(fx.modifyLiquidity), ctx([pool])) as LiquidityEvent;
    db.insertEvents([evt]);
    expect(db.loadEvents(8453)[0]).toEqual(evt);
  } finally {
    db.closeDb();
  }
});
