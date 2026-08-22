import { afterEach, describe, expect, test } from "bun:test";
import { fetchTokenPriceForPool } from "../src/ingest/dexscreener.ts";

const TOKEN = "0x" + "aa".repeat(20);
const POOL = "0x" + "bb".repeat(20);

const pair = (overrides: Record<string, unknown> = {}) => ({
  chainId: "ethereum",
  pairAddress: POOL,
  baseToken: { address: TOKEN, symbol: "TEST" },
  quoteToken: { address: "0x" + "cc".repeat(20), symbol: "WETH" },
  priceNative: "0.01",
  volume: { h24: 1000 },
  liquidity: { usd: 100 },
  ...overrides,
});

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("DexScreener performance observations", () => {
  test("pins the lookup to the session pool", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify([pair()]), { status: 200 })) as unknown as typeof fetch;
    const result = await fetchTokenPriceForPool(1, TOKEN, POOL);
    expect(result.kind).toBe("price");
    if (result.kind === "price") expect(result.value.poolAddress).toBe(POOL);
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
});
