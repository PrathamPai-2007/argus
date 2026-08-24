import type { Address, SwapEvent } from "./types.ts";

export const PERFORMANCE_WINDOW_SECS = 12 * 60 * 60;
export const PERFORMANCE_TARGET_BPS = 15_000;
export const PERFORMANCE_STOP_BPS = 8_000;
export const PRICE_SCALE = 1_000_000_000_000_000_000n;

const KNOWN_DECIMALS: Record<string, number> = {
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": 6,
  "0xdac17f958d2ee523a2206206994597c13d831ec7": 6,
  "0x6b175474e89094c44da98b954eedeac495271d0f": 18,
};

export type PerformanceOutcome = "active" | "target_hit" | "stop_hit" | "expired" | "retracted" | "invalid_price";

export interface PerformanceSession {
  id: number;
  alert_id: number;
  chain_id: number;
  token_address: Address;
  pool_address: Address;
  quote_token: Address | null;
  entry_price: bigint;
  current_price: bigint;
  target_price: bigint;
  stop_price: bigint;
  opened_at: number;
  expires_at: number;
  closed_at: number | null;
  outcome: PerformanceOutcome;
  entry_block: number;
  last_block: number;
  min_price: bigint;
  max_price: bigint;
  updated_at: number;
  last_poll_at: number | null;
  missing_observations: number;
  close_reason: string | null;
  entry_source: string;
  last_observation_source: string | null;
  last_observation_block: number | null;
}

export interface PerformanceUpdate {
  outcome: PerformanceOutcome;
  currentPrice: bigint;
  minPrice: bigint;
  maxPrice: bigint;
  closedAt: number | null;
}

export type PerformanceEvent =
  | { type: "performance_opened"; session: PerformanceSession }
  | { type: "performance_updated"; session: PerformanceSession }
  | { type: "performance_closed"; session: PerformanceSession }
  | { type: "performance_retracted"; session: PerformanceSession };

/** Pool-relative price. The fixed scale keeps comparisons exact without floating point. */
export function decimalsForAddress(address: string | null | undefined, fallback = 18): number {
  return address ? KNOWN_DECIMALS[address.toLowerCase()] ?? fallback : fallback;
}

/** Return quote-per-token at PRICE_SCALE, correcting raw ERC-20 decimals. */
export function priceFromSwap(
  swap: Pick<SwapEvent, "tokenAmount" | "quoteAmount">,
  tokenDecimals = 18,
  quoteDecimals = 18,
): bigint | null {
  if (swap.tokenAmount <= 0n || swap.quoteAmount <= 0n) return null;
  if (tokenDecimals < 0 || quoteDecimals < 0 || tokenDecimals > 255 || quoteDecimals > 255) return null;
  return (swap.quoteAmount * PRICE_SCALE * 10n ** BigInt(tokenDecimals)) / (swap.tokenAmount * 10n ** BigInt(quoteDecimals));
}

export function thresholds(entryPrice: bigint): { targetPrice: bigint; stopPrice: bigint } {
  return {
    targetPrice: (entryPrice * BigInt(PERFORMANCE_TARGET_BPS)) / 10_000n,
    stopPrice: (entryPrice * BigInt(PERFORMANCE_STOP_BPS)) / 10_000n,
  };
}

export function updateSession(
  session: Pick<PerformanceSession, "entry_price" | "target_price" | "stop_price" | "min_price" | "max_price" | "expires_at" | "outcome">,
  price: bigint,
  timestamp: number,
): PerformanceUpdate {
  const minPrice = price < session.min_price ? price : session.min_price;
  const maxPrice = price > session.max_price ? price : session.max_price;
  if (session.outcome !== "active") {
    return { outcome: session.outcome, currentPrice: price, minPrice, maxPrice, closedAt: null };
  }

  // Sanity check: If price is non-positive or deviates excessively (>20x) from entry in a single step
  // (e.g. quote denomination mismatch or corrupt swap), mark as invalid_price instead of reporting false TP/SL.
  if (price <= 0n || (session.entry_price > 0n && (price > session.entry_price * 20n || price * 20n < session.entry_price))) {
    return { outcome: "invalid_price", currentPrice: price, minPrice, maxPrice, closedAt: timestamp };
  }

  if (timestamp >= session.expires_at) return { outcome: "expired", currentPrice: price, minPrice, maxPrice, closedAt: timestamp };
  // Stop is evaluated before target so a malformed/extreme observation cannot report a win.
  if (price <= session.stop_price) return { outcome: "stop_hit", currentPrice: price, minPrice, maxPrice, closedAt: timestamp };
  if (price >= session.target_price) return { outcome: "target_hit", currentPrice: price, minPrice, maxPrice, closedAt: timestamp };
  return { outcome: "active", currentPrice: price, minPrice, maxPrice, closedAt: null };
}

export function returnBps(entryPrice: bigint, currentPrice: bigint): number | null {
  if (entryPrice <= 0n) return null;
  return Number(((currentPrice - entryPrice) * 10_000n) / entryPrice);
}
