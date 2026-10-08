import { chainInfo, factoryInfo, orientPair, priceRef, priceRefPool } from "../chains.ts";
import { log } from "../logger.ts";
import { compareEvents, type Address, type ChainEvent, type PoolCreatedEvent } from "../model.ts";
import { ALL_TOPICS, decodeLog, isPoolCreation, poolKey, type PoolRef, type RawLog, type TxInfo } from "./decode.ts";
import { HeadStream } from "./heads.ts";
import { hex, type RpcPool } from "./rpc.ts";

/** The slice of RpcPool the sync loop needs (lets tests drive a fake chain). */
export type SyncRpc = Pick<RpcPool, "batch" | "request" | "limits" | "endpointStatus">;

// Block-cursor sync: one serialized loop per chain. Every iteration fetches
// headers (reorg check), logs for the whole range in one filtered query, and
// signer info for pool events — then emits ordered events and advances. Live
// following and gap recovery are the same code path, so there is no window
// where a subscription switch can drop logs.

export type SyncStatus = "starting" | "live" | "catching_up" | "degraded" | "stopped";

export interface SyncCallbacks {
  onEvents(chainId: number, events: ChainEvent[]): Promise<void>;
  onReorg(chainId: number, fromBlock: number): Promise<void>;
  onFinalized(chainId: number, upToBlock: number): void;
  onStatus?(chainId: number, status: SyncStatus, detail?: Record<string, unknown>): void;
  /** Called when the loop auto-registers a freshly created pool (launch capture). */
  onPoolRegistered?(chainId: number, pool: PoolRef, created: PoolCreatedEvent): void;
}

export interface SyncOptions {
  chainId: number;
  rpc: SyncRpc;
  wsUrls: string[];
  finalityDepth: number;
  blockTimeMs: number;
  /** Gaps larger than this are skipped (best-effort recovery, invariant 8). */
  maxGapBlocks?: number;
  /** Auto-register new pools emitted by known factories. */
  autoRegisterPools?: boolean;
  /** Resume after this block (persisted finalized cursor) when within maxGapBlocks of the head. */
  resumeFrom?: number | null;
  /** Start this many blocks behind the head (historical catch-up through the live path). */
  rewindBlocks?: number;
}

interface Header {
  number: string;
  hash: string;
  parentHash: string;
  timestamp: string;
}

interface RpcLog {
  address: string;
  topics: `0x${string}`[];
  data: `0x${string}`;
  blockNumber: string;
  blockHash: string;
  transactionIndex: string;
  logIndex: string;
  transactionHash: `0x${string}`;
  removed?: boolean;
}

const MAX_RANGE = 100; // headers per batch while catching up
const ADDRESS_CHUNK = 500;
const MAX_REORG_WALK = 64;
const HASH_MEMORY = 512;
/** Provider answers meaning "this history is pruned here", not "try again". */
const UNSERVABLE = /first available|unknown state|archive requests|missing trie|pruned|state (is )?not available/i;

class RangeRetry extends Error {}

export class ChainSync {
  readonly chainId: number;
  private pools = new Map<Address, PoolRef>();
  private tokens = new Set<Address>();
  private hashes = new Map<number, string>();
  private cursor = -1;
  private head = 0;
  private finalized = 0;
  private running = false;
  private ticking: Promise<void> | null = null;
  private dirty = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private heads: HeadStream | null = null;
  private _status: SyncStatus = "stopped";
  private lastProcessedAt = 0;
  private consecutiveErrors = 0;
  readonly stats = { blocks: 0, logs: 0, events: 0, reorgs: 0, skippedBlocks: 0 };

  constructor(private opts: SyncOptions, private cb: SyncCallbacks) {
    this.chainId = opts.chainId;
  }

  // ---- registry -----------------------------------------------------------------

  /** Track a pool's trades; by default its traded token's transfers are followed too. */
  registerPool(pool: PoolRef, opts: { watchToken?: boolean } = {}): void {
    this.pools.set(pool.address, pool);
    if (opts.watchToken !== false) this.tokens.add(pool.token);
  }

