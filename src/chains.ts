import type { Address } from "./model.ts";

// Static per-chain DEX knowledge. Every address here was verified on-chain
// (symbol/decimals for quotes, factory.getPair/getPool for reference pools).
// Pools are oriented at registration time against this table, so a quote token
// is never mistaken for the traded token regardless of address sort order.

export type DexVersion = "v2" | "v3";

export interface FactoryInfo {
  address: Address;
  dex: DexVersion;
  name: string;
}

export interface QuoteInfo {
  symbol: string;
  decimals: number;
  /** USD-pegged stablecoin (price 1) vs the chain's wrapped native token (priced via `nativeUsdPool`). */
  stable: boolean;
}

export interface ChainInfo {
  chainId: number;
  name: string;
  nativeSymbol: string;
  wrappedNative: Address;
  quotes: Record<Address, QuoteInfo>;
  factories: FactoryInfo[];
  /** Deep wrapped-native/USDC V3 pool whose swaps set the native USD price. */
  nativeUsdPool: { address: Address; dex: DexVersion; token0: Address; token1: Address };
  explorer: string;
  dexscreener: string;
}

export const CHAINS: Record<number, ChainInfo> = {
  1: {
    chainId: 1,
    name: "Ethereum",
    nativeSymbol: "ETH",
    wrappedNative: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    quotes: {
      "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": { symbol: "WETH", decimals: 18, stable: false },
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC", decimals: 6, stable: true },
      "0xdac17f958d2ee523a2206206994597c13d831ec7": { symbol: "USDT", decimals: 6, stable: true },
      "0x6b175474e89094c44da98b954eedeac495271d0f": { symbol: "DAI", decimals: 18, stable: true },
    },
    factories: [
      { address: "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f", dex: "v2", name: "uniswap-v2" },
      { address: "0x1f98431c8ad98523631ae4a59f267346ea31f984", dex: "v3", name: "uniswap-v3" },
    ],
    // USDC (token0) / WETH (token1), 0.05%
    nativeUsdPool: {
      address: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
      dex: "v3",
      token0: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      token1: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    },
    explorer: "https://etherscan.io",
    dexscreener: "ethereum",
  },
  8453: {
    chainId: 8453,
    name: "Base",
    nativeSymbol: "ETH",
    wrappedNative: "0x4200000000000000000000000000000000000006",
    quotes: {
      "0x4200000000000000000000000000000000000006": { symbol: "WETH", decimals: 18, stable: false },
      "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { symbol: "USDC", decimals: 6, stable: true },
    },
    factories: [
      { address: "0x8909dc15e40173ff4699343b6eb8132c65e18ec6", dex: "v2", name: "uniswap-v2" },
      { address: "0x33128a8fc17869897dce68ed026d694621f6fdfd", dex: "v3", name: "uniswap-v3" },
    ],
    // WETH (token0) / USDC (token1), 0.05%
    nativeUsdPool: {
      address: "0xd0b53d9277642d899df5c87a3966a349a798f224",
      dex: "v3",
      token0: "0x4200000000000000000000000000000000000006",
      token1: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    },
    explorer: "https://basescan.org",
    dexscreener: "base",
  },
};

export function chainInfo(chainId: number): ChainInfo {
  const info = CHAINS[chainId];
  if (!info) throw new Error(`unsupported chain ${chainId} (supported: ${Object.keys(CHAINS).join(", ")})`);
  return info;
}

export function quoteInfo(chainId: number, token: Address): QuoteInfo | undefined {
  return CHAINS[chainId]?.quotes[token.toLowerCase()];
}

export function factoryInfo(chainId: number, address: Address): FactoryInfo | undefined {
  const a = address.toLowerCase();
  return CHAINS[chainId]?.factories.find((f) => f.address === a);
}

/**
 * Orient a pair: which side is the traded token and which is the quote.
 * Returns null when neither or both sides are known quotes (e.g. WETH/USDC,
 * or two unknown tokens) — such pools carry no tradable-token signal.
 */
export function orientPair(chainId: number, token0: Address, token1: Address): { token: Address; quote: Address } | null {
  const q0 = quoteInfo(chainId, token0) !== undefined;
  const q1 = quoteInfo(chainId, token1) !== undefined;
  if (q0 === q1) return null;
  return q0 ? { token: token1.toLowerCase(), quote: token0.toLowerCase() } : { token: token0.toLowerCase(), quote: token1.toLowerCase() };
}
