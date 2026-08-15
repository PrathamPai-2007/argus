import type { ScoringConfig } from "./config.ts";
import { recentSignals } from "./db.ts";
import type { Address, Severity, Signal } from "./types.ts";

// Weighted signals → 0–100 risk score → severity (PLAN.md §7).
// Best weight per rule within the signal window (a rule re-firing doesn't stack).

export interface ScoreResult {
  score: number;
  severity: Severity | null;
  signals: Signal[];
}

export function severityFor(score: number, cfg: ScoringConfig): Severity | null {
  if (score >= cfg.critical) return "critical";
  if (score >= cfg.alert) return "alert";
  if (score >= cfg.info) return "info";
  return null;
}

export function scoreToken(chainId: number, token: Address, cfg: ScoringConfig, nowSecs = Math.floor(Date.now() / 1000)): ScoreResult {
  const since = nowSecs - cfg.signalWindowHours * 3600;
  const signals = recentSignals(chainId, token, since);
  const bestPerRule = new Map<string, number>();
  const bestSignalPerRule = new Map<string, Signal>();
  for (const s of signals) {
    if (s.weight > (bestPerRule.get(s.ruleId) ?? -1)) {
      bestPerRule.set(s.ruleId, s.weight);
      bestSignalPerRule.set(s.ruleId, s);
    }
  }
  let score = 0;
  for (const w of bestPerRule.values()) score += w;
  score = Math.min(100, score);
  const kept = [...bestSignalPerRule.values()].sort((a, b) => b.weight - a.weight);
  return { score, severity: severityFor(score, cfg), signals: kept };
}
