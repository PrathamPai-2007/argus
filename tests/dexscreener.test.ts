import { afterEach, describe, expect, test } from "bun:test";
import { rankStablecoinVolume } from "../src/ingest/dexscreener.ts";

const originalFetch = globalThis.fetch;
const USDC = "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDT = "dac17f958d2ee523a2206206994597c13d831ec7";
const DAI = "6b175474e89094c44da98b954eedeac495271d0f";

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("DexScreener volume ranking", () => {
  test("aggregates Ethereum stablecoin-quoted pair volume", async () => {
    const tokenA = "0x" + "aa".repeat(20);
    const tokenB = "0x" + "bb".repeat(20);
    let calls = 0;
    globalThis.fetch = (async (input: unknown) => {
      calls++;
      const url = String(input);
      const stable = url.includes(USDC) ? "0x" + USDC : url.includes(USDT) ? "0x" + USDT : "0x" + DAI;
      const pairs = stable.toLowerCase().includes(USDC)
        ? [
            { chainId: "ethereum", pairAddress: "0x" + "11".repeat(20), baseToken: { address: tokenA }, quoteToken: { address: stable }, volume: { h1: 100 } },
            { chainId: "bsc", pairAddress: "0x" + "22".repeat(20), baseToken: { address: tokenB }, quoteToken: { address: stable }, volume: { h1: 999 } },
          ]
        : stable.toLowerCase().includes(USDT)
          ? [{ chainId: "ethereum", pairAddress: "0x" + "33".repeat(20), baseToken: { address: tokenA }, quoteToken: { address: stable }, volume: { h1: 50 } }]
          : [{ chainId: "ethereum", pairAddress: "0x" + "44".repeat(20), baseToken: { address: tokenB }, quoteToken: { address: stable }, volume: { h1: 200 } }];
      return new Response(JSON.stringify({ pairs }));
    }) as unknown as typeof fetch;

    const ranked = await rankStablecoinVolume(1, 10);

    expect(calls).toBe(3);
    expect(ranked.map((token) => [token.address, token.volume])).toEqual([
      [tokenB, 200],
      [tokenA, 150],
    ]);
    expect(ranked[0]?.pools).toHaveLength(1);
  });
});
