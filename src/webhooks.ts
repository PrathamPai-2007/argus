import type { WebhookConfig } from "./config.ts";
import { log, redactUrl } from "./logger.ts";
import type { AlertPayload } from "./db.ts";

// Outbound webhook delivery: POST JSON to any HTTP endpoint with an optional
// HMAC-SHA256 signature. No SDKs — plain fetch. Delivery is fire-and-forget
// (never blocks ingestion); failures retry with backoff, then log.

export interface WebhookTarget {
  url: string;
  events: Set<"alert" | "exit">;
  secret: string | null;
  timeoutMs: number;
  retries: number;
}

export interface WebhookBody {
  type: "alert" | "exit" | "alert_retracted";
  sentAt: number;
  chainId: number;
  tokenAddress: string;
  [key: string]: unknown;
}

export class WebhookDispatcher {
  private targets: WebhookTarget[] = [];
  private stopped = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private controllers = new Set<AbortController>();

  setTargets(targets: WebhookConfig[]): void {
    this.stopped = false;
    this.targets = targets.map((t) => ({ ...t, events: new Set(t.events) }));
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }

  /** A new opportunity or exit alert was emitted. */
  dispatchAlert(payload: AlertPayload, id: number, confirmed: boolean): void {
    const { token, ...rest } = payload;
    this.fire({ type: payload.kind === "exit" ? "exit" : "alert", sentAt: Math.floor(Date.now() / 1000), id, confirmed, tokenAddress: token, ...rest }, payload.kind === "exit" ? "exit" : "alert");
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

  private fire(body: WebhookBody, event: "alert" | "exit"): void {
    for (const t of this.targets) {
      if (!t.events.has(event)) continue;
      void this.post(t, body, 0);
    }
  }

  private async post(target: WebhookTarget, body: WebhookBody, attempt: number): Promise<void> {
    if (this.stopped) return;
    const raw = JSON.stringify(body);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "argus",
      "x-argus-event": body.type,
    };
    if (target.secret) headers["x-argus-signature"] = `sha256=${await hmacSha256(target.secret, raw)}`;
    let controller: AbortController | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      controller = new AbortController();
      this.controllers.add(controller);
      timeout = setTimeout(() => controller?.abort(), target.timeoutMs);
      const res = await fetch(target.url, {
        method: "POST",
        headers,
        body: raw,
        signal: controller.signal,
        redirect: "error",
      });
      if (!res.ok) {
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          log.error("webhook rejected permanently", { event: body.type, url: redactUrl(target.url), status: res.status });
          return;
        }
        throw new Error(`webhook ${redactUrl(target.url)} returned HTTP ${res.status}`);
      }
      await res.body?.cancel();
      log.debug("webhook delivered", { event: body.type, url: redactUrl(target.url) });
    } catch (err) {
      if (attempt < target.retries) {
        const delay = 500 * 2 ** attempt;
        const timer = setTimeout(() => {
          this.timers.delete(timer);
          void this.post(target, body, attempt + 1);
        }, delay);
        this.timers.add(timer);
      } else {
        log.error("webhook delivery failed", { event: body.type, url: redactUrl(target.url), err });
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      if (controller) this.controllers.delete(controller);
    }
  }
}

async function hmacSha256(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
