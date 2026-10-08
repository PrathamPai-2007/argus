import { AlertManager } from "./alerts/manager.ts";
import { buildAlertPayload, telegramOutcome } from "./alerts/format.ts";
import { TelegramSink, type AlertSink } from "./alerts/telegram.ts";
import { chainInfo } from "./chains.ts";
import type { ArgusConfig, ChainConfig } from "./config.ts";
import * as db from "./db.ts";
import { TOPICS, decodeLog, type PoolRef, type RawLog } from "./ingest/decode.ts";
import { defaultExplorer, FunderResolver } from "./ingest/funders.ts";
import { discoverPools, readPoolBalances, readTokenMeta } from "./ingest/reads.ts";
import { hex, RpcPool } from "./ingest/rpc.ts";
import { ChainSync, type SyncStatus } from "./ingest/sync.ts";
import { log } from "./logger.ts";
import type { Address, ChainEvent, PoolCreatedEvent, SwapEvent } from "./model.ts";
import { expire, observe, openPosition, type Position } from "./positions.ts";
import { seedLabels } from "./seeds.ts";
import { assess, type Assessment, type Signal } from "./signals.ts";
import { ChainState, type TokenMetrics } from "./state.ts";
import { WebhookDispatcher } from "./webhooks.ts";

// Orchestrator: ChainSync → persist facts → ChainState → assess touched tokens
// → signal log / alerts / paper positions. Backpressure is natural: the sync
// loop awaits onEvents, so nothing is ever dropped between layers.

export type LiveUpdate =
  | { type: "scores"; chainId: number; items: db.ScoreRow[] }
  | { type: "alert"; alert: db.AlertRow }
  | { type: "trades"; chainId: number; token: Address; trades: Array<{ ts: number; side: "buy" | "sell"; usd: number; trader: Address; txHash: string }> }
  | { type: "signal"; entry: db.SignalLogRow }
  | { type: "position"; position: Position }
  | { type: "status"; status: EngineStatus };

interface Runtime {
  cfg: ChainConfig;
  rpc: RpcPool;
  sync: ChainSync;
  state: ChainState;
  funders: FunderResolver | null;
  status: SyncStatus;
  lastBlock: number;
  lastTs: number;
  /** Swaps awaiting finality before they count toward wallet track records. */
  pendingTrades: Array<{ block: number } & db.WalletTradeDelta>;
  lastSignals: Map<Address, Signal[]>;
  metaInFlight: Set<Address>;
  eventsApplied: number;
}

export interface EngineStatus {
  startedAt: number;
  chains: Array<{
    chainId: number;
    name: string;
    status: SyncStatus;
    head: number;
    cursor: number;
    lag: number;
    lastBlockAt: number;
    headStream: string;
    nativeUsd: number;
    watchedTokens: number;
    pools: number;
    eventsApplied: number;
    funderQueue: number | null;
    funderCoverage: string;
    endpoints: Array<{ url: string; healthy: boolean; failures: number }>;
    rpc: { requests: number; calls: number; failovers: number; errors: number };
  }>;
  failedEvents: number;
}

const REF_TOUCH = "__ref__";
const ACTIVE_SECS = 30 * 60;

export class ArgusEngine {
  private runtimes = new Map<number, Runtime>();
  private alerts: AlertManager;
  private webhooks = new WebhookDispatcher();
  private listeners = new Set<(u: LiveUpdate) => void>();
  private openPositions = new Map<string, Position[]>();
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private running = false;
  private startedAt = 0;

  constructor(private cfg: ArgusConfig, private opts: { rewindBlocks?: number } = {}) {
    const sinks: AlertSink[] = [];
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chat = process.env.TELEGRAM_CHAT_ID;
    if (cfg.alerts.telegram) {
      if (token && chat) sinks.push(new TelegramSink(token, chat));
      else log.warn("alerts.telegram is on but TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID are unset — alerts stay on the dashboard");
    }
    this.webhooks.setTargets(cfg.webhooks);
    this.alerts = new AlertManager(cfg.alerts, sinks, this.webhooks);
  }

