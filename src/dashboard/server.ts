import type { ArgusEngine } from "../engine.ts";
import * as db from "../db.ts";
import { log } from "../logger.ts";
import type { PerformanceEvent } from "../performance.ts";
import type { Address } from "../types.ts";
import { renderPage } from "./page.ts";

// Phase 4 dashboard (PLAN.md §16): local-only Bun.serve + SSE on 127.0.0.1:<port>.
// Zero deps: plain ServerResponse API, SSE for live pushes, JSON polling for data.

export interface DashboardOptions {
  port: number;
}

interface SseClient {
  write: (payload: unknown) => void;
  close: () => void;
}

function safeJson(data: unknown): string {
  return JSON.stringify(data, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

function queryLimit(value: string | null, fallback: number): number {
  if (value === null || value === "") return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 500) : fallback;
}

export class DashboardServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private sseClients = new Map<number, SseClient>();
  private nextSseId = 1;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private readonly authToken = process.env.ARGUS_DASHBOARD_TOKEN ?? null;

  constructor(
    private engine: ArgusEngine,
    private opts: DashboardOptions,
  ) {
    engine.setAlertHook((payload, id) =>
      this.broadcast({
        type: "alert",
        id,
        chainId: payload.chainId,
        tokenAddress: payload.tokenAddress,
        score: payload.score,
        severity: payload.severity,
        headline: payload.headline,
      }),
    );
    engine.setPerformanceHook((event) => this.broadcast({ type: "performance", data: event }));
    engine.setSignalHook((signal) => this.broadcast({ type: "signal", data: signal }));
    engine.setEventHook((event) => this.broadcast({ type: "event", data: event }));
  }

  start(): void {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: this.opts.port,
      fetch: (req, server) => {
        const url = new URL(req.url);
        if (url.pathname === "/ws") {
          if (this.authToken && !authorized(req, this.authToken)) {
            return new Response("unauthorized", { status: 401 });
          }
          const upgraded = server.upgrade(req, { data: undefined });
          if (upgraded) return undefined;
          return new Response("upgrade failed", { status: 400 });
        }
        return this.handle(req);
      },
      websocket: {
        open: (ws) => {
          ws.subscribe("argus-live");
        },
        message: () => {},
        close: () => {},
      },
    });
    this.tickTimer = setInterval(() => this.broadcastStatus(), 5_000);
    log.info("dashboard listening", { url: `http://127.0.0.1:${this.opts.port}` });
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    for (const client of this.sseClients.values()) client.close();
    this.sseClients.clear();
    if (this.server) {
      this.server.stop(true);
      this.server = null;
    }
  }

  private handle(req: Request): Response {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("method not allowed", { status: 405 });
    }

    const url = new URL(req.url);
    const accept = req.headers.get("accept") ?? "";
    if (this.authToken && !authorized(req, this.authToken)) {
      return new Response("authentication required", { status: 401, headers: { "www-authenticate": 'Basic realm="argus"' } });
    }

    if (url.pathname === "/" || url.pathname.startsWith("/token/")) {
      return new Response(renderPage(), { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (url.pathname === "/events/stream") {
      const encoder = new TextEncoder();
      const id = this.nextSseId++;
      const stream = new ReadableStream({
        start: (controller) => {
          const client: SseClient = {
            write: (payload) => {
              try {
                controller.enqueue(encoder.encode(`data: ${safeJson(payload)}\n\n`));
                if ((controller.desiredSize ?? 0) < 0) {
                  this.sseClients.delete(id);
                  controller.close();
                }
              } catch {
                this.sseClients.delete(id);
              }
            },
            close: () => { try { controller.close(); } catch { /* already closed */ } },
          };
          this.sseClients.set(id, client);
          client.write({ type: "hello", t: Date.now() });
        },
        cancel: () => {
          this.sseClients.delete(id);
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        },
      });
    }

    if (url.pathname === "/api/status") {
      return this.json(this.engine.status());
    }
    if (url.pathname === "/api/tokens") {
      const chain = url.searchParams.get("chain");
      const now = Math.floor(Date.now() / 1000);
      const tokens = [];
      const chains = this.engine.chainsForStatus();
      const targetChains = chains.length > 0 ? chains : [1];
      for (const c of targetChains) {
        if (chain && Number(chain) !== c) continue;
        for (const t of db.listWatchedTokens(c, now)) {
          tokens.push({ ...t, chainId: c, lastAlert: db.lastAlertForToken(c, t.address) });
        }
      }
      return this.json(tokens);
    }
    if (url.pathname === "/api/alerts") {
      const limit = queryLimit(url.searchParams.get("limit"), 100);
      return this.json(db.listAlerts(limit));
    }
    if (url.pathname === "/api/signals") {
      const chain = Number(url.searchParams.get("chain") ?? 0);
      const limit = queryLimit(url.searchParams.get("limit"), 50);
      return this.json(db.listSignals(chain || undefined, limit));
    }
    if (url.pathname === "/api/performance") {
      const chain = Number(url.searchParams.get("chain") ?? 0);
      const token = url.searchParams.get("token")?.toLowerCase() as Address | undefined;
      const activeOnly = url.searchParams.get("active") === "1";
      const limit = queryLimit(url.searchParams.get("limit"), 100);
      return this.json(db.listPerformanceSessions({ ...(chain ? { chainId: chain } : {}), ...(token ? { tokenAddress: token } : {}), activeOnly, limit }));
    }
    const tokenMatch = url.pathname.match(/^\/api\/token\/(\d+)\/(0x[0-9a-fA-F]{40})$/);
    if (tokenMatch) {
      if (accept.includes("text/html")) {
        return new Response(renderPage(), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      const chainId = Number(tokenMatch[1]);
      const token = tokenMatch[2]!.toLowerCase() as Address;
      return this.json({
        token: db.getToken(chainId, token),
        signals: db.listSignalsForToken(chainId, token, 100),
        alerts: db.listAlertsForToken(chainId, token, 50),
        pools: db.listPoolsForToken(chainId, token),
        performance: db.listPerformanceSessions({ chainId, tokenAddress: token, limit: 50 }),
      });
    }
    const tokenGraphMatch = url.pathname.match(/^\/api\/graph\/token\/(\d+)\/(0x[0-9a-fA-F]{40})$/);
    if (tokenGraphMatch) {
      const chainId = Number(tokenGraphMatch[1]);
      const token = tokenGraphMatch[2]!.toLowerCase() as Address;
      return this.json(this.graphForToken(chainId, token));
    }
    const walletGraphMatch = url.pathname.match(/^\/api\/graph\/wallet\/(\d+)\/(0x[0-9a-fA-F]{40})$/);
    if (walletGraphMatch) {
      const chainId = Number(walletGraphMatch[1]);
      const addr = walletGraphMatch[2]!.toLowerCase() as Address;
      return this.json(this.graphForWallet(chainId, addr));
    }
    if (url.pathname === "/api/events/recent") {
      const limit = queryLimit(url.searchParams.get("limit"), 100);
      return this.json(db.listRecentEvents(limit));
    }

    return new Response("not found", { status: 404 });
  }

  private broadcast(data: unknown): void {
    const payload = safeJson(data);
    for (const client of this.sseClients.values()) client.write(data);
    if (this.server) {
      this.server.publish("argus-live", payload);
    }
  }

  /** Wallet clusters + funding edges for a token (graph API for external visualization). */
  private graphForToken(chainId: number, token: Address): unknown {
    const graph = this.engine.graphView(chainId);
    const tokenRow = db.getToken(chainId, token);
    const allMembers = new Set<Address>();
    const clusters = graph.clusterBreakdown(token).map((c) => ({
      clusterId: c.clusterId,
      memberCount: c.memberCount,
      pctOfSupply: round2(c.pctOfSupply),
      balance: c.balance.toString(),
      members: c.members.map((m) => {
        allMembers.add(m);
        const w = graph.wallets.get(m);
        const label = graph.labelOf(m);
        return {
          address: m,
          balance: graph.balanceOf(token, m).toString(),
          label: label?.label ?? null,
          labelKind: label?.kind ?? null,
          funder: w?.funder ?? null,
          nonce: w?.nonce ?? null,
          firstSeenBlock: w?.firstSeenBlock ?? null,
          firstSeenAt: w?.firstSeenAt ?? null,
        };
      }),
    }));
    const funding = db
      .listFundingEdgesForWallets(chainId, [...allMembers], 500)
      .map((e) => ({ funder: e.funder, funded: e.funded, amount: e.amount.toString(), method: e.method, blockNumber: e.block_number }));
    return {
      chainId,
      token,
      symbol: tokenRow?.symbol ?? null,
      decimals: tokenRow?.decimals ?? null,
      totalSupply: tokenRow?.totalSupply?.toString() ?? null,
      circulatingSupply: graph.circulatingSupply(token)?.toString() ?? null,
      pools: db.listPoolsForToken(chainId, token),
      clusters,
      funding,
      graphUpdatedAt: Date.now(),
    };
  }

  /** A single wallet's cluster, funder chain and funding edges (graph API). */
  private graphForWallet(chainId: number, addr: Address): unknown {
    const graph = this.engine.graphView(chainId);
    const w = graph.wallets.get(addr);
    const label = graph.labelOf(addr);
    const cluster = graph.clusterOf(addr);
    const members = cluster.length > 0 ? cluster : [addr];
    const funding = db
      .listFundingEdgesForWallets(chainId, members, 200)
      .map((e) => ({ funder: e.funder, funded: e.funded, amount: e.amount.toString(), method: e.method, blockNumber: e.block_number }));
    return {
      chainId,
      address: addr,
      firstSeenBlock: w?.firstSeenBlock ?? null,
      firstSeenAt: w?.firstSeenAt ?? null,
      nonce: w?.nonce ?? null,
      funder: w?.funder ?? null,
      label: label?.label ?? null,
      labelKind: label?.kind ?? null,
      funderChain: graph.funderChain(addr, 5),
      cluster: members.map((m) => {
        const mw = graph.wallets.get(m);
        const ml = graph.labelOf(m);
        return { address: m, label: ml?.label ?? null, labelKind: ml?.kind ?? null, funder: mw?.funder ?? null };
      }),
      funding,
      graphUpdatedAt: Date.now(),
    };
  }

  private broadcastStatus(): void {
    this.broadcast({ type: "status", t: Date.now(), status: this.engine.status() });
  }

  private json(data: unknown, status = 200): Response {
    return new Response(safeJson(data), {
      status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-cache",
      },
    });
  }
}

function authorized(req: Request, token: string): boolean {
  const header = req.headers.get("authorization") ?? "";
  if (header.startsWith("Bearer ") && header.slice(7) === token) return true;
  if (header.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice(6));
      if (decoded.slice(decoded.indexOf(":") + 1) === token) return true;
    } catch {
      /* ignore decoding error */
    }
  }
  try {
    const url = new URL(req.url);
    const queryToken = url.searchParams.get("token");
    if (queryToken && queryToken === token) return true;
  } catch {
    /* ignore url parse error */
  }
  return false;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
