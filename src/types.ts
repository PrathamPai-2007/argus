// Standard normalized events (PLAN.md §5). All chain adapters emit these.

export type Address = string; // lowercase 0x-prefixed

export interface BaseEvent {
  chainId: number;
  blockNumber: number;
  transactionIndex?: number;
  logIndex: number;
  txHash: string;
  timestamp: number; // unix seconds
}

export interface StandardTransferEvent extends BaseEvent {
  kind: "transfer";
  tokenAddress: Address;
  sender: Address;
  receiver: Address;
  amount: bigint;
}

export interface SwapEvent extends BaseEvent {
  kind: "swap";
  poolAddress: Address;
  tokenAddress: Address; // the watched-token side of the pair
  buyer: Address;
  direction: "buy" | "sell";
  tokenAmount: bigint;
  quoteAmount: bigint;
}

export interface PoolCreatedEvent extends BaseEvent {
  kind: "pool_created";
  factory: string;
  poolAddress: Address;
  token0: Address;
  token1: Address;
}

export type FundingMethod = "native_transfer" | "disperse" | "internal_call";

export interface FundingEvent extends BaseEvent {
  kind: "funding";
  funder: Address;
  funded: Address;
  amount: bigint;
  method: FundingMethod;
}

export type StandardEvent = StandardTransferEvent | SwapEvent | PoolCreatedEvent | FundingEvent;
export type EventKind = StandardEvent["kind"];

// ---- Signals & alerts ------------------------------------------------------

export type RuleId = "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7" | "R8";

export interface Signal {
  id?: number;
  chainId: number;
  tokenAddress: Address;
  ruleId: RuleId;
  weight: number;
  evidence: Record<string, unknown>;
  blockNumber: number;
  timestamp: number;
  sourceTxHash?: string | null;
  sourceLogIndex?: number | null;
  finalized?: boolean;
  retracted?: boolean;
  score?: number;
  severity?: Severity | null;
  outcome?: "below_threshold" | "alert_created" | "alert_suppressed";
  outcomeReason?: string | null;
  alertId?: number | null;
}

export type Severity = "info" | "alert" | "critical";

export interface AlertPayload {
  chainId: number;
  tokenAddress: Address;
  score: number;
  severity: Severity;
  signals: Signal[];
  headline: string;
  lines: string[];
  links: { dexscreener: string; bubblemaps: string; dashboard: string };
}

export interface AlertRecord extends AlertPayload {
  id: number;
  confirmed: boolean;
  retracted: boolean;
  createdAt: number;
}

export type PerformanceWatchStatus =
  | "pending"
  | "evaluating"
  | "opened"
  | "skipped_stale_swap"
  | "skipped_no_pool"
  | "skipped_invalid_price"
  | "skipped_liquidity_unavailable"
  | "provider_error";

// ---- Token metadata ---------------------------------------------------------

export interface TokenMeta {
  chainId: number;
  address: Address;
  symbol: string | null;
  decimals: number | null;
  totalSupply: bigint | null;
  source: "manual" | "factory" | "ranked" | "candidate";
}

export type CandidateStatus = "discovered" | "evaluating" | "promoted" | "rejected" | "expired";

export interface TokenCandidate {
  chainId: number;
  address: Address;
  source: "factory" | "ranked" | "wallet_cohort";
  status: CandidateStatus;
  score: number;
  evidence: Record<string, unknown>;
  firstSeenAt: number;
  lastEvaluatedAt: number | null;
  expiresAt: number;
}

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const DEAD_ADDRESSES = new Set([
  ZERO_ADDRESS,
  "0x000000000000000000000000000000000000dead",
]);