  // ---- public surface (dashboard) ------------------------------------------------------

  subscribe(fn: (u: LiveUpdate) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  stateFor(chainId: number): ChainState | null {
    return this.runtimes.get(chainId)?.state ?? null;
  }

  chainIds(): number[] {
    return [...this.runtimes.keys()];
  }

  metrics(chainId: number, token: Address): TokenMetrics | null {
    const rt = this.runtimes.get(chainId);
    return rt ? rt.state.metrics(token, this.chainNow(rt)) : null;
  }

  status(): EngineStatus {
    return {
      startedAt: this.startedAt,
      failedEvents: db.countFailedEvents(),
      chains: [...this.runtimes.values()].map((rt) => {
        const s = rt.sync.status();
        return {
          chainId: rt.cfg.chainId,
          name: rt.cfg.name,
          status: rt.status,
          head: s.head,
          cursor: s.cursor,
          lag: s.lag,
          lastBlockAt: s.lastProcessedAt,
          headStream: s.headStream,
          nativeUsd: Math.round(rt.state.nativeUsd * 100) / 100,
          watchedTokens: s.tokens,
          pools: s.pools,
          eventsApplied: rt.eventsApplied,
          funderQueue: rt.funders?.pending ?? null,
          funderCoverage: rt.funders ? `${db.countFunding(rt.cfg.chainId)} wallets resolved` : "disabled (no explorer key)",
          endpoints: s.endpoints,
          rpc: { ...rt.rpc.stats },
        };
      }),
    };
  }

  // ---- lifecycle -----------------------------------------------------------------------

  async start(): Promise<void> {
    this.running = true;
    this.startedAt = Math.floor(Date.now() / 1000);
    const chains = this.cfg.chains.filter((c) => c.enabled);
    seedLabels(chains.map((c) => c.chainId));
    for (const p of db.listPositions({ openOnly: true })) this.trackPosition(p);

    for (const c of chains) {
      const rt = this.createRuntime(c);
      this.runtimes.set(c.chainId, rt);
      await this.restore(rt);
    }
    for (const w of this.cfg.watchlist) {
      const rt = this.runtimes.get(w.chainId);
      if (rt) void this.watchManual(rt, w.address).catch((err) => log.warn("watchlist setup failed", { chainId: w.chainId, token: w.address, err: String(err) }));
    }
    await Promise.all([...this.runtimes.values()].map((rt) => rt.sync.start().catch((err) => {
      log.error("chain sync failed to start", { chainId: rt.cfg.chainId, err: String(err) });
    })));

    this.timers.push(setInterval(() => void this.housekeeping(), 60_000));
    this.timers.push(setInterval(() => this.emit({ type: "status", status: this.status() }), 5_000));
    this.timers.push(setInterval(() => this.pruneRetention(), 3_600_000));
    log.info("argus engine started", { chains: chains.map((c) => c.name), watchlist: this.cfg.watchlist.length });
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const rt of this.runtimes.values()) {
      rt.funders?.stop();
      await rt.sync.stop();
    }
    this.webhooks.stop();
    log.info("argus engine stopped");
  }

  updateConfig(next: ArgusConfig): void {
    this.cfg.signals = next.signals;
    this.cfg.alerts = next.alerts;
    this.cfg.discovery = next.discovery;
    this.cfg.smartMoney = next.smartMoney;
    this.cfg.webhooks = next.webhooks;
    this.alerts.updateConfig(next.alerts);
    this.webhooks.setTargets(next.webhooks);
    log.info("config hot-reloaded (signals, alerts, discovery, smartMoney, webhooks)");
  }

