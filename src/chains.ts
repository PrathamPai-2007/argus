import type { Address } from "./model.ts";

// Static per-chain DEX knowledge. Every address here was verified on-chain
// (symbol/decimals for quotes, factory.getPair/getPool and token0/token1 for
// reference pools, bytecode for the V4 PoolManagers). Pools are oriented at
// registration against this table, so a quote token is never mistaken for the
// traded token regardless of address sort order.

export type DexVersion = "v2" | "v3" | "v4";

export interface FactoryInfo {
  /** Factory contract, or the V4 PoolManager singleton (pools live inside it). */
  address: Address;
  dex: DexVersion;
  name: string;
}

/**
 * How a quote token gets its USD price:
 * - stable: pegged at $1
 * - native: wrapped/native gas token, priced by the chain's native reference pool
 * - ref: priced by its own reference pool in `priceRefs`
 */
export type QuotePricing = "stable" | "native" | "ref";

export interface QuoteInfo {
  symbol: string;
  decimals: number;
  pricing: QuotePricing;
}

/** A deep pool against USDC whose post-swap price sets `base`'s USD price. */
export interface PriceRef {
  address: Address;
  dex: "v3";
  token0: Address;
  token1: Address;
  /** Token priced by this pool (wrapped native, ZORA, VIRTUAL, …). */
  base: Address;
  /** USD stablecoin it is priced against. */
  usd: Address;
}

export interface ChainInfo {
  chainId: number;
  name: string;
  nativeSymbol: string;
  wrappedNative: Address;
  quotes: Record<Address, QuoteInfo>;
  factories: FactoryInfo[];
  /** First entry prices the wrapped native token; others price `ref` quotes. */
  priceRefs: PriceRef[];
  explorer: string;
  dexscreener: string;
}

/** Native ETH as a V4 currency (address(0)). */
export const NATIVE = "0x0000000000000000000000000000000000000000";

export const CHAINS: Record<number, ChainInfo> = {
  1: {
    chainId: 1,
    name: "Ethereum",
    nativeSymbol: "ETH",
    wrappedNative: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    quotes: {
      [NATIVE]: { symbol: "ETH", decimals: 18, pricing: "native" },
      "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": { symbol: "WETH", decimals: 18, pricing: "native" },
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC", decimals: 6, pricing: "stable" },
      "0xdac17f958d2ee523a2206206994597c13d831ec7": { symbol: "USDT", decimals: 6, pricing: "stable" },
      "0x6b175474e89094c44da98b954eedeac495271d0f": { symbol: "DAI", decimals: 18, pricing: "stable" },
    },
    factories: [
      { address: "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f", dex: "v2", name: "uniswap-v2" },
      { address: "0x1f98431c8ad98523631ae4a59f267346ea31f984", dex: "v3", name: "uniswap-v3" },
      { address: "0x000000000004444c5dc75cb358380d2e3de08a90", dex: "v4", name: "uniswap-v4" },
    ],
    priceRefs: [
      // USDC (token0) / WETH (token1), 0.05%
      { address: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640", dex: "v3", token0: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", token1: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", base: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", usd: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" },
    ],
    explorer: "https://etherscan.io",
    dexscreener: "ethereum",
  },
  8453: {
    chainId: 8453,
    name: "Base",
    nativeSymbol: "ETH",
    wrappedNative: "0x4200000000000000000000000000000000000006",
    quotes: {
      [NATIVE]: { symbol: "ETH", decimals: 18, pricing: "native" },
      "0x4200000000000000000000000000000000000006": { symbol: "WETH", decimals: 18, pricing: "native" },
      "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { symbol: "USDC", decimals: 6, pricing: "stable" },
      // Zora coins and Virtuals agents launch against these; each is priced by its USDC pool.
      "0x1111111111166b7fe7bd91427724b487980afc69": { symbol: "ZORA", decimals: 18, pricing: "ref" },
      "0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b": { symbol: "VIRTUAL", decimals: 18, pricing: "ref" },
    },
    factories: [
      { address: "0x8909dc15e40173ff4699343b6eb8132c65e18ec6", dex: "v2", name: "uniswap-v2" },
      { address: "0x33128a8fc17869897dce68ed026d694621f6fdfd", dex: "v3", name: "uniswap-v3" },
      { address: "0x498581ff718922c3f8e6a244956af099b2652b2b", dex: "v4", name: "uniswap-v4" },
    ],
    priceRefs: [
      // WETH (token0) / USDC (token1), 0.05%
      { address: "0xd0b53d9277642d899df5c87a3966a349a798f224", dex: "v3", token0: "0x4200000000000000000000000000000000000006", token1: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", base: "0x4200000000000000000000000000000000000006", usd: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
      // ZORA (token0) / USDC (token1), 0.3%
      { address: "0xedc625b74537ee3a10874f53d170e9c17a906b9c", dex: "v3", token0: "0x1111111111166b7fe7bd91427724b487980afc69", token1: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", base: "0x1111111111166b7fe7bd91427724b487980afc69", usd: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
      // VIRTUAL (token0) / USDC (token1), 0.3%
      { address: "0x529d2863a1521d0b57db028168fde2e97120017c", dex: "v3", token0: "0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b", token1: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", base: "0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b", usd: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
    ],
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

export function priceRef(chainId: number, pool: Address): PriceRef | undefined {
  return CHAINS[chainId]?.priceRefs.find((r) => r.address === pool);
}

/** The pool-ref shape used for registering a price reference with sync/state. */
export function priceRefPool(r: PriceRef) {
  return { address: r.address, dex: r.dex, token0: r.token0, token1: r.token1, token: r.base, quote: r.usd };
}

/**
 * Orient a pair: which side is the traded token and which is the quote.
 * Returns null when neither or both sides are known quotes (e.g. WETH/USDC,
 * ZORA/ETH, or two unknown tokens) — such pools carry no tradable-token signal.
 */
export function orientPair(chainId: number, token0: Address, token1: Address): { token: Address; quote: Address } | null {
  const q0 = quoteInfo(chainId, token0) !== undefined;
  const q1 = quoteInfo(chainId, token1) !== undefined;
  if (q0 === q1) return null;
  return q0 ? { token: token1.toLowerCase(), quote: token0.toLowerCase() } : { token: token0.toLowerCase(), quote: token1.toLowerCase() };
}
