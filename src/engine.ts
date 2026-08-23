import { watch } from "node:fs";
import { AlertManager } from "./alerts/manager.ts";
import { scoreCandidate } from "./candidates.ts";
import { buildAlertLinks, formatPerformanceOutcomeMessage, TelegramSink, type AlertSink } from "./alerts/telegram.ts";
import { loadConfig, reloadConfig, type ArgusConfig } from "./config.ts";
import * as db from "./db.ts";
import { resolveFactories } from "./factories.ts";
import { GraphEngine, DEFAULT_GRAPH_TUNING } from "./graph/engine.ts";
import { EvmAdapter, type AdapterStatus, type ChainAdapter } from "./ingest/evm.ts";
import { rankStablecoinVolume, fetchTokenPrice, fetchTokenPriceForPool, type RankedToken } from "./ingest/dexscreener.ts";
import { log, redactUrl } from "./logger.ts";
import { decimalsForAddress, priceFromSwap, thresholds, updateSession, PERFORMANCE_WINDOW_SECS, type PerformanceEvent, type PerformanceSession } from "./performance.ts";
import { EventQueue } from "./queue.ts";
import { RULES } from "./rules/index.ts";
import { scoreToken } from "./scorer.ts";
import { seedLabels } from "./seeds.ts";
import { WebhookDispatcher } from "./webhooks.ts";
import type { Address, AlertPayload, Signal, StandardEvent, TokenMeta } from "./types.ts";

// Orchestrator (PLAN.md §4): adapters → queue → graph → rules → scorer → alerts.

interface QueuedEvents {
  chainId: number;
  events: StandardEvent[];
}

interface ChainRuntime {
  adapter: ChainAdapter;
  status: AdapterStatus;
  lastAppliedBlock: number;
  eventsApplied: number;
}

const KNOWN_QUOTES: Record<number, Set<string>> = {
  1: new Set(
    [
      "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
      "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
      "0x6b175474e89094c44da98b954eedeac495271d0f", // DAI
    ].map((a) => a.toLowerCase()),
  ),
  56: new Set(
    [
      "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", // WBNB
      "0x55d398326f99059ff775485246999027b3197955", // USDT
      "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", // USDC
    ].map((a) => a.toLowerCase()),
  ),
  8453: new Set(
    [
      "0x4200000000000000000000000000000000000006", // WETH
      "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC
    ].map((a) => a.toLowerCase()),
  ),
};

export class ArgusEngine {
  private graphs = new Map<number, GraphEngine>();
  private queue = new EventQueue<QueuedEvents>(100_000, (item) => item.events.length);
  private queueRecoveryDropped = 0;
  private queueRecoveryRunning = new Set<number>();
  private chains = new Map<number, ChainRuntime>();
  private alertManager: AlertManager;
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  private draining = false;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private performanceTimer: ReturnType<typeof setInterval> | null = null;
  private performancePollRunning = false;
  private volumeTimer: ReturnType<typeof setInterval> | null = null;
  private configWatcher: ReturnType<typeof watch> | null = null;
  private significance = new Map<string, { lastAt: number; lastValue: number | null }>();
  private metaInFlight = new Set<string>();
  private metaFailed = new Set<string>(); // tokens whose totalSupply() reverts — never re-fetch (meta-fetch storm)
  private nonceInFlight = new Set<string>();
  private pendingFinalized = new Map<number, number>();
  private finalizing = new Set<number>();
  private controlTail: Promise<void> = Promise.resolve();
  private running = false;
  private alertHook: ((payload: AlertPayload, id: number) => void) | null = null;
  private performanceHook: ((event: PerformanceEvent) => void) | null = null;
  private webhooks = new WebhookDispatcher();
  private enrichmentQueue: RankedToken[] = [];
  private enrichmentQueued = new Set<string>();
  private enrichmentRunning = false;
  private failedEventRetries = new Map<string, number>();
  private failedEventTimers = new Set<ReturnType<typeof setTimeout>>();

  private signalHook?: (signal: Signal) => void;
  private eventHook?: (event: StandardEvent) => void;
  private tokenHook?: (token: TokenMeta) => void;
  /** Optional live hook for emitted alerts (Phase 4 dashboard SSE/WS). */
  setAlertHook(hook: (payload: AlertPayload, id: number) => void): void {
    this.alertHook = hook;
  }

  setPerformanceHook(hook: (event: PerformanceEvent) => void): void {
    this.performanceHook = hook;
  }

  setSignalHook(hook: (signal: Signal) => void): void {
    this.signalHook = hook;
  }

  setEventHook(hook: (event: StandardEvent) => void): void {
    this.eventHook = hook;
  }

  setTokenHook(hook: (token: TokenMeta) => void): void {
    this.tokenHook = hook;
  }

  /** Active chain ids (Phase 4 dashboard). */
  chainsForStatus(): number[] {
    return [...this.chains.keys()];
  }

  /** Live graph view for the dashboard/API (read-only; never mutate from outside). */
  graphView(chainId?: number): GraphEngine {
    if (chainId !== undefined) return this.graphFor(chainId);
    const firstChain = this.chains.keys().next().value ?? 1;
    return this.graphFor(firstChain);
  }

  private graphFor(chainId: number): GraphEngine {
    let graph = this.graphs.get(chainId);
    if (!graph) {
      graph = new GraphEngine(DEFAULT_GRAPH_TUNING);
      this.graphs.set(chainId, graph);
    }
    return graph;
  }

  constructor(private cfg: ArgusConfig) {
    const sinks: AlertSink[] = [];
    if (cfg.alerts.telegram) {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (token && chatId) {
        sinks.push(new TelegramSink(token, chatId));
      } else {
        log.warn("alerts.telegram enabled but TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set — alerts will only be logged");
      }
    }
    this.alertManager = new AlertManager(cfg.alerts, cfg.scoring, sinks);
    this.webhooks.setTargets(cfg.webhooks);
  }

  // ---- startup ----------------------------------------------------------------