  private createRuntime(c: ChainConfig): Runtime {
    const rpc = new RpcPool(c.http, `rpc:${c.chainId}`);
    const state = new ChainState(c.chainId);
    const rt: Runtime = {
      cfg: c, rpc, state, funders: null, status: "starting", lastBlock: 0, lastTs: 0, pendingTrades: [], lastSignals: new Map(), metaInFlight: new Set(), eventsApplied: 0,
      sync: null as unknown as ChainSync,
    };
    rt.sync = new ChainSync(
      { chainId: c.chainId, rpc, wsUrls: c.ws, finalityDepth: c.finalityDepth, blockTimeMs: c.blockTimeMs, autoRegisterPools: this.cfg.discovery.newPools, resumeFrom: db.finalizedCursor(c.chainId), ...(this.opts.rewindBlocks ? { rewindBlocks: this.opts.rewindBlocks } : {}) },
      {
        onEvents: (_id, events) => this.onEvents(rt, events),
        onReorg: (_id, from) => this.onReorg(rt, from),
        onFinalized: (_id, block) => this.onFinalized(rt, block),
        onStatus: (_id, status, detail) => {
          rt.status = status;
          log.info("chain status", { chainId: c.chainId, status, ...detail });
        },
        onPoolRegistered: (_id, ref, created) => this.onLaunch(rt, ref, created),
      },
    );
    const explorer = defaultExplorer(c.chainId, this.cfg.explorerKeys);
    if (explorer) {
      const labels = db.loadLabels(c.chainId);
      rt.funders = new FunderResolver(c.chainId, explorer, rpc, (r) => {
        db.saveFunding(c.chainId, r);
        state.setFunding(r.wallet, { funder: r.funder, funderIsService: r.funderIsService });
      }, (a) => labels.get(a)?.kind === "cex");
    } else {
      log.warn("no explorer key for funder lookups — clustering signals degrade", { chainId: c.chainId, hint: c.chainId === 1 ? "set ETHERSCAN_API_KEY" : "set BLOCKSCOUT_API_KEY (free at blockscout.com)" });
    }
    return rt;
  }

  /** Rebuild state from local finalized facts (no RPC) and re-register watched pools. */
  private async restore(rt: Runtime): Promise<void> {
    const chainId = rt.cfg.chainId;
    const cursor = db.finalizedCursor(chainId);
    // Session reset (invariant 13): unfinalized facts are re-ingested from the cursor.
    db.deleteUnfinalizedFrom(chainId, (cursor ?? 0) + 1);
    const labels = db.loadLabels(chainId);
    rt.state.setServiceLabels(new Map([...labels].filter(([, l]) => ["cex", "router", "bridge"].includes(l.kind)).map(([a, l]) => [a, l.label])));
    for (const f of db.loadFunding(chainId)) rt.state.setFunding(f.wallet, { funder: f.funder, funderIsService: f.funderIsService });
    rt.state.setSmartWallets(db.smartWallets(chainId, this.cfg.smartMoney));

    const watched = db.listWatchedTokens(chainId);
    const tokens = watched.map((t) => t.address);
    for (const t of watched) rt.state.setTokenMeta(t.address, { symbol: t.symbol, name: t.name, decimals: t.decimals, totalSupply: t.totalSupply });
    const ref = chainInfo(chainId).nativeUsdPool;
    rt.state.registerPool({ address: ref.address, dex: ref.dex, token0: ref.token0, token: chainInfo(chainId).wrappedNative, quote: ref.token0 === chainInfo(chainId).wrappedNative ? ref.token1 : ref.token0 });
    for (const p of db.listPools(chainId)) {
      if (!tokens.includes(p.token)) continue;
      rt.state.registerPool(p, p.createdBlock);
      rt.sync.registerPool(p);
    }
    rt.sync.setWatchedTokens(tokens);
    const events = db.loadEvents(chainId, { tokens: [...tokens, chainInfo(chainId).wrappedNative], finalizedOnly: true });
    for (const e of events) rt.state.apply(e);
    for (const t of tokens) {
      const s = db.getScore(chainId, t);
      if (s) rt.lastSignals.set(t, s.signals);
    }
    if (events.length > 0) log.info("restored chain state from local facts", { chainId, tokens: tokens.length, events: events.length });
  }

  // ---- event flow ------------------------------------------------------------------------