  unregisterPool(address: Address): void {
    this.pools.delete(address);
  }

  setWatchedTokens(tokens: Iterable<Address>): void {
    this.tokens = new Set([...tokens].map((t) => t.toLowerCase()));
    for (const p of this.pools.values()) if (!priceRef(this.chainId, p.address)) this.tokens.add(p.token);
  }

  watchedTokens(): Address[] {
    return [...this.tokens];
  }

  registeredPools(): PoolRef[] {
    return [...this.pools.values()];
  }

  /**
   * Log sources: factories (incl. V4 PoolManagers, which also emit every V4
   * pool's swaps), price references, pool contracts and watched tokens. V4
   * pools are bytes32 ids, not addresses, so they never enter the filter.
   */
  private addresses(): Address[] {
    const info = chainInfo(this.chainId);
    const pools = [...this.pools.keys()].filter((k) => k.length === 42);
    return [...new Set<Address>([...info.factories.map((f) => f.address), ...pools, ...this.tokens])];
  }

  private poolOf(l: RawLog): PoolRef | undefined {
    return this.pools.get(poolKey(l, (a) => factoryInfo(this.chainId, a)));
  }

  // ---- lifecycle ----------------------------------------------------------------

  async start(): Promise<void> {
    this.running = true;
    this.setStatus("starting");
    // Live startup never waits on history (invariant 7): resume from the
    // persisted finalized cursor only when the gap is within the recovery window.
    this.head = Number(BigInt(await this.opts.rpc.request<string>("eth_blockNumber", [])));
    const resume = this.opts.resumeFrom ?? null;
    const maxGap = Math.max(this.opts.maxGapBlocks ?? 2_000, this.opts.rewindBlocks ?? 0);
    this.opts.maxGapBlocks = maxGap;
    if (this.opts.rewindBlocks) this.cursor = Math.min(resume ?? Infinity, this.head - this.opts.rewindBlocks);
    else this.cursor = resume !== null && resume < this.head && this.head - resume <= maxGap ? resume : this.head - 1;
    this.finalized = Math.max(this.finalized, resume ?? 0);
    for (const r of chainInfo(this.chainId).priceRefs) this.registerPool(priceRefPool(r), { watchToken: false });
    if (this.opts.wsUrls.length > 0) {
      this.heads = new HeadStream(this.opts.wsUrls, (n) => this.onHead(n), `heads:${this.chainId}`);
      this.heads.start();
    }
    // HTTP polling backs up the socket; with a healthy socket it is a cheap no-op check.
    this.pollTimer = setInterval(() => void this.poll(), Math.max(1_000, this.opts.blockTimeMs));
    this.kick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.heads?.stop();
    this.heads = null;
    await this.ticking;
    this.setStatus("stopped");
  }

  status(): { status: SyncStatus; head: number; cursor: number; lag: number; lastProcessedAt: number; pools: number; tokens: number; headStream: string; endpoints: ReturnType<RpcPool["endpointStatus"]> } {
    return {
      status: this._status,
      head: this.head,
      cursor: this.cursor,
      lag: Math.max(0, this.head - this.cursor),
      lastProcessedAt: this.lastProcessedAt,
      pools: this.pools.size,
      tokens: this.tokens.size,
      headStream: this.heads?.state ?? "disabled",
      endpoints: this.opts.rpc.endpointStatus(),
    };
  }

  private setStatus(status: SyncStatus, detail?: Record<string, unknown>): void {
    if (status === this._status && !detail) return;
    this._status = status;
    this.cb.onStatus?.(this.chainId, status, detail);
  }

  /** Resolves once the current sync loop (if any) has drained. */
  async idle(): Promise<void> {
    while (this.ticking) await this.ticking;
  }

  notifyHead(n: number): void {
    this.onHead(n);
  }

  private onHead(n: number): void {
    if (n > this.head) this.head = n;
    this.kick();
  }

