import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AlertManager } from "./alerts/manager.ts";
import { buildAlertLinks, TelegramSink, type AlertSink } from "./alerts/telegram.ts";
import { loadConfig, reloadConfig, type ArgusConfig } from "./config.ts";
import * as db from "./db.ts";
import { resolveFactories } from "./factories.ts";
import { GraphEngine, DEFAULT_GRAPH_TUNING } from "./graph/engine.ts";
import { EvmAdapter, type AdapterStatus, type ChainAdapter } from "./ingest/evm.ts";
import { log, redactUrl } from "./logger.ts";
import { priceFromSwap, thresholds, updateSession, PERFORMANCE_WINDOW_SECS, type PerformanceEvent } from "./performance.ts";
import { EventQueue } from "./queue.ts";
import { RULES } from "./rules/index.ts";
import { scoreToken } from "./scorer.ts";
import { seedLabels } from "./seeds.ts";
import { WebhookDispatcher } from "./webhooks.ts";
import type { Address, AlertPayload, Signal, StandardEvent } from "./types.ts";

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
  private graph: GraphEngine;
  private queue = new EventQueue<QueuedEvents>(100_000);
  private chains = new Map<number, ChainRuntime>();
  private alertManager: AlertManager;
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  private draining = false;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private performanceTimer: ReturnType<typeof setInterval> | null = null;
  private configWatcher: ReturnType<typeof watch> | null = null;
  private significance = new Map<string, { lastAt: number; lastValue: number | null }>();
  private metaInFlight = new Set<string>();
  private metaFailed = new Set<string>(); // tokens whose totalSupply() reverts — never re-fetch (meta-fetch storm)
  private nonceInFlight = new Set<string>();
  private pendingFinalized = new Map<number, number>();
  private finalizing = new Set<number>();
  private snapshotBlocks = new Map<number, number>();
  private running = false;
  private alertHook: ((payload: AlertPayload, id: number) => void) | null = null;
  private performanceHook: ((event: PerformanceEvent) => void) | null = null;
  private webhooks = new WebhookDispatcher();

  /** Optional live hook for emitted alerts (Phase 4 dashboard SSE). */
  setAlertHook(hook: (payload: AlertPayload, id: number) => void): void {
    this.alertHook = hook;
  }

  setPerformanceHook(hook: (event: PerformanceEvent) => void): void {
    this.performanceHook = hook;
  }

  /** Active chain ids (Phase 4 dashboard). */
  chainsForStatus(): number[] {
    return [...this.chains.keys()];
  }

  /** Live graph view for the dashboard/API (read-only; never mutate from outside). */
  graphView(): GraphEngine {
    return this.graph;
  }

  constructor(private cfg: ArgusConfig) {
    this.graph = new GraphEngine(DEFAULT_GRAPH_TUNING);
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
    const enabled = this.cfg.chains.filter((c) => c.enabled);
    seedLabels(enabled.map((c) => c.chainId));

    // An active backfill owns unfinalized facts that must survive a restart; replay
    // them instead of restoring a snapshot that may predate the durable cursor.
    const activeBackfill = enabled.some((c) => {
      const job = db.getBackfillJob(c.chainId);
      return job?.status === "running" || job?.status === "failed";
    });
    const restored = activeBackfill ? false : this.restoreSnapshot(enabled.map((c) => c.chainId));
    for (const c of enabled) {
      const job = db.getBackfillJob(c.chainId);
      if (job?.status === "failed") db.upsertBackfillJob({ ...job, status: "running", lastError: null });
      this.loadChainStateIntoGraph(c.chainId);
      if (!restored) {
        const t0 = Date.now();
        const events = db.loadEvents(c.chainId, 0, Number.MAX_SAFE_INTEGER, activeBackfill ? undefined : { finalizedOnly: true });
        for (const e of events) this.graph.applyEvent(e);
        log.info("rebuilt graph from finalized events", { chainId: c.chainId, events: events.length, ms: Date.now() - t0 });
      }
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
            return safe;
          });
          const inserted = db.insertEvents(safeEvents, false);
          if (inserted.length > 0) {
            this.queue.push({ chainId, events: inserted });
            await this.drain();
          }
        },
        onFinalized: (chainId, upTo) => this.onFinalized(chainId, upTo),
        onReorg: (chainId, from) => void this.onReorg(chainId, from),
        onHead: () => {},
        onStatus: (chainId, status, detail) => this.onAdapterStatus(chainId, status, detail),
        onBackfillProgress: (chainId, progress) => {
          db.upsertBackfillJob({
            chainId,
            fromBlock: progress.fromBlock,
            toBlock: progress.toBlock,
            phase: progress.phase,
            nextBlock: progress.nextBlock,
            provider: progress.provider,
            status: progress.phase === "complete" ? "complete" : "running",
            lastError: null,
          });
        },
        getBackfillProgress: (chainId) => {
          const job = db.getBackfillJob(chainId);
          if (!job || (job.status !== "running" && job.status !== "failed")) return null;
          return { phase: job.phase, nextBlock: job.nextBlock, fromBlock: job.fromBlock, toBlock: job.toBlock, provider: job.provider };
        },
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
        this.graph.registerPool(p.poolAddress, p.createdBlock, p.createdTs ?? undefined);
        if (p.token0 && p.token1) adapter.registerPool(p.poolAddress, p.token0, p.token1);
      }
      this.chains.set(c.chainId, { adapter, status: "connecting", lastAppliedBlock: this.snapshotBlocks.get(c.chainId) ?? 0, eventsApplied: 0 });
    }

    this.drainTimer = setInterval(() => this.drain(), 250);
    this.snapshotTimer = setInterval(() => this.saveSnapshot(), 5 * 60_000);
    this.pruneTimer = setInterval(() => this.retentionSweep(), 60 * 60_000);
    this.performanceTimer = setInterval(() => this.expirePerformance(), 60_000);

    for (const [chainId, rt] of this.chains) {
      const resumeFrom = this.snapshotBlocks.get(chainId) ?? db.getCheckpoint(chainId);
      rt.adapter.start(resumeFrom).catch((err) => {
        const safeErr = redactUrl(String(err));
        log.error("adapter start failed", { chainId, err: safeErr });
        const job = db.getBackfillJob(chainId);
        if (job?.status === "running") db.upsertBackfillJob({ ...job, status: "failed", lastError: safeErr });
        this.onAdapterStatus(chainId, "error", { err: safeErr });
      });
    }

    this.watchConfigFile();
    log.info("argus engine started", {
      chains: enabled.map((c) => c.chainId),
      configuredWatchlist: this.cfg.watchlist.length,
      activeWatchlist: enabled.reduce((n, c) => n + db.listWatchedTokens(c.chainId, now).length, 0),
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.drainTimer) clearInterval(this.drainTimer);
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    if (this.performanceTimer) clearInterval(this.performanceTimer);
    this.configWatcher?.close();
    for (const rt of this.chains.values()) await rt.adapter.stop();
    this.drain(); // flush
    this.saveSnapshot();
    log.info("argus engine stopped");
  }

  private loadChainStateIntoGraph(chainId: number): void {
    this.graph.setLabels(db.loadLabels(chainId));
    const now = Math.floor(Date.now() / 1000);
    for (const t of db.listWatchedTokens(chainId, now)) {
      if (t.totalSupply !== null) this.graph.setTotalSupply(t.address, t.totalSupply);
    }
    for (const p of db.listPools(chainId)) {
      this.graph.registerPool(p.poolAddress, p.createdBlock, p.createdTs ?? undefined);
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
    void (async () => {
      try {
        await this.drainUntilEmpty();
        const boundary = this.pendingFinalized.get(chainId);
        if (boundary === undefined) return;
        db.markEventsFinalized(chainId, boundary);
        db.setCheckpoint(chainId, boundary);
        db.confirmAlertsUpTo(chainId, boundary);
        this.graph.finalize(boundary);
        if (this.pendingFinalized.get(chainId) === boundary) this.pendingFinalized.delete(chainId);
      } finally {
        this.finalizing.delete(chainId);
        if (this.pendingFinalized.has(chainId)) this.onFinalized(chainId, this.pendingFinalized.get(chainId) as number);
      }
    })();
  }

  private async onReorg(chainId: number, fromBlock: number): Promise<void> {
    await this.drainUntilEmpty();
    const pending = this.pendingFinalized.get(chainId);
    if (pending !== undefined && pending >= fromBlock) this.pendingFinalized.delete(chainId);
    const rewound = this.graph.rewindTo(fromBlock);
    db.deleteUnfinalizedFrom(chainId, fromBlock);
    const rt = this.chains.get(chainId);
    if (rt && rt.lastAppliedBlock >= fromBlock) rt.lastAppliedBlock = fromBlock - 1;
    const reason = `reorg at block ${fromBlock}`;
    const retracted = await this.alertManager.retractUnconfirmed(chainId, reason);
    const retractedPerformance = db.retractPerformanceForAlerts(retracted);
    for (const id of retractedPerformance) {
      const session = db.getPerformanceSession(id);
      if (session) this.performanceHook?.({ type: "performance_retracted", session });
    }
    for (const id of retracted) {
      const row = db.getAlert(id);
      if (row) this.webhooks.dispatchRetraction(id, chainId, row.token_address, reason);
    }
    log.warn("reorg handled", { chainId, fromBlock, rewoundTransitions: rewound, retracted: retracted.length });
  }

  private async drainUntilEmpty(): Promise<void> {
    do {
      await this.drain();
      if (this.draining || this.queue.depth > 0) await new Promise((resolve) => setTimeout(resolve, 0));
    } while (this.draining || this.queue.depth > 0);
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
          try {
            this.graph.applyEvent(evt);
            if (rt) {
              rt.eventsApplied++;
              if (evt.blockNumber > rt.lastAppliedBlock) rt.lastAppliedBlock = evt.blockNumber;
            }
            this.postProcess(chainId, evt);
          } catch (err) {
            // A single bad event must never kill the process (silent-death 2026-08-14).
            log.error("event processing failed — skipping", {
              chainId,
              block: evt.blockNumber,
              kind: evt.kind,
              err: String(err),
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
      return;
    }

    if (evt.kind === "swap") {
      this.updatePerformance(evt);
      // R2 volume anomaly: run rules for watched tokens only
      if (!db.getToken(chainId, evt.tokenAddress)) return;
      this.chains.get(chainId)?.adapter.addRelevantAddresses([evt.buyer]);
      this.runRules(chainId, evt);
      return;
    }

    if (evt.kind !== "transfer") return;
    const token = evt.tokenAddress;
    const isPoolLp = this.graph.isPool(token);

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
      if (this.graph.isFresh(evt.receiver, evt.timestamp, 30) && this.graph.nonceOf(evt.receiver) === null) {
        this.fetchNonce(chainId, evt.receiver);
      }
    }

    this.runRules(chainId, evt);
  }

  private runRules(chainId: number, evt: StandardEvent): void {
    for (const [id, rule] of Object.entries(RULES)) {
      const ruleCfg = this.cfg.rules[id as keyof typeof this.cfg.rules];
      if (!ruleCfg?.enabled) continue;
      let signal: Signal | null = null;
      try {
        signal = rule(evt, this.graph, this.cfg.rules);
      } catch (err) {
        log.error("rule evaluation failed", { rule: id, err: String(err) });
        continue;
      }
       if (signal) this.handleSignal(signal, false, evt); // live events are unfinalized — alerts ship tagged "unconfirmed" (PLAN.md §11.1)
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
    this.webhooks.dispatchSignal(signal);

    const res = scoreToken(signal.chainId, signal.tokenAddress, this.cfg.scoring, now);
    if (res.severity === null) return;
    const payload = this.buildAlertPayload(signal.chainId, signal.tokenAddress, res.score, res.severity, res.signals);
    void this.alertManager.maybeAlert(payload, finalized).then((id) => {
      if (id !== null) {
        this.openPerformanceSession(id, signal.chainId, signal.tokenAddress, sourceEvent);
        this.alertHook?.(payload, id);
        this.webhooks.dispatchAlert(payload, id, finalized);
      }
    }).catch((err) => {
      log.error("alert pipeline failed", { token: payload.tokenAddress, err: String(err), stack: (err as Error)?.stack });
    });
  }

  private openPerformanceSession(alertId: number, chainId: number, tokenAddress: Address, sourceEvent?: StandardEvent): void {
    const swap = sourceEvent?.kind === "swap" ? sourceEvent : db.latestSwapForToken(chainId, tokenAddress);
    if (!swap) return;
    const entryPrice = priceFromSwap(swap);
    if (entryPrice === null) return;
    const pool = db.listPoolsForToken(swap.chainId, swap.tokenAddress).find((p) => p.pool_address === swap.poolAddress);
    const { targetPrice, stopPrice } = thresholds(entryPrice);
    const openedAt = sourceEvent?.timestamp ?? swap.timestamp;
    const entryBlock = sourceEvent?.blockNumber ?? swap.blockNumber;
    const id = db.createPerformanceSession({
      alertId,
      chainId: swap.chainId,
      tokenAddress: swap.tokenAddress,
      poolAddress: swap.poolAddress,
      quoteToken: pool?.quote_token ?? null,
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
    const price = priceFromSwap(swap);
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
      });
      const updated = db.getPerformanceSession(session.id);
      if (!updated) continue;
      this.performanceHook?.({ type: updated.outcome === "active" ? "performance_updated" : "performance_closed", session: updated });
    }
  }

  private expirePerformance(): void {
    const ids = db.expirePerformanceSessions(Math.floor(Date.now() / 1000));
    for (const id of ids) {
      const session = db.getPerformanceSession(id);
      if (session) this.performanceHook?.({ type: "performance_closed", session });
    }
  }

  private buildAlertPayload(chainId: number, token: Address, score: number, severity: AlertPayload["severity"], signals: Signal[]): AlertPayload {
    const topCluster = this.graph.clusterBreakdown(token).find((c) => c.memberCount > 1);
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
        if (totalSupply) this.graph.setTotalSupply(token, totalSupply);
        // Non-standard / reverting totalSupply(): remember it so the per-transfer
        // lazy check stops firing RPC calls for every event on this token.
        if (totalSupply === null) this.metaFailed.add(key);
        log.info("fetched token metadata", { chainId, token, symbol: meta.symbol, totalSupply: totalSupply?.toString() });
      })
      .catch((err) => {
        log.warn("metadata fetch failed", { chainId, token, err: String(err) });
        this.metaFailed.add(key);
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
      .then((nonce) => this.graph.setNonce(addr, nonce))
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
      this.graph.registerPool(evt.poolAddress, evt.blockNumber, evt.timestamp);
      this.chains.get(evt.chainId)?.adapter.registerPool(evt.poolAddress, evt.token0, evt.token1);
      if (!this.cfg.autoWatch.enabled) continue;
      const existing = db.getToken(evt.chainId, token);
      if (existing && existing.expires_at === null) continue; // permanent watch already
      const expiresAt = Math.floor(Date.now() / 1000) + this.cfg.autoWatch.watchHours * 3600;
      db.upsertToken({ chainId: evt.chainId, address: token, symbol: null, decimals: null, totalSupply: null, source: "factory", expiresAt });
      log.info("auto-watch: new pool token", { chainId: evt.chainId, token, pool: evt.poolAddress, watchHours: this.cfg.autoWatch.watchHours });
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

  // ---- snapshots / retention / hot reload -------------------------------------------------

  private saveSnapshot(): void {
    try {
      const blocks: Record<string, number> = {};
      for (const [chainId, rt] of this.chains) {
        // Never regress below the restored block (a fresh instance has lastAppliedBlock 0
        // until the first backfill delivers events — writing 0 clobbers the checkpoint).
        blocks[String(chainId)] = Math.max(rt.lastAppliedBlock, this.snapshotBlocks.get(chainId) ?? 0);
      }
      const json = JSON.stringify({ version: 1, savedAt: Date.now(), blocks, graph: JSON.parse(this.graph.toJSON()) });
      mkdirSync(dirname(this.cfg.snapshotPath), { recursive: true });
      writeFileSync(this.cfg.snapshotPath, json);
      log.debug("snapshot saved", { path: this.cfg.snapshotPath });
    } catch (err) {
      log.error("snapshot save failed", { err: String(err) });
    }
  }

  private restoreSnapshot(requiredChains: number[]): boolean {
    try {
      if (!existsSync(this.cfg.snapshotPath)) return false;
      const j = JSON.parse(readFileSync(this.cfg.snapshotPath, "utf8")) as { version: number; blocks: Record<string, number>; graph: unknown };
      if (j.version !== 1) return false;
      const blocks = Object.entries(j.blocks).filter(([, block]) => block > 0);
      const blockMap = new Map(blocks.map(([chainId, block]) => [Number(chainId), block]));
      // The snapshot is saved at lastAppliedBlock ≈ head, but the checkpoint is
      // head − finalityDepth, so they are (almost) never equal — requiring equality
      // made restore always fail and replay everything on every restart. Restore as
      // long as the snapshot is at least as far along as the finalized checkpoint
      // (it contains that state); the adapter resumes from snapshotBlock + 1.
      if (blocks.length === 0 || requiredChains.some((chainId) => (blockMap.get(chainId) ?? 0) < (db.getCheckpoint(chainId) ?? 0))) {
        log.info("snapshot is not aligned with finalized checkpoints — rebuilding graph");
        return false;
      }
      this.graph = GraphEngine.fromJSON(JSON.stringify(j.graph));
      for (const [k, v] of blocks) this.snapshotBlocks.set(Number(k), v);
      log.info("restored graph snapshot", { blocks: j.blocks });
      return true;
    } catch (err) {
      log.warn("snapshot restore failed — falling back to replay", { err: String(err) });
      return false;
    }
  }

  private retentionSweep(): void {
    const pruned = db.pruneEvents(this.cfg.retention.eventDays * 86_400);
    this.refreshWatchSubscriptionForExpiry();
    if (pruned > 0) log.info("retention sweep", { prunedEvents: pruned });
  }

  private refreshWatchSubscriptionForExpiry(): void {
    for (const chainId of this.chains.keys()) this.refreshWatchSubscription(chainId);
  }

  private watchConfigFile(): void {
    try {
      let debounce: ReturnType<typeof setTimeout> | null = null;
      this.configWatcher = watch("argus.config.ts", () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => void this.hotReload(), 500);
      });
    } catch (err) {
      log.warn("config hot-reload watcher failed", { err: String(err) });
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
    this.cfg.webhooks = next.webhooks;
    this.webhooks.setTargets(next.webhooks);
    log.info("config hot-reloaded (rules/scoring/alerts/autoWatch/webhooks)");
  }

  // ---- status ------------------------------------------------------------------------------

  status(): Record<string, unknown> {
    const chains: Record<string, unknown> = {};
    for (const [chainId, rt] of this.chains) {
      chains[String(chainId)] = {
        ...rt.adapter.status(),
        lastAppliedBlock: rt.lastAppliedBlock,
        eventsApplied: rt.eventsApplied,
        checkpoint: db.getCheckpoint(chainId),
      };
    }
    return { chains, queueDepth: this.queue.depth, queueDropped: this.queue.dropped, wallets: this.graph.wallets.size };
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