  private async onEvents(rt: Runtime, raw: ChainEvent[]): Promise<void> {
    const refPool = chainInfo(rt.cfg.chainId).nativeUsdPool.address;
    // One reference-pool price per block is plenty; keep the last.
    const lastRefPerBlock = new Map<number, ChainEvent>();
    for (const e of raw) if (e.kind === "swap" && e.pool === refPool) lastRefPerBlock.set(e.blockNumber, e);
    const events = raw.filter((e) => !(e.kind === "swap" && e.pool === refPool) || lastRefPerBlock.get(e.blockNumber) === e);

    const fresh = db.insertEvents(events);
    const touched = new Set<Address>();
    const trades = new Map<Address, Array<{ ts: number; side: "buy" | "sell"; usd: number; trader: Address; txHash: string }>>();
    for (const e of fresh) {
      try {
        rt.state.apply(e);
        db.clearFailedEvent(e);
      } catch (err) {
        db.recordFailedEvent(e, err);
        log.error("event application failed", { chainId: rt.cfg.chainId, block: e.blockNumber, kind: e.kind, err: String(err) });
        continue;
      }
      rt.eventsApplied++;
      if (e.blockNumber > rt.lastBlock) rt.lastBlock = e.blockNumber;
      if (e.timestamp > rt.lastTs) rt.lastTs = e.timestamp;
      if (e.kind === "swap" && e.pool === refPool) {
        touched.add(REF_TOUCH);
        continue;
      }
      if (e.kind === "swap") {
        touched.add(e.token);
        this.onTrade(rt, e, trades);
      } else if (e.kind === "transfer" || e.kind === "liquidity" || e.kind === "reserves") {
        touched.add(e.token);
        if (e.kind === "transfer") this.maybeResolveHolder(rt, e.token, e.to, e.amount);
      }
    }
    for (const [token, list] of trades) this.emit({ type: "trades", chainId: rt.cfg.chainId, token, trades: list });
    touched.delete(REF_TOUCH);
    if (touched.size > 0) await this.assessTokens(rt, [...touched]);
  }

  private onTrade(rt: Runtime, e: SwapEvent, out: Map<Address, Array<{ ts: number; side: "buy" | "sell"; usd: number; trader: Address; txHash: string }>>): void {
    const last = rt.state.tradesOf(e.token).at(-1);
    const usd = last && last.txHash === e.txHash ? last.usd : 0;
    rt.pendingTrades.push({ block: e.blockNumber, wallet: e.trader, token: e.token, side: e.side, tokenAmount: Number(e.tokenAmount), usd, at: e.timestamp });
    const list = out.get(e.token) ?? [];
    list.push({ ts: e.timestamp, side: e.side, usd, trader: e.trader, txHash: e.txHash });
    out.set(e.token, list);
    if (e.side === "buy" && rt.funders && !rt.state.fundingOf(e.trader)) {
      const m = rt.state.tradersOf(e.token).get(e.trader);
      const metaLaunch = db.getToken(rt.cfg.chainId, e.token)?.launchBlock ?? null;
      const priority = metaLaunch !== null && e.blockNumber <= metaLaunch + 2 ? 0 : m && m.buys <= 1 ? 2 : 4;
      if (priority <= 2 || rt.funders.pending < 5_000) rt.funders.enqueue(e.trader, priority);
    }
  }

  /** Large transfer recipients are where distribution wallets hide: resolve their funders. */
  private maybeResolveHolder(rt: Runtime, token: Address, to: Address, amount: bigint): void {
    if (!rt.funders || rt.state.fundingOf(to) || rt.state.isPool(to)) return;
    const supply = rt.state.tokenMeta(token)?.totalSupply;
    if (supply && supply > 0n && amount * 200n >= supply) rt.funders.enqueue(to, 1);
  }

  private chainNow(rt: Runtime): number {
    // Chain time keeps windows deterministic (replay) and honest during catch-up.
    return rt.lastTs || Math.floor(Date.now() / 1000);
  }

