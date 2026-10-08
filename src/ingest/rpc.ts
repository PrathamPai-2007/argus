import { log, redactUrl } from "../logger.ts";

// JSON-RPC over HTTP with endpoint failover, per-endpoint limits and request
// coalescing. Limits are inferred from the host because free providers differ
// wildly (PublicNode batches 500 calls; dRPC free rejects batches over 3).

export interface EndpointLimits {
  maxBatch: number;
  maxLogRange: number;
  /** Max requests per second (each batch item counts). */
  rps: number;
}

export function limitsFor(url: string): EndpointLimits {
  const host = (() => { try { return new URL(url).host; } catch { return url; } })();
  if (host.includes("publicnode.com")) return { maxBatch: 500, maxLogRange: 2_000, rps: 50 };
  if (host.includes("drpc.org")) return { maxBatch: 3, maxLogRange: 100, rps: 20 };
  if (host.includes("base.org")) return { maxBatch: 1, maxLogRange: 100, rps: 10 };
  if (host.includes("alchemy.com")) return { maxBatch: 50, maxLogRange: 10, rps: 10 };
  if (host.includes("infura.io")) return { maxBatch: 50, maxLogRange: 2_000, rps: 5 };
  return { maxBatch: 20, maxLogRange: 500, rps: 10 };
}

export class RpcError extends Error {
  constructor(message: string, readonly code: number | null, readonly retryable: boolean) {
    super(message);
  }
}

export interface RpcCall {
  method: string;
  params: unknown[];
}

interface Endpoint {
  url: string;
  limits: EndpointLimits;
  coolUntil: number;
  failures: number;
  tokens: number;
  refilledAt: number;
}

const TIMEOUT_MS = 15_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Errors that mean "this request is fine, the endpoint is busy/broken right now". */
function isRetryable(code: number | null, message: string): boolean {
  if (code === 429 || (code !== null && code >= 500 && code < 600)) return true;
  if (code === -32005 || code === -32011 || code === -32603 || code === -32000) return true;
  return /rate|limit|timeout|timed out|busy|unavailable|capacity|header not found|beyond current head|try again/i.test(message);
}

export class RpcPool {
  private endpoints: Endpoint[];
  private inflight = new Map<string, Promise<unknown>>();
  private nextId = 1;
  readonly stats = { requests: 0, calls: 0, failovers: 0, errors: 0 };

  constructor(urls: string[], private label = "rpc") {
    if (urls.length === 0) throw new Error(`${label}: no HTTP endpoints configured`);
    const now = Date.now();
    this.endpoints = urls.map((url) => ({ url, limits: limitsFor(url), coolUntil: 0, failures: 0, tokens: limitsFor(url).rps, refilledAt: now }));
  }

  /** Smallest limits across endpoints, so a call shaped for one survives failover to any. */
  get limits(): EndpointLimits {
    return {
      maxBatch: Math.min(...this.endpoints.map((e) => e.limits.maxBatch)),
      maxLogRange: Math.min(...this.endpoints.map((e) => e.limits.maxLogRange)),
      rps: Math.max(...this.endpoints.map((e) => e.limits.rps)),
    };
  }

  /** Primary endpoint limits (used for sizing when the primary is healthy). */
  get primaryLimits(): EndpointLimits {
    return this.pick().limits;
  }

  endpointStatus(): Array<{ url: string; healthy: boolean; failures: number }> {
    const now = Date.now();
    return this.endpoints.map((e) => ({ url: redactUrl(e.url), healthy: e.coolUntil <= now, failures: e.failures }));
  }

