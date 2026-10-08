import { useSyncExternalStore } from "react";
import type { AlertRow, EngineStatus, LiveUpdate, Position, ScoreRow, SignalLogRow, TradeRow } from "./types.ts";

// One EventSource for the whole app. Updates land in a tiny store; components
// subscribe to the slice they render via useSyncExternalStore.

export type Connection = "connecting" | "live" | "reconnecting";

interface LiveState {
  connection: Connection;
  status: EngineStatus | null;
  /** Latest score per chain:token, merged over REST snapshots. */
  scores: Map<string, ScoreRow>;
  scoreVersion: number;
  alerts: AlertRow[];
  signals: SignalLogRow[];
  trades: Map<string, TradeRow[]>;
  positions: Map<number, Position>;
  lastAlertId: number | null;
}

const state: LiveState = {
  connection: "connecting",
  status: null,
  scores: new Map(),
  scoreVersion: 0,
  alerts: [],
  signals: [],
  trades: new Map(),
  positions: new Map(),
  lastAlertId: null,
};

const listeners = new Set<() => void>();
let snapshot = { ...state };
function changed(): void {
  snapshot = { ...state };
  for (const l of listeners) l();
}

export const key = (chainId: number, token: string) => `${chainId}:${token}`;

function apply(u: LiveUpdate | { type: "hello" }): void {
  switch (u.type) {
    case "hello":
      return;
    case "status":
      state.status = u.status;
      break;
    case "scores":
      for (const s of u.items) state.scores.set(key(s.chainId, s.token), s);
      state.scoreVersion++;
      break;
    case "alert":
      state.alerts = [u.alert, ...state.alerts.filter((a) => a.id !== u.alert.id)].slice(0, 200);
      state.lastAlertId = u.alert.id;
      break;
    case "signal":
      state.signals = [u.entry, ...state.signals].slice(0, 300);
      break;
    case "trades": {
      const k = key(u.chainId, u.token);
      state.trades.set(k, [...[...u.trades].reverse(), ...(state.trades.get(k) ?? [])].slice(0, 300));
      break;
    }
    case "position":
      state.positions.set(u.position.id, u.position);
      break;
  }
  changed();
}

let source: EventSource | null = null;
export function connectLive(): void {
  if (source) return;
  source = new EventSource("/api/stream", { withCredentials: true });
  source.onopen = () => {
    state.connection = "live";
    changed();
  };
  source.onerror = () => {
    state.connection = "reconnecting";
    changed();
  };
  source.onmessage = (e) => {
    try {
      apply(JSON.parse(e.data as string) as LiveUpdate);
    } catch { /* ignore malformed frame */ }
  };
}

export function reconnectLive(): void {
  source?.close();
  source = null;
  connectLive();
}

export function seedScores(rows: ScoreRow[]): void {
  for (const s of rows) {
    const existing = state.scores.get(key(s.chainId, s.token));
    if (!existing || existing.at <= s.at) state.scores.set(key(s.chainId, s.token), s);
  }
  state.scoreVersion++;
  changed();
}

export function useLive<T>(select: (s: LiveState) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => select(snapshot),
  );
}