  private async assessTokens(rt: Runtime, tokens: Address[]): Promise<void> {
    const chainId = rt.cfg.chainId;
    const now = this.chainNow(rt);
    const scores: db.ScoreRow[] = [];
    for (const token of tokens) {
      const m = rt.state.metrics(token, now);
      if (!m) continue;
      const a = assess(m, this.cfg.signals);
      const summary = metricsSummary(m, rt.state.tokenMeta(token)?.decimals ?? null);
      db.upsertScore(a, rt.lastBlock, summary);
      scores.push({ chainId, token, at: a.at, block: rt.lastBlock, score: a.score, verdict: a.verdict, gate: a.gate, signals: a.signals, metrics: summary });
      this.logSignalChanges(rt, token, a);
      await this.actOn(rt, a, m);
      this.markPositions(rt, token, m);
    }
    if (scores.length > 0) this.emit({ type: "scores", chainId, items: scores });
  }

  private logSignalChanges(rt: Runtime, token: Address, a: Assessment): void {
    const prev = new Map((rt.lastSignals.get(token) ?? []).map((s) => [s.id, s]));
    const next = new Map(a.signals.map((s) => [s.id, s]));
    const changes: Array<[Signal, db.SignalLogRow["change"]]> = [];
    for (const [id, s] of next) {
      const p = prev.get(id);
      if (!p) changes.push([s, "fired"]);
      else if (p.severity !== s.severity) changes.push([s, "escalated"]);
    }
    for (const [id, s] of prev) if (!next.has(id)) changes.push([s, "cleared"]);
    rt.lastSignals.set(token, a.signals);
    for (const [s, change] of changes) {
      const id = db.logSignal(rt.cfg.chainId, token, s, change, rt.lastBlock, a.at);
      this.emit({ type: "signal", entry: { id, chainId: rt.cfg.chainId, token, signalId: s.id, kind: s.kind, severity: s.severity, change, title: s.title, evidence: s.evidence, block: rt.lastBlock, at: a.at } });
    }
  }

  private async actOn(rt: Runtime, a: Assessment, m: TokenMetrics): Promise<void> {
    const chainId = rt.cfg.chainId;
    const key = `${chainId}:${a.token}`;
    const decimals = rt.state.tokenMeta(a.token)?.decimals ?? null;
    const hasAlertPosition = (this.openPositions.get(key) ?? []).some((p) => p.kind === "alert");
    const confirmed = false; // alerts confirm when their block finalizes

    if ((a.verdict === "alert" || a.verdict === "high_conviction") && m.priceUnitUsd !== null) {
      const payload = buildAlertPayload("opportunity", a, m, decimals, this.cfg.dashboard.port);
      const id = await this.alerts.emit(payload, rt.lastBlock, confirmed);
      if (id !== null) {
        const row = db.getAlert(id);
        if (row) this.emit({ type: "alert", alert: row });
        if (!hasAlertPosition) this.open(rt, a.token, "alert", id, a.score, m.priceUnitUsd);
        db.setWatchUntil(chainId, a.token, Math.floor(Date.now() / 1000) + 86_400);
      }
      return;
    }
    if (a.verdict === "avoid" && hasAlertPosition) {
      const payload = buildAlertPayload("exit", a, m, decimals, this.cfg.dashboard.port);
      const id = await this.alerts.emit(payload, rt.lastBlock, confirmed);
      const row = id !== null ? db.getAlert(id) : null;
      if (row) this.emit({ type: "alert", alert: row });
      return;
    }
    // Baseline cohort: liquid launches we watched from block one and never alerted.
    if (m.launchObserved && m.priceUnitUsd !== null && m.liquidityUsd >= this.cfg.discovery.baselineLiquidityUsd && !(this.openPositions.get(key) ?? []).length && !db.lastAlert(chainId, a.token, "opportunity")) {
      this.open(rt, a.token, "baseline", null, a.score, m.priceUnitUsd);
    }
  }

  private open(rt: Runtime, token: Address, kind: "alert" | "baseline", alertId: number | null, score: number, unitUsd: number): void {
    const p = openPosition({ chainId: rt.cfg.chainId, token, kind, alertId, score, entryUnitUsd: unitUsd, entryAt: this.chainNow(rt), entryBlock: rt.lastBlock });
    const id = db.insertPosition(p);
    if (id === 0) return; // a baseline already exists
    const saved = { ...p, id };
    this.trackPosition(saved);
    this.emit({ type: "position", position: saved });
  }

