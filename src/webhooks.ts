import type { WebhookConfig } from "./config.ts";
import { log } from "./logger.ts";
import type { AlertPayload, Signal } from "./types.ts";

// Outbound webhook delivery (PLAN.md §17): POST JSON to any HTTP endpoint with an
// optional HMAC-SHA256 signature. No SDKs — plain fetch. Delivery is fire-and-forget
// (never blocks the ingest pipeline); failures retry with backoff, then log.

export interface WebhookTarget {
  url: string;
  events: Set<"alert" | "signal">;
  secret: string | null;
  timeoutMs: number;
  retries: number;
}

export interface WebhookBody {
  type: "alert" | "alert_retracted" | "signal";
  sentAt: number;
  chainId: number;
  tokenAddress: string;
  [key: string]: unknown;
}

export class WebhookDispatcher {
  private targets: WebhookTarget[] = [];

  setTargets(targets: WebhookConfig[]): void {
    this.targets = targets.map((t) => ({ ...t, events: new Set(t.events) }));
  }

  /** A new alert was emitted (or, when retracted, sent again via dispatchRetraction). */
  dispatchAlert(payload: AlertPayload, id: number, confirmed: boolean): void {
    const body: WebhookBody = {
      type: "alert",
      sentAt: Math.floor(Date.now() / 1000),
      id,
      confirmed,
      chainId: payload.chainId,
      tokenAddress: payload.tokenAddress,
      score: payload.score,
      severity: payload.severity,
      headline: payload.headline,
      lines: payload.lines,
      signals: payload.signals,
      links: payload.links,
    };
    this.fire(body, "alert");
  }

  /** A heuristic signal fired (significance-filtered upstream). */
  dispatchSignal(signal: Signal): void {
    const body: WebhookBody = {
      type: "signal",
      sentAt: Math.floor(Date.now() / 1000),
      chainId: signal.chainId,
      tokenAddress: signal.tokenAddress,
      ruleId: signal.ruleId,
      weight: signal.weight,
      evidence: signal.evidence,
      blockNumber: signal.blockNumber,
      timestamp: signal.timestamp,
    };
    this.fire(body, "signal");
  }

  /** An earlier unconfirmed alert was invalidated by a reorg. */
  dispatchRetraction(id: number, chainId: number, tokenAddress: string, reason: string): void {
    const body: WebhookBody = {
      type: "alert_retracted",
      sentAt: Math.floor(Date.now() / 1000),
      id,
      chainId,
      tokenAddress,
      reason,
    };
    this.fire(body, "alert");
  }

  private fire(body: WebhookBody, event: "alert" | "signal"): void {
    for (const t of this.targets) {
      if (!t.events.has(event)) continue;
      void this.post(t, body, 0);
    }
  }

  private async post(target: WebhookTarget, body: WebhookBody, attempt: number): Promise<void> {
    const raw = JSON.stringify(body);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "argus",
      "x-argus-event": body.type,
    };
    if (target.secret) headers["x-argus-signature"] = `sha256=${await hmacSha256(target.secret, raw)}`;
    try {
      const res = await fetch(target.url, {
        method: "POST",
        headers,
        body: raw,
        signal: AbortSignal.timeout(target.timeoutMs),
      });
      if (!res.ok) throw new Error(`webhook ${target.url} returned HTTP ${res.status}`);
      log.debug("webhook delivered", { event: body.type, url: target.url });
    } catch (err) {
      if (attempt < target.retries) {
        const delay = 500 * 2 ** attempt;
        setTimeout(() => void this.post(target, body, attempt + 1), delay);
      } else {
        log.error("webhook delivery failed", { event: body.type, url: target.url, err: String(err) });
      }
    }
  }
}

async function hmacSha256(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
