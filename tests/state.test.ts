import { describe, expect, test } from "bun:test";
import { CHAINS } from "../src/chains.ts";
import type { ChainEvent, LiquidityEvent, ReservesEvent, SwapEvent, TransferEvent } from "../src/model.ts";
import { ChainState } from "../src/state.ts";

const WETH = CHAINS[1]!.wrappedNative;
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const REF = CHAINS[1]!.nativeUsdPool.address;
const MEME = "0x" + "11".repeat(20);
const POOL = "0x" + "ab".repeat(20);
const DEV = "0x" + "de".repeat(20);
const T0 = 1_700_000_000;
const ETH = 10n ** 18n;
const a = (n: number) => "0x" + n.toString(16).padStart(40, "0");

let logIndex = 0;
const base = (block: number, ts = T0 + block * 12) => ({ chainId: 1, blockNumber: block, transactionIndex: 0, logIndex: logIndex++, txHash: "0x" + block.toString(16).padStart(64, "0"), timestamp: ts });

function swap(block: number, trader: string, side: "buy" | "sell", tokenAmount: bigint, quoteAmount: bigint, nonce: number | null = 50): SwapEvent {
  return { kind: "swap", ...base(block), pool: POOL, dex: "v2", token: MEME, quote: WETH, side, tokenAmount, quoteAmount, trader, traderNonce: nonce, recipient: trader, sqrtPriceX96: null };
}
const reserves = (block: number, tokenReserve: bigint, quoteReserve: bigint): ReservesEvent => ({ kind: "reserves", ...base(block), pool: POOL, token: MEME, quote: WETH, tokenReserve, quoteReserve });
const liq = (block: number, action: "add" | "remove", tokenAmount: bigint, quoteAmount: bigint, provider = DEV): LiquidityEvent => ({ kind: "liquidity", ...base(block), pool: POOL, dex: "v2", token: MEME, quote: WETH, action, tokenAmount, quoteAmount, provider });
const transfer = (block: number, from: string, to: string, amount: bigint): TransferEvent => ({ kind: "transfer", ...base(block), token: MEME, from, to, amount });

/** ETH priced at $2000 via a reference-pool swap, plus a launched MEME/WETH pool with 10 ETH. */
function launched(): ChainState {
  const s = new ChainState(1);
  s.registerPool({ address: REF, dex: "v3", token0: USDC, token: WETH, quote: USDC });
  s.apply({ kind: "swap", ...base(1), pool: REF, dex: "v3", token: WETH, quote: USDC, side: "buy", tokenAmount: ETH, quoteAmount: 2_000_000_000n, trader: a(1), traderNonce: 1, recipient: a(1), sqrtPriceX96: null });
  s.registerPool({ address: POOL, dex: "v2", token0: MEME, token: MEME, quote: WETH }, 10);
  s.setTokenMeta(MEME, { symbol: "MEME", name: null, decimals: 18, totalSupply: 1_000_000n * ETH });
  s.apply(transfer(9, "0x0000000000000000000000000000000000000000", DEV, 1_000_000n * ETH));
  s.apply(transfer(10, DEV, POOL, 800_000n * ETH));
  s.apply(reserves(10, 800_000n * ETH, 10n * ETH));
  s.apply(liq(10, "add", 800_000n * ETH, 10n * ETH));
  return s;
}

describe("ChainState", () => {
  test("prices native via the reference pool and values liquidity in USD", () => {
    const s = launched();
    expect(s.nativeUsd).toBe(2000);
    const m = s.metrics(MEME, T0 + 200)!;
    expect(m.launchObserved).toBe(true);
    expect(m.creator).toBe(DEV);
    expect(m.liquidityUsd).toBe(40_000); // 2 × 10 ETH × $2000
    expect(m.initialLiquidityUsd).toBe(40_000);
    expect(m.priceUnitUsd! * 1e18).toBeCloseTo(10 * 2000 / 800_000, 8);
  });

  test("attributes trades to signers and tracks launch-block buyers", () => {
    const s = launched();
    s.apply(swap(10, a(100), "buy", 50_000n * ETH, ETH, 0)); // fresh sniper in launch block
    s.apply(swap(11, a(101), "buy", 50_000n * ETH, ETH, 1));
    s.apply(swap(20, a(102), "buy", 1_000n * ETH, ETH / 10n, 300));
    const m = s.metrics(MEME, T0 + 20 * 12 + 5)!;
    expect(m.launchBuyers).toBe(2);
    expect(m.launchFreshBuyers).toBe(2);
    expect(m.launchSupplyPct).toBe(10);
    expect(m.w15m.buyUsd).toBeCloseTo(4_200, 6);
    expect(m.w15m.freshBuyers).toBe(2);
  });

  test("rewindTo restores exact prior state", () => {
    const s = launched();
    s.apply(swap(12, a(100), "buy", 10n * ETH, ETH));
    const before = JSON.stringify(s.metrics(MEME, T0 + 1000), (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    s.apply(swap(13, a(101), "sell", 10n * ETH, ETH));
    s.apply(reserves(13, 900n * ETH, 1n * ETH));
    s.apply(liq(14, "remove", 100n * ETH, 9n * ETH));
    s.apply(transfer(14, a(100), a(103), 5n * ETH));
    expect(s.rewindTo(13)).toBe(4);
    expect(JSON.stringify(s.metrics(MEME, T0 + 1000), (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(before);
  });

  test("measures a liquidity pull against the pool before removal", () => {
    const s = launched();
    // V2 burn: Sync (post-burn reserves) precedes Burn in the same tx
    s.apply(reserves(15, 160_000n * ETH, 2n * ETH));
    s.apply(liq(15, "remove", 640_000n * ETH, 8n * ETH));
    const m = s.metrics(MEME, T0 + 15 * 12)!;
    expect(m.maxRemovalFraction).toBeCloseTo(0.8, 5);
    expect(m.liquidityUsd).toBeCloseTo(8_000, 6);
  });

  test("same-block buy+sell marks MEV and excludes it from organic buyers", () => {
    const s = launched();
    s.apply(swap(30, a(200), "buy", ETH, ETH / 100n));
    s.apply(swap(30, a(200), "sell", ETH, ETH / 100n));
    s.apply(swap(31, a(201), "buy", ETH, ETH / 100n));
    const m = s.metrics(MEME, T0 + 31 * 12 + 1)!;
    expect(m.mevTraders).toBe(1);
    expect(m.w15m.buyers).toBe(2);
    expect(m.w15m.organicBuyers).toBe(1);
  });

  test("clusters holders by common non-service funder", () => {
    const s = launched();
    const boss = a(999);
    for (const w of [a(300), a(301), a(302)]) {
      s.setFunding(w, { funder: boss, funderIsService: false });
      s.apply(transfer(40, POOL, w, 100_000n * ETH));
    }
    s.setFunding(a(303), { funder: a(998), funderIsService: true }); // exchange-funded: no grouping
    s.apply(transfer(40, POOL, a(303), 100_000n * ETH));
    const m = s.metrics(MEME, T0 + 1000)!;
    expect(m.topClusterSize).toBe(3);
    expect(m.topClusterPct).toBe(30);
  });
});

test("events not touching registered pools are ignored", () => {
  const s = new ChainState(1);
  const evt: ChainEvent = swap(1, a(1), "buy", 1n, 1n);
  s.apply(evt);
  expect(s.metrics(MEME, T0)).toBeNull();
});