  async request<T>(method: string, params: unknown[]): Promise<T> {
    const key = method + JSON.stringify(params);
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;
    const p = this.batch([{ method, params }]).then((r) => r[0] as T).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /** Executes calls in order; results align with input. Fails if any call fails. */
  async batch(calls: RpcCall[]): Promise<unknown[]> {
    return this.run(calls, false);
  }

  /**
   * Like batch(), but a non-retryable per-call error (an eth_call revert, a
   * non-contract) yields null for that item instead of failing the batch.
   */
  async settle(calls: RpcCall[]): Promise<unknown[]> {
    return this.run(calls, true);
  }

  private async run(calls: RpcCall[], tolerant: boolean): Promise<unknown[]> {
    if (calls.length === 0) return [];
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < this.endpoints.length * 2; attempt++) {
      const ep = this.pick();
      const wait = ep.coolUntil - Date.now();
      if (wait > 0) await sleep(Math.min(wait, 5_000));
      try {
        const out: unknown[] = [];
        for (let i = 0; i < calls.length; i += ep.limits.maxBatch) {
          out.push(...(await this.send(ep, calls.slice(i, i + ep.limits.maxBatch), tolerant)));
        }
        ep.failures = 0;
        return out;
      } catch (err) {
        lastErr = err;
        this.stats.errors++;
        const retryable = err instanceof RpcError ? err.retryable : true;
        if (!retryable) throw err;
        ep.failures++;
        ep.coolUntil = Date.now() + Math.min(60_000, 1_000 * 2 ** Math.min(ep.failures - 1, 6));
        this.stats.failovers++;
        log.warn(`${this.label} endpoint failed — failing over`, { endpoint: redactUrl(ep.url), failures: ep.failures, err: String(err).slice(0, 200) });
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /** Healthy endpoint in priority order; if all are cooling, the one that recovers first. */
  private pick(): Endpoint {
    const now = Date.now();
    return this.endpoints.find((e) => e.coolUntil <= now) ?? [...this.endpoints].sort((a, b) => a.coolUntil - b.coolUntil)[0]!;
  }

  private async throttle(ep: Endpoint, cost: number): Promise<void> {
    for (;;) {
      const now = Date.now();
      ep.tokens = Math.min(ep.limits.rps, ep.tokens + ((now - ep.refilledAt) / 1000) * ep.limits.rps);
      ep.refilledAt = now;
      if (ep.tokens >= Math.min(cost, ep.limits.rps)) {
        ep.tokens -= cost;
        return;
      }
      await sleep(Math.ceil(((Math.min(cost, ep.limits.rps) - ep.tokens) / ep.limits.rps) * 1000));
    }
  }

  private async send(ep: Endpoint, calls: RpcCall[], tolerant: boolean): Promise<unknown[]> {
    await this.throttle(ep, calls.length);
    this.stats.requests++;
    this.stats.calls += calls.length;
    const body = calls.map((c) => ({ jsonrpc: "2.0", id: this.nextId++, method: c.method, params: c.params }));
    let res: Response;
    try {
      res = await fetch(ep.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(calls.length === 1 ? body[0] : body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new RpcError(`network: ${String(err)}`, null, true);
    }
    const text = await res.text();
    if (!res.ok) throw new RpcError(`HTTP ${res.status}: ${text.slice(0, 160)}`, res.status, isRetryable(res.status, text));
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new RpcError(`invalid JSON: ${text.slice(0, 160)}`, null, true);
    }
    const replies = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{ id: number; result?: unknown; error?: { code: number; message: string } }>;
    if (replies.length !== calls.length) throw new RpcError(`batch reply size ${replies.length} != ${calls.length}`, null, true);
    const byId = new Map(replies.map((r) => [r.id, r]));
    return body.map((b) => {
      const r = byId.get(b.id);
      if (!r) throw new RpcError("batch reply missing id", null, true);
      if (r.error) {
        const retryable = isRetryable(r.error.code, r.error.message);
        if (tolerant && !retryable) return null;
        throw new RpcError(`${b.method}: ${r.error.message}`, r.error.code, retryable);
      }
      return r.result;
    });
  }
}

export const hex = (n: number | bigint): string => "0x" + n.toString(16);