  private async poll(): Promise<void> {
    if (!this.running) return;
    // Skip the HTTP check while the socket is delivering heads promptly.
    if (this.heads?.state === "live" && Date.now() - this.heads.lastHeadAt < this.opts.blockTimeMs * 3) return;
    try {
      this.onHead(Number(BigInt(await this.opts.rpc.request<string>("eth_blockNumber", []))));
    } catch (err) {
      log.warn("head poll failed", { chainId: this.chainId, err: String(err).slice(0, 200) });
    }
  }

  private kick(): void {
    if (!this.running) return;
    if (this.ticking) {
      this.dirty = true;
      return;
    }
    this.ticking = this.loop().finally(() => {
      this.ticking = null;
    });
  }

  private async loop(): Promise<void> {
    do {
      this.dirty = false;
      try {
        await this.syncToHead();
        this.consecutiveErrors = 0;
      } catch (err) {
        this.consecutiveErrors++;
        this.setStatus("degraded", { err: String(err).slice(0, 200) });
        log.warn("sync iteration failed — will retry", { chainId: this.chainId, attempt: this.consecutiveErrors, err: String(err).slice(0, 300) });
        await new Promise((r) => setTimeout(r, Math.min(30_000, 500 * 2 ** Math.min(this.consecutiveErrors, 6))));
        this.dirty = true;
      }
    } while (this.dirty && this.running);
  }

  // ---- sync ---------------------------------------------------------------------

  private async syncToHead(): Promise<void> {
    const maxGap = this.opts.maxGapBlocks ?? 2_000;
    if (this.head - this.cursor > maxGap) {
      const skipTo = this.head - maxGap;
      log.warn("sync gap exceeds recovery window — skipping ahead", { chainId: this.chainId, from: this.cursor + 1, to: skipTo, skipped: skipTo - this.cursor });
      this.stats.skippedBlocks += skipTo - this.cursor;
      this.cursor = skipTo;
      this.hashes.clear();
    }
    while (this.running && this.cursor < this.head) {
      const from = this.cursor + 1;
      const to = Math.min(this.head, from + Math.min(MAX_RANGE, this.opts.rpc.limits.maxLogRange) - 1);
      this.setStatus(this.head - this.cursor > 3 ? "catching_up" : "live");
      try {
        await this.syncRange(from, to);
      } catch (err) {
        if (err instanceof RangeRetry) {
          log.debug("range not yet consistent — retrying", { chainId: this.chainId, from, to, reason: err.message });
          await new Promise((r) => setTimeout(r, 300));
          continue;
        }
        // History the providers no longer serve cannot be recovered by retrying:
        // skip to recent blocks (best-effort recovery, invariant 8).
        if (UNSERVABLE.test(String(err))) {
          const skipTo = Math.max(this.cursor, this.head - 64);
          log.warn("providers no longer serve this range — skipping ahead", { chainId: this.chainId, from, to: skipTo, err: String(err).slice(0, 200) });
          this.stats.skippedBlocks += skipTo - this.cursor;
          this.cursor = skipTo;
          this.hashes.clear();
          if (skipTo >= from) continue;
        }
        throw err;
      }
    }
    if (this.running) this.setStatus("live");
  }

  private async headers(blocks: number[]): Promise<Array<Header | null>> {
    return (await this.opts.rpc.batch(blocks.map((n) => ({ method: "eth_getBlockByNumber", params: [hex(n), false] })))) as Array<Header | null>;
  }

