import { afterEach, describe, expect, test } from "bun:test";
import { fetchTokenPriceForPool, clearPriceCache } from "../src/ingest/dexscreener.ts";

const TOKEN = "0x" + "aa".repeat(20);
const POOL = "0x" + "bb".repeat(20);
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

const pair = (overrides: Record<string, unknown> = {}) => ({
  chainId: "ethereum",
  pairAddress: POOL,
  baseToken: { address: TOKEN, symbol: "TEST" },
  quoteToken: { address: WETH, symbol: "WETH" },
  priceNative: "0.01",
  priceUsd: "25",
  volume: { h24: 1000 },
  liquidity: { usd: 100 },
  ...overrides,
});

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearPriceCache();
});

describe("DexScreener performance observations", () => {
  test("pins the lookup to the session pool", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify([pair()]), { status: 200 })) as unknown as typeof fetch;
    const result = await fetchTokenPriceForPool(1, TOKEN, POOL);
    expect(result.kind).toBe("price");
    if (result.kind === "price") {
      expect(result.value.poolAddress).toBe(POOL);
      expect(result.value.price).toBe(10_000_000_000_000_000n); // 0.01 WETH per token @ 1e18
    }
  });

  test("does not substitute another pool", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify([pair({ pairAddress: "0x" + "dd".repeat(20) })]), { status: 200 })) as unknown as typeof fetch;
    expect((await fetchTokenPriceForPool(1, TOKEN, POOL)).kind).toBe("pool_missing");
  });

  test("reports zero-liquidity observations separately", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify([pair({ liquidity: { usd: 0 } })]), { status: 200 })) as unknown as typeof fetch;
    expect((await fetchTokenPriceForPool(1, TOKEN, POOL)).kind).toBe("liquidity_lost");
  });

  test("does not treat provider errors as liquidation", async () => {
    globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch;
    expect((await fetchTokenPriceForPool(1, TOKEN, POOL)).kind).toBe("provider_error");
  });

  test("stablecoin quotes derive from the USD price, never the native price", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify([pair({ quoteToken: { address: USDC, symbol: "USDC" } })]), { status: 200 })) as unknown as typeof fetch;
    const result = await fetchTokenPriceForPool(1, TOKEN, POOL);
    expect(result.kind).toBe("price");
    if (result.kind === "price") expect(result.value.price).toBe(25_000_000_000_000_000_000n);
  });

  test("refuses unknown quote denominations instead of guessing", async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify([pair({ quoteToken: { address: "0x" + "ee".repeat(20), symbol: "WEIRD" } })]),
      { status: 200 },
    )) as unknown as typeof fetch;
    expect((await fetchTokenPriceForPool(1, TOKEN, POOL)).kind).toBe("pool_missing");
  });

  test("exponential-notation prices are refused, not crashed on", async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify([pair({ priceUsd: "2e+21", priceNative: undefined })]),
      { status: 200 },
    )) as unknown as typeof fetch;
    expect((await fetchTokenPriceForPool(1, TOKEN, POOL)).kind).toBe("pool_missing");
  });

  test("never inverts a cross-denominated price when the token is not the base", async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify([{ ...pair(), baseToken: { address: "0x" + "11".repeat(20), symbol: "OTHER" }, quoteToken: { address: TOKEN, symbol: "TEST" } }]),
      { status: 200 },
    )) as unknown as typeof fetch;
    expect((await fetchTokenPriceForPool(1, TOKEN, POOL)).kind).toBe("pool_missing");
  });
});
