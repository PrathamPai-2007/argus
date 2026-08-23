import type { Address } from "../types.ts";
import { log } from "../logger.ts";

const API_ROOT = "https://api.dexscreener.com";
const REQUEST_TIMEOUT_MS = 10_000;

const STABLECOINS: Record<number, Address[]> = {
  1: [
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    "0xdac17f958d2ee523a2206206994597c13d831ec7",
    "0x6b175474e89094c44da98b954eedeac495271d0f",
  ],
};

interface DexPair {
  chainId?: string;
  pairAddress?: string;
  baseToken?: { address?: string; symbol?: string; name?: string };
  quoteToken?: { address?: string; symbol?: string; name?: string };
  priceUsd?: string;
  priceNative?: string;
  volume?: { h1?: number; h24?: number };
  liquidity?: { usd?: number | null };
  pairCreatedAt?: number;
}

interface RankedPool {
  poolAddress: Address;
  tokenAddress: Address;
  quoteToken: Address;
  volume: number;
  liquidityUsd: number | null;
  createdAt: number | null;
}

export interface RankedToken {
  chainId: number;
  address: Address;
  volume: number;
  pools: RankedPool[];
}

function isAddress(value: unknown): value is Address {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function asPairs(value: unknown): DexPair[] {
  if (!value) return [];
  if (Array.isArray(value)) return value as DexPair[];
  if (typeof value === "object") {
    const pairs = (value as { pairs?: unknown }).pairs;
    return Array.isArray(pairs) ? (pairs as DexPair[]) : [];
  }
  return [];
}

async function fetchPairs(chainId: number, stablecoin: Address): Promise<DexPair[]> {
  const url = `${API_ROOT}/token-pairs/v1/${chainId === 1 ? "ethereum" : String(chainId)}/${stablecoin}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { "user-agent": "argus" } });
  if (!response.ok) throw new Error(`DexScreener HTTP ${response.status}`);
  return asPairs(await response.json());
}

export interface TokenPrice {
  price: bigint;
  poolAddress: Address;
  quoteToken: Address;
  symbol?: string | undefined;
  liquidityUsd: number | null;
  volumeUsd: number | null;
}

export type TokenPriceObservation =
  | { kind: "price"; value: TokenPrice }
  | { kind: "pool_missing" }
  | { kind: "liquidity_lost" }
  | { kind: "provider_error" };

/** Fetch current pool-relative token price and DEX pool details for any token from DexScreener as fallback. */
export async function fetchTokenPrice(chainId: number, token: Address): Promise<TokenPrice | null> {
  const observation = await fetchTokenPriceForPool(chainId, token);
  return observation.kind === "price" ? observation.value : null;
}

/** Fetch a price while keeping the performance session pinned to its original pool. */
export async function fetchTokenPriceForPool(chainId: number, token: Address, poolAddress?: Address): Promise<TokenPriceObservation> {
  const chainName = chainId === 1 ? "ethereum" : String(chainId);
  const url = `${API_ROOT}/tokens/v1/${chainName}/${token}`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { "user-agent": "argus" } });
    if (!response.ok) return { kind: "provider_error" };
    const pairs = asPairs(await response.json());
    if (pairs.length === 0) return { kind: "pool_missing" };

    const wantedPool = poolAddress?.toLowerCase();
    const best = wantedPool
      ? pairs.find((pair) => pair.pairAddress?.toLowerCase() === wantedPool)
      : pairs.sort((a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0))[0];
    if (!best) return { kind: "pool_missing" };

    const baseAddr = best.baseToken?.address?.toLowerCase() as Address | undefined;
    const quoteAddr = best.quoteToken?.address?.toLowerCase() as Address | undefined;
    const poolAddr = best.pairAddress?.toLowerCase() as Address | undefined;
    const priceUsdStr = best.priceUsd;
    const priceNativeStr = best.priceNative;
    if (!baseAddr || !quoteAddr || !poolAddr) return { kind: "pool_missing" };

    const isBase = baseAddr === token.toLowerCase();
    const priceUsd = typeof priceUsdStr === "string" ? parseFloat(priceUsdStr) : null;
    const priceNative = typeof priceNativeStr === "string" ? parseFloat(priceNativeStr) : null;
    // DexScreener reports the base token's price. Invert it when the watched
    // token is the quote side so this remains quote-per-watched-token.
    const basePrice = priceNative ?? priceUsd;
    const effPrice = isBase ? basePrice : (basePrice !== null && basePrice > 0 ? 1 / basePrice : null);
    if (effPrice === null || !isFinite(effPrice) || effPrice < 0) return { kind: "pool_missing" };
    if (effPrice === 0 || (best.liquidity?.usd !== null && best.liquidity?.usd !== undefined && best.liquidity.usd <= 0)) {
      return { kind: "liquidity_lost" };
    }

    const str = effPrice.toFixed(18);
    const parts = str.split(".");
    const scaledPrice = parts.length === 2 ? BigInt((parts[0] ?? "0") + (parts[1] ?? "").slice(0, 18).padEnd(18, "0")) : null;
    if (scaledPrice === null) return { kind: "pool_missing" };
    return { kind: "price", value: {
      price: scaledPrice,
      poolAddress: poolAddr,
      quoteToken: isBase ? quoteAddr : baseAddr,
      symbol: isBase ? best.baseToken?.symbol : best.quoteToken?.symbol,
      liquidityUsd: typeof best.liquidity?.usd === "number" ? best.liquidity.usd : null,
      volumeUsd: typeof best.volume?.h24 === "number" ? best.volume.h24 : null,
    } };
  } catch (err) {
    log.warn("DexScreener fetchTokenPrice failed", { chainId, token, err });
    return { kind: "provider_error" };
  }
}

/** Return top tokens by recent stablecoin-quoted DEX volume for one chain. */
export async function rankStablecoinVolume(chainId: number, topN: number): Promise<RankedToken[]> {
  const stablecoins = STABLECOINS[chainId] ?? [];
  if (stablecoins.length === 0) return [];

  const stableSet = new Set(stablecoins.map((s) => s.toLowerCase()));
  const totals = new Map<Address, { volume: number; pools: RankedPool[] }>();
  for (const stablecoin of stablecoins) {
    let pairs: DexPair[] = await fetchPairs(chainId, stablecoin);
    for (const pair of pairs) {
      const base = pair.baseToken?.address?.toLowerCase();
      const quote = pair.quoteToken?.address?.toLowerCase();
      const pool = pair.pairAddress?.toLowerCase();
      if (!isAddress(base) || !isAddress(quote) || !isAddress(pool)) continue;
      const expectedChain = chainId === 1 ? "ethereum" : String(chainId);
      if (pair.chainId !== expectedChain) continue;

      const isBaseStable = stableSet.has(base);
      const isQuoteStable = stableSet.has(quote);
      if (isBaseStable && isQuoteStable) continue;
      if (!isBaseStable && !isQuoteStable) continue;

      const targetToken = (isQuoteStable ? base : quote) as Address;
      const quoteToken = (isQuoteStable ? quote : base) as Address;

      const h1Vol = typeof pair.volume?.h1 === "number" && Number.isFinite(pair.volume.h1) && pair.volume.h1 > 0 ? pair.volume.h1 : 0;
      const h24Vol = typeof pair.volume?.h24 === "number" && Number.isFinite(pair.volume.h24) && pair.volume.h24 > 0 ? pair.volume.h24 / 24 : 0;
      const volume = h1Vol > 0 ? h1Vol : h24Vol;
      if (volume <= 0) continue;

      const rankedPool: RankedPool = {
        poolAddress: pool,
        tokenAddress: targetToken,
        quoteToken: quoteToken,
        volume,
        liquidityUsd: typeof pair.liquidity?.usd === "number" ? pair.liquidity.usd : null,
        createdAt: typeof pair.pairCreatedAt === "number" ? Math.floor(pair.pairCreatedAt / 1000) : null,
      };
      const current = totals.get(targetToken) ?? { volume: 0, pools: [] };
      current.volume += volume;
      current.pools.push(rankedPool);
      totals.set(targetToken, current);
    }
  }

  return [...totals.entries()]
    .sort((a, b) => b[1].volume - a[1].volume)
    .slice(0, topN)
    .map(([address, value]) => ({ chainId, address, volume: value.volume, pools: value.pools.sort((a, b) => b.volume - a.volume) }));
}
