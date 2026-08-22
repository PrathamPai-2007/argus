import {
  createPublicClient,
  http,
  parseAbiItem,
  webSocket,
  type Abi,
  type Block,
  type Log as ViemLog,
  type PublicClient,
  type Transport,
  toEventSelector,
} from "viem";
import { probeArchiveDepth, probeTraceCapability } from "./probe.ts";
import type { ChainConfig } from "../config.ts";
import { log, redactUrl } from "../logger.ts";
import type { Address, FundingEvent, StandardEvent, TokenMeta } from "../types.ts";
import { fetchBigQueryLogs } from "./bigquery.ts";
import { fetchEtherscanLogs } from "./etherscan.ts";
import {
  decodeDisperseCalldata,
  fundingEvent,
  normalizePairCreated,
  normalizeSwap,
  normalizeTransfer,
  type RawLog,
} from "./normalizer.ts";

const TRANSFER_ABI = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const PAIR_CREATED_ABI = parseAbiItem("event PairCreated(address indexed token0, address indexed token1, address pair, uint256)");
const SWAP_ABI = parseAbiItem("event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)");
const ERC20_META_ABI = parseAbiItem("function totalSupply() view returns (uint256)");

// Synthetic logIndex bases so funding edges derived from txs never collide with real logs.
const LOGIDX_NATIVE = 10_000_000;
const LOGIDX_DISPERSE = 20_000_000;

const GETLOGS_CHUNK = 128n; // keep busy-token responses small on free RPC tiers
const GETLOGS_THROTTLE_CHUNK = 32n; // last-resort sub-chunk after a rate-limit failure
const MAX_THROTTLE_WAIT_MS = 60_000; // ceiling for rate-limit backoff
const THROTTLE_RETRIES = 1; // fail over immediately when an endpoint throttles
const MAX_REORG_WALK = 64;
const FUNDING_BUFFER_BLOCKS = 128; // retroactive funding lookback once a wallet is followed
const MAX_FUNDING_BUFFER_ENTRIES = 250_000; // memory bound for buffered native-transfer candidates
const MAX_RELEVANT = 50_000; // memory bound for followed-address set
const RECOVER_COOLDOWN_MS = 10_000; // avoid recovery thrash loops
const WATCHDOG_STALL_MS = 180_000; // force recovery if backfill/reconnect makes no progress this long
const BACKFILL_CONCURRENCY = 4; // concurrent per-address fetches when an endpoint rejects multi-address eth_getLogs
const TINY_GAP_RPC_BLOCKS = 64; // tiny reorg gaps are fastest on RPC; larger jobs use the historical provider
const ETHERSCAN_INITIAL_RANGE_BLOCKS = 256;
const ETHERSCAN_MAX_ESTIMATE_SECS = 900;

export type AdapterStatus = "connecting" | "live" | "stale" | "reconnecting" | "backfilling" | "stopped" | "error";

export interface AdapterCallbacks {
  /** Normalized events, ordered by (blockNumber, logIndex) within each call. */
  onEvents(chainId: number, events: StandardEvent[]): void | Promise<void>;
  /** Blocks ≤ upToBlock are now final. */
  onFinalized(chainId: number, upToBlock: number): void;
  /** Canonical chain diverged; engine must rewind all unfinalized state ≥ fromBlock. */
  onReorg(chainId: number, fromBlock: number): void | Promise<void>;
  onStatus(chainId: number, status: AdapterStatus, detail?: Record<string, unknown>): void;
  onBackfillProgress?(chainId: number, progress: { phase: string; nextBlock: number; fromBlock: number; toBlock: number; provider: string }): void | Promise<void>;
  getBackfillProgress?(chainId: number): { phase: string; nextBlock: number; fromBlock: number; toBlock: number; provider: string } | null;
  getAppliedBlock?(chainId: number): number;
}

