import type { AlertsConfig, ScoringConfig } from "../config.ts";
import { alertsInLastMinute, insertAlert, lastAlertForToken, retractAlert, getDb } from "../db.ts";
import { log } from "../logger.ts";
import type { AlertPayload } from "../types.ts";
import type { AlertSink } from "./telegram.ts";

// Alert quality controls (PLAN.md §7/§8):
//  - dedup: same token can't re-alert within cooldownMinutes…
//  - …unless score rose ≥ escalationDelta (pattern intensifying)
//  - global max-alerts-per-minute; critical bypasses the global rate limit
//  - every alert persisted to SQLite; unconfirmed alerts retracted on reorg

export class AlertManager {
  constructor(
    private alertsCfg: AlertsConfig,
    private scoringCfg: ScoringConfig,
    private sinks: AlertSink[],
  ) {}

  /** Returns the new alert id, or null if suppressed. */
  async maybeAlert(payload: AlertPayload, confirmed: boolean): Promise<number | null> {
    if (payload.score < this.scoringCfg.info) return null;
    const now = Math.floor(Date.now() / 1000);

    const last = lastAlertForToken(payload.chainId, payload.tokenAddress);
    if (last) {
      const cooldownSecs = this.alertsCfg.cooldownMinutes * 60;
      const inCooldown = now - last.created_at < cooldownSecs;
      if (inCooldown) {
        const escalated = payload.score >= last.score + this.alertsCfg.escalationDelta;
        if (!escalated) {
          log.debug("alert suppressed by cooldown", { token: payload.tokenAddress, score: payload.score, lastScore: last.score });
          return null;
        }
        log.info("alert escalation inside cooldown", { token: payload.tokenAddress, from: last.score, to: payload.score });
      }
    }

    if (payload.severity !== "critical" && alertsInLastMinute() >= this.alertsCfg.maxAlertsPerMinute) {
      log.warn("alert suppressed by global rate limit", { token: payload.tokenAddress, score: payload.score });
      return null;
    }

    const id = insertAlert(payload, confirmed, payload.signals.length > 0 ? Math.max(...payload.signals.map((s) => s.blockNumber)) : null);
    log.info("ALERT", { id, token: payload.tokenAddress, score: payload.score, severity: payload.severity, confirmed });
    for (const sink of this.sinks) {
      try {
        await sink.send(payload, id, confirmed);
      } catch (err) {
        log.error("alert sink failed", { sink: sink.name, err: String(err) });
      }
    }
    return id;
  }

  /** Retract all unconfirmed alerts for a chain (reorg invalidation, PLAN.md §11.1). Returns retracted ids. */
  async retractUnconfirmed(chainId: number, reason: string): Promise<number[]> {
    const rows = getDb()
      .query("SELECT id, token_address FROM alerts WHERE chain_id = ? AND confirmed = 0 AND retracted = 0")
      .all(chainId) as { id: number; token_address: string }[];
    for (const r of rows) {
      retractAlert(r.id);
      const text = `↩️ ARGUS retraction: alert #${r.id} (${r.token_address}) invalidated — ${reason}`;
      for (const sink of this.sinks) {
        try {
          await sink.sendText(text);
        } catch (err) {
          log.error("retraction sink failed", { sink: sink.name, err: String(err) });
        }
      }
    }
    if (rows.length > 0) log.warn("retracted unconfirmed alerts", { chainId, count: rows.length, reason });
    return rows.map((r) => r.id);
  }
}
