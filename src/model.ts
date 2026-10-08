// Domain model: normalized chain facts (events) and the judgements derived
// from them (signals, assessments). Events are facts; everything else is
// rebuildable by replaying them.

import type { DexVersion } from "./chains.ts";

export type Address = string; // lowercase 0x-prefixed
export type { DexVersion };

export interface EventBase {
  chainId: number;
  blockNumber: number;
  transactionIndex: number;
  logIndex: number;
  txHash: string;
  timestamp: number; // unix seconds
}

/** ERC-20 Transfer of a watched token. */
export interface TransferEvent extends EventBase {
  kind: "transfer";
  token: Address;
  from: Address;
  to: Address;
  amount: bigint;
}

/**
 * A trade against a registered pool, oriented to the traded token.
 * `trader` is the transaction signer (tx.from), never the router or pool
 * recipient, so bots and aggregators resolve to the wallet that paid gas.
 */
export interface SwapEvent extends EventBase {
  kind: "swap";
  pool: Address;
  dex: DexVersion;
  token: Address;
  quote: Address;
  side: "buy" | "sell";
  tokenAmount: bigint;
  quoteAmount: bigint;
  trader: Address;
  /** tx nonce of the trader at this trade: 0 means the wallet's very first transaction. */
  traderNonce: number | null;
  recipient: Address;
  /** V3 post-swap price; null for V2 (reserves arrive via a `reserves` event). */
  sqrtPriceX96: bigint | null;
}

/** Uniswap V2 Sync: absolute pool reserves after a swap/mint/burn. */
export interface ReservesEvent extends EventBase {
  kind: "reserves";
  pool: Address;
  token: Address;
  quote: Address;
  tokenReserve: bigint;
  quoteReserve: bigint;
}

/** Liquidity added to or removed from a pool (V2 Mint/Burn, V3 Mint/Burn). */
export interface LiquidityEvent extends EventBase {
  kind: "liquidity";
  pool: Address;
  dex: DexVersion;
  token: Address;
  quote: Address;
  action: "add" | "remove";
  tokenAmount: bigint;
  quoteAmount: bigint;
  provider: Address;
}

export interface PoolCreatedEvent extends EventBase {
  kind: "pool_created";
  pool: Address;
  dex: DexVersion;
  factory: Address;
  token0: Address;
  token1: Address;
  fee: number | null;
}

export type FundingMethod = "native_transfer" | "disperse";

/** Native-token funding edge (gas money), the backbone of wallet clustering. */
export interface FundingEvent extends EventBase {
  kind: "funding";
  funder: Address;
  funded: Address;
  amount: bigint;
  method: FundingMethod;
}

export type ChainEvent = TransferEvent | SwapEvent | ReservesEvent | LiquidityEvent | PoolCreatedEvent | FundingEvent;
export type EventKind = ChainEvent["kind"];

/** Total order of events within a chain: block, tx, log. */
export function compareEvents(a: EventBase, b: EventBase): number {
  return a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex;
}

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const DEAD_ADDRESS = "0x000000000000000000000000000000000000dead";
export const BURN_ADDRESSES: ReadonlySet<Address> = new Set([ZERO_ADDRESS, DEAD_ADDRESS]);