  private trackPosition(p: Position): void {
    const key = `${p.chainId}:${p.token}`;
    this.openPositions.set(key, [...(this.openPositions.get(key) ?? []).filter((x) => x.id !== p.id), p]);
  }

  private markPositions(rt: Runtime, token: Address, m: TokenMetrics): void {
    const key = `${rt.cfg.chainId}:${token}`;
    const list = this.openPositions.get(key);
    if (!list || m.priceUnitUsd === null) return;
    const next: Position[] = [];
    for (const p of list) {
      const u = observe(p, m.priceUnitUsd, this.chainNow(rt));
      if (u !== p) {
        db.savePosition(u);
        this.emit({ type: "position", position: u });
        if (u.closedAt !== null) void this.onPositionClosed(u, m.symbol);
      }
      if (u.closedAt === null) next.push(u);
    }
    if (next.length) this.openPositions.set(key, next);
    else this.openPositions.delete(key);
  }

  private async onPositionClosed(p: Position, symbol: string | null): Promise<void> {
    if (p.kind === "alert") await this.alerts.broadcast(telegramOutcome(p, symbol));
  }

  // ---- launches & watches ------------------------------------------------------------------

  private onLaunch(rt: Runtime, ref: PoolRef, created: PoolCreatedEvent): void {
    const chainId = rt.cfg.chainId;
    const watched = rt.sync.watchedTokens().length;
    if (watched > this.cfg.discovery.maxWatchedPerChain) this.evictQuietest(rt);
    db.insertPool({ chainId, ...ref, createdBlock: created.blockNumber });
    db.upsertToken({
      chainId, address: ref.token, source: "launch", firstSeenAt: created.timestamp, launchBlock: created.blockNumber, launchAt: created.timestamp,
      watchUntil: created.timestamp + this.cfg.discovery.watchHours * 3600,
    });
    rt.state.registerPool(ref, created.blockNumber);
    void this.fetchMeta(rt, ref.token);
    void this.backfillHolders(rt, ref.token, created.blockNumber);
  }

  private async watchManual(rt: Runtime, token: Address): Promise<void> {
    const chainId = rt.cfg.chainId;
    db.upsertToken({ chainId, address: token, source: "manual", firstSeenAt: Math.floor(Date.now() / 1000) });
    await this.fetchMeta(rt, token);
    const pools = await discoverPools(rt.rpc, chainId, token);
    for (const p of pools) {
      const balances = await readPoolBalances(rt.rpc, p);
      // Ignore dust pools: they add log volume without price information.
      if (!balances || balances.quoteBalance === 0n) continue;
      db.insertPool({ chainId, ...p, createdBlock: null });
      rt.state.registerPool(p);
      rt.state.setPoolBalances(p.address, balances.tokenBalance, balances.quoteBalance);
      rt.sync.registerPool(p);
    }
    rt.sync.setWatchedTokens([...rt.sync.watchedTokens(), token]);
    log.info("watching token", { chainId, token, pools: pools.length });
  }

  private async fetchMeta(rt: Runtime, token: Address): Promise<void> {
    if (rt.metaInFlight.has(token)) return;
    rt.metaInFlight.add(token);
    try {
      const meta = await readTokenMeta(rt.rpc, token);
      rt.state.setTokenMeta(token, meta);
      const existing = db.getToken(rt.cfg.chainId, token);
      if (existing) db.upsertToken({ ...existing, ...meta, totalSupply: meta.totalSupply });
    } catch (err) {
      log.debug("token metadata fetch failed", { chainId: rt.cfg.chainId, token, err: String(err) });
    } finally {
      rt.metaInFlight.delete(token);
    }
  }

