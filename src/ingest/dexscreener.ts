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

/**
 * Quote tokens whose denomination we can honestly convert into a pool-relative
 * price: `priceNative` is quoted in the chain's native wrapper (WETH), and
 * stablecoin prices equal their USD price. Anything else cannot be priced
 * without guessing, so we refuse instead of returning a wrong number.
 */
const KNOWN_QUOTE_KIND: Record<string, "native" | "stable"> = {
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": "native",
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "stable",
  "0xdac17f958d2ee523a2206206994597c13d831ec7": "stable",
  "0x6b175474e89094c44da98b954eedeac495271d0f": "stable",
};

function scalePriceTo18(value: number): bigint | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  // toFixed switches to exponential notation ("2e+21") for huge values,
  // which BigInt cannot parse; refuse instead of throwing.
  const [intPart = "0", fracPart = ""] = value.toFixed(18).split(".");
  if (!/^\d+$/.test(intPart || "")) return null;
  const scaled = BigInt((intPart || "0") + fracPart.slice(0, 18).padEnd(18, "0"));
  return scaled > 0n ? scaled : null;
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

const priceCache = new Map<string, { val: Promise<TokenPriceObservation>; expires: number }>();

export function clearPriceCache() {
  priceCache.clear();
}

/** Fetch a price while keeping the performance session pinned to its original pool. */
export function fetchTokenPriceForPool(chainId: number, token: Address, poolAddress?: Address): Promise<TokenPriceObservation> {
  const cacheKey = `${chainId}-${token}-${poolAddress || ""}`;
  const now = Date.now();
  const cached = priceCache.get(cacheKey);
  if (cached && cached.expires > now) {
    return cached.val;
  }

  const promise = (async (): Promise<TokenPriceObservation> => {
    const chainName = chainId === 1 ? "ethereum" : String(chainId);
    const url = `${API_ROOT}/tokens/v1/${chainName}/${token}`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { "user-agent": "argus" } });
      if (!response.ok) return { kind: "provider_error" };
      const pairs = asPairs(await response.json());
      if (pairs.length === 0) return { kind: "pool_missing" };

      const tokenAddr = token.toLowerCase();
      const wantedPool = poolAddress?.toLowerCase();
      // Pool-relative price is only well-defined when the watched token is the
      // pair's base side; never invert a cross-denominated price to force a fit.
      const ordered = wantedPool
        ? pairs.filter((pair) => pair.pairAddress?.toLowerCase() === wantedPool)
        : pairs.sort((a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0));
      const best = ordered.find((pair) => {
        if (pair.baseToken?.address?.toLowerCase() !== tokenAddr) return false;
        return KNOWN_QUOTE_KIND[pair.quoteToken?.address?.toLowerCase() ?? ""] !== undefined;
      });
      if (!best) return { kind: "pool_missing" };

      const quoteAddr = best.quoteToken?.address?.toLowerCase() as Address;
      const poolAddr = best.pairAddress?.toLowerCase() as Address;
      const priceUsd = typeof best.priceUsd === "string" ? parseFloat(best.priceUsd) : null;
      const priceNative = typeof best.priceNative === "string" ? parseFloat(best.priceNative) : null;
      const kind = KNOWN_QUOTE_KIND[quoteAddr];
      const rawPrice = kind === "native" ? priceNative : priceUsd;
      if (!poolAddr || rawPrice === null || !isFinite(rawPrice) || rawPrice <= 0) return { kind: "pool_missing" };
      if (best.liquidity?.usd !== null && best.liquidity?.usd !== undefined && best.liquidity.usd <= 0) {
        return { kind: "liquidity_lost" };
      }

      const scaledPrice = scalePriceTo18(rawPrice);
      if (scaledPrice === null) return { kind: "pool_missing" };
      return { kind: "price", value: {
        price: scaledPrice,
        poolAddress: poolAddr,
        quoteToken: quoteAddr,
        symbol: best.baseToken?.symbol,
        liquidityUsd: typeof best.liquidity?.usd === "number" ? best.liquidity.usd : null,
        volumeUsd: typeof best.volume?.h24 === "number" ? best.volume.h24 : null,
      } };
    } catch (err) {
      log.warn("DexScreener fetchTokenPrice failed", { chainId, token, err });
      return { kind: "provider_error" };
    }
  })();

  priceCache.set(cacheKey, { val: promise, expires: now + 5000 });
  return promise;
}

/** Return top tokens by recent stablecoin-quoted DEX volume for one chain. */
export async function rankStablecoinVolume(chainId: number, topN: number): Promise<RankedToken[]> {
  const stablecoins = STABLECOINS[chainId] ?? [];
  if (stablecoins.length === 0) return [];

  const stableSet = new Set(stablecoins.map((s) => s.toLowerCase()));
  const totals = new Map<Address, { volume: number; pools: RankedPool[] }>();
  for (const stablecoin of stablecoins) {
    let pairs: DexPair[] = [];
    try {
      pairs = await fetchPairs(chainId, stablecoin);
    } catch (err) {
      log.warn("DexScreener fetchPairs failed for stablecoin", { chainId, stablecoin, err });
      continue;
    }
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
