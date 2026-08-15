import type { Address, SwapEvent } from "./types.ts";

export const PERFORMANCE_WINDOW_SECS = 12 * 60 * 60;
export const PERFORMANCE_TARGET_BPS = 15_000;
export const PERFORMANCE_STOP_BPS = 8_000;
export const PRICE_SCALE = 1_000_000_000_000_000_000n;

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
export function priceFromSwap(swap: Pick<SwapEvent, "tokenAmount" | "quoteAmount">): bigint | null {
  if (swap.tokenAmount <= 0n || swap.quoteAmount <= 0n) return null;
  return (swap.quoteAmount * PRICE_SCALE) / swap.tokenAmount;
}

export function thresholds(entryPrice: bigint): { targetPrice: bigint; stopPrice: bigint } {
  return {
    targetPrice: (entryPrice * BigInt(PERFORMANCE_TARGET_BPS)) / 10_000n,
    stopPrice: (entryPrice * BigInt(PERFORMANCE_STOP_BPS)) / 10_000n,
  };
}

export function updateSession(
  session: Pick<PerformanceSession, "target_price" | "stop_price" | "min_price" | "max_price" | "expires_at" | "outcome">,
  price: bigint,
  timestamp: number,
): PerformanceUpdate {
  const minPrice = price < session.min_price ? price : session.min_price;
  const maxPrice = price > session.max_price ? price : session.max_price;
  if (session.outcome !== "active") {
    return { outcome: session.outcome, currentPrice: price, minPrice, maxPrice, closedAt: null };
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