export interface ChainAdapter {
  readonly chainId: number;
  start(resumeFrom: number | null): Promise<void>;
  stop(): Promise<void>;
  setWatchedTokens(addrs: Address[]): void;
  setFactories(addrs: Address[]): void;
  /** Add addresses whose funding edges should be tracked (watched-token participants, labels). */
  addRelevantAddresses(addrs: Address[]): void;
  /** Register a Uniswap V2-style pool (token0/token1 known) for LP/Swap subscriptions. */
  registerPool(pool: Address, token0: Address, token1: Address): void;
  fetchTokenMeta(address: Address): Promise<Partial<TokenMeta>>;
  getNonce(address: Address): Promise<number>;
  recover(reason: string): Promise<void>;
  flushEvents(): Promise<void>;
  backfillToken(token: Address, fromBlock: bigint, toBlock: bigint): Promise<number>;
  getMaxArchiveDepth(): number;
  status(): { status: AdapterStatus; endpoint: string; lastHead: number; lastHeadAt: number; tracesAvailable: boolean | null };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run `fn` over `items` with at most `limit` concurrent executions (ordering not guaranteed). */
async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++] as T;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export class EvmAdapter implements ChainAdapter {
  readonly chainId: number;
  private client: PublicClient | null = null;
  private endpointIdx = 0;
  private watchedTokens = new Set<Address>();
  private factories = new Set<Address>();
  private disperseContracts = new Set<Address>();
  private relevant = new Set<Address>(); // followed addresses (funding edges for these only)
  private relevantOrder: Address[] = []; // FIFO for the 50k cap
  private pools = new Set<Address>(); // known pool contracts (LP tokens + Swap sources)
  private poolSides = new Map<Address, { token0: Address; token1: Address }>();
  private fundingBuffer: Array<{ block: number; entries: FundingEvent[] }> = []; // rolling window for retroactive funding
  private fundingIndex = new Map<Address, Set<FundingEvent>>(); // address → buffered funding (retroactive lookup, no full-buffer scans)
  private claimedFunding = new Set<string>(); // dedup key `${block}:${logIndex}` against buffer re-emits
  private unwatchers: Array<() => void> = [];
  private running = false;
  private _status: AdapterStatus = "stopped";
  private lastHead = 0;
  private observedHead = 0; // highest chain head observed (getBlockNumber/newHeads) — reported in status(), distinct from lastHead (ingested high-water mark)
  private lastHeadAt = 0;
  private lastProgressAt = 0;
  private backfillTail: Promise<void> = Promise.resolve(); // serializes overlapping backfillRange calls
  private eventDispatch: Promise<void> | null = null;
  private backfillProgress: { from: number; to: number; progress: number } | null = null;
  private blockTimes = new Map<number, number>();
  private recentHeads: Array<{ number: number; hash: string; parentHash: string }> = [];
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private infuraRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private consecutiveFailures = 0;
  private lastRecoverAt = 0;
  private busy = false;
  private lastFinalizedSent = 0;
  private traces: boolean | null = null;
  private deferredHead: Block<bigint, true> | null = null;
  private selectedBackfillProvider = "rpc";

  constructor(
    private cfg: ChainConfig,
    private cb: AdapterCallbacks,
  ) {
    this.chainId = cfg.chainId;
  }

  private emitEvents(events: StandardEvent[]): Promise<void> {
    const dispatch = () => this.cb.onEvents(this.chainId, events);
    if (this.eventDispatch === null) {
      try {
        this.eventDispatch = Promise.resolve(dispatch());
      } catch (err) {
        this.eventDispatch = Promise.reject(err);
      }
    } else {
      this.eventDispatch = this.eventDispatch.then(dispatch);
    }
    this.eventDispatch = this.eventDispatch.catch((err: unknown) => {
      log.error("event dispatch failed", { chainId: this.chainId, err });
    });
    return this.eventDispatch;
  }

  // ---- lifecycle -----------------------------------------------------------

  async start(_resumeFrom: number | null): Promise<void> {
    this.running = true;
    this.setStatus("connecting");
    await this.connect();
    if (!this.running) return;

    const head = Number(await this.withRetry(() => this.mustClient().getBlockNumber()));
    if (head > this.observedHead) this.observedHead = head;
    this.startHeartbeat();
    this.startWatchdog();
    await this.subscribe(true);
    // Start from the current head. Historical state is intentionally not loaded
    // into the live graph; reconnects and reorgs still use bounded in-process
    // recovery backfills after startup.
    const pendingHead = this.deferredHead;
    this.deferredHead = null;
    this.lastHead = head;
    this.lastProgressAt = Date.now();
    this.lastFinalizedSent = head - this.cfg.finalityDepth;
    if (pendingHead && Number(pendingHead.number) > head) {
      this.setStatus("backfilling", { from: head + 1, to: Number(pendingHead.number), reason: "startup-gap" });
      await this.backfillRange(BigInt(head + 1), pendingHead.number as bigint);
      this.pushHead({ number: Number(pendingHead.number), hash: pendingHead.hash as string, parentHash: pendingHead.parentHash as string });
      this.lastHead = Number(pendingHead.number);
    }
    this.busy = false;
    this.setStatus("live", { head: this.lastHead });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    if (this.infuraRetryTimer) clearTimeout(this.infuraRetryTimer);
    this.heartbeatTimer = null;
    this.watchdogTimer = null;
    this.infuraRetryTimer = null;
    this.teardownSubs();
    this.setStatus("stopped");
  }

  flushEvents(): Promise<void> {
    return this.eventDispatch ?? Promise.resolve();
  }

  backfillToken(token: Address, fromBlock: bigint, toBlock: bigint): Promise<number> {
    return this.backfillRange(fromBlock, toBlock, undefined, undefined, token.toLowerCase() as Address);
  }

  setWatchedTokens(addrs: Address[]): void {
    this.watchedTokens = new Set(addrs.map((a) => a.toLowerCase()));
    if (this.running && this._status === "live") void this.resubscribeLogs();
  }

  setFactories(addrs: Address[]): void {
    this.factories = new Set(addrs.map((a) => a.toLowerCase()));
    if (this.running && this._status === "live") void this.resubscribeLogs();
  }

  setDisperseContracts(addrs: Address[]): void {
    this.disperseContracts = new Set(addrs.map((a) => a.toLowerCase()));
  }

  /** Follow a set of addresses: their native/disperse funding edges become events,
   *  and any already-buffered funding for them within the last FUNDING_BUFFER_BLOCKS
   *  is emitted retroactively (Bug A fix — funding only for wallets we care about). */
  addRelevantAddresses(addrs: Address[]): void {
    const newAddrs: Address[] = [];
    for (const raw of addrs) {
      const a = raw.toLowerCase();
      if (this.relevant.has(a)) continue;
      this.relevant.add(a);
      this.relevantOrder.push(a);
      newAddrs.push(a);
    }
    while (this.relevantOrder.length > MAX_RELEVANT) {
      const evict = this.relevantOrder.shift();
      if (evict !== undefined) this.relevant.delete(evict);
    }
    if (newAddrs.length === 0) return;
    // Indexed retroactive lookup: only entries touching the newly-followed
    // addresses are considered, so a large buffer is never scanned wholesale.
    const hits: FundingEvent[] = [];
    const seen = new Set<string>();
    for (const a of newAddrs) {
      for (const e of this.fundingIndex.get(a) ?? []) {
        const key = this.fundingKey(e);
        if (seen.has(key) || this.claimedFunding.has(key)) continue;
        if (this.relevant.has(e.funder) || (this.relevant.has(e.funded) && !this.pools.has(e.funded))) {
          seen.add(key);
          this.claimedFunding.add(key);
          hits.push(e);
        }
      }
    }
    if (hits.length > 0) void this.emitEvents(hits);
  }

  /** Register a Uniswap V2-style pool (from factory logs or auto-watch); enables
   *  LP-transfer (R7) and Swap (R2) subscriptions for it. */
  registerPool(pool: Address, token0: Address, token1: Address): void {
    const p = pool.toLowerCase();
    const t0 = token0.toLowerCase();
    const t1 = token1.toLowerCase();
    const isNew = !this.pools.has(p);
    this.pools.add(p);
    if (!this.poolSides.has(p)) this.poolSides.set(p, { token0: t0, token1: t1 });
    if (isNew && this.running && this._status === "live") void this.resubscribeLogs();
  }

  status() {
    return {
      status: this._status,
      endpoint: this.redact(this.endpointIdx),
      // Report the highest observed chain head, not the ingested high-water mark
      // (lastHead only advances as blocks are applied, so it lags during backfill
      // — the dashboard showed a frozen "head" while events streamed past it).
      lastHead: Math.max(this.lastHead, this.observedHead),
      lastHeadAt: this.lastHeadAt,
      tracesAvailable: this.traces,
      backfill: this.backfillProgress,
    };
  }

  // ---- connection + failover ------------------------------------------------

  private mustClient(): PublicClient {
    if (!this.client) throw new Error("adapter not connected");
    return this.client;
  }

  private buildClient(url: string, silentMode = false): PublicClient {
    let transport: Transport;
    if (/^wss?:\/\//.test(url)) {
      transport = webSocket(url, { retryCount: 2, retryDelay: 500, timeout: 20_000 });
    } else {
      if (!silentMode) log.warn("HTTP endpoint configured — falling back to polling (higher latency)", { chainId: this.chainId });
      transport = http(url, { retryCount: 2, retryDelay: 500, timeout: 20_000 });
    }
    return createPublicClient({ transport });
  }

  private maxArchiveDepth = 100_000;

  /** Connect to the healthiest endpoint without subscribing (used by start() and the backfill CLI). */
  async connect(): Promise<void> {
    let lastErr: unknown = null;
    for (let i = 0; i < this.cfg.rpcs.length; i++) {
      this.endpointIdx = i;
      try {
        this.client = this.buildClient(this.cfg.rpcs[i] as string);
        await this.withRetry(() => this.mustClient().getBlockNumber());
        this.traces = await this.probeTraceCapability();
        this.maxArchiveDepth = await probeArchiveDepth(this.mustClient());
        log.info("connected to endpoint", { chainId: this.chainId, endpoint: this.redact(i), traces: this.traces, archiveDepth: this.maxArchiveDepth });
        if (!this.isInfuraUrl(this.cfg.rpcs[i])) this.scheduleInfuraRetry();
        return;
      } catch (err) {
        lastErr = err;
        log.warn("endpoint failed, trying next", { chainId: this.chainId, endpoint: this.redact(i), err });
      }
    }
    throw new Error(`all RPC endpoints failed for chain ${this.chainId}: ${redactUrl(String(lastErr))}`);
  }

  public getMaxArchiveDepth(): number {
    return this.maxArchiveDepth;
  }

  private redact(i: number): string {
    const url = this.cfg.rpcs[i] ?? "";
    return url.replace(/\/([A-Za-z0-9_-]{16,})$/, "/***");
  }

  private isInfuraUrl(url?: string): boolean {
    const u = (url ?? "").toLowerCase();
    return u.includes("infura.io") || u.includes("infura");
  }

  private getInfuraIndex(): number {
    const idx = this.cfg.rpcs.findIndex((r) => this.isInfuraUrl(r));
    return idx >= 0 ? idx : 0;
  }

  private scheduleInfuraRetry(): void {
    const infuraIndex = this.getInfuraIndex();
    if (!this.isInfuraUrl(this.cfg.rpcs[infuraIndex]) || infuraIndex === this.endpointIdx || this.infuraRetryTimer || this.cfg.rpcs.length < 2) return;
    const delayMs = this.cfg.infuraRetryMinutes * 60_000;
    this.infuraRetryTimer = setTimeout(() => {
      this.infuraRetryTimer = null;
      void this.tryInfuraRecovery();
    }, delayMs);
    log.info("Infura recovery probe scheduled", { chainId: this.chainId, delayMs });
  }

  private async tryInfuraRecovery(): Promise<void> {
    if (!this.running || this.endpointIdx === this.getInfuraIndex()) return;
    if (this.busy) {
      this.scheduleInfuraRetry();
      return;
    }
    const infuraIndex = this.getInfuraIndex();
    const probe = this.buildClient(this.cfg.rpcs[infuraIndex] as string, true);
    try {
      await probe.getBlockNumber();
      log.info("Infura recovery probe succeeded", { chainId: this.chainId });
      this.endpointIdx = infuraIndex;
      this.consecutiveFailures = 0;
      await this.recover("infura-retry");
    } catch (err) {
      log.warn("Infura recovery probe failed — staying on fallback", { chainId: this.chainId, err });
      this.scheduleInfuraRetry();
    }
  }

  private httpClients = new Map<number, PublicClient>();
  private httpEndpointIdx = 0;

  private buildHttpClient(url: string): PublicClient {
    let httpUrl = url;
    if (/^wss:\/\//i.test(url)) httpUrl = url.replace(/^wss:\/\//i, "https://").replace(/\/ws\/v3\//i, "/v3/");
    else if (/^ws:\/\//i.test(url)) httpUrl = url.replace(/^ws:\/\//i, "http://");
    return this.buildClient(httpUrl, true);
  }

  private getHttpClient(preferSecondary = false): PublicClient {
    const httpList = this.cfg.httpRpcs && this.cfg.httpRpcs.length > 0 ? this.cfg.httpRpcs : this.cfg.rpcs;
    if (httpList.length === 0) return this.mustClient();
    const targetIdx = preferSecondary && httpList.length > 1 ? 1 : (this.httpEndpointIdx % httpList.length);
    
    // In tests or single-rpc setups without explicit HTTP urls, if the primary client is an HTTP client, reuse it:
    if (this.client && targetIdx === 0 && !/^wss?:\/\//i.test(this.cfg.rpcs[0] ?? "")) {
      return this.client;
    }

    let client = this.httpClients.get(targetIdx);
    if (!client) {
      client = this.buildHttpClient(httpList[targetIdx]!);
      this.httpClients.set(targetIdx, client);
    }
    return client;
  }

  /** Probe trace-API support (PLAN.md §6, §11.4). */
  private async probeTraceCapability(): Promise<boolean> {
    const ok = await probeTraceCapability(this.mustClient());
    if (!ok) log.warn("trace APIs unavailable on endpoint — degrading to log-only funding extraction", { chainId: this.chainId });
    return ok;
  }

  /** True when the RPC error indicates rate limiting / temporary overload (Infura free tier).
   *  Infura's flaky eth_getLogs answers as -32603 "service temporarily unavailable" OR as
   *  -32602 "Missing or invalid parameters ... internal error" — both are transient and must
   *  be retried/failed-over, not treated as fatal (observed 2026-08-15 after a backfill
   *  completed: a follow-up pool-LP getLogs hit this and aborted the whole engine start). */
  private isThrottleError(e: unknown): boolean {
    const s = String(e).toLowerCase();
    return (
      s.includes("service temporarily unavailable") ||
      s.includes("temporarily unavailable") ||
      s.includes("internal error") ||
      s.includes("rate limit") ||
      s.includes("rate_limit") ||
      s.includes("too many requests") ||
      s.includes("usage limit") ||
      s.includes("logs.map is not a function") ||
      s.includes("method not available") ||
      s.includes("301") ||
      s.includes("429") ||
      s.includes("500") ||
      s.includes("502") ||
      s.includes("503") ||
      s.includes("521") ||
      s.includes("522") ||
      s.includes("status: 5") ||
      s.includes("web server is down") ||
      s.includes("request exceeded") ||
      s.includes("over capacity") ||
      s.includes("timeout") ||
      s.includes("timed out")
    );
  }

  /** Some free RPCs (PublicNode, Infura free) reject multi-address eth_getLogs. */
  private isParamsRejected(e: unknown): boolean {
    const s = String(e).toLowerCase();
    return (
      s.includes("invalidparams") ||
      s.includes("invalid parameters") ||
      s.includes("invalidinputrpcerror") ||
      s.includes("request blocked")
    );
  }

  private isArchiveUnsupported(e: unknown): boolean {
    const s = String(e).toLowerCase();
    return s.includes("archive requests require") || s.includes("personal token") || s.includes("archive node");
  }

  /** Load-balanced free RPCs can answer eth_blockNumber from a node ahead of the
   *  one serving eth_getLogs — the request is rejected with "block range extends
   *  beyond current head block" (observed 2026-08-15 on PublicNode during a
   *  recovery backfill). These are NOT hard failures: clamp the range to the
   *  serving node's head and retry. */
  private isBeyondHead(e: unknown): boolean {
    const s = String(e).toLowerCase();
    return s.includes("extends beyond current head") || s.includes("beyond current head block") || s.includes("block range exceeds") || s.includes("block range extends past");
  }

  private chooseBackfillProvider(fromBlock: bigint, toBlock: bigint): void {
    const span = Number(toBlock - fromBlock + 1n);
    // Tiny reorg gaps are faster on RPC. Larger gaps use the historical provider
    // when its bounded request estimate is reasonable; this avoids both RPC
    // archive limitations and Etherscan's old four-block request explosion.
    if (span <= TINY_GAP_RPC_BLOCKS) {
      this.selectedBackfillProvider = "rpc";
      return;
    }
    const requestAddresses = Math.max(1, this.watchedTokens.size + this.pools.size + this.factories.size);
    const estimateSeconds = Math.ceil(span / ETHERSCAN_INITIAL_RANGE_BLOCKS) * requestAddresses / Math.max(1, this.cfg.backfill.etherscan.requestsPerSecond);
    const threshold = this.cfg.backfill.bigqueryThresholdHours * 3600;
    if (this.cfg.backfill.bigquery.enabled && estimateSeconds > threshold) this.selectedBackfillProvider = "bigquery";
    else if (this.cfg.backfill.etherscan.enabled && this.cfg.backfill.etherscan.apiKey && estimateSeconds <= ETHERSCAN_MAX_ESTIMATE_SECS) this.selectedBackfillProvider = "etherscan";
    else if (span <= TINY_GAP_RPC_BLOCKS) this.selectedBackfillProvider = "rpc";
    else if (this.cfg.backfill.etherscan.enabled && this.cfg.backfill.etherscan.apiKey) this.selectedBackfillProvider = "etherscan";
    else this.selectedBackfillProvider = "rpc";
    if (this.selectedBackfillProvider !== "rpc") {
      log.info("selected historical backfill provider", {
        chainId: this.chainId,
        provider: this.selectedBackfillProvider,
        estimatedSeconds: Math.round(estimateSeconds),
        thresholdSeconds: threshold,
      });
    }
  }

  private eventTopic(event: typeof TRANSFER_ABI | typeof PAIR_CREATED_ABI | typeof SWAP_ABI): `0x${string}` {
    if (event === TRANSFER_ABI) return toEventSelector("Transfer(address indexed from, address indexed to, uint256 value)");
    if (event === PAIR_CREATED_ABI) return toEventSelector("PairCreated(address indexed token0, address indexed token1, address pair, uint256)");
    return toEventSelector("Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)");
  }

  /**
   * eth_getLogs that shrinks its range on throttle failures instead of giving up.
   * A single USDT-range response can exceed free-tier limits; subdividing to
   * GETLOGS_THROTTLE_CHUNK blocks lets the whole gap still be ingested (no silent gaps).
   */
  private async getLogsAdaptive(
    addrs: Address | Address[],
    event: typeof TRANSFER_ABI | typeof PAIR_CREATED_ABI | typeof SWAP_ABI,
    fromBlock: bigint,
    toBlock: bigint,
    allowFailover = true,
    overrideClient?: PublicClient | undefined,
  ): Promise<ViemLog[]> {
    if (Array.isArray(addrs)) {
      if (addrs.length === 0) return [];
      if (addrs.length === 1) addrs = addrs[0]!;
    }
    const span = toBlock - fromBlock + 1n;
    if (this.selectedBackfillProvider !== "rpc") {
      const addresses = (Array.isArray(addrs) ? addrs : [addrs]).map((a) => a.toLowerCase() as Address);
      const topic0 = this.eventTopic(event);
      try {
        if (this.selectedBackfillProvider === "etherscan") {
          if (!this.cfg.backfill.etherscan.apiKey) throw new Error("Etherscan backfill selected without an API key");
          return await fetchEtherscanLogs({
            apiUrl: this.cfg.backfill.etherscan.apiUrl,
            apiKey: this.cfg.backfill.etherscan.apiKey,
            chainId: this.chainId,
            addresses,
            topic0,
            fromBlock,
            toBlock,
            requestsPerSecond: this.cfg.backfill.etherscan.requestsPerSecond,
            onRequest: () => { this.lastProgressAt = Date.now(); },
          });
        }
        if (!this.cfg.backfill.bigquery.projectId || !this.cfg.backfill.bigquery.credentialsPath) throw new Error("BigQuery backfill selected without credentials");
        const bigQueryArgs = {
          projectId: this.cfg.backfill.bigquery.projectId,
          credentialsPath: this.cfg.backfill.bigquery.credentialsPath,
          dataset: this.cfg.backfill.bigquery.dataset,
          addresses,
          topic0,
          fromBlock,
          toBlock,
          ...(this.cfg.backfill.bigquery.maxBytesBilled !== null ? { maxBytesBilled: this.cfg.backfill.bigquery.maxBytesBilled } : {}),
        };
        return await fetchBigQueryLogs(bigQueryArgs);
      } catch (err) {
        log.warn("historical provider failed — falling back to RPC", { chainId: this.chainId, provider: this.selectedBackfillProvider, err });
        this.selectedBackfillProvider = "rpc";
      }
    }

    // Policy: Small gaps (<= 64 blocks) use the primary HTTP RPC to preserve the
    // live WebSocket provider's quota; the secondary HTTP RPC is only failover.
    let activeClient = overrideClient;
    if (!activeClient) {
      if (span <= 64n) {
        activeClient = this.getHttpClient(false);
      } else if (this.selectedBackfillProvider === "rpc" && this.endpointIdx === this.getInfuraIndex() && this.cfg.rpcs.length > 1) {
        activeClient = this.getHttpClient(false);
      } else {
        activeClient = this.getHttpClient(false);
      }
    }

    try {
      // Large address arrays regularly time out on hosted RPCs even when the
      // equivalent single-address queries succeed. Fan out with a hard
      // concurrency cap before asking the provider for a range split.
      if (Array.isArray(addrs) && addrs.length > 1) {
        const out: ViemLog[] = [];
        await mapLimit(addrs, BACKFILL_CONCURRENCY, async (address) => {
          out.push(...(await this.getLogsAdaptive(address, event, fromBlock, toBlock, allowFailover, activeClient)));
          this.lastProgressAt = Date.now();
        });
        return out;
      }
      return await this.withRetry(
        () => activeClient.getLogs({ address: addrs as `0x${string}` | `0x${string}`[], event, fromBlock, toBlock }),
        THROTTLE_RETRIES,
      );
    } catch (err) {
      if (this.isBeyondHead(err)) {
        // The requested range extends past the serving node's head (load-balanced
        // free RPCs answer getBlockNumber from a node ahead of the getLogs node).
        // Clamp toBlock to the current head and retry instead of aborting the
        // whole backfill phase (Bug: recovery aborted with a stale lastHead).
        let head: bigint | null = null;
        try {
          head = await this.withRetry(() => activeClient.getBlockNumber(), 1);
        } catch {
          /* keep null */
        }
        let clamped: bigint | null = null;
        if (head !== null && head < toBlock) {
          clamped = BigInt(Math.min(Number(head), Number(toBlock)));
        } else if (toBlock > fromBlock) {
          // If the load balancer routed getBlockNumber to a node ahead of the getLogs node,
          // step back 1 block.
          clamped = toBlock - 1n;
        }
        if (clamped !== null && clamped >= fromBlock) {
          log.warn("getLogs range beyond serving node's head — clamping", {
            chainId: this.chainId,
            from: Number(fromBlock),
            to: Number(toBlock),
            clamped: Number(clamped),
            head: head !== null ? Number(head) : null,
          });
          return await this.getLogsAdaptive(addrs, event, fromBlock, clamped, allowFailover, activeClient);
        }
        // Block is not yet mined on the serving RPC node
        return [];
      }
      if (this.isArchiveUnsupported(err)) {
        if (this.selectedBackfillProvider === "rpc" && this.cfg.backfill.etherscan.enabled && this.cfg.backfill.etherscan.apiKey) {
          log.warn("RPC endpoint does not support archive logs — switching to Etherscan", { chainId: this.chainId, endpoint: this.redact(this.endpointIdx) });
          this.selectedBackfillProvider = "etherscan";
          return await this.getLogsAdaptive(addrs, event, fromBlock, toBlock, allowFailover, overrideClient);
        }
        // Free RPC archive block depth restriction cannot be fixed by range subdivision.
        throw err;
      }
      // Endpoint rejected the multi-address form (free tiers block arrays): fall
      // back to one adaptive call per address, run concurrently.
      if (Array.isArray(addrs) && addrs.length > 1 && this.isParamsRejected(err)) {
        try {
          const out: ViemLog[] = [];
          await mapLimit(addrs, BACKFILL_CONCURRENCY, async (a) => {
            out.push(...(await this.getLogsAdaptive(a, event, fromBlock, toBlock, allowFailover, activeClient)));
            this.lastProgressAt = Date.now(); // long splits must not trip the stall watchdog
          });
          return out;
        } catch (perAddrErr) {
          err = perAddrErr;
        }
      }
      const httpList = this.cfg.httpRpcs.length > 0 ? this.cfg.httpRpcs : this.cfg.rpcs;
      if (allowFailover && this.isThrottleError(err) && httpList.length > 1 && !overrideClient) {
        this.httpEndpointIdx++;
        const nextClient = this.getHttpClient(true);
        log.warn("RPC throttled — failing over for backfill query", {
          chainId: this.chainId,
          from: Number(fromBlock),
          to: Number(toBlock),
          endpoint: this.httpEndpointIdx % httpList.length,
        });
        return await this.getLogsAdaptive(addrs, event, fromBlock, toBlock, false, nextClient);
      }
      // Bubble a timeout/throttle up so the outer phase can gracefully fail or retry.
      if (!allowFailover && this.isThrottleError(err)) throw err;
      if (span <= GETLOGS_THROTTLE_CHUNK) throw err; // nothing left to subdivide
      const mid = fromBlock + span / 2n - 1n;
      log.warn("getLogs chunk too large, subdividing", {
        chainId: this.chainId,
        address: Array.isArray(addrs) ? addrs.length : addrs,
        from: Number(fromBlock),
        to: Number(toBlock),
        err,
      });
      const a = await this.getLogsAdaptive(addrs, event, fromBlock, mid, false, activeClient);
      const b = await this.getLogsAdaptive(addrs, event, mid + 1n, toBlock, false, activeClient);
      return [...a, ...b];
    }
  }

  private async withRetry<T>(fn: () => Promise<T>, attempts = 5, endpointUrl?: string): Promise<T> {
    let err: unknown = null;
    const currentUrl = endpointUrl ?? this.cfg.rpcs[this.endpointIdx] ?? "";
    const isInfura = this.isInfuraUrl(currentUrl) || this.endpointIdx === this.getInfuraIndex();
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (e) {
        err = e;
        this.lastProgressAt = Date.now(); // active recovery must not trip stall watchdog
        if (i + 1 >= attempts) break;
        
        const throttled = this.isThrottleError(e);
        // Fast-fail if not Infura and heavily throttled, since public RPCs often ban us outright.
        if (throttled && !isInfura && i >= 1) break;

        // Throttle responses on Infura start at 5s backoff up to 60s max.
        // Non-Infura throttle starts at 2s; non-throttle starts at 500ms.
        const base = isInfura && throttled ? 5_000 : (throttled ? 2_000 : 500);
        const cap = throttled ? MAX_THROTTLE_WAIT_MS : 4_000;
        const jitter = Math.floor(Math.random() * 250);
        const delay = Math.min(2 ** i * base, cap) + jitter;
        log.warn("rpc retry scheduled", { chainId: this.chainId, attempt: i + 1, throttled, isInfura, delayMs: delay, err });
        await sleep(delay);
      }
    }
    throw err;
  }

  // ---- subscriptions ---------------------------------------------------------

  private teardownSubs(): void {
    for (const u of this.unwatchers) {
      try {
        u();
      } catch {
        /* ignore */
      }
    }
    this.unwatchers = [];
  }

  private async subscribe(withLogs = true): Promise<void> {
    this.teardownSubs();
    const c = this.mustClient();

    // newHeads
    this.unwatchers.push(
      c.watchBlocks({
        onBlock: (block) => void this.onNewHead(block as Block<bigint, true>).catch((err) => {
          log.error("head processing failed", { chainId: this.chainId, err });
          void this.recover("head-processing-failed");
        }),
        onError: (err) => this.onStreamError("newHeads", err),
        includeTransactions: true,
        emitMissed: false,
      }),
    );
    if (withLogs) await this.resubscribeLogs();
  }

  private async resubscribeLogs(): Promise<void> {
    // replace only the log subscriptions (keep newHeads)
    this.stopLogSubscriptions();
    const c = this.mustClient();
    const tokens = [...this.watchedTokens];
    if (tokens.length > 0) {
      this.unwatchers.push(
        c.watchEvent({
          address: tokens as `0x${string}`[],
          event: TRANSFER_ABI,
          onLogs: (logs) => void this.onTokenLogs(logs),
          onError: (err) => this.onStreamError("logs", err),
        }),
      );
    }
    const factories = [...this.factories];
    if (factories.length > 0) {
      this.unwatchers.push(
        c.watchEvent({
          address: factories as `0x${string}`[],
          event: PAIR_CREATED_ABI,
          onLogs: (logs) => void this.onFactoryLogs(logs),
          onError: (err) => this.onStreamError("factory-logs", err),
        }),
      );
    }
    // Pool LP-token transfers (R7 liquidity-exit) and swaps (R2 volume anomaly)
    const pools = [...this.pools];
    if (pools.length > 0) {
      this.unwatchers.push(
        c.watchEvent({
          address: pools as `0x${string}`[],
          event: TRANSFER_ABI,
          onLogs: (logs) => void this.onPoolTransferLogs(logs),
          onError: (err) => this.onStreamError("pool-lp-logs", err),
        }),
        c.watchEvent({
          address: pools as `0x${string}`[],
          event: SWAP_ABI,
          onLogs: (logs) => void this.onSwapLogs(logs),
          onError: (err) => this.onStreamError("pool-swap-logs", err),
        }),
      );
    }
  }

  private stopLogSubscriptions(): void {
    if (this.unwatchers.length <= 1) return;
    const [heads, ...rest] = this.unwatchers;
    for (const u of rest) {
      try { u(); } catch { /* ignore */ }
    }
    this.unwatchers = heads ? [heads] : [];
  }

  private onStreamError(kind: string, err: unknown): void {
    log.error("stream error", { chainId: this.chainId, kind, err });
    void this.recover("stream-error");
  }

  // ---- heartbeat / stale-stream handling (PLAN.md §11.2) ---------------------

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.lastHeadAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (!this.running) return;
      const silentFor = Date.now() - this.lastHeadAt;
      if (silentFor > this.cfg.staleAfterMs && this._status === "live") {
        log.warn("stale stream detected", { chainId: this.chainId, silentForMs: silentFor, threshold: this.cfg.staleAfterMs });
        void this.recover("stale");
      }
    }, 2_000);
  }

  /** Watchdog: force recovery if backfill/reconnect makes no forward progress
   *  (Bug B — the 2026-08-14 run looped forever in backfilling without a timeout). */
  private startWatchdog(): void {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.lastProgressAt = Date.now();
    this.watchdogTimer = setInterval(() => {
      if (!this.running) return;
      if (this._status === "live" || this._status === "stopped") return;
      const stuckFor = Date.now() - this.lastProgressAt;
      if (stuckFor > WATCHDOG_STALL_MS) {
        this.lastProgressAt = Date.now();
        log.error("no progress while recovering — forcing restart", { chainId: this.chainId, status: this._status, stuckForMs: stuckFor });
        void this.recover("stalled");
      }
    }, 15_000);
  }

  /** Stale or broken stream: reconnect, backfill the gap, resume.
   *  Guards (Bug B): a busy mutex prevents overlapping recoveries; a cooldown
   *  dampens repeated failures; recentHeads/blockTimes are cleared so phantom
   *  parentHash mismatches from a previous backend can't fake a deep reorg. */
  async recover(reason: string): Promise<void> {
    if (!this.running) return;
    if (this.busy) {
      this.lastProgressAt = Date.now();
      return;
    }
    this.busy = true;
    this.lastProgressAt = Date.now();
    const now = Date.now();
    if (now - this.lastRecoverAt < RECOVER_COOLDOWN_MS && reason !== "stale" && reason !== "stream-error" && reason !== "recovery-failed") {
      this.busy = false;
      return;
    }
    this.lastRecoverAt = now;
    this.setStatus("reconnecting", { reason });
    this.teardownSubs();
    this.reconnectAttempt++;

    // Fresh, clean state for the new connection — stale heads/timestamps from the
    // previous backend MUST NOT survive (root cause of the phantom-reorg loop).
    this.recentHeads = [];
    this.blockTimes.clear();
    this.fundingBuffer = [];
    this.fundingIndex.clear();
    this.lastProgressAt = Date.now();

    // Rotate after one failed recovery so a dead provider does not hold recovery hostage.
    if (this.consecutiveFailures >= 1) {
      const previousEndpoint = this.endpointIdx;
      this.endpointIdx = (this.endpointIdx + 1) % this.cfg.rpcs.length;
      this.consecutiveFailures = 0;
      if (this.isInfuraUrl(this.cfg.rpcs[previousEndpoint]) && !this.isInfuraUrl(this.cfg.rpcs[this.endpointIdx])) {
        this.scheduleInfuraRetry();
      }
    }
    const backoff = Math.min(30_000, 2 ** Math.min(this.reconnectAttempt, 6) * 500) + Math.floor(Math.random() * 500);
    await sleep(backoff);
    if (!this.running) {
      this.busy = false;
      return;
    }

    try {
      this.client = this.buildClient(this.cfg.rpcs[this.endpointIdx] as string);
      const head = Number(await this.withRetry(() => this.mustClient().getBlockNumber(), 3));
      if (head > this.observedHead) this.observedHead = head;
      this.deferredHead = null;
      await this.subscribe(false);
      let caughtUpThrough = this.lastHead;
      const job = this.cb.getBackfillProgress?.(this.chainId) ?? null;
      const appliedStart = (this.cb.getAppliedBlock?.(this.chainId) ?? this.lastHead) + 1;
      const resumeStart = reason === "queue-overflow" ? Math.min(this.lastHead + 1, appliedStart) : (job !== null ? job.nextBlock : this.lastHead + 1);
      if (head > resumeStart - 1) {
        this.setStatus("backfilling", { from: resumeStart, to: head });
        // Best-effort: a flaky gap backfill must not wedge the chain in "error"
        // (2026-08-15: a transient Infura eth_getLogs error made recovery loop in
        // status error for minutes). Keep the last good head; the head-gap path
        // retries the rest from the durable job cursor.
        try {
          caughtUpThrough = await this.backfillRange(
            BigInt(job !== null ? job.fromBlock : resumeStart),
            BigInt(head),
            job !== null ? job.phase : undefined,
            job !== null ? job.fromBlock : undefined,
          );
        } catch (err) {
          log.warn("recovery backfill failed — resuming live; gap retried via head-gap", {
            chainId: this.chainId,
            resumeStart,
            head,
            err,
          });
        }
      }
      while (true) {
        const pending = this.deferredHead as Block<bigint, true> | null;
        if (!pending || Number(pending.number) <= caughtUpThrough) break;
        this.deferredHead = null;
        const pendingNumber = pending.number as bigint;
        try {
          caughtUpThrough = await this.backfillRange(BigInt(caughtUpThrough + 1), pendingNumber);
        } catch (err) {
          log.warn("recovery deferred-head backfill failed — resuming live", {
            chainId: this.chainId,
            from: caughtUpThrough + 1,
            to: Number(pendingNumber),
            err,
          });
          break;
        }
      }
      this.lastHead = caughtUpThrough;
      this.lastProgressAt = Date.now();
      this.reconnectAttempt = 0;
      await this.resubscribeLogs();
      this.lastHeadAt = Date.now();
      this.setStatus("live", { head: caughtUpThrough });
      this.busy = false;
    } catch (err) {
      this.consecutiveFailures++;
      log.error("recovery failed", { chainId: this.chainId, err, attempt: this.consecutiveFailures });
      this.busy = false;
      if (this.running) this.setStatus("error", { err });
      void this.recover("recovery-failed");
    }
  }

  // ---- block handling ----------------------------------------------------------

  private async onNewHead(block: Block<bigint, true> | undefined): Promise<void> {
    if (!this.running) return;
    if (!block || block.hash === null || block.number === null) return; // pending/garbage block — ignore
    const observedNumber = Number(block.number);
    if (observedNumber > this.observedHead) this.observedHead = observedNumber;
    // Only the live stream drives head/reorg processing; while backfilling or
    // reconnecting the stream is not canonical yet (Bug B guard).
    if (this._status !== "live") {
      this.lastHeadAt = Date.now();
      if (!this.deferredHead || Number(block.number) > Number(this.deferredHead.number)) this.deferredHead = block;
      return;
    }
    const blockHash = block.hash;
    const number = Number(block.number);
    const timestamp = Number(block.timestamp);
    this.lastHeadAt = Date.now();
    this.blockTimes.set(number, timestamp);

    // Reorg vs gap detection (Bug B). Load-balanced backends reconnect to a
    // different node: parentHash mismatches on consecutive live heads that are
    // still a strict extension are GAPS (missed heads), not reorgs.
    const prev = this.recentHeads[this.recentHeads.length - 1];
    if (prev) {
      if (number > prev.number) {
        const gap = number - prev.number;
        if (gap > 1) {
          if (gap <= this.cfg.finalityDepth * 2) {
            // Verify the canonical chain still descends from our last buffered head.
            // If the first canonical block past the gap doesn't point back at prev,
            // blocks inside the gap were replaced (reorg) — a silent backfill would
            // ingest forked data and never rewind (Bug: gap misdetected as benign).
            let firstAfterParent: string | null = null;
            try {
              const firstAfter = (await this.withRetry(() =>
                this.mustClient().getBlock({ blockNumber: BigInt(prev.number + 1), includeTransactions: false }),
                2,
              )) as Block;
              firstAfterParent = firstAfter.parentHash;
            } catch {
              /* handled below as unverifiable */
            }
            if (firstAfterParent !== null && firstAfterParent !== prev.hash) {
              log.warn("head gap contains a reorg — rewinding to last known head", { chainId: this.chainId, from: prev.number + 1, to: number - 1, gap });
              this.stopLogSubscriptions();
              this.rewindFunding(prev.number + 1);
              this.recentHeads = this.recentHeads.filter((h) => h.number <= prev.number);
              await this.cb.onReorg(this.chainId, prev.number + 1);
              this.setStatus("backfilling", { from: prev.number + 1, to: number - 1, reason: "head-gap-reorg" });
              let backfilled = false;
              try {
                await this.backfillRange(BigInt(prev.number + 1), BigInt(number - 1));
                this.lastProgressAt = Date.now();
                backfilled = true;
              } catch {
                /* best-effort; log already emitted */
              } finally {
                await this.resubscribeLogs();
              }
              if (!backfilled) {
                void this.recover("head-gap-reorg");
                return;
              }
              this.setStatus("live", { head: this.lastHead });
              this.pushHead({ number, hash: blockHash, parentHash: block.parentHash });
              this.lastHead = number;
              this.finalizeUpTo(number);
              return;
            }
            if (firstAfterParent === null) {
              // couldn't verify the gap boundary — recover cleanly rather than risk forked data
              log.warn("head gap verification failed — recovering", { chainId: this.chainId, gap });
              this.recentHeads = [];
              void this.recover("deep-gap");
              return;
            }
            // small gap = missed heads (or fresh node hop): backfill silently, stay live
            log.info("head gap — backfilling", { chainId: this.chainId, from: prev.number + 1, to: number - 1, gap });
            this.stopLogSubscriptions();
            this.setStatus("backfilling", { from: prev.number + 1, to: number - 1, reason: "head-gap" });
            let backfilled = false;
            try {
              await this.backfillRange(BigInt(prev.number + 1), BigInt(number - 1));
              this.lastProgressAt = Date.now();
              backfilled = true;
            } catch {
              /* backfill is best-effort; log already emitted */
            } finally {
              await this.resubscribeLogs();
            }
            if (!backfilled) {
              void this.recover("head-gap");
              return;
            }
            this.setStatus("live", { head: this.lastHead });
            this.pushHead({ number, hash: blockHash, parentHash: block.parentHash });
            this.lastHead = number;
            this.finalizeUpTo(number);
            return;
          }
          // deep discontinuity: the chain state is unreliable — recover cleanly
          log.warn("deep head gap — recovering", { chainId: this.chainId, prev: prev.number, newHead: number, gap });
          this.recentHeads = [];
          void this.recover("deep-gap");
          return;
        }
        if (number === prev.number + 1 && block.parentHash !== prev.hash) {
          await this.handleReorg(block as Block<bigint, true> & { hash: `0x${string}` });
          return;
        }
        // contiguous: normal extension
      } else if (number < prev.number) {
        log.warn("head went backwards", { chainId: this.chainId, prev: prev.number, newHead: number });
        void this.recover("head-backwards");
        return;
      } else if (block.parentHash !== prev.hash) {
        await this.handleReorg(block as Block<bigint, true> & { hash: `0x${string}` });
        return;
      } else {
        return; // duplicate head — ignore
      }
    }

    this.pushHead({ number, hash: blockHash, parentHash: block.parentHash });
    if (number > this.lastHead) this.lastHead = number;

    const funding = this.extractFundingFromBlock(block);
    if (funding.length > 0) this.bufferFunding(funding);

    this.finalizeUpTo(number);
  }

  private finalizeUpTo(number: number): void {
    const boundary = number - this.cfg.finalityDepth;
    if (boundary > this.lastFinalizedSent) {
      this.lastFinalizedSent = boundary;
      this.cb.onFinalized(this.chainId, boundary);
    }
  }

  private pushHead(h: { number: number; hash: string; parentHash: string }): void {
    this.recentHeads.push(h);
    const cap = Math.max(this.cfg.finalityDepth * 3, 96);
    while (this.recentHeads.length > cap) this.recentHeads.shift();
    while (this.blockTimes.size > 4096) {
      const oldest = this.blockTimes.keys().next().value;
      if (oldest === undefined) break;
      this.blockTimes.delete(oldest);
    }
  }

  /** Walk back to the fork point, tell the engine to rewind, then re-ingest canonical range. */
  private async handleReorg(newHead: Block<bigint, true> & { hash: `0x${string}` }): Promise<void> {
    const number = Number(newHead.number);
    log.warn("reorg detected", { chainId: this.chainId, newHead: number, newHeadHash: newHead.hash });
    this.stopLogSubscriptions();
    let forkPoint = number - 1;
    let matched = false;
    for (let depth = 0; depth < MAX_REORG_WALK && forkPoint >= 0; depth++, forkPoint--) {
      const buffered = this.recentHeads.find((h) => h.number === forkPoint);
      if (!buffered) break;
      const canonical = (await this.withRetry(() =>
        this.mustClient().getBlock({ blockNumber: BigInt(forkPoint), includeTransactions: false }),
      )) as Block;
      if (canonical.hash === buffered.hash) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      log.error("reorg deeper than buffer — forcing resync from checkpoint", { chainId: this.chainId });
      // treat the whole buffered range as suspect
      forkPoint = this.lastFinalizedSent;
      if (forkPoint >= number) forkPoint = number - MAX_REORG_WALK;
    }

    const fromBlock = forkPoint + 1;
    // drop forked heads
    this.recentHeads = this.recentHeads.filter((h) => h.number <= forkPoint);
    this.rewindFunding(fromBlock);
    try {
      await this.cb.onReorg(this.chainId, fromBlock);
      // re-ingest canonical history for the forked range
      await this.backfillRange(BigInt(fromBlock), BigInt(number));
    } finally {
      await this.resubscribeLogs();
    }
    this.pushHead({ number, hash: newHead.hash, parentHash: newHead.parentHash });
    this.lastHead = number;
    this.lastHeadAt = Date.now();
    this.lastProgressAt = Date.now();
  }

  // ---- funding extraction from block transactions (PLAN.md §6) -----------------
  // Bug A: on mainnet nearly every block has native ETH transfers. We do NOT emit
  // funding for all of them. Candidates are parked in a rolling fundingBuffer and
  // emitted only when they involve a relevant (followed) address — either because
  // the funder is relevant, or the funded wallet is relevant and not a pool. The
  // engine follows watched-token participants via addRelevantAddresses, which also
  // drains buffered funding retroactively.

  private extractFundingFromBlock(block: Block<bigint, true>): FundingEvent[] {
    const out: FundingEvent[] = [];
    const number = Number(block.number);
    const timestamp = Number(block.timestamp);
    const txs = block.transactions as Array<{
      hash: string;
      from: string;
      to: string | null;
      value: bigint;
      input: string;
      transactionIndex: number;
    }>;
    for (const tx of txs) {
      const to = tx.to?.toLowerCase();
      if (!to) continue;
      // batch-sender contracts: one call → N funding edges (always relevant)
      if (this.disperseContracts.has(to)) {
        const payout = decodeDisperseCalldata(tx.input as `0x${string}`);
        if (payout && payout.kind === "ether") {
          payout.recipients.forEach((recipient, i) => {
            out.push(
              fundingEvent({
                chainId: this.chainId,
                funder: tx.from.toLowerCase(),
                funded: recipient,
                amount: payout.values[i] ?? 0n,
                method: "disperse",
                txHash: tx.hash,
                blockNumber: number,
                logIndex: LOGIDX_DISPERSE + tx.transactionIndex * 1000 + i,
                timestamp,
              }),
            );
          });
          continue;
        }
      }
      // Native transfers are parked unconditionally — relevance is decided by
      // bufferFunding, which retains non-relevant candidates for the rolling
      // window. Gating here would drop funding sent BEFORE a wallet became
      // relevant (e.g. a watched-token participant funded by a CEX), silently
      // losing the R6/R8 edges the retroactive buffer exists to catch.
      if (tx.value > 0n) {
        out.push(
          fundingEvent({
            chainId: this.chainId,
            funder: tx.from.toLowerCase(),
            funded: to,
            amount: tx.value,
            method: "native_transfer",
            txHash: tx.hash,
            blockNumber: number,
            logIndex: LOGIDX_NATIVE + tx.transactionIndex,
            timestamp,
          }),
        );
      }
    }
    return out;
  }

  /** Park funding candidates in a rolling buffer; emit only the relevant subset now. */
  private bufferFunding(entries: FundingEvent[]): void {
    const currentBlock = entries.reduce((max, e) => Math.max(max, e.blockNumber), 0);
    const minClaimedBlock = currentBlock - FUNDING_BUFFER_BLOCKS;
    this.claimedFunding = new Set([...this.claimedFunding].filter((key) => Number(key.split(":", 1)[0]) >= minClaimedBlock));
    const hits: FundingEvent[] = [];
    const retained: FundingEvent[] = [];
    for (const e of entries) {
      const key = this.fundingKey(e);
      if (this.claimedFunding.has(key)) continue;
      if (this.relevant.has(e.funder) || (this.relevant.has(e.funded) && !this.pools.has(e.funded))) {
        this.claimedFunding.add(key);
        hits.push(e);
      } else {
        retained.push(e);
      }
    }
    if (hits.length > 0) void this.emitEvents(hits);
    if (retained.length === 0) return;
    for (const e of retained) this.indexFunding(e);
    this.fundingBuffer.push({ block: entries[0]?.blockNumber ?? 0, entries: retained });
    while (this.fundingBuffer.length > FUNDING_BUFFER_BLOCKS) {
      const head = this.fundingBuffer[0];
      if (!head) break;
      const cutoff = head.block + FUNDING_BUFFER_BLOCKS;
      if ((this.fundingBuffer[1]?.block ?? Infinity) > cutoff) {
        this.unindexFunding(head.entries);
        this.fundingBuffer.shift();
      } else {
        break;
      }
    }
    if (this.fundingBuffer.length > FUNDING_BUFFER_BLOCKS * 2) {
      const head = this.fundingBuffer[0];
      if (head) this.unindexFunding(head.entries);
      this.fundingBuffer.shift(); // hard cap
    }
    // Absolute entry cap: buffering ALL native transfers (not just relevant ones)
    // makes a 128-block window large on busy chains — evict the oldest entries first.
    let buffered = 0;
    for (const b of this.fundingBuffer) buffered += b.entries.length;
    while (buffered > MAX_FUNDING_BUFFER_ENTRIES) {
      const head = this.fundingBuffer[0];
      if (!head) break;
      const drop = Math.min(head.entries.length, buffered - MAX_FUNDING_BUFFER_ENTRIES);
      const dropped = head.entries.splice(0, drop);
      this.unindexFunding(dropped);
      buffered -= drop;
      if (head.entries.length === 0) this.fundingBuffer.shift();
    }
  }

  private indexFunding(e: FundingEvent): void {
    for (const raw of [e.funder, e.funded]) {
      const addr = raw.toLowerCase();
      let set = this.fundingIndex.get(addr);
      if (!set) {
        set = new Set();
        this.fundingIndex.set(addr, set);
      }
      set.add(e);
    }
  }

  private unindexFunding(entries: FundingEvent[]): void {
    for (const e of entries) {
      for (const raw of [e.funder, e.funded]) {
        const addr = raw.toLowerCase();
        const set = this.fundingIndex.get(addr);
        if (!set) continue;
        set.delete(e);
        if (set.size === 0) this.fundingIndex.delete(addr);
      }
    }
  }

  private fundingKey(e: FundingEvent): string {
    return `${e.blockNumber}:${e.txHash}:${e.logIndex}`;
  }

  private rewindFunding(fromBlock: number): void {
    this.claimedFunding = new Set([...this.claimedFunding].filter((key) => Number(key.split(":", 1)[0]) < fromBlock));
    const kept = this.fundingBuffer.filter((entry) => entry.block < fromBlock);
    this.unindexFunding(this.fundingBuffer.flatMap((entry) => (entry.block >= fromBlock ? entry.entries : [])));
    this.fundingBuffer = kept;
  }

  // ---- log handling -------------------------------------------------------------

  private toRaw(l: ViemLog): RawLog {
    return {
      address: l.address.toLowerCase(),
      topics: l.topics as unknown as RawLog["topics"],
      data: l.data,
      blockNumber: Number(l.blockNumber),
      logIndex: l.logIndex ?? 0,
      transactionHash: l.transactionHash ?? "0x",
    };
  }

  private async onTokenLogs(logs: ViemLog[]): Promise<void> {
    const events: StandardEvent[] = [];
    const timestamps = await this.blockTimesFor(logs);
    for (const l of logs) {
      const ts = timestamps.get(Number(l.blockNumber)) ?? Math.floor(Date.now() / 1000);
      const evt = normalizeTransfer(this.toRaw(l), this.chainId, ts);
      if (evt) events.push(evt);
    }
    if (events.length > 0) void this.emitEvents(events);
  }

  private async onFactoryLogs(logs: ViemLog[]): Promise<void> {
    const events: StandardEvent[] = [];
    const timestamps = await this.blockTimesFor(logs);
    for (const l of logs) {
      const ts = timestamps.get(Number(l.blockNumber)) ?? Math.floor(Date.now() / 1000);
      const evt = normalizePairCreated(this.toRaw(l), this.chainId, "uniswap-v2", ts);
      if (evt) {
        this.registerPool(evt.poolAddress, evt.token0, evt.token1);
        events.push(evt);
      }
    }
    if (events.length > 0) void this.emitEvents(events);
  }

  /** LP-token transfers of known pools (R7 input). The pool is the LP token, so
   *  normalizeTransfer with tokenAddress = pool gives the mint/burn/transfer log. */
  private async onPoolTransferLogs(logs: ViemLog[]): Promise<void> {
    const events: StandardEvent[] = [];
    const timestamps = await this.blockTimesFor(logs);
    for (const l of logs) {
      const pool = l.address.toLowerCase();
      const ts = timestamps.get(Number(l.blockNumber)) ?? Math.floor(Date.now() / 1000);
      const evt = normalizeTransfer(this.toRaw(l), this.chainId, ts, pool as Address);
      if (evt) events.push(evt);
    }
    if (events.length > 0) void this.emitEvents(events);
  }

  /** Swap logs of known pools (R2 input). */
  private async onSwapLogs(logs: ViemLog[]): Promise<void> {
    const events: StandardEvent[] = [];
    const timestamps = await this.blockTimesFor(logs);
    for (const l of logs) {
      const pool = l.address.toLowerCase();
      const sides = this.poolSides.get(pool);
      if (!sides) continue; // not a registered pair — ignore
      const ts = timestamps.get(Number(l.blockNumber)) ?? Math.floor(Date.now() / 1000);
      for (const token of [sides.token0, sides.token1]) {
        if (!this.watchedTokens.has(token)) continue; // only watched-token swaps matter
        const evt = normalizeSwap(this.toRaw(l), this.chainId, token, pool, token === sides.token0, ts);
        if (evt) events.push(evt);
      }
    }
    if (events.length > 0) void this.emitEvents(events);
  }

  private async blockTime(n: number): Promise<number> {
    const cached = this.blockTimes.get(n);
    if (cached !== undefined) return cached;
    try {
      const b = (await this.withRetry(() => this.mustClient().getBlock({ blockNumber: BigInt(n), includeTransactions: false }))) as Block;
      const ts = Number(b.timestamp);
      this.blockTimes.set(n, ts);
      return ts;
    } catch {
      return Math.floor(Date.now() / 1000);
    }
  }

  private async blockTimesFor(logs: ViemLog[]): Promise<Map<number, number>> {
    const allNumbers = [...new Set(logs.map((l) => Number(l.blockNumber)))];
    for (const l of logs) {
      const timestamp = (l as ViemLog & { blockTimestamp?: number }).blockTimestamp;
      if (timestamp !== undefined) this.blockTimes.set(Number(l.blockNumber), timestamp);
    }
    const missing = allNumbers.filter((n) => !this.blockTimes.has(n));
    for (let i = 0; i < missing.length; i += 8) {
      await Promise.all(missing.slice(i, i + 8).map((n) => this.blockTime(n)));
    }
    return new Map(allNumbers.map((n) => [n, this.blockTimes.get(n) ?? Math.floor(Date.now() / 1000)]));
  }

  // ---- backfill (gap recovery + replay source, PLAN.md §10/§11.3) ----------------

  async backfillRange(fromBlock: bigint, toBlock: bigint, resumePhase?: string, jobFromBlock?: number, onlyToken?: Address): Promise<number> {
    if (fromBlock > toBlock) return Number(toBlock);
    // Serialize overlapping backfill calls instead of skipping the late one
    // (Bug: a concurrent call used to be skipped, so callers believed the range
    // was ingested — recover() went live with a stale lastHead and the gap was
    // never closed). Callers await their own call, so a concurrent caller must
    // WAIT for the in-flight backfill to finish rather than return early.
    // Re-runs are safe: events are idempotent (INSERT OR IGNORE) and
    // Repeated ranges are safe because event inserts are idempotent.
    const prev = this.backfillTail;
    let release = () => {};
    this.backfillTail = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await this.backfillRangeInner(fromBlock, toBlock, resumePhase, jobFromBlock, onlyToken);
    } finally {
      release();
    }
  }

  private async backfillRangeInner(fromBlock: bigint, toBlock: bigint, resumePhase?: string, jobFromBlock?: number, onlyToken?: Address): Promise<number> {
    if (fromBlock > toBlock) return Number(toBlock);
    // Clamp the range to the serving node's current head up-front. Load-balanced
    // free RPCs answer eth_blockNumber from a node ahead of the one serving
    // eth_getLogs ("block range extends beyond current head block"), so a range
    // ending at the fetched head aborts the whole phase. Clamping keeps the
    // actual ingested-through block honest (returned to callers).
    try {
      const currentHead = Number(await this.withRetry(() => this.mustClient().getBlockNumber(), 1));
      if (currentHead > this.observedHead) this.observedHead = currentHead;
      if (currentHead < Number(toBlock)) {
        log.warn("backfill range clamped to serving node's head", { chainId: this.chainId, from: Number(fromBlock), to: Number(toBlock), head: currentHead });
        toBlock = BigInt(currentHead);
        if (fromBlock > toBlock) return Number(toBlock);
      }
    } catch {
      /* head fetch failed — keep the requested range; getLogsAdaptive re-clamps */
    }
    this.chooseBackfillProvider(fromBlock, toBlock);
    const gap = Number(toBlock - fromBlock);
    const rangeStart = jobFromBlock ?? Number(fromBlock);
    const markProgress = () => (this.lastProgressAt = Date.now());
    const emit = async (events: StandardEvent[]) => {
      if (events.length === 0) return;
      events.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex || a.kind.localeCompare(b.kind));
      await this.emitEvents(events);
    };
    const progress = async (phase: string, nextBlock: bigint) => {
      await this.cb.onBackfillProgress?.(this.chainId, {
        phase,
        nextBlock: Number(nextBlock),
        fromBlock: rangeStart,
        toBlock: Number(toBlock),
        provider: this.selectedBackfillProvider,
      });
    };
    const reportProgress = () => {
      this.backfillProgress = { from: Number(fromBlock), to: Number(toBlock), progress: 0 };
    };
    reportProgress();

    // Batch all addresses into ONE getLogs per block-chunk: ~24 tokens used to
    // mean ~24 sequential RPC calls per chunk; now it is a single call.
    const rangeChunks = Number((toBlock - fromBlock + 1n + GETLOGS_CHUNK - 1n) / GETLOGS_CHUNK);
    const poolChunks = this.pools.size > 0 ? rangeChunks : 0;
    const totalSteps = rangeChunks /* tokens */ + (onlyToken ? 0 : this.factories.size) + poolChunks /* LP */ + poolChunks /* swap */ + (gap <= 128 ? 1 : 0);
    let doneSteps = 0;
    const setStep = (done: number) => {
      this.backfillProgress = { from: Number(fromBlock), to: Number(toBlock), progress: Math.round((done / Math.max(1, totalSteps)) * 100) };
    };

    const phaseOrder = ["tokens", "factory", "lp", "swap", "funding"];
    const startPhase = resumePhase && phaseOrder.includes(resumePhase) ? resumePhase : "tokens";
    const shouldRun = (phase: string) => phaseOrder.indexOf(phase) >= phaseOrder.indexOf(startPhase);
    const savedProgress = this.cb.getBackfillProgress?.(this.chainId);

    // 1. Transfer logs for all watched tokens, batched per chunk
    const tokens = onlyToken ? [onlyToken] : [...this.watchedTokens];
    const isDualRpcCatchUp = this.cfg.rpcs.length > 1 && this.selectedBackfillProvider === "rpc";
    const clientInfura = isDualRpcCatchUp ? this.getHttpClient(false) : undefined;
    const clientPublic = isDualRpcCatchUp ? this.getHttpClient(true) : undefined;

    if (tokens.length > 0 && shouldRun("tokens")) {
      const first = startPhase === "tokens" && savedProgress ? BigInt(Math.max(Number(fromBlock), savedProgress.nextBlock)) : fromBlock;
      const chunks: Array<{ from: bigint; to: bigint; client?: PublicClient | undefined }> = [];
      let idx = 0;
      for (let from = first; from <= toBlock; from += GETLOGS_CHUNK) {
        const to = from + GETLOGS_CHUNK - 1n > toBlock ? toBlock : from + GETLOGS_CHUNK - 1n;
        const targetClient = isDualRpcCatchUp
          ? (idx % 2 === 0 ? clientInfura : clientPublic)
          : undefined;
        chunks.push(targetClient !== undefined ? { from, to, client: targetClient } : { from, to });
        idx++;
      }

      if (isDualRpcCatchUp && chunks.length > 1) {
        log.info("dual-RPC parallel catch-up backfilling tokens phase", {
          chainId: this.chainId,
          chunks: chunks.length,
          from: Number(fromBlock),
          to: Number(toBlock),
        });
        await mapLimit(chunks, 2, async (c) => {
          markProgress();
          setStep(doneSteps);
          try {
            const logs = await this.getLogsAdaptive(tokens, TRANSFER_ABI, c.from, c.to, true, c.client);
            const timestamps = await this.blockTimesFor(logs);
            const batch: StandardEvent[] = [];
            for (const l of logs) {
              const ts = timestamps.get(Number(l.blockNumber)) ?? Math.floor(Date.now() / 1000);
              const evt = normalizeTransfer(this.toRaw(l), this.chainId, ts);
              if (evt) batch.push(evt);
            }
            await emit(batch);
          } catch (err) {
            log.error("backfill getLogs parallel chunk failed", { chainId: this.chainId, from: Number(c.from), to: Number(c.to), err });
            await progress("tokens", c.from);
            throw err;
          }
          await progress("tokens", c.to + 1n);
          setStep(++doneSteps);
        });
      } else {
        for (const c of chunks) {
          markProgress();
          setStep(doneSteps);
          try {
            const logs = await this.getLogsAdaptive(tokens, TRANSFER_ABI, c.from, c.to, true, c.client);
            const timestamps = await this.blockTimesFor(logs);
            const batch: StandardEvent[] = [];
            for (const l of logs) {
              const ts = timestamps.get(Number(l.blockNumber)) ?? Math.floor(Date.now() / 1000);
              const evt = normalizeTransfer(this.toRaw(l), this.chainId, ts);
              if (evt) batch.push(evt);
            }
            await emit(batch);
          } catch (err) {
            log.error("backfill getLogs failed", { chainId: this.chainId, from: Number(c.from), to: Number(c.to), err });
            await progress("tokens", c.from);
            throw err;
          }
          await progress("tokens", c.to + 1n);
          setStep(++doneSteps);
        }
      }
    }
    await progress("factory", fromBlock);

    // 2. Factory PairCreated logs (registers pools for step 3).
    //    Best-effort: PairCreated is pool discovery, not core transfer data — a
    //    transient provider error must not abort the backfill (2026-08-15: a
    //    flaky Infura eth_getLogs here after the main backfill completed aborted
    //    the whole engine start). Log, advance the cursor, keep going.
    if (!onlyToken && shouldRun("factory")) for (const f of this.factories) {
      markProgress();
      setStep(doneSteps);
      try {
        const logs = await this.getLogsAdaptive([f as Address], PAIR_CREATED_ABI, fromBlock, toBlock);
        const timestamps = await this.blockTimesFor(logs);
        for (const l of logs) {
          const ts = timestamps.get(Number(l.blockNumber)) ?? Math.floor(Date.now() / 1000);
          const evt = normalizePairCreated(this.toRaw(l), this.chainId, "uniswap-v2", ts);
          if (evt) {
            this.registerPool(evt.poolAddress, evt.token0, evt.token1);
            await emit([evt]);
          }
        }
      } catch (err) {
        log.warn("backfill factory getLogs failed — skipping phase", { chainId: this.chainId, factory: f, err });
        await progress("factory", toBlock + 1n);
        setStep(++doneSteps);
        break;
      }
      setStep(++doneSteps);
    }
    await progress("lp", fromBlock);

    // 3. Pool LP transfers + Swaps for all pools, batched per chunk.
    //    Best-effort (R7/R2 input, not core transfer data): a transient provider
    //    error on one chunk must not abort the whole backfill — log, advance the
    //    cursor past the phase, and move on (2026-08-15: flaky Infura eth_getLogs
    //    on a pool here aborted the engine right after the main backfill completed).
    const pools = [...this.pools].filter((pool) => {
      if (!onlyToken) return true;
      const sides = this.poolSides.get(pool);
      return sides?.token0 === onlyToken || sides?.token1 === onlyToken;
    });
    if (pools.length > 0 && shouldRun("lp")) {
      const first = startPhase === "lp" && savedProgress ? BigInt(Math.max(Number(fromBlock), savedProgress.nextBlock)) : fromBlock;
      for (let from = first; from <= toBlock; from += GETLOGS_CHUNK) {
        markProgress();
        setStep(doneSteps);
        const to = from + GETLOGS_CHUNK - 1n > toBlock ? toBlock : from + GETLOGS_CHUNK - 1n;
        try {
          const lpLogs = await this.getLogsAdaptive(pools, TRANSFER_ABI, from, to);
          const timestamps = await this.blockTimesFor(lpLogs);
          const batch: StandardEvent[] = [];
          for (const l of lpLogs) {
            const ts = timestamps.get(Number(l.blockNumber)) ?? Math.floor(Date.now() / 1000);
            const evt = normalizeTransfer(this.toRaw(l), this.chainId, ts, l.address.toLowerCase() as Address);
            if (evt) batch.push(evt);
          }
          await emit(batch);
        } catch (err) {
          log.warn("backfill pool LP logs failed — skipping phase", { chainId: this.chainId, from: Number(from), to: Number(to), err });
          await progress("lp", toBlock + 1n);
          setStep(++doneSteps);
          break;
        }
        await progress("lp", to + 1n);
        setStep(++doneSteps);
      }
      await progress("swap", fromBlock);
    }
    // 3b. Pool swaps (R2 input) — gated independently of LP: the swap loop used to
    //     live inside the `shouldRun("lp")` block, so resuming from phase "swap"
    //     (lp already done) skipped it entirely — swap data was silently dropped.
    if (pools.length > 0 && shouldRun("swap")) {
      const firstSwap = startPhase === "swap" && savedProgress ? BigInt(Math.max(Number(fromBlock), savedProgress.nextBlock)) : fromBlock;
      for (let from = firstSwap; from <= toBlock; from += GETLOGS_CHUNK) {
        markProgress();
        setStep(doneSteps);
        const to = from + GETLOGS_CHUNK - 1n > toBlock ? toBlock : from + GETLOGS_CHUNK - 1n;
        try {
          const swapLogs = await this.getLogsAdaptive(pools, SWAP_ABI, from, to);
          const timestamps = await this.blockTimesFor(swapLogs);
          const batch: StandardEvent[] = [];
          for (const l of swapLogs) {
            const pool = l.address.toLowerCase() as Address;
            const sides = this.poolSides.get(pool);
            if (!sides) continue;
            const ts = timestamps.get(Number(l.blockNumber)) ?? Math.floor(Date.now() / 1000);
            for (const token of [sides.token0, sides.token1]) {
              if (onlyToken ? token !== onlyToken : !this.watchedTokens.has(token)) continue;
              const evt = normalizeSwap(this.toRaw(l), this.chainId, token, pool, token === sides.token0, ts);
              if (evt) batch.push(evt);
            }
          }
          await emit(batch);
        } catch (err) {
          log.warn("backfill pool swap logs failed — skipping phase", { chainId: this.chainId, from: Number(from), to: Number(to), err });
          await progress("swap", toBlock + 1n);
          setStep(++doneSteps);
          break;
        }
        await progress("swap", to + 1n);
        setStep(++doneSteps);
      }
    }
    await progress("funding", fromBlock);

    // 4. Funding edges from block txs — only for small gaps (reorg/stale recovery);
    //    candidates are buffered and emitted only for relevant addresses (Bug A).
    if (gap <= 128 && shouldRun("funding")) {
      setStep(doneSteps++);
      const funding: FundingEvent[] = [];
      let fundingFailed = false;
      for (let n = fromBlock; n <= toBlock; n++) {
        markProgress();
        if (fundingFailed) continue;
        try {
          const block = (await this.withRetry(() =>
            this.mustClient().getBlock({ blockNumber: n, includeTransactions: true }),
            2,
          )) as Block<bigint, true>;
          this.blockTimes.set(Number(n), Number(block.timestamp));
          funding.push(...this.extractFundingFromBlock(block));
        } catch (err) {
          fundingFailed = true;
          log.warn("backfill getBlock failed — skipping funding extraction for the rest of this gap", { chainId: this.chainId, block: Number(n), err });
        }
      }
      if (funding.length > 0) this.bufferFunding(funding);
    }

    await progress("complete", toBlock + 1n);
    this.backfillProgress = null;
    if (gap > 0) log.info("backfilled range", { chainId: this.chainId, from: Number(fromBlock), to: Number(toBlock) });
    return Number(toBlock);
  }

  // ---- metadata / nonces -----------------------------------------------------------

  async fetchTokenMeta(address: Address): Promise<Partial<TokenMeta>> {
    const c = this.mustClient();
    const out: Partial<TokenMeta> = {};
    try {
      out.totalSupply = (await c.readContract({
        address: address as `0x${string}`,
        abi: [ERC20_META_ABI] as unknown as Abi,
        functionName: "totalSupply",
      })) as bigint;
    } catch {
      /* non-standard token */
    }
    for (const [fn, key] of [
      ["decimals", "decimals"],
      ["symbol", "symbol"],
    ] as const) {
      try {
        const v = await c.readContract({
          address: address as `0x${string}`,
          abi: [parseAbiItem(`function ${fn}() view returns (${fn === "decimals" ? "uint8" : "string"})`)] as unknown as Abi,
          functionName: fn,
        });
        (out as Record<string, unknown>)[key] = v;
      } catch {
        /* ignore */
      }
    }
    return out;
  }

  async getNonce(address: Address): Promise<number> {
    return this.mustClient().getTransactionCount({ address: address as `0x${string}` });
  }

  private setStatus(s: AdapterStatus, detail?: Record<string, unknown>): void {
    this._status = s;
    this.cb.onStatus(this.chainId, s, detail);
  }
}
