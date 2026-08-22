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
      const timeSinceLast = now - last.created_at;
      const inCooldown = timeSinceLast < cooldownSecs;
      
      let lastPayloadSev: string | null = null;
      try { lastPayloadSev = JSON.parse(last.payload_json).severity; } catch {}
      const newCritical = payload.severity === "critical" && lastPayloadSev !== "critical";
      
      if (inCooldown) {
        if (!newCritical) {
          log.debug("alert suppressed by cooldown", { token: payload.tokenAddress, score: payload.score, lastScore: last.score, timeSinceLast });
          return null;
        }
        log.info("alert escalation inside cooldown", { token: payload.tokenAddress, from: last.score, to: payload.score });
      } else {
        if (payload.score <= last.score && payload.severity === lastPayloadSev) {
          log.debug("alert suppressed (score didn't increase)", { token: payload.tokenAddress, score: payload.score });
          return null;
        }
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
        log.error("alert sink failed", { sink: sink.name, err });
      }
    }
    return id;
  }

  /** Retract unconfirmed alerts at or after the reorg boundary. */
  async retractUnconfirmed(chainId: number, fromBlock: number, reason: string): Promise<number[]> {
    const rows = getDb()
      .query("SELECT id, token_address FROM alerts WHERE chain_id = ? AND confirmed = 0 AND retracted = 0 AND (block_number IS NULL OR block_number >= ?)")
      .all(chainId, fromBlock) as { id: number; token_address: string }[];
    for (const r of rows) {
      retractAlert(r.id);
      const text = `↩️ ARGUS retraction: alert #${r.id} (${r.token_address}) invalidated — ${reason}`;
      for (const sink of this.sinks) {
        try {
          await sink.sendText(text);
        } catch (err) {
          log.error("retraction sink failed", { sink: sink.name, err });
        }
      }
    }
    if (rows.length > 0) log.warn("retracted unconfirmed alerts", { chainId, count: rows.length, reason });
    return rows.map((r) => r.id);
  }
}
