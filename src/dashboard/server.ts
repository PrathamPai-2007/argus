import { timingSafeEqual } from "node:crypto";
import index from "../../web/index.html";
import type { ArgusConfig } from "../config.ts";
import * as db from "../db.ts";
import type { ArgusEngine, LiveUpdate } from "../engine.ts";
import { log } from "../logger.ts";
import type { Address } from "../model.ts";
import { trackRecord } from "../positions.ts";

// Dashboard: the React SPA (web/) plus a JSON API and an SSE stream, bound to
// 127.0.0.1 (invariant 10). With ARGUS_DASHBOARD_TOKEN set, every API and
// stream request needs Bearer/Basic auth or the session cookie that
// POST /api/session issues (EventSource cannot send headers).

const COOKIE = "argus_session";
const VERDICT_RANK: Record<string, number> = { high_conviction: 0, alert: 1, watch: 2, avoid: 3, quiet: 4 };

type Handler = (req: Request & { params: Record<string, string> }, url: URL) => Response | Promise<Response>;

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers },
  });

const isAddress = (s: string | undefined): s is string => typeof s === "string" && /^0x[0-9a-f]{40}$/.test(s);

function intParam(v: string | null, def: number, max: number): number {
  const n = Number(v);
  return v !== null && Number.isInteger(n) && n > 0 ? Math.min(n, max) : def;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class DashboardServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private unsubscribe: (() => void) | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly authToken = process.env.ARGUS_DASHBOARD_TOKEN || null;
  private readonly encoder = new TextEncoder();

  constructor(private engine: ArgusEngine, private cfg: ArgusConfig) {}

  get port(): number {
    return this.server?.port ?? this.cfg.dashboard.port;
  }

  start(port = this.cfg.dashboard.port): void {
    this.unsubscribe = this.engine.subscribe((u) => this.push(u));
    const api = (h: Handler) => (req: Request & { params: Record<string, string> }) => this.guard(req, h);
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      development: process.env.NODE_ENV !== "production" && process.env.ARGUS_DEV === "1",
      routes: {
        "/api/session": { POST: (req) => this.login(req) },
        "/api/status": api(() => json(this.engine.status())),
        "/api/opportunities": api((_r, url) => this.opportunities(url)),
        "/api/tokens/:chain/:address": api((r) => this.token(r.params)),
        "/api/tokens/:chain/:address/candles": api((r, url) => this.candles(r.params, url)),
        "/api/tokens/:chain/:address/graph": api((r) => this.graph(r.params)),
        "/api/alerts": api((_r, url) => json(db.listAlerts({ ...chainFilter(url), ...cursor(url), limit: intParam(url.searchParams.get("limit"), 50, 200) }))),
        "/api/activity": api((_r, url) => json(db.listSignalLog({ ...chainFilter(url), ...cursor(url), ...(isAddress(url.searchParams.get("token") ?? undefined) ? { token: url.searchParams.get("token")! } : {}), limit: intParam(url.searchParams.get("limit"), 100, 500) }))),
        "/api/track-record": api(() => this.trackRecord()),
        "/api/wallets": api((_r, url) => json(db.walletLeaderboard({ ...chainFilter(url), minClosedTrades: Math.max(1, Math.min(this.cfg.smartMoney.minClosedTrades, 3)), limit: intParam(url.searchParams.get("limit"), 100, 500) }))),
        "/api/wallets/:chain/:address": api((r) => this.wallet(r.params)),
        "/api/stream": api(() => this.stream()),
        "/api/*": () => json({ error: "not found" }, 404),
        "/*": index,
      },
      error: (err) => {
        log.error("dashboard request failed", { err: String(err) });
        return json({ error: "internal error" }, 500);
      },
    });
    this.heartbeat = setInterval(() => this.write(": keepalive\n\n"), 15_000);
    log.info("dashboard listening", { url: `http://127.0.0.1:${this.port}`, auth: this.authToken ? "token" : "open (localhost only)" });
  }

  stop(): void {
    this.unsubscribe?.();
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const c of this.clients) {
      try { c.close(); } catch { /* already closed */ }
    }
    this.clients.clear();
    this.server?.stop(true);
    this.server = null;
  }

  // ---- auth ---------------------------------------------------------------------------

  private authorized(req: Request): boolean {
    if (!this.authToken) return true;
    const header = req.headers.get("authorization") ?? "";
    if (header.startsWith("Bearer ") && safeEqual(header.slice(7), this.authToken)) return true;
    if (header.startsWith("Basic ")) {
      try {
        const decoded = atob(header.slice(6));
        if (safeEqual(decoded.slice(decoded.indexOf(":") + 1), this.authToken)) return true;
      } catch { /* malformed */ }
    }
    const cookie = (req.headers.get("cookie") ?? "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
    return cookie !== undefined && safeEqual(decodeURIComponent(cookie.slice(COOKIE.length + 1)), this.authToken);
  }

  private async guard(req: Request & { params: Record<string, string> }, h: Handler): Promise<Response> {
    if (!this.authorized(req)) return json({ error: "authentication required" }, 401);
    try {
      return await h(req, new URL(req.url));
    } catch (err) {
      log.error("api handler failed", { path: new URL(req.url).pathname, err: String(err) });
      return json({ error: "internal error" }, 500);
    }
  }

  private async login(req: Request): Promise<Response> {
    if (!this.authToken) return json({ ok: true, auth: false });
    let supplied = "";
    try {
      supplied = String(((await req.json()) as { token?: unknown }).token ?? "");
    } catch { /* empty body */ }
    if (!safeEqual(supplied, this.authToken)) return json({ error: "invalid token" }, 401);
    return json({ ok: true, auth: true }, 200, { "set-cookie": `${COOKIE}=${encodeURIComponent(this.authToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` });
  }

  // ---- live stream ----------------------------------------------------------------------

  private stream(): Response {
    let self: ReadableStreamDefaultController<Uint8Array> | null = null;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        self = controller;
        this.clients.add(controller);
        controller.enqueue(this.encoder.encode(`retry: 3000\ndata: ${JSON.stringify({ type: "hello", at: Date.now() })}\n\n`));
        controller.enqueue(this.encoder.encode(`data: ${JSON.stringify({ type: "status", status: this.engine.status() })}\n\n`));
      },
      cancel: () => {
        if (self) this.clients.delete(self);
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" } });
  }

  private push(u: LiveUpdate): void {
    if (this.clients.size === 0) return;
    this.write(`data: ${JSON.stringify(u, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}\n\n`);
  }

  private write(chunk: string): void {
    const bytes = this.encoder.encode(chunk);
    for (const c of this.clients) {
      try {
        // A client that stopped reading must not grow memory without bound.
        if ((c.desiredSize ?? 1) < -64) throw new Error("slow consumer");
        c.enqueue(bytes);
      } catch {
        this.clients.delete(c);
        try { c.close(); } catch { /* closed */ }
      }
    }
  }

  // ---- data ----------------------------------------------------------------------------

  private opportunities(url: URL): Response {
    const scores = db.listScores({ ...chainFilter(url), limit: intParam(url.searchParams.get("limit"), 300, 1_000) });
    const tokens = db.listTokens(scores.map((s) => ({ chainId: s.chainId, address: s.token })));
    const items = scores
      .map((s) => {
        const t = tokens.get(`${s.chainId}:${s.token}`);
        return { ...s, name: t?.name ?? null, source: t?.source ?? null, launchAt: t?.launchAt ?? null, watchUntil: t?.watchUntil ?? null, spark: this.sparkline(s.chainId, s.token) };
      })
      .sort((a, b) => (VERDICT_RANK[a.verdict] ?? 9) - (VERDICT_RANK[b.verdict] ?? 9) || b.score - a.score || b.at - a.at);
    return json(items);
  }

  /** ~24 points of price over the last hour, from in-memory trades. */
  private sparkline(chainId: number, token: Address): number[] {
    const trades = this.engine.stateFor(chainId)?.tradesOf(token) ?? [];
    if (trades.length === 0) return [];
    const end = trades[trades.length - 1]!.ts;
    const bucket = 150;
    const out: number[] = [];
    let i = 0;
    for (let b = end - 3_600; b <= end; b += bucket) {
      let last: number | null = null;
      while (i < trades.length && trades[i]!.ts < b + bucket) {
        if (trades[i]!.ts >= end - 3_600 && trades[i]!.unitUsd > 0) last = trades[i]!.unitUsd;
        i++;
      }
      if (last !== null) out.push(last);
      else if (out.length) out.push(out[out.length - 1]!);
    }
    return out;
  }

  private parse(params: Record<string, string>): { chainId: number; address: Address } | null {
    const chainId = Number(params["chain"]);
    const address = (params["address"] ?? "").toLowerCase();
    return Number.isInteger(chainId) && isAddress(address) ? { chainId, address } : null;
  }

  private token(params: Record<string, string>): Response {
    const p = this.parse(params);
    if (!p) return json({ error: "expected /api/tokens/:chainId/:0xaddress" }, 400);
    const state = this.engine.stateFor(p.chainId);
    const meta = db.getToken(p.chainId, p.address);
    const score = db.getScore(p.chainId, p.address);
    const trades = (state?.tradesOf(p.address) ?? []).slice(-150).reverse().map((t) => ({ ts: t.ts, block: t.block, side: t.side, usd: t.usd, trader: t.trader, nonce: t.nonce, txHash: t.txHash, unitUsd: t.unitUsd }));
    const holders = this.topHolders(p.chainId, p.address, 25);
    return json({
      chainId: p.chainId,
      address: p.address,
      token: meta,
      score,
      watched: meta !== null && (meta.watchUntil === null || meta.watchUntil > Date.now() / 1000),
      live: state?.metrics(p.address, Math.floor(Date.now() / 1000)) !== null && state !== null,
      pools: db.listPools(p.chainId, p.address),
      alerts: db.listAlerts({ chainId: p.chainId, token: p.address, limit: 20 }),
      positions: db.listPositions({ chainId: p.chainId, token: p.address, limit: 20 }),
      activity: db.listSignalLog({ chainId: p.chainId, token: p.address, limit: 60 }),
      trades,
      holders,
    });
  }

  private topHolders(chainId: number, token: Address, n: number) {
    const state = this.engine.stateFor(chainId);
    if (!state) return [];
    const supply = state.tokenMeta(token)?.totalSupply ?? null;
    const traders = state.tradersOf(token);
    return [...state.holdersOf(token)]
      .filter(([a, b]) => b > 0n && !state.isPool(a) && a !== token)
      .sort((x, y) => (y[1] > x[1] ? 1 : y[1] < x[1] ? -1 : 0))
      .slice(0, n)
      .map(([address, balance]) => {
        const f = state.fundingOf(address);
        const pos = traders.get(address);
        return {
          address,
          pct: supply && supply > 0n ? Number((balance * 1_000_000n) / supply) / 10_000 : null,
          cluster: state.clusterKey(address),
          funder: f?.funder ?? null,
          funderIsService: f?.funderIsService ?? null,
          boughtUsd: pos ? Math.round(pos.costUsd) : null,
          soldUsd: pos ? Math.round(pos.proceedsUsd) : null,
          firstNonce: pos?.firstNonce ?? null,
        };
      });
  }

  private candles(params: Record<string, string>, url: URL): Response {
    const p = this.parse(params);
    if (!p) return json({ error: "bad token path" }, 400);
    const tf = [15, 60, 300, 900].includes(Number(url.searchParams.get("tf"))) ? Number(url.searchParams.get("tf")) : 60;
    const state = this.engine.stateFor(p.chainId);
    const decimals = state?.tokenMeta(p.address)?.decimals ?? null;
    const scale = decimals === null ? 1 : 10 ** decimals;
    const out: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }> = [];
    for (const t of state?.tradesOf(p.address) ?? []) {
      if (!(t.unitUsd > 0)) continue;
      const time = t.ts - (t.ts % tf);
      const px = t.unitUsd * scale;
      const last = out[out.length - 1];
      if (last && last.time === time) {
        last.high = Math.max(last.high, px);
        last.low = Math.min(last.low, px);
        last.close = px;
        last.volume += t.usd;
      } else {
        out.push({ time, open: last?.close ?? px, high: Math.max(px, last?.close ?? px), low: Math.min(px, last?.close ?? px), close: px, volume: t.usd });
      }
    }
    return json({ tf, priceScale: decimals === null ? "raw-unit" : "token", candles: out });
  }

  /** Funding graph of a token's holders and early buyers, grouped by cluster key. */
  private graph(params: Record<string, string>): Response {
    const p = this.parse(params);
    if (!p) return json({ error: "bad token path" }, 400);
    const state = this.engine.stateFor(p.chainId);
    if (!state) return json({ nodes: [], edges: [] });
    const holders = this.topHolders(p.chainId, p.address, 40);
    const meta = state.tokenMeta(p.address);
    const creatorScore = db.getScore(p.chainId, p.address)?.metrics["creator"] as string | null | undefined;
    const wallets = new Map<Address, { pct: number | null; role: string }>();
    for (const h of holders) wallets.set(h.address, { pct: h.pct, role: "holder" });
    for (const [addr, pos] of state.tradersOf(p.address)) {
      if (wallets.size >= 80) break;
      if (!wallets.has(addr) && pos.buys > 0) wallets.set(addr, { pct: null, role: pos.sold >= pos.bought ? "exited" : "buyer" });
    }
    if (creatorScore) wallets.set(creatorScore, { pct: wallets.get(creatorScore)?.pct ?? null, role: "creator" });
    const nodes: Array<{ id: string; kind: string; pct: number | null; cluster: string; label: string | null }> = [];
    const edges: Array<{ source: string; target: string; service: boolean }> = [];
    const funders = new Set<Address>();
    for (const [addr, w] of wallets) {
      nodes.push({ id: addr, kind: w.role, pct: w.pct, cluster: state.clusterKey(addr), label: null });
      const f = state.fundingOf(addr);
      if (f?.funder) {
        edges.push({ source: f.funder, target: addr, service: f.funderIsService });
        funders.add(f.funder);
      }
    }
    for (const f of funders) if (!wallets.has(f)) nodes.push({ id: f, kind: "funder", pct: null, cluster: state.clusterKey(f), label: null });
    return json({ symbol: meta?.symbol ?? null, nodes, edges });
  }

  private trackRecord(): Response {
    const positions = db.listPositions({ limit: 5_000 });
    return json({ summary: trackRecord(positions), recent: positions.slice(0, 100) });
  }

  private wallet(params: Record<string, string>): Response {
    const p = this.parse(params);
    if (!p) return json({ error: "bad wallet path" }, 400);
    const state = this.engine.stateFor(p.chainId);
    return json({ ...db.walletDetail(p.chainId, p.address), funding: state?.fundingOf(p.address) ?? null, cluster: state?.clusterKey(p.address) ?? p.address });
  }
}

function chainFilter(url: URL): { chainId?: number } {
  const c = Number(url.searchParams.get("chain"));
  return Number.isInteger(c) && c > 0 ? { chainId: c } : {};
}

function cursor(url: URL): { beforeId?: number } {
  const c = Number(url.searchParams.get("before"));
  return Number.isInteger(c) && c > 0 ? { beforeId: c } : {};
}