  async start(): Promise<void> {
    this.running = true;
    db.resetSessionData();
    const enabled = this.cfg.chains.filter((c) => c.enabled);
    seedLabels(enabled.map((c) => c.chainId));

    for (const c of enabled) {
      this.loadChainStateIntoGraph(c.chainId);
    }

    // Config watchlist → tokens table
    const now = Math.floor(Date.now() / 1000);
    for (const w of this.cfg.watchlist) {
      db.upsertToken({ chainId: w.chainId, address: w.address, symbol: null, decimals: null, totalSupply: null, source: "manual" });
    }

    // Adapters
    for (const c of enabled) {
      const adapter = new EvmAdapter(c, {
        onEvents: async (chainId, events) => {
          const safeEvents = events.map((event) => {
            const safe = { ...event, timestamp: Number((event as unknown as { timestamp: unknown }).timestamp) } as StandardEvent;
            if (safe.kind === "transfer" || safe.kind === "funding") safe.amount = BigInt(safe.amount);
            if (safe.kind === "swap") {
              safe.tokenAmount = BigInt(safe.tokenAmount);
              safe.quoteAmount = BigInt(safe.quoteAmount);
            }
            this.eventHook?.(safe);
            return safe;
          });
          const inserted = db.insertEvents(safeEvents, false);
          if (inserted.length > 0) {
            if (this.queue.depth >= this.queue.capacity && this.queue.dropped > this.queueRecoveryDropped) {
              this.queueRecoveryDropped = this.queue.dropped;
              void this.recoverQueueOverflow(chainId);
            }
            for (let i = 0; i < inserted.length; i += 256) {
              this.queue.push({ chainId, events: inserted.slice(i, i + 256) });
            }
            if (this.queue.dropped > this.queueRecoveryDropped) {
              this.queueRecoveryDropped = this.queue.dropped;
              void this.recoverQueueOverflow(chainId);
            }
            await this.drain();
          }
        },
        onFinalized: (chainId, upTo) => this.onFinalized(chainId, upTo),
        onReorg: (chainId, from) => this.onReorg(chainId, from),
          onStatus: (chainId, status, detail) => this.onAdapterStatus(chainId, status, detail),
          getAppliedBlock: (chainId) => this.chains.get(chainId)?.lastAppliedBlock ?? 0,
      });
      const labels = db.loadLabels(c.chainId);
      adapter.setDisperseContracts([...labels.entries()].filter(([, l]) => l.kind === "disperse").map(([a]) => a));
      const watched = db.listWatchedTokens(c.chainId, now).map((t) => t.address);
      adapter.setWatchedTokens(watched);
      if (this.cfg.autoWatch.enabled) adapter.setFactories(resolveFactories(c.chainId, this.cfg.autoWatch.factories));
      // Seed funding-follow set with known infra/CEX/disperse addresses so their
      // gas-funding edges are tracked from the start (Bug A: relevance-gated funding).
      adapter.addRelevantAddresses([...labels.keys()]);
      // Register pools known from the DB so LP/Swap subscriptions are live immediately.
      for (const p of db.listPools(c.chainId)) {
        this.graphFor(c.chainId).registerPool(p.poolAddress, p.createdBlock, p.createdTs ?? undefined);
        const t0 = p.token0 ?? p.tokenAddress;
        const t1 = p.token1 ?? p.quoteToken ?? p.tokenAddress;
        if (db.getToken(c.chainId, p.tokenAddress)?.source !== "candidate") adapter.registerPool(p.poolAddress, t0, t1);
      }
      this.chains.set(c.chainId, { adapter, status: "connecting", lastAppliedBlock: 0, eventsApplied: 0 });
    }

    this.drainTimer = setInterval(() => this.drain(), 250);
    this.pruneTimer = setInterval(() => this.retentionSweep(), 60 * 60_000);
    this.performanceTimer = setInterval(() => void this.expirePerformance(), 15_000);

    for (const [chainId, rt] of this.chains) {
      rt.adapter.start(null).catch((err) => {
        const safeErr = redactUrl(String(err));
        log.error("adapter start failed", { chainId, err: safeErr });
        this.onAdapterStatus(chainId, "error", { err: safeErr });
      });
    }
    void this.primeWatchlistPools();

    this.watchConfigFile();
    this.volumeTimer = setInterval(() => void this.refreshVolumeRankings(), this.cfg.volumeRanking.pollMinutes * 60_000);
    setTimeout(() => void this.refreshVolumeRankings(), 10_000);
    log.info("argus engine started", {
      chains: enabled.map((c) => c.chainId),
      configuredWatchlist: this.cfg.watchlist.length,
      activeWatchlist: enabled.reduce((n, c) => n + db.listWatchedTokens(c.chainId, now).length, 0),
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.drainTimer) clearInterval(this.drainTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    if (this.performanceTimer) clearInterval(this.performanceTimer);
    if (this.volumeTimer) clearInterval(this.volumeTimer);
    this.configWatcher?.close();
    for (const rt of this.chains.values()) await rt.adapter.stop();
    for (const timer of this.failedEventTimers) clearTimeout(timer);
    this.failedEventTimers.clear();
    for (const rt of this.chains.values()) await rt.adapter.flushEvents();
    await this.drainUntilEmpty();
    await this.controlTail;
    this.webhooks.stop();
    log.info("argus engine stopped");
  }

  private loadChainStateIntoGraph(chainId: number): void {
    const graph = this.graphFor(chainId);
    graph.setLabels(db.loadLabels(chainId));
    const now = Math.floor(Date.now() / 1000);
    for (const t of db.listWatchedTokens(chainId, now)) {
      if (t.totalSupply !== null) graph.setTotalSupply(t.address, t.totalSupply);
    }
    for (const p of db.listPools(chainId)) {
      graph.registerPool(p.poolAddress, p.createdBlock, p.createdTs ?? undefined);
    }
  }

  // ---- adapter callbacks ---------------------------------------------------------

  private onAdapterStatus(chainId: number, status: AdapterStatus, detail?: Record<string, unknown>): void {
    const rt = this.chains.get(chainId);
    if (rt) rt.status = status;
    log.info("adapter status", { chainId, status, ...detail });
  }

  private onFinalized(chainId: number, upToBlock: number): void {
    const previous = this.pendingFinalized.get(chainId) ?? 0;
    this.pendingFinalized.set(chainId, Math.max(previous, upToBlock));
    if (this.finalizing.has(chainId)) return;
    this.finalizing.add(chainId);
    void this.enqueueControl(async () => {
      try {
        await this.drainUntilEmpty();
        const boundary = this.pendingFinalized.get(chainId);
        if (boundary === undefined) return;
        db.markEventsFinalized(chainId, boundary);
        db.confirmAlertsUpTo(chainId, boundary);
        this.graphFor(chainId).finalize(boundary);
        if (this.pendingFinalized.get(chainId) === boundary) this.pendingFinalized.delete(chainId);
      } finally {
        this.finalizing.delete(chainId);
        if (this.pendingFinalized.has(chainId)) this.onFinalized(chainId, this.pendingFinalized.get(chainId) as number);
      }
    }).catch((err) => log.error("finalization failed", { chainId, err }));
  }

  private async onReorg(chainId: number, fromBlock: number): Promise<void> {
    const rt = this.chains.get(chainId);
    return this.enqueueControl(async () => {
      if (rt) await rt.adapter.flushEvents();
      await this.drainUntilEmpty();
      const pending = this.pendingFinalized.get(chainId);
      if (pending !== undefined && pending >= fromBlock) this.pendingFinalized.delete(chainId);
      const rewound = this.graphFor(chainId).rewindTo(fromBlock);
      db.deleteDerivedFrom(chainId, fromBlock);
      db.deleteUnfinalizedFrom(chainId, fromBlock);
      if (rt && rt.lastAppliedBlock >= fromBlock) rt.lastAppliedBlock = fromBlock - 1;
      const reason = `reorg at block ${fromBlock}`;
      const retracted = await this.alertManager.retractUnconfirmed(chainId, fromBlock, reason);
      const retractedPerformance = db.retractPerformanceForAlerts(retracted);
      const forkedPerformance = db.retractPerformanceFrom(chainId, fromBlock);
      for (const id of [...new Set([...retractedPerformance, ...forkedPerformance])]) {
        const session = db.getPerformanceSession(id);
        if (session) this.performanceHook?.({ type: "performance_retracted", session });
      }
      for (const id of retracted) {
        const row = db.getAlert(id);
        if (row) this.webhooks.dispatchRetraction(id, chainId, row.token_address, reason);
      }
      this.significance = new Map([...this.significance].filter(([key]) => !key.startsWith(`${chainId}:`)));
      log.warn("reorg handled", { chainId, fromBlock, rewoundTransitions: rewound, retracted: retracted.length });
    });
  }

  private enqueueControl(fn: () => Promise<void>): Promise<void> {
    const next = this.controlTail.then(fn, fn);
    this.controlTail = next.catch(() => undefined);
    return next;
  }

  private async drainUntilEmpty(): Promise<void> {
    do {
      await this.drain();
      if (this.draining || this.queue.depth > 0) await new Promise((resolve) => setTimeout(resolve, 0));
    } while (this.draining || this.queue.depth > 0);
  }

  private async recoverQueueOverflow(chainId: number): Promise<void> {
    if (this.queueRecoveryRunning.has(chainId)) return;
    this.queueRecoveryRunning.add(chainId);
    return this.enqueueControl(async () => {
      try {
        await this.drainUntilEmpty();
        const runtime = this.chains.get(chainId);
        if (!runtime) return;
        const from = runtime.lastAppliedBlock + 1;
        db.deleteUnfinalizedFrom(chainId, from);
        await runtime.adapter.recover("queue-overflow");
      } finally {
        this.queueRecoveryRunning.delete(chainId);
      }
    });
  }

  private scheduleEventRetry(chainId: number, evt: StandardEvent, graphApplied: boolean): void {
    const key = `${evt.chainId}:${evt.blockNumber}:${evt.logIndex}:${evt.kind}`;
    const attempts = this.failedEventRetries.get(key) ?? 0;
    if (attempts >= 3 || !this.running) return;
    this.failedEventRetries.set(key, attempts + 1);
    const timer = setTimeout(() => {
      this.failedEventTimers.delete(timer);
      try {
        if (graphApplied) this.postProcess(chainId, evt);
        else this.queue.push({ chainId, events: [evt] });
        this.failedEventRetries.delete(key);
      } catch (err) {
        log.error("event retry failed", { chainId, block: evt.blockNumber, kind: evt.kind, err });
        this.scheduleEventRetry(chainId, evt, graphApplied);
      }
      void this.drain();
    }, 1_000 * (attempts + 1));
    this.failedEventTimers.add(timer);
  }

  // ---- main drain loop --------------------------------------------------------------

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      // Smaller slices + far more frequent yields: rule scans are O(events) (R4 walks
      // the full ledger/DSU ~60ms on busy tokens), so a 5k-event batch with 512-event
      // yields could block the event loop for 30s+ and starve the dashboard/SSE
      // (Bug: /api/status timed out during USDT backfills). Yield every 64 events so
      // the longest synchronous stretch stays ~4s even at 60ms/event.
      const batch = this.queue.drain(1_000);
      for (const { chainId, events } of batch) {
        events.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
        const rt = this.chains.get(chainId);
        for (let i = 0; i < events.length; i++) {
          const evt = events[i] as StandardEvent;
          const graph = this.graphFor(chainId);
          let graphApplied = false;
          try {
            graph.applyEvent(evt);
            graphApplied = true;
            if (rt) {
              rt.eventsApplied++;
              if (evt.blockNumber > rt.lastAppliedBlock) rt.lastAppliedBlock = evt.blockNumber;
            }
            this.postProcess(chainId, evt);
            this.failedEventRetries.delete(`${evt.chainId}:${evt.blockNumber}:${evt.logIndex}:${evt.kind}`);
          } catch (err) {
            this.scheduleEventRetry(chainId, evt, graphApplied);
            log.error("event processing failed — skipping", {
              chainId,
              block: evt.blockNumber,
              kind: evt.kind,
              err,
              stack: (err as Error)?.stack,
            });
          }
          if ((i & 63) === 63) await new Promise((r) => setTimeout(r, 0));
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /** Rules + metadata + auto-watch, per applied event. */
  private postProcess(chainId: number, evt: StandardEvent): void {
    const now = Math.floor(Date.now() / 1000);

    if (evt.kind === "pool_created") {
      this.handlePoolCreated(evt);
      return;
    }

    if (evt.kind === "funding") {
      db.upsertWallet({ address: evt.funded, chainId, firstSeenBlock: evt.blockNumber, firstSeenAt: evt.timestamp, funder: evt.funder });
      db.insertFundingEdge({ funder: evt.funder, funded: evt.funded, chainId, amount: evt.amount, blockNumber: evt.blockNumber, method: evt.method });
      // funders of relevant wallets are themselves relevant (feeds R6 funder chains)
      this.chains.get(chainId)?.adapter.addRelevantAddresses([evt.funder]);
      
      // Re-evaluate rules for tokens this wallet bought, since retroactive funding
      // arrives after the transfer event that discovered the wallet.
      const tokens = this.graphFor(chainId).getTokensBoughtBy(evt.funded);
      for (const token of tokens) {
        const syn: StandardEvent = {
          kind: "transfer",
          chainId,
          blockNumber: evt.blockNumber,
          timestamp: evt.timestamp,
          txHash: evt.txHash,
          logIndex: 0,
          tokenAddress: token,
          sender: "0x0000000000000000000000000000000000000000",
          receiver: evt.funded,
          amount: 0n,
        };
        this.runRules(chainId, syn);
      }
      return;
    }

    if (evt.kind === "swap") {
      this.updatePerformance(evt);
      // R2 volume anomaly: run rules for watched tokens only
      const tokenMeta = db.getToken(chainId, evt.tokenAddress);
      if (!tokenMeta) return;
      this.chains.get(chainId)?.adapter.addRelevantAddresses([evt.buyer]);
      if (tokenMeta.source === "candidate") return;
      this.runRules(chainId, evt);
      return;
    }

    if (evt.kind !== "transfer") return;
    const token = evt.tokenAddress;
    const graph = this.graphFor(chainId);
    const isPoolLp = graph.isPool(token);

    if (!isPoolLp) {
      const meta = db.getToken(chainId, token);
      if (!meta) return; // not watched (shouldn't happen — subscription filters)
      if (meta.expires_at !== null && meta.expires_at <= now) return; // auto-watch expired

      // Auto-watch is a sliding window: a token that is still moving stays watched.
      // Without this, expires_at was never extended and active tokens quietly dropped
      // out mid-activity (Bug: expired watched tokens vanished from subscriptions).
      if (meta.expires_at !== null && this.cfg.autoWatch.enabled && meta.expires_at - now < this.cfg.autoWatch.watchHours * 3600) {
        db.upsertToken({
          chainId,
          address: token,
          symbol: meta.symbol,
          decimals: meta.decimals,
          totalSupply: meta.totalSupply,
          source: meta.source,
          expiresAt: now + this.cfg.autoWatch.watchHours * 3600,
        });
      }

      // lazy metadata (totalSupply/decimals/symbol), cached in SQLite — fetched once (PLAN.md §6)
      if (meta.totalSupply === null) this.fetchMeta(chainId, token);

      // follow the participants: their native funding edges now matter (Bug A)
      this.chains.get(chainId)?.adapter.addRelevantAddresses([evt.sender, evt.receiver]);

      // lazy nonce check for fresh receivers (PLAN.md §6 "nonce 0–1 = genuinely fresh")
      if (graph.isFresh(evt.receiver, evt.timestamp, 30) && graph.nonceOf(evt.receiver) === null) {
        this.fetchNonce(chainId, evt.receiver);
      }
      if (meta.source === "candidate") return;
      this.runRules(chainId, evt);
    } else {
      const poolDb = db.getDb().query("SELECT token_address FROM pools WHERE chain_id = ? AND pool_address = ?").get(chainId, token) as { token_address: string } | undefined;
      if (poolDb) {
        this.runRules(chainId, evt, poolDb.token_address as Address);
      }
    }
  }

  private runRules(chainId: number, evt: StandardEvent, targetTokenOverride?: Address): void {
    for (const [id, rule] of Object.entries(RULES)) {
      const ruleCfg = this.cfg.rules[id as keyof typeof this.cfg.rules];
      if (!ruleCfg?.enabled) continue;
      let signal: Signal | null = null;
      try {
        signal = rule(evt, this.graphFor(chainId), this.cfg.rules);
      } catch (err) {
        log.error("rule evaluation failed", { rule: id, err });
        continue;
      }
      if (signal) {
        if (targetTokenOverride) signal.tokenAddress = targetTokenOverride;
        this.handleSignal(signal, false, evt);
      }
    }
  }

  /** Significance filter: don't persist the same (token, rule) signal twice unless it intensifies or the window elapsed. */
  private handleSignal(signal: Signal, finalized: boolean, sourceEvent?: StandardEvent): void {
    const key = `${signal.chainId}:${signal.tokenAddress}:${signal.ruleId}`;
    const now = signal.timestamp;
    const value = extractSignalValue(signal);
    const prev = this.significance.get(key);
    const cooldownSecs = this.cfg.alerts.cooldownMinutes * 60;
    if (prev) {
      // intensified = materially worse than last time (1.5×) and at least 60s ago —
      // otherwise rising counters re-fire on every single event
      const intensified = value !== null && prev.lastValue !== null && value > prev.lastValue * 1.5 && now - prev.lastAt > 60;
      const expired = now - prev.lastAt > cooldownSecs;
      if (!intensified && !expired) return;
    }
    this.significance.set(key, { lastAt: now, lastValue: value });
    db.insertSignal(signal);
    this.signalHook?.(signal);
    this.webhooks.dispatchSignal(signal);

    const res = scoreToken(signal.chainId, signal.tokenAddress, this.cfg.scoring, now);
    if (res.severity === null) return;
    const payload = this.buildAlertPayload(signal.chainId, signal.tokenAddress, res.score, res.severity, res.signals);
    void this.alertManager.maybeAlert(payload, finalized).then(async (id) => {
      if (id !== null) {
        const alert = db.getAlert(id);
        if (!alert || alert.retracted) return;
        // Permanently watch alerted token across sessions
        db.upsertToken({ chainId: payload.chainId, address: payload.tokenAddress, symbol: null, decimals: null, totalSupply: null, source: "factory", expiresAt: null });
        this.refreshWatchSubscription(payload.chainId);
        await this.ensureTokenPoolsRegistered(payload.chainId, payload.tokenAddress);
        await this.openPerformanceSession(id, signal.chainId, signal.tokenAddress, sourceEvent);
        const clusters = this.graphFor(signal.chainId).clusterBreakdown(payload.tokenAddress);
        db.syncClusters(clusters);
        this.alertHook?.(payload, id);
        this.webhooks.dispatchAlert(payload, id, finalized);
      }
    }).catch((err) => {
      log.error("alert pipeline failed", { token: payload.tokenAddress, err });
    });
  }

  private async ensureTokenPoolsRegistered(chainId: number, token: Address): Promise<void> {
    const existing = db.listPoolsForToken(chainId, token);
    if (existing.length > 0) {
      for (const p of existing) {
        const quote = p.quote_token ?? token;
        this.chains.get(chainId)?.adapter.registerPool(p.pool_address, token, quote);
        this.graphFor(chainId).registerPool(p.pool_address);
      }
      return;
    }
    const fallback = await fetchTokenPrice(chainId, token);
    if (fallback) {
      db.insertPool({
        chainId,
        poolAddress: fallback.poolAddress,
        tokenAddress: token,
        quoteToken: fallback.quoteToken,
        factory: "dexscreener",
        createdBlock: 0,
      });
      this.chains.get(chainId)?.adapter.registerPool(fallback.poolAddress, token, fallback.quoteToken);
      this.graphFor(chainId).registerPool(fallback.poolAddress);
    }
  }

  private async primeWatchlistPools(): Promise<void> {
    for (const watch of this.cfg.watchlist) {
      const runtime = this.chains.get(watch.chainId);
      if (!runtime || db.listPoolsForToken(watch.chainId, watch.address).length > 0) continue;
      const fallback = await fetchTokenPrice(watch.chainId, watch.address);
      if (!fallback) continue;
      db.insertPool({
        chainId: watch.chainId,
        poolAddress: fallback.poolAddress,
        tokenAddress: watch.address,
        quoteToken: fallback.quoteToken,
        factory: "dexscreener",
        createdBlock: runtime.adapter.status().lastHead,
      });
      runtime.adapter.registerPool(fallback.poolAddress, watch.address, fallback.quoteToken);
      this.graphFor(watch.chainId).registerPool(fallback.poolAddress);
      log.info("watchlist pool primed", { chainId: watch.chainId, token: watch.address, pool: fallback.poolAddress });
    }
  }

  private async openPerformanceSession(alertId: number, chainId: number, tokenAddress: Address, sourceEvent?: StandardEvent): Promise<void> {
    let swap = sourceEvent?.kind === "swap" ? sourceEvent : db.latestSwapForToken(chainId, tokenAddress);
    const swapPool = swap ? db.getDb().query("SELECT quote_token FROM pools WHERE chain_id = ? AND pool_address = ? AND token_address = ?")
      .get(chainId, swap.poolAddress, tokenAddress) as { quote_token: Address | null } | undefined : undefined;
    const tokenDecimals = db.getToken(chainId, tokenAddress)?.decimals ?? 18;
    const quoteDecimals = swapPool?.quote_token
      ? db.getToken(chainId, swapPool.quote_token)?.decimals ?? decimalsForAddress(swapPool.quote_token)
      : 18;
    let entryPrice = swap ? priceFromSwap(swap, tokenDecimals, quoteDecimals) : null;
    let poolAddress = swap?.poolAddress;
    let quoteToken: Address | null = null;
    const openedAt = sourceEvent?.timestamp ?? (swap?.timestamp ?? Math.floor(Date.now() / 1000));
    const entryBlock = sourceEvent?.blockNumber ?? (swap?.blockNumber ?? 0);

    if (entryPrice === null) {
      const fallback = await fetchTokenPrice(chainId, tokenAddress);
      if (fallback) {
        entryPrice = fallback.price;
        poolAddress = fallback.poolAddress;
        quoteToken = fallback.quoteToken;
        db.insertPool({
          chainId,
          poolAddress: fallback.poolAddress,
          tokenAddress,
          quoteToken: fallback.quoteToken,
          factory: "dexscreener",
          createdBlock: entryBlock,
        });
        this.chains.get(chainId)?.adapter.registerPool(fallback.poolAddress, tokenAddress, fallback.quoteToken);
        this.graphFor(chainId).registerPool(fallback.poolAddress);
      }
    }

    if (entryPrice === null || !poolAddress) return;
    const pool = db.listPoolsForToken(chainId, tokenAddress).find((p) => p.pool_address === poolAddress);
    const { targetPrice, stopPrice } = thresholds(entryPrice);
    const id = db.createPerformanceSession({
      alertId,
      chainId,
      tokenAddress,
      poolAddress,
      quoteToken: quoteToken ?? pool?.quote_token ?? null,
      entryPrice,
      targetPrice,
      stopPrice,
      openedAt,
      expiresAt: openedAt + PERFORMANCE_WINDOW_SECS,
      entryBlock,
    });
    const session = db.getPerformanceSession(id);
    if (session) this.performanceHook?.({ type: "performance_opened", session });
  }

  private updatePerformance(swap: StandardEvent & { kind: "swap" }): void {
    const pool = db.getDb().query("SELECT quote_token FROM pools WHERE chain_id = ? AND pool_address = ? AND token_address = ?")
      .get(swap.chainId, swap.poolAddress, swap.tokenAddress) as { quote_token: Address | null } | undefined;
    const tokenDecimals = db.getToken(swap.chainId, swap.tokenAddress)?.decimals ?? 18;
    const quoteDecimals = pool?.quote_token
      ? db.getToken(swap.chainId, pool.quote_token)?.decimals ?? decimalsForAddress(pool.quote_token)
      : 18;
    const price = priceFromSwap(swap, tokenDecimals, quoteDecimals);
    if (price === null) return;
    const sessions = db.listPerformanceSessions({ chainId: swap.chainId, tokenAddress: swap.tokenAddress, activeOnly: true });
    for (const session of sessions) {
      if (session.pool_address !== swap.poolAddress) continue;
      const result = updateSession(session, price, swap.timestamp);
        db.updatePerformanceSession({
        id: session.id,
        outcome: result.outcome,
        currentPrice: result.currentPrice,
        minPrice: result.minPrice,
        maxPrice: result.maxPrice,
        lastBlock: swap.blockNumber,
        updatedAt: swap.timestamp,
          closedAt: result.closedAt,
          missingObservations: 0,
          closeReason: result.outcome === "active" ? null : "price_threshold",
        });
      const updated = db.getPerformanceSession(session.id);
      if (!updated) continue;
      this.performanceHook?.({ type: updated.outcome === "active" ? "performance_updated" : "performance_closed", session: updated });
      if (updated.outcome !== "active") {
        this.dispatchOutcomeNotification(updated);
      }
    }
  }

  private async expirePerformance(): Promise<void> {
    if (this.performancePollRunning || !this.running) return;
    this.performancePollRunning = true;
    try {
      const ids = db.expirePerformanceSessions(Math.floor(Date.now() / 1000));
      for (const id of ids) {
        const session = db.getPerformanceSession(id);
        if (session) {
          this.performanceHook?.({ type: "performance_closed", session });
          this.dispatchOutcomeNotification(session);
        }
      }

      // Polling check for active sessions with low swap frequency.
      const activeSessions = db.listPerformanceSessions({ activeOnly: true });
      const now = Math.floor(Date.now() / 1000);
      for (const session of activeSessions) {
        if (now - session.updated_at < 15) continue;
        const observation = await fetchTokenPriceForPool(session.chain_id, session.token_address, session.pool_address);
        if (observation.kind === "provider_error") continue;
        if (observation.kind === "pool_missing" || observation.kind === "liquidity_lost") {
          const missing = session.missing_observations + 1;
          if (observation.kind === "liquidity_lost" || missing >= 3) {
            const currentPrice = 0n;
            db.updatePerformanceSession({
              id: session.id,
              outcome: "stop_hit",
              currentPrice,
              minPrice: 0n,
              maxPrice: session.max_price,
              lastBlock: session.last_block,
              updatedAt: now,
              closedAt: now,
              lastPollAt: now,
              missingObservations: missing,
              closeReason: "liquidity_lost",
            });
            const closed = db.getPerformanceSession(session.id);
            if (closed) {
              this.performanceHook?.({ type: "performance_closed", session: closed });
              this.dispatchOutcomeNotification(closed);
            }
          } else {
            db.updatePerformanceSession({
              id: session.id,
              outcome: session.outcome,
              currentPrice: session.current_price,
              minPrice: session.min_price,
              maxPrice: session.max_price,
              lastBlock: session.last_block,
              updatedAt: session.updated_at,
              closedAt: session.closed_at,
              lastPollAt: now,
              missingObservations: missing,
            });
          }
          continue;
        }

        const latest = db.getPerformanceSession(session.id);
        if (!latest || latest.outcome !== "active" || latest.updated_at > session.updated_at) continue;
        const result = updateSession(session, observation.value.price, now);
          db.updatePerformanceSession({
            id: session.id,
            outcome: result.outcome,
            currentPrice: result.currentPrice,
            minPrice: result.minPrice,
            maxPrice: result.maxPrice,
            lastBlock: session.last_block,
            updatedAt: now,
            closedAt: result.closedAt,
            lastPollAt: now,
            missingObservations: 0,
            closeReason: result.outcome === "active" ? null : "price_threshold",
          });
          const updated = db.getPerformanceSession(session.id);
          if (updated) {
            this.performanceHook?.({ type: updated.outcome === "active" ? "performance_updated" : "performance_closed", session: updated });
            if (updated.outcome !== "active") {
              this.dispatchOutcomeNotification(updated);
            }
          }
      }
    } finally {
      this.performancePollRunning = false;
    }
  }

  private dispatchOutcomeNotification(session: PerformanceSession): void {
    const msg = formatPerformanceOutcomeMessage(session);
    for (const sink of this.alertManager["sinks"]) {
      void sink.sendText(msg).catch((err) => log.error("outcome sink failed", { sink: sink.name, err }));
    }
  }

  private buildAlertPayload(chainId: number, token: Address, score: number, severity: AlertPayload["severity"], signals: Signal[]): AlertPayload {
    const topCluster = this.graphFor(chainId).clusterBreakdown(token).find((c) => c.memberCount > 1);
    const headline = topCluster
      ? `${topCluster.memberCount} wallets hold ${topCluster.pctOfSupply.toFixed(2)}% of supply in one cluster`
      : (signals[0] ? ruleHeadline(signals[0]) : "suspicious activity detected");
    const lines = signals.map((s) => ruleLine(s));
    if (topCluster) lines.push(`Top cluster ${topCluster.clusterId.slice(0, 10)}… — ${topCluster.memberCount} wallets, ${topCluster.pctOfSupply.toFixed(2)}% of supply`);
    return {
      chainId,
      tokenAddress: token,
      score,
      severity,
      signals,
      headline,
      lines,
      links: buildAlertLinks(chainId, token, this.cfg.dashboard.port),
    };
  }

  // ---- metadata / nonces (lazy, once per token/wallet) ---------------------------------

  private metaAttempts = new Map<string, number>();

  private fetchMeta(chainId: number, token: Address): void {
    const key = `${chainId}:${token}`;
    if (this.metaInFlight.has(key) || this.metaFailed.has(key)) return;
    this.metaInFlight.add(key);
    const rt = this.chains.get(chainId);
    if (!rt) {
      this.metaInFlight.delete(key);
      return;
    }
    rt.adapter
      .fetchTokenMeta(token)
      .then((meta) => {
        const existing = db.getToken(chainId, token);
        const totalSupply = meta.totalSupply ?? existing?.totalSupply ?? null;
        db.upsertToken({
          chainId,
          address: token,
          symbol: (meta.symbol as string) ?? existing?.symbol ?? null,
          decimals: (meta.decimals as number) ?? existing?.decimals ?? null,
          totalSupply,
          source: existing?.source ?? "manual",
        });
        if (totalSupply) this.graphFor(chainId).setTotalSupply(token, totalSupply);
        if (totalSupply === null) this.metaFailed.add(key);
        else this.metaAttempts.delete(key);
        log.info("fetched token metadata", { chainId, token, symbol: meta.symbol, totalSupply: totalSupply?.toString() });
      })
      .catch((err) => {
        const attempts = (this.metaAttempts.get(key) ?? 0) + 1;
        this.metaAttempts.set(key, attempts);
        if (attempts >= 3) {
          this.metaFailed.add(key);
          log.warn("metadata fetch failed permanently after retries", { chainId, token, err });
        } else {
          log.warn("metadata fetch failed (will retry on next event)", { chainId, token, attempts, err });
        }
      })
      .finally(() => this.metaInFlight.delete(key));
  }

  private fetchNonce(chainId: number, addr: Address): void {
    const key = `${chainId}:${addr}`;
    if (this.nonceInFlight.has(key)) return;
    this.nonceInFlight.add(key);
    const rt = this.chains.get(chainId);
    if (!rt) return;
    rt.adapter
      .getNonce(addr)
      .then((nonce) => this.graphFor(chainId).setNonce(addr, nonce))
      .catch(() => void 0)
      .finally(() => this.nonceInFlight.delete(key));
  }

  // ---- auto-watch (PLAN.md §12) -----------------------------------------------------------

  private handlePoolCreated(evt: StandardEvent & { kind: "pool_created" }): void {
    const quotes = KNOWN_QUOTES[evt.chainId] ?? new Set<string>();
    const token0IsQuote = quotes.has(evt.token0);
    const token1IsQuote = quotes.has(evt.token1);
    const candidates: Address[] = [];
    if (!token0IsQuote) candidates.push(evt.token0);
    if (!token1IsQuote) candidates.push(evt.token1);
    const quote = token0IsQuote ? evt.token0 : token1IsQuote ? evt.token1 : null;

    for (const token of candidates) {
      db.insertPool({
        chainId: evt.chainId,
        poolAddress: evt.poolAddress,
        tokenAddress: token,
        quoteToken: quote,
        factory: evt.factory,
        createdBlock: evt.blockNumber,
        createdTs: evt.timestamp,
        token0: evt.token0,
        token1: evt.token1,
      });
      this.graphFor(evt.chainId).registerPool(evt.poolAddress, evt.blockNumber, evt.timestamp);
      if (!this.cfg.autoWatch.enabled) continue;
      const existing = db.getToken(evt.chainId, token);
      if (existing && existing.expires_at === null) continue; // permanent watch already
      const expiresAt = Math.floor(Date.now() / 1000) + this.cfg.autoWatch.watchHours * 3600;
      if (this.cfg.candidateDiscovery.enabled) {
        db.upsertCandidate({ chainId: evt.chainId, address: token, source: "factory", firstSeenAt: evt.timestamp, expiresAt });
        db.upsertToken({ chainId: evt.chainId, address: token, symbol: null, decimals: null, totalSupply: null, source: "candidate", expiresAt });
        log.info("candidate: new pool token", { chainId: evt.chainId, token, pool: evt.poolAddress });
      } else {
        db.upsertToken({ chainId: evt.chainId, address: token, symbol: null, decimals: null, totalSupply: null, source: "factory", expiresAt });
        log.info("auto-watch: new pool token", { chainId: evt.chainId, token, pool: evt.poolAddress, watchHours: this.cfg.autoWatch.watchHours });
        this.chains.get(evt.chainId)?.adapter.registerPool(evt.poolAddress, evt.token0, evt.token1);
      }
      this.refreshWatchSubscription(evt.chainId);
      this.fetchMeta(evt.chainId, token);
    }
  }

  private refreshWatchSubscription(chainId: number): void {
    const rt = this.chains.get(chainId);
    if (!rt) return;
    const now = Math.floor(Date.now() / 1000);
    rt.adapter.setWatchedTokens(db.listWatchedTokens(chainId, now).map((t) => t.address));
  }

  // ---- retention / hot reload -------------------------------------------------

  private retentionSweep(): void {
    const pruned = db.pruneEvents(this.cfg.retention.eventDays * 86_400);
    this.refreshWatchSubscriptionForExpiry();
    this.pruneSignificance();
    this.syncAllClusters();
    if (pruned > 0) log.info("retention sweep", { prunedEvents: pruned });
  }

  private pruneSignificance(): void {
    const now = Math.floor(Date.now() / 1000);
    const cooldownSecs = this.cfg.alerts.cooldownMinutes * 60;
    for (const [key, entry] of this.significance.entries()) {
      if (now - entry.lastAt > cooldownSecs) {
        this.significance.delete(key);
      }
    }
  }

  private syncAllClusters(): void {
    for (const chainId of this.chains.keys()) {
      const graph = this.graphFor(chainId);
      const activeTokens = db.listWatchedTokens(chainId, Math.floor(Date.now() / 1000));
      const allClusters: db.ClusterMaterialized[] = [];
      for (const t of activeTokens) {
        const breakdown = graph.clusterBreakdown(t.address);
        for (const c of breakdown) {
          allClusters.push({
            clusterId: c.clusterId,
            memberCount: c.memberCount,
            members: c.members,
          });
        }
      }
      db.syncClusters(allClusters);
    }
  }

  private refreshWatchSubscriptionForExpiry(): void {
    for (const chainId of this.chains.keys()) this.refreshWatchSubscription(chainId);
  }

  private async refreshVolumeRankings(): Promise<void> {
    if (!this.running) return;
    for (const chain of this.cfg.chains.filter((c) => c.enabled)) {
      try {
        const ranked = await rankStablecoinVolume(chain.chainId, this.cfg.volumeRanking.topN);
        const now = Math.floor(Date.now() / 1000);
        db.expireCandidates(now);
        const runtime = this.chains.get(chain.chainId);
        if (!runtime) continue;
        const head = runtime.adapter.status().lastHead;
        const candidates = ranked.slice(0, this.cfg.candidateDiscovery.maxCandidatesPerCycle);
        if (this.cfg.candidateDiscovery.enabled) {
          const dbCandidates = db.listCandidates(chain.chainId).filter((c) =>
            (c.status === "discovered" || c.status === "evaluating" || c.status === "rejected") &&
            (!c.lastEvaluatedAt || now - c.lastEvaluatedAt >= this.cfg.candidateDiscovery.evaluationMinutes * 60)
          );
          for (const c of dbCandidates) {
            if (candidates.some((r) => r.address === c.address)) continue;
            const fallback = await fetchTokenPrice(chain.chainId, c.address);
            if (fallback) {
              candidates.push({
                chainId: chain.chainId,
                address: c.address,
                volume: fallback.volumeUsd ?? 0,
                pools: [{
                  poolAddress: fallback.poolAddress,
                  tokenAddress: c.address,
                  quoteToken: fallback.quoteToken,
                  volume: fallback.volumeUsd ?? 0,
                  liquidityUsd: fallback.liquidityUsd,
                  createdAt: null,
                }],
              });
            }
          }
        }
        for (const token of candidates) {
          const existing = db.getToken(token.chainId, token.address);
          if (existing?.source === "manual" || existing?.source === "factory") continue;
          if (this.cfg.candidateDiscovery.enabled && existing?.source === "ranked") continue;
          const candidate = db.getCandidate(token.chainId, token.address);
          const due = !candidate?.lastEvaluatedAt || now - candidate.lastEvaluatedAt >= this.cfg.candidateDiscovery.evaluationMinutes * 60;
          if (this.cfg.candidateDiscovery.enabled) {
            db.upsertCandidate({
              chainId: token.chainId, address: token.address, source: "ranked",
              firstSeenAt: db.getCandidate(token.chainId, token.address)?.firstSeenAt ?? now,
              expiresAt: now + this.cfg.candidateDiscovery.candidateTtlHours * 3600,
            });
            db.upsertToken({ chainId: token.chainId, address: token.address, symbol: null, decimals: null, totalSupply: null, source: "candidate", expiresAt: now + this.cfg.candidateDiscovery.candidateTtlHours * 3600 });
          } else {
            db.upsertToken({ chainId: token.chainId, address: token.address, symbol: null, decimals: null, totalSupply: null, source: "ranked", expiresAt: now + this.cfg.volumeRanking.pollMinutes * 120 });
          }
          for (const pool of token.pools) {
            db.insertPool({
              chainId: token.chainId,
              poolAddress: pool.poolAddress,
              tokenAddress: pool.tokenAddress,
              quoteToken: pool.quoteToken,
              factory: "dexscreener",
              createdBlock: head,
              ...(pool.createdAt !== null ? { createdTs: pool.createdAt } : {}),
              token0: pool.tokenAddress,
              token1: pool.quoteToken,
            });
            this.graphFor(token.chainId).registerPool(pool.poolAddress, head, pool.createdAt ?? undefined);
            if (!this.cfg.candidateDiscovery.enabled) runtime.adapter.registerPool(pool.poolAddress, pool.tokenAddress, pool.quoteToken);
          }
          this.fetchMeta(token.chainId, token.address);
          if (due) this.enqueueEnrichment(token);
        }
        this.refreshWatchSubscription(chain.chainId);
        log.info("token candidates refreshed", { chainId: chain.chainId, candidates: candidates.map((token) => ({ token: token.address, volume: token.volume })) });
      } catch (err) {
        log.warn("volume ranking refresh failed", { chainId: chain.chainId, err });
      }
    }
    void this.drainEnrichmentQueue();
  }

  private enqueueEnrichment(token: RankedToken): void {
    const key = `${token.chainId}:${token.address}`;
    if (this.enrichmentQueued.has(key)) return;
    this.enrichmentQueued.add(key);
    this.enrichmentQueue.push(token);
  }

  private async drainEnrichmentQueue(): Promise<void> {
    if (this.enrichmentRunning || !this.running) return;
    this.enrichmentRunning = true;
    try {
      while (this.running && this.enrichmentQueue.length > 0) {
        const token = this.enrichmentQueue.shift() as RankedToken;
        const key = `${token.chainId}:${token.address}`;
        this.enrichmentQueued.delete(key);
        const runtime = this.chains.get(token.chainId);
        if (!runtime) continue;
        const head = runtime.adapter.status().lastHead;
        if (head === 0) {
          this.enrichmentQueue.unshift(token);
          this.enrichmentQueued.add(key);
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        const requestedBlocks = Math.max(1, Math.ceil(this.cfg.volumeRanking.backfillHours * 300));
        const maxDepth = runtime.adapter.getMaxArchiveDepth();
        const blocks = Math.min(requestedBlocks, maxDepth);
        const from = BigInt(Math.max(0, head - blocks));
        try {
          await runtime.adapter.backfillToken(token.address, from, BigInt(head));
          await this.evaluateCandidate(token, head);
          log.info("candidate evaluation complete", { chainId: token.chainId, token: token.address, from: Number(from), to: head });
        } catch (err) {
          log.warn("ranked token enrichment skipped (archive/rate-limited on free RPC)", { chainId: token.chainId, token: token.address, err });
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    } finally {
      this.enrichmentRunning = false;
    }
  }

  private async evaluateCandidate(token: RankedToken, head: number): Promise<void> {
    const candidate = db.getCandidate(token.chainId, token.address);
    if (!candidate || candidate.status === "promoted" || candidate.expiresAt <= Math.floor(Date.now() / 1000)) return;
    const now = Math.floor(Date.now() / 1000);
    db.updateCandidateScore(token.chainId, token.address, candidate.score, candidate.evidence, "evaluating");
    const liquidityUsd = token.pools.reduce((max, pool) => Math.max(max, pool.liquidityUsd ?? 0), 0) || null;
    const created = token.pools.map((pool) => pool.createdAt).filter((value): value is number => value !== null);
    const createdAt = created.length > 0 ? Math.min(...created) : null;
    const stats = this.graphFor(token.chainId).candidateBuyerStats(token.address, now - 86_400, now);
    const result = scoreCandidate({
      liquidityUsd,
      volumeUsd: token.volume,
      poolAgeHours: createdAt === null ? null : Math.max(0, (now - createdAt) / 3600),
      ...stats,
      minimumLiquidityUsd: this.cfg.candidateDiscovery.minimumLiquidityUsd,
      minimumIndependentBuyers: this.cfg.candidateDiscovery.minimumIndependentBuyers,
    });
    const status = result.eligible && result.score >= this.cfg.candidateDiscovery.promotionScore ? "promoted" : "rejected";
    db.updateCandidateScore(token.chainId, token.address, result.score, result.evidence, status);
    if (status === "promoted") {
      db.promoteCandidate(token.chainId, token.address, candidate.source === "factory" ? "factory" : "ranked", now + this.cfg.autoWatch.watchHours * 3600);
      const runtime = this.chains.get(token.chainId);
      for (const pool of db.listPoolsForToken(token.chainId, token.address)) {
        this.graphFor(token.chainId).registerPool(pool.pool_address, head);
        runtime?.adapter.registerPool(pool.pool_address, token.address, pool.quote_token ?? token.address);
      }
      this.refreshWatchSubscription(token.chainId);
      log.info("promoted quality token candidate", { chainId: token.chainId, token: token.address, score: result.score, head });
    }
  }

  private watchConfigFile(): void {
    try {
      let debounce: ReturnType<typeof setTimeout> | null = null;
      this.configWatcher = watch("argus.config.ts", () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => void this.hotReload(), 500);
      });
    } catch (err) {
      log.warn("config hot-reload watcher failed", { err });
    }
  }

  /** Hot-reload rules/scoring/alerts (PLAN.md §12). Chain/watchlist changes need a restart. */
  private async hotReload(): Promise<void> {
    const next = await reloadConfig();
    if (!next) {
      log.warn("config reload failed validation — keeping previous config");
      return;
    }
    this.cfg.rules = next.rules;
    this.cfg.scoring = next.scoring;
    this.cfg.alerts = next.alerts;
    this.cfg.autoWatch = next.autoWatch;
    this.cfg.candidateDiscovery = next.candidateDiscovery;
    this.cfg.volumeRanking = next.volumeRanking;
    this.cfg.webhooks = next.webhooks;
    this.webhooks.setTargets(next.webhooks);
    log.info("config hot-reloaded (rules/scoring/alerts/autoWatch/candidateDiscovery/volumeRanking/webhooks)");
  }

  // ---- status ------------------------------------------------------------------------------

  status(): Record<string, unknown> {
    const chains: Record<string, unknown> = {};
    for (const [chainId, rt] of this.chains) {
      chains[String(chainId)] = {
        ...rt.adapter.status(),
        lastAppliedBlock: rt.lastAppliedBlock,
        eventsApplied: rt.eventsApplied,
      };
    }
    const candidates = db.listCandidates();
    return {
      chains,
      queueDepth: this.queue.depth,
      queueDropped: this.queue.dropped,
      wallets: [...this.graphs.values()].reduce((n, graph) => n + graph.wallets.size, 0),
      candidates: {
        total: candidates.length,
        discovered: candidates.filter((c) => c.status === "discovered").length,
        evaluating: candidates.filter((c) => c.status === "evaluating").length,
        promoted: candidates.filter((c) => c.status === "promoted").length,
        rejected: candidates.filter((c) => c.status === "rejected").length,
        expired: candidates.filter((c) => c.status === "expired").length,
      },
    };
  }
}

// ---- alert text helpers -------------------------------------------------------------

function extractSignalValue(s: Signal): number | null {
  const e = s.evidence;
  const v =
    e["freshWalletPct"] ??
    e["pctOfSupply"] ??
    e["clusterPctOfSupply"] ??
    e["recipientCount"] ??
    e["freshBuyerCount"] ??
    e["walletCount"] ??
    e["spikePct"] ??
    e["lockedPct"];
  return typeof v === "number" ? v : null;
}

function ruleHeadline(s: Signal): string {
  switch (s.ruleId) {
    case "R1":
      return `Fresh wallets accumulated ${String(s.evidence["freshWalletPct"])}% of supply in ${String(s.evidence["windowHours"])}h`;
    case "R2":
      return `Volume spike: ${String(s.evidence["spikePct"])}% vs prior ${String(s.evidence["windowMinutes"])}m`;
    case "R3":
      return `Sybil fan-out: ${String(s.evidence["recipientCount"])} sub-wallets from one sender`;
    case "R4":
      return `Cluster holds ${String(s.evidence["pctOfSupply"])}% of supply`;
    case "R5":
      return `${String(s.evidence["freshBuyerCount"])} fresh wallets bought in block ${String(s.evidence["block"])}`;
    case "R6":
      return "Accumulating cluster is funded by the token deployer";
    case "R7":
      return `Liquidity exiting: ${String(s.evidence["lockedPct"])}% of LP still locked`;
    case "R8":
      return `${String(s.evidence["walletCount"])} wallets funded same-size from ${String(s.evidence["exchangeLabel"])}`;
    default:
      return "suspicious activity detected";
  }
}

function ruleLine(s: Signal): string {
  const e = s.evidence;
  switch (s.ruleId) {
    case "R1":
      return `R1 fresh-wallet accumulation: ${String(e["freshWalletPct"])}% in ${String(e["windowHours"])}h across ${String(e["freshWalletCount"])} wallets (<${String(e["walletAgeDays"])}d old)`;
    case "R2":
      return `R2 volume spike: ${String(e["spikePct"])}% over ${String(e["windowMinutes"])}m (cur ${String(e["currentVolume"])} vs ${String(e["priorVolume"])})`;
    case "R3":
      return `R3 sybil fan-out: ${String(e["sender"]).slice(0, 12)}… sent identical amounts to ${String(e["recipientCount"])} wallets in ${String(e["windowMinutes"])}m`;
    case "R4":
      return `R4 cluster concentration: ${String(e["memberCount"])} wallets hold ${String(e["pctOfSupply"])}% (threshold ${String(e["threshold"])}%)`;
    case "R5":
      return `R5 bundled buys: ${String(e["freshBuyerCount"])} fresh wallets in block ${String(e["block"])}`;
    case "R6":
      return `R6 deployer-linked funding: ${String(e["linkedCount"])}/${String(e["clusterSize"])} wallets within ${String(e["maxHops"])} hops of deployer ${String(e["deployer"]).slice(0, 12)}…`;
    case "R7":
      return `R7 LP-lock safety: pool ${String(e["pool"]).slice(0, 12)}… only ${String(e["lockedPct"])}% of ${String(e["lpMinted"])} LP still locked (${String(e["poolAgeHours"])}h old)`;
    case "R8":
      return `R8 exchange fan-out: ${String(e["walletCount"])} wallets funded ${String(e["identicalAmount"])} wei each from ${String(e["exchangeLabel"])} within ${String(e["windowMinutes"])}m`;
    default:
      return `${s.ruleId} (weight ${s.weight})`;
  }
}