  /**
   * Holder history before the pool existed (the mint and the dev's distribution)
   * lives in blocks we never synced. One bounded getLogs fetches it; holder
   * deltas commute and those blocks are long final, so applying them now is safe.
   */
  private async backfillHolders(rt: Runtime, token: Address, launchBlock: number): Promise<void> {
    const span = Math.min(rt.rpc.primaryLimits.maxLogRange, 2_000);
    try {
      const from = Math.max(0, launchBlock - span);
      const logs = (await rt.rpc.request<Array<{ address: string; topics: `0x${string}`[]; data: `0x${string}`; blockNumber: string; transactionIndex: string; logIndex: string; transactionHash: `0x${string}` }>>(
        "eth_getLogs", [{ fromBlock: hex(from), toBlock: hex(launchBlock - 1), address: token, topics: [TOPICS.transfer] }],
      ));
      const ctx = { chainId: rt.cfg.chainId, timestamp: 0, pool: () => undefined, factory: () => undefined, isWatchedToken: () => true, tx: () => undefined };
      const events = logs.map((l): RawLog => ({ ...l, address: l.address.toLowerCase(), blockNumber: Number(BigInt(l.blockNumber)), transactionIndex: Number(BigInt(l.transactionIndex)), logIndex: Number(BigInt(l.logIndex)) }))
        .map((l) => decodeLog(l, ctx)).filter((e): e is ChainEvent => e !== null);
      for (const e of db.insertEvents(events)) rt.state.apply(e);
      if (events.length > 0) log.debug("backfilled pre-launch holders", { chainId: rt.cfg.chainId, token, transfers: events.length });
    } catch (err) {
      log.debug("pre-launch holder backfill skipped", { chainId: rt.cfg.chainId, token, err: String(err).slice(0, 200) });
    }
  }

  private unwatch(rt: Runtime, token: Address): void {
    for (const p of db.listPools(rt.cfg.chainId, token)) rt.sync.unregisterPool(p.address);
    rt.sync.setWatchedTokens(rt.sync.watchedTokens().filter((t) => t !== token));
    rt.state.dropToken(token);
    rt.lastSignals.delete(token);
    db.deleteScore(rt.cfg.chainId, token);
  }

  private evictQuietest(rt: Runtime): void {
    const now = this.chainNow(rt);
    const candidates = db.listWatchedTokens(rt.cfg.chainId).filter((t) => t.source !== "manual" && !this.openPositions.has(`${rt.cfg.chainId}:${t.address}`));
    const lastTrade = (t: Address) => rt.state.tradesOf(t).at(-1)?.ts ?? 0;
    const quiet = candidates.sort((a, b) => lastTrade(a.address) - lastTrade(b.address)).slice(0, Math.max(1, Math.floor(candidates.length / 10)));
    for (const t of quiet) {
      db.setWatchUntil(rt.cfg.chainId, t.address, now);
      this.unwatch(rt, t.address);
    }
    log.info("watch cap reached — evicted quiet tokens", { chainId: rt.cfg.chainId, evicted: quiet.length });
  }

  private async housekeeping(): Promise<void> {
    if (!this.running) return;
    const wall = Math.floor(Date.now() / 1000);
    for (const rt of this.runtimes.values()) {
      const chainId = rt.cfg.chainId;
      rt.state.setSmartWallets(db.smartWallets(chainId, this.cfg.smartMoney));
      const active = new Set(rt.sync.watchedTokens());
      for (const t of db.listWatchedTokens(chainId, 0)) {
        if (t.watchUntil === null || t.watchUntil > wall || !active.has(t.address)) continue;
        const lastTrade = rt.state.tradesOf(t.address).at(-1)?.ts ?? 0;
        const age = wall - (t.launchAt ?? t.firstSeenAt);
        const held = this.openPositions.has(`${chainId}:${t.address}`);
        if (held || (wall - lastTrade < ACTIVE_SECS && age < this.cfg.discovery.maxWatchHours * 3600)) {
          db.setWatchUntil(chainId, t.address, wall + 3600);
        } else {
          this.unwatch(rt, t.address);
        }
      }
    }
    for (const [key, list] of this.openPositions) {
      const kept: Position[] = [];
      for (const p of list) {
        const e = expire(p, wall);
        if (e !== p) {
          db.savePosition(e);
          this.emit({ type: "position", position: e });
          void this.onPositionClosed(e, this.stateFor(p.chainId)?.tokenMeta(p.token)?.symbol ?? null);
        } else kept.push(p);
      }
      if (kept.length) this.openPositions.set(key, kept);
      else this.openPositions.delete(key);
    }
  }

