// Paper positions: every alert is "bought" at the spot price when it fires,
// and every baseline token (watched, liquid, never alerted) is bought the same
// way. Comparing the two is the only honest answer to "do the alerts work?".
// Pure functions; persistence lives in db.ts.

export type PositionKind = "alert" | "baseline";
export type Horizon = "m15" | "h1" | "h6" | "h24";

export const HORIZONS: Record<Horizon, number> = { m15: 900, h1: 3_600, h6: 21_600, h24: 86_400 };
export const POSITION_LIFETIME = HORIZONS.h24;

export interface Position {
  id: number;
  chainId: number;
  token: string;
  kind: PositionKind;
  alertId: number | null;
  score: number | null;
  entryUnitUsd: number;
  entryAt: number;
  entryBlock: number;
  lastUnitUsd: number;
  lastAt: number;
  peakUnitUsd: number;
  troughUnitUsd: number;
  /** Return (fraction, e.g. 0.42 = +42%) at each horizon, once reached. */
  returns: Record<Horizon, number | null>;
  closedAt: number | null;
}

export function openPosition(p: Omit<Position, "lastUnitUsd" | "lastAt" | "peakUnitUsd" | "troughUnitUsd" | "returns" | "closedAt" | "id"> & { id?: number }): Position {
  return {
    id: p.id ?? 0,
    ...p,
    lastUnitUsd: p.entryUnitUsd,
    lastAt: p.entryAt,
    peakUnitUsd: p.entryUnitUsd,
    troughUnitUsd: p.entryUnitUsd,
    returns: { m15: null, h1: null, h6: null, h24: null },
    closedAt: null,
  };
}

/** Apply a price observation. Horizons are stamped with the first price seen at or after them. */
export function observe(pos: Position, unitUsd: number, ts: number): Position {
  if (pos.closedAt !== null || ts < pos.lastAt || !(unitUsd > 0) || !Number.isFinite(unitUsd)) return pos;
  const next: Position = { ...pos, returns: { ...pos.returns } };
  // Horizons crossed since the last observation keep the last known price,
  // not this later one, when the gap spans them (no look-ahead).
  for (const [h, secs] of Object.entries(HORIZONS) as [Horizon, number][]) {
    if (next.returns[h] !== null) continue;
    const at = pos.entryAt + secs;
    if (ts >= at) next.returns[h] = (pos.lastAt >= at ? pos.lastUnitUsd : unitUsd) / pos.entryUnitUsd - 1;
  }
  next.lastUnitUsd = unitUsd;
  next.lastAt = ts;
  if (unitUsd > next.peakUnitUsd) next.peakUnitUsd = unitUsd;
  if (unitUsd < next.troughUnitUsd) next.troughUnitUsd = unitUsd;
  if (ts >= pos.entryAt + POSITION_LIFETIME) next.closedAt = ts;
  return next;
}

/** Close positions past their lifetime with the last known price (no observation needed). */
export function expire(pos: Position, now: number): Position {
  if (pos.closedAt !== null || now < pos.entryAt + POSITION_LIFETIME) return pos;
  const next: Position = { ...pos, returns: { ...pos.returns }, closedAt: now };
  for (const h of Object.keys(HORIZONS) as Horizon[]) {
    if (next.returns[h] === null) next.returns[h] = pos.lastUnitUsd / pos.entryUnitUsd - 1;
  }
  return next;
}

export const peakMultiple = (p: Position) => p.peakUnitUsd / p.entryUnitUsd;
export const currentReturn = (p: Position) => p.lastUnitUsd / p.entryUnitUsd - 1;

export interface CohortStats {
  count: number;
  /** Median return at each horizon over positions that reached it. */
  median: Record<Horizon, number | null>;
  /** Share of positions (that reached 1h) whose price at 1h was above entry. */
  winRate1h: number | null;
  /** Share of positions that at any point doubled. */
  hit2x: number | null;
  medianPeak: number | null;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function cohort(positions: Position[]): CohortStats {
  const med = {} as Record<Horizon, number | null>;
  for (const h of Object.keys(HORIZONS) as Horizon[]) {
    med[h] = median(positions.map((p) => p.returns[h]).filter((r): r is number => r !== null));
  }
  const reached1h = positions.filter((p) => p.returns.h1 !== null);
  return {
    count: positions.length,
    median: med,
    winRate1h: reached1h.length ? reached1h.filter((p) => p.returns.h1! > 0).length / reached1h.length : null,
    hit2x: positions.length ? positions.filter((p) => peakMultiple(p) >= 2).length / positions.length : null,
    medianPeak: median(positions.map(peakMultiple)),
  };
}

export interface TrackRecord {
  alerts: CohortStats;
  baseline: CohortStats;
  byScore: Array<{ bucket: string; stats: CohortStats }>;
}

export function trackRecord(positions: Position[]): TrackRecord {
  const alerts = positions.filter((p) => p.kind === "alert");
  const buckets: Array<[string, number, number]> = [["60–69", 60, 70], ["70–79", 70, 80], ["80+", 80, 101]];
  return {
    alerts: cohort(alerts),
    baseline: cohort(positions.filter((p) => p.kind === "baseline")),
    byScore: buckets.map(([bucket, lo, hi]) => ({ bucket, stats: cohort(alerts.filter((p) => (p.score ?? 0) >= lo && (p.score ?? 0) < hi)) })),
  };
}
