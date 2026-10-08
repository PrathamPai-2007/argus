import type { AlertsConfig } from "../config.ts";
import * as db from "../db.ts";
import { log } from "../logger.ts";
import type { WebhookDispatcher } from "../webhooks.ts";
import { telegramAlert } from "./format.ts";
import type { AlertSink } from "./telegram.ts";

// Alert delivery policy:
//  - opportunity: once per token per cooldown, unless the score rises by
//    rescoreDelta or the verdict upgrades to high conviction
//  - exit: once per alerted token while its position is open
//  - global hourly cap; high-conviction and exit alerts bypass it
//  - unconfirmed alerts are retracted on reorg (invariant 4)

export type AlertDecision = { send: true } | { send: false; reason: string };

export class AlertManager {
  constructor(private cfg: AlertsConfig, private sinks: AlertSink[], private webhooks: WebhookDispatcher | null) {}

  updateConfig(cfg: AlertsConfig): void {
    this.cfg = cfg;
  }

  decide(p: db.AlertPayload, nowSecs: number): AlertDecision {
    const last = db.lastAlert(p.chainId, p.token, p.kind);
    if (p.kind === "exit") {
      return last && nowSecs - last.createdAt < 6 * 3600 ? { send: false, reason: "exit_already_sent" } : { send: true };
    }
    if (last && nowSecs - last.createdAt < this.cfg.cooldownMinutes * 60) {
      const upgraded = p.verdict === "high_conviction" && last.verdict !== "high_conviction";
      if (!upgraded && p.score < last.score + this.cfg.rescoreDelta) return { send: false, reason: "cooldown" };
    }
    if (p.verdict !== "high_conviction" && db.alertsSince(nowSecs - 3600) >= this.cfg.maxPerHour) return { send: false, reason: "hourly_cap" };
    return { send: true };
  }

  /** Persist and deliver; returns the alert id, or null when policy suppresses it. */
  async emit(p: db.AlertPayload, block: number, confirmed: boolean, nowSecs = Math.floor(Date.now() / 1000)): Promise<number | null> {
    const decision = this.decide(p, nowSecs);
    if (!decision.send) {
      log.debug("alert suppressed", { token: p.token, kind: p.kind, score: p.score, reason: decision.reason });
      return null;
    }
    const id = db.insertAlert(p, block, confirmed);
    log.info("ALERT", { id, chainId: p.chainId, token: p.token, symbol: p.symbol, kind: p.kind, verdict: p.verdict, score: p.score, confirmed });
    await this.broadcast(telegramAlert(p, id, confirmed));
    this.webhooks?.dispatchAlert(p, id, confirmed);
    return id;
  }

  async broadcast(html: string): Promise<void> {
    for (const sink of this.sinks) {
      try {
        await sink.sendText(html);
      } catch (err) {
        log.error("alert sink failed", { sink: sink.name, err: String(err) });
      }
    }
  }

  async retract(chainId: number, fromBlock: number): Promise<number[]> {
    const ids = db.retractAlertsFrom(chainId, fromBlock);
    for (const id of ids) {
      const a = db.getAlert(id);
      if (!a) continue;
      await this.broadcast(`↩️ <b>Retracted</b> alert #${id} (${a.symbol ? `$${a.symbol}` : a.token.slice(0, 10)}): chain reorganized at block ${fromBlock}.`);
      this.webhooks?.dispatchRetraction(id, chainId, a.token, `reorg at block ${fromBlock}`);
    }
    if (ids.length > 0) log.warn("retracted unconfirmed alerts", { chainId, fromBlock, count: ids.length });
    return ids;
  }
}
