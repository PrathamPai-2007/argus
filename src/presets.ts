import type { RulesConfig, ScoringConfig } from "./config.ts";

// Phase 5 — replay tuning presets (PLAN.md §13). Named threshold/weight bundles
// applied to `replay` so you can backtest the same data under different
// sensitivities without touching argus.config.ts. `default` = config as-is.

export type PresetName = "default" | "cautious" | "strict";

export const PRESETS: Record<PresetName, Partial<RulesConfig> & { scoring?: Partial<ScoringConfig> }> = {
  default: {},

  // Cast a wider net: lower thresholds, catches early/mid manipulation phases.
  cautious: {
    R1: { enabled: true, supplyPct: 8, windowHours: 4, walletAgeDays: 14, weight: 35 },
    R2: { enabled: true, volumeSpikePct: 150, windowMinutes: 30, weight: 25 },
    R3: { enabled: true, minRecipients: 5, windowMinutes: 30, weight: 30 },
    R4: { enabled: true, warnPct: 6, critPct: 12, critWeight: 45, weight: 30 },
    R5: { enabled: true, minBuyers: 3, walletAgeDays: 14, weight: 25 },
    R6: { enabled: true, maxHops: 3, minClusterPct: 0.5, weight: 50 },
    R7: { enabled: true, minLockedPct: 50, minPoolAgeHours: 24, weight: 20 },
    R8: { enabled: true, minWallets: 2, windowMinutes: 120, weight: 20 },
    scoring: { info: 35, alert: 55, critical: 75 },
  },

  // High-confidence only: strict thresholds reduce noise on liquid majors.
  strict: {
    R1: { enabled: true, supplyPct: 30, windowHours: 1, walletAgeDays: 3, weight: 35 },
    R2: { enabled: true, volumeSpikePct: 600, windowMinutes: 10, weight: 25 },
    R3: { enabled: true, minRecipients: 20, windowMinutes: 10, weight: 30 },
    R4: { enabled: true, warnPct: 20, critPct: 35, critWeight: 45, weight: 30 },
    R5: { enabled: true, minBuyers: 10, walletAgeDays: 3, weight: 25 },
    R6: { enabled: true, maxHops: 1, minClusterPct: 3, weight: 50 },
    R7: { enabled: true, minLockedPct: 15, minPoolAgeHours: 96, weight: 20 },
    R8: { enabled: true, minWallets: 6, windowMinutes: 30, weight: 20 },
    scoring: { info: 50, alert: 65, critical: 85 },
  },
};

/** Apply a preset's overrides onto a config (mutates rules/scoring in place). */
export function applyPreset<T extends { rules: RulesConfig; scoring: ScoringConfig }>(cfg: T, name: PresetName): T {
  const p = PRESETS[name];
  if (!p) throw new Error(`unknown preset "${name}" (expected: ${Object.keys(PRESETS).join(", ")})`);
  if (name === "default") return cfg;
  for (const [ruleId, patch] of Object.entries(p)) {
    if (ruleId === "scoring") continue;
    const key = ruleId as keyof RulesConfig;
    if (patch && cfg.rules[key]) Object.assign(cfg.rules[key], patch);
  }
  if (p.scoring) Object.assign(cfg.scoring, p.scoring);
  return cfg;
}