  private pruneRetention(): void {
    const pruned = db.pruneEvents(Math.floor(Date.now() / 1000) - this.cfg.retention.eventDays * 86_400);
    if (pruned > 0) log.info("retention sweep", { prunedEvents: pruned });
  }

  // ---- finality & reorgs -------------------------------------------------------------------

  private onFinalized(rt: Runtime, block: number): void {
    db.markFinalized(rt.cfg.chainId, block);
    rt.state.finalize(block, this.chainNow(rt));
    const ready = rt.pendingTrades.filter((t) => t.block <= block);
    if (ready.length > 0) {
      rt.pendingTrades = rt.pendingTrades.filter((t) => t.block > block);
      db.applyWalletTrades(rt.cfg.chainId, ready.filter((t) => t.usd > 0));
    }
  }

  private async onReorg(rt: Runtime, fromBlock: number): Promise<void> {
    const chainId = rt.cfg.chainId;
    const rewound = rt.state.rewindTo(fromBlock);
    db.deleteUnfinalizedFrom(chainId, fromBlock);
    rt.pendingTrades = rt.pendingTrades.filter((t) => t.block < fromBlock);
    const retracted = await this.alerts.retract(chainId, fromBlock);
    for (const [key, list] of this.openPositions) {
      const kept = list.filter((p) => !(p.chainId === chainId && p.alertId !== null && retracted.includes(p.alertId)));
      if (kept.length) this.openPositions.set(key, kept);
      else this.openPositions.delete(key);
    }
    rt.lastBlock = Math.min(rt.lastBlock, fromBlock - 1);
    log.warn("reorg handled", { chainId, fromBlock, rewound, retracted: retracted.length });
  }

  private emit(u: LiveUpdate): void {
    for (const fn of this.listeners) {
      try {
        fn(u);
      } catch (err) {
        log.error("live listener failed", { err: String(err) });
      }
    }
  }
}

/** Compact, JSON-safe metrics for the board and API (no bigints). */
export function metricsSummary(m: TokenMetrics, decimals: number | null): Record<string, unknown> {
  const w = (x: TokenMetrics["w15m"]) => ({ buys: x.buys, sells: x.sells, buyUsd: Math.round(x.buyUsd), sellUsd: Math.round(x.sellUsd), buyers: x.buyers, organicBuyers: x.organicBuyers, freshBuyers: x.freshBuyers, traders: x.traders });
  return {
    symbol: m.symbol,
    ageSec: m.ageSec,
    launchObserved: m.launchObserved,
    priceUsd: m.priceUnitUsd !== null && decimals !== null ? m.priceUnitUsd * 10 ** decimals : null,
    priceUnitUsd: m.priceUnitUsd,
    marketCapUsd: m.priceUnitUsd !== null && m.totalSupply !== null ? m.priceUnitUsd * Number(m.totalSupply) : null,
    liquidityUsd: Math.round(m.liquidityUsd),
    initialLiquidityUsd: m.initialLiquidityUsd === null ? null : Math.round(m.initialLiquidityUsd),
    w5m: w(m.w5m), w15m: w(m.w15m), w1h: w(m.w1h),
    trades: m.trades,
    smartBuyers: m.smartBuyers.length,
    earlyBuyers: m.earlyBuyers,
    earlyBuyersHolding: m.earlyBuyersHolding,
    launchSupplyPct: m.launchSupplyPct,
    topClusterPct: m.topClusterPct,
    topHolderPct: m.topHolderPct,
    funderCoverage: Math.round(m.funderCoverage * 100) / 100,
    creator: m.creator,
  };
}