  /**
   * Only boundary headers (reorg anchor + range end) and the headers of blocks
   * that actually carry logs are fetched: an idle 100-block catch-up costs two
   * header calls instead of a hundred.
   */
  private async syncRange(from: number, requestedTo: number): Promise<void> {
    let to = requestedTo;
    let [first, last] = await this.headers(from === to ? [from] : [from, to]);
    // Load-balanced nodes can lag the head we saw: fall back to one block, then wait.
    if (!first) throw new RangeRetry("head block not available yet");
    if (from !== to && !last) {
      to = from;
      last = first;
    }
    last ??= first;
    const parent = this.hashes.get(from - 1);
    if (parent !== undefined && first.parentHash !== parent) {
      await this.handleReorg(from);
      return;
    }
    const known = new Map<number, Header>([[from, first], [to, last]]);
    const hashOf = new Map<number, string>();
    const timeOf = new Map<number, number>();
    const index = () => {
      for (const [n, h] of known) {
        hashOf.set(n, h.hash);
        timeOf.set(n, Number(BigInt(h.timestamp)));
      }
    };
    const verify = async (logs: RawLog[], hashes: Map<RawLog, string>) => {
      const missing = [...new Set(logs.map((l) => l.blockNumber))].filter((n) => !known.has(n));
      if (missing.length > 0) {
        const fetched = await this.headers(missing);
        fetched.forEach((h, i) => {
          if (!h) throw new RangeRetry(`header ${missing[i]} unavailable`);
          known.set(missing[i]!, h);
        });
      }
      index();
      // A log whose block hash differs from the header means the chain moved
      // between calls: refetch the range rather than ingest a half-reorged view.
      for (const l of logs) if (hashOf.get(l.blockNumber) !== hashes.get(l)) throw new RangeRetry(`log block hash mismatch at ${l.blockNumber}`);
    };
    index();

    const fetched = await this.fetchLogs(this.addresses(), from, to);
    await verify(fetched.logs, fetched.hashes);
    const logs = fetched.logs;
    const events: ChainEvent[] = [];
    const created = await this.decodeAll(logs, timeOf, events);

    // Launch capture: pools created in this range may already have trades and
    // token transfers in the same blocks. Fetch them before emitting.
    if (created.length > 0) {
      const followUp = new Set<Address>();
      for (const c of created) {
        // V4 pools live in the PoolManager, whose logs are already in this range.
        if (c.dex !== "v4") followUp.add(c.pool);
        const ref = this.pools.get(c.pool);
        if (ref) followUp.add(ref.token);
      }
      const extra = await this.fetchLogs([...followUp], Math.min(...created.map((c) => c.blockNumber)), to);
      await verify(extra.logs, extra.hashes);
      const seen = new Set(logs.map((l) => `${l.transactionHash}:${l.logIndex}`));
      await this.decodeAll(extra.logs.filter((l) => !seen.has(`${l.transactionHash}:${l.logIndex}`)), timeOf, events);
    }

    events.sort(compareEvents);
    if (events.length > 0) await this.cb.onEvents(this.chainId, events);

    for (const [n, h] of hashOf) this.hashes.set(n, h);
    for (const n of this.hashes.keys()) if (n < to - HASH_MEMORY) this.hashes.delete(n);
    this.cursor = to;
    this.lastProcessedAt = Date.now();
    this.stats.blocks += to - from + 1;
    this.stats.logs += logs.length;
    this.stats.events += events.length;

    const finalized = to - this.opts.finalityDepth;
    if (finalized > this.finalized) {
      this.finalized = finalized;
      this.cb.onFinalized(this.chainId, finalized);
    }
  }

  private async fetchLogs(addresses: Address[], from: number, to: number): Promise<{ logs: RawLog[]; hashes: Map<RawLog, string> }> {
    const calls = [];
    for (let i = 0; i < addresses.length; i += ADDRESS_CHUNK) {
      calls.push({ method: "eth_getLogs", params: [{ fromBlock: hex(from), toBlock: hex(to), address: addresses.slice(i, i + ADDRESS_CHUNK), topics: [ALL_TOPICS] }] });
    }
    const results = (await this.opts.rpc.batch(calls)) as RpcLog[][];
    const out: RawLog[] = [];
    const hashes = new Map<RawLog, string>();
    for (const l of results.flat()) {
      if (l.removed) continue;
      const block = Number(BigInt(l.blockNumber));
      const raw: RawLog = {
        address: l.address.toLowerCase(),
        topics: l.topics,
        data: l.data,
        blockNumber: block,
        transactionIndex: Number(BigInt(l.transactionIndex)),
        logIndex: Number(BigInt(l.logIndex)),
        transactionHash: l.transactionHash,
      };
      out.push(raw);
      hashes.set(raw, l.blockHash);
    }
    return { logs: out, hashes };
  }

