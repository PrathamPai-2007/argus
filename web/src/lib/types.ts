// API shapes, imported type-only from the server so the contract cannot drift.
export type { AlertRow, ScoreRow, SignalLogRow, WalletStats, TokenRow, PoolRow } from "../../../src/db.ts";
export type { EngineStatus, LiveUpdate } from "../../../src/engine.ts";
export type { Position, TrackRecord, CohortStats, Horizon } from "../../../src/positions.ts";
export type { Signal, Verdict } from "../../../src/signals.ts";

import type { AlertRow, PoolRow, ScoreRow, SignalLogRow, TokenRow } from "../../../src/db.ts";
import type { Position, TrackRecord } from "../../../src/positions.ts";

export interface BoardMetrics {
  symbol: string | null;
  ageSec: number;
  launchObserved: boolean;
  priceUsd: number | null;
  priceUnitUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number;
  initialLiquidityUsd: number | null;
  w5m: WindowSummary;
  w15m: WindowSummary;
  w1h: WindowSummary;
  trades: number;
  smartBuyers: number;
  earlyBuyers: number;
  earlyBuyersHolding: number;
  launchSupplyPct: number | null;
  topClusterPct: number | null;
  topHolderPct: number | null;
  funderCoverage: number;
  creator: string | null;
}

export interface WindowSummary {
  buys: number;
  sells: number;
  buyUsd: number;
  sellUsd: number;
  buyers: number;
  organicBuyers: number;
  freshBuyers: number;
  traders: number;
}

export type Opportunity = ScoreRow & { name: string | null; source: string | null; launchAt: number | null; watchUntil: number | null; spark: number[] };

export interface TradeRow {
  ts: number;
  block?: number;
  side: "buy" | "sell";
  usd: number;
  trader: string;
  nonce?: number | null;
  txHash: string;
  unitUsd?: number;
}

export interface Holder {
  address: string;
  pct: number | null;
  cluster: string;
  funder: string | null;
  funderIsService: boolean | null;
  boughtUsd: number | null;
  soldUsd: number | null;
  firstNonce: number | null;
}

export interface TokenDetail {
  chainId: number;
  address: string;
  token: TokenRow | null;
  score: ScoreRow | null;
  watched: boolean;
  live: boolean;
  pools: PoolRow[];
  alerts: AlertRow[];
  positions: Position[];
  activity: SignalLogRow[];
  trades: TradeRow[];
  holders: Holder[];
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface GraphData {
  symbol: string | null;
  nodes: Array<{ id: string; kind: "holder" | "buyer" | "exited" | "creator" | "funder"; pct: number | null; cluster: string; label: string | null }>;
  edges: Array<{ source: string; target: string; service: boolean }>;
}

export interface TrackRecordResponse {
  summary: TrackRecord;
  recent: Position[];
}