  /** Decodes logs (registering newly created pools as it goes); returns pools created. */
  private async decodeAll(logs: RawLog[], timeOf: Map<number, number>, out: ChainEvent[]): Promise<PoolCreatedEvent[]> {
    logs.sort((a, b) => a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex);
    const created: PoolCreatedEvent[] = [];
    // Factory events first so pools created in this batch are known before signer lookup.
    for (const l of logs) {
      if (!isPoolCreation(l)) continue;
      const evt = decodeLog(l, this.context(l.blockNumber, timeOf, new Map()));
      if (evt?.kind !== "pool_created") continue;
      out.push(evt);
      const orient = this.opts.autoRegisterPools === false ? null : orientPair(this.chainId, evt.token0, evt.token1);
      if (orient && !this.pools.has(evt.pool)) {
        const ref: PoolRef = { address: evt.pool, dex: evt.dex, token0: evt.token0, token1: evt.token1, ...orient };
        this.registerPool(ref);
        this.cb.onPoolRegistered?.(this.chainId, ref, evt);
        created.push(evt);
      }
    }
    const txs = await this.signers(logs.filter((l) => this.poolOf(l) !== undefined).map((l) => l.transactionHash));
    for (const l of logs) {
      if (isPoolCreation(l)) continue;
      const evt = decodeLog(l, this.context(l.blockNumber, timeOf, txs));
      if (evt) out.push(evt);
    }
    return created;
  }

  private context(block: number, timeOf: Map<number, number>, txs: Map<string, TxInfo>) {
    return {
      chainId: this.chainId,
      timestamp: timeOf.get(block) ?? Math.floor(Date.now() / 1000),
      pool: (a: Address) => this.pools.get(a),
      factory: (a: Address) => factoryInfo(this.chainId, a),
      isWatchedToken: (a: Address) => this.tokens.has(a),
      tx: (h: string) => txs.get(h),
    };
  }

  private async signers(hashes: string[]): Promise<Map<string, TxInfo>> {
    const unique = [...new Set(hashes.map((h) => h.toLowerCase()))];
    const out = new Map<string, TxInfo>();
    if (unique.length === 0) return out;
    const txs = (await this.opts.rpc.batch(unique.map((h) => ({ method: "eth_getTransactionByHash", params: [h] })))) as Array<{ from: string; nonce: string } | null>;
    txs.forEach((tx, i) => {
      if (tx) out.set(unique[i]!, { from: tx.from.toLowerCase(), nonce: Number(BigInt(tx.nonce)) });
    });
    return out;
  }

  private async handleReorg(from: number): Promise<void> {
    this.stats.reorgs++;
    // Hashes are sparse (range ends and log-bearing blocks); walk the ones we
    // hold, newest first, until one is still canonical.
    const candidates = [...this.hashes.keys()].filter((n) => n < from).sort((a, b) => b - a).slice(0, MAX_REORG_WALK);
    let fork = candidates.at(-1) ?? from - 1;
    let matched = false;
    if (candidates.length > 0) {
      const headers = await this.headers(candidates);
      const hit = candidates.findIndex((n, i) => headers[i]?.hash === this.hashes.get(n));
      if (hit >= 0) {
        fork = candidates[hit]!;
        matched = true;
      }
    }
    if (!matched) log.error("reorg deeper than tracked history — rewinding to oldest known block", { chainId: this.chainId, from, fork });
    log.warn("reorg detected", { chainId: this.chainId, detectedAt: from, forkPoint: fork, depth: from - 1 - fork });
    await this.cb.onReorg(this.chainId, fork + 1);
    for (const n of this.hashes.keys()) if (n > fork) this.hashes.delete(n);
    this.cursor = fork;
  }
}
