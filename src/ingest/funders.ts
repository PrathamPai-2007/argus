import { log } from "../logger.ts";
import type { Address } from "../model.ts";
import type { RpcPool } from "./rpc.ts";

// First-funder lookup: who sent a wallet its first native funds. Funding is a
// permanent fact, so each wallet is resolved once and cached by the caller.
// ETH uses Etherscan V2 (free tier: 3 req/s). Base needs Blockscout's PRO API
// (free key): Etherscan's Base coverage is paid-only and the keyless Blockscout
// endpoints sit behind a Cloudflare challenge. Without a key, Base clustering
// degrades and metrics report the reduced funder coverage.

export interface FunderResult {
  wallet: Address;
  funder: Address | null;
  fundedBlock: number | null;
  /** Funder looks like an exchange/bridge/hot wallet (high nonce), so it is not evidence of common control. */
  funderIsService: boolean;
}

export interface ExplorerConfig {
  /** Etherscan-compatible base URL. */
  apiUrl: string;
  apiKey: string | null;
  /** Multichain parameter (Etherscan V2: chainid, Blockscout PRO: chain_id). */
  chainParam: { name: string; value: number } | null;
  requestsPerSecond: number;
}

export function defaultExplorer(chainId: number, keys: { etherscan?: string | null; blockscout?: string | null }): ExplorerConfig | null {
  if (chainId === 1 && keys.etherscan) return { apiUrl: "https://api.etherscan.io/v2/api", apiKey: keys.etherscan, chainParam: { name: "chainid", value: 1 }, requestsPerSecond: 3 };
  if (keys.blockscout) return { apiUrl: "https://api.blockscout.com/v2/api", apiKey: keys.blockscout, chainParam: { name: "chain_id", value: chainId }, requestsPerSecond: 4 };
  return null;
}

/** A funder that has sent this many transactions is a service, not a person. */
const SERVICE_NONCE = 1_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ExplorerTx {
  blockNumber: string;
  from: string;
  to: string;
  value: string;
  isError?: string;
}

export class FunderResolver {
  private queue: Array<{ wallet: Address; priority: number }> = [];
  private queued = new Set<Address>();
  private running = false;
  private stopped = false;
  private lastRequestAt = 0;
  private serviceCache = new Map<Address, boolean>();
  readonly stats = { resolved: 0, failed: 0, requests: 0 };

  constructor(
    private chainId: number,
    private explorer: ExplorerConfig,
    private rpc: Pick<RpcPool, "batch">,
    private onResult: (r: FunderResult) => void,
    private knownServices: (a: Address) => boolean = () => false,
  ) {}

  get pending(): number {
    return this.queue.length;
  }

  /** Lower priority number = sooner. Re-enqueueing an address can only raise its priority. */
  enqueue(wallet: Address, priority = 5): void {
    const w = wallet.toLowerCase();
    if (this.queued.has(w)) {
      const item = this.queue.find((q) => q.wallet === w);
      if (item && priority < item.priority) item.priority = priority;
      return;
    }
    this.queued.add(w);
    this.queue.push({ wallet: w, priority });
    void this.drain();
  }

  stop(): void {
    this.stopped = true;
  }

  private async drain(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      while (this.queue.length > 0 && !this.stopped) {
        this.queue.sort((a, b) => a.priority - b.priority);
        const batch = this.queue.splice(0, 8);
        const results: FunderResult[] = [];
        for (const { wallet } of batch) {
          try {
            results.push(await this.lookup(wallet));
          } catch (err) {
            this.stats.failed++;
            log.debug("funder lookup failed", { chainId: this.chainId, wallet, err: String(err).slice(0, 200) });
          } finally {
            this.queued.delete(wallet);
          }
        }
        await this.classify(results);
        for (const r of results) {
          this.stats.resolved++;
          this.onResult(r);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async call(params: Record<string, string>): Promise<ExplorerTx[]> {
    const gap = 1000 / this.explorer.requestsPerSecond - (Date.now() - this.lastRequestAt);
    if (gap > 0) await sleep(gap);
    this.lastRequestAt = Date.now();
    this.stats.requests++;
    const url = new URL(this.explorer.apiUrl);
    if (this.explorer.chainParam !== null) url.searchParams.set(this.explorer.chainParam.name, String(this.explorer.chainParam.value));
    if (this.explorer.apiKey) url.searchParams.set("apikey", this.explorer.apiKey);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (res.status === 429) {
      await sleep(2_000);
      throw new Error("explorer rate limited");
    }
    const body = (await res.json()) as { status?: string; message?: string; result?: unknown };
    if (Array.isArray(body.result)) return body.result as ExplorerTx[];
    // "No transactions found" is a valid empty answer.
    if (body.message && /no (transactions|records)/i.test(body.message)) return [];
    throw new Error(`explorer: ${body.message ?? "unexpected response"} ${typeof body.result === "string" ? body.result : ""}`);
  }

  private async lookup(wallet: Address): Promise<FunderResult> {
    const q = { module: "account", address: wallet, sort: "asc", page: "1", offset: "10", startblock: "0" };
    const [normal, internal] = [await this.call({ ...q, action: "txlist" }), await this.call({ ...q, action: "txlistinternal" })];
    let best: { funder: Address; block: number } | null = null;
    for (const tx of [...normal, ...internal]) {
      if (tx.isError === "1" || tx.to?.toLowerCase() !== wallet || BigInt(tx.value || "0") === 0n) continue;
      const block = Number(tx.blockNumber);
      if (!best || block < best.block) best = { funder: tx.from.toLowerCase(), block };
    }
    return { wallet, funder: best?.funder ?? null, fundedBlock: best?.block ?? null, funderIsService: false };
  }

  /** Mark funders with service-like nonces (one batched RPC call per drain batch). */
  private async classify(results: FunderResult[]): Promise<void> {
    const unknown = [...new Set(results.map((r) => r.funder).filter((f): f is Address => f !== null && !this.serviceCache.has(f) && !this.knownServices(f)))];
    if (unknown.length > 0) {
      try {
        const nonces = (await this.rpc.batch(unknown.map((a) => ({ method: "eth_getTransactionCount", params: [a, "latest"] })))) as string[];
        unknown.forEach((a, i) => this.serviceCache.set(a, Number(BigInt(nonces[i] ?? "0x0")) >= SERVICE_NONCE));
      } catch (err) {
        log.debug("funder nonce classification failed", { chainId: this.chainId, err: String(err).slice(0, 200) });
      }
    }
    for (const r of results) {
      if (r.funder) r.funderIsService = this.knownServices(r.funder) || (this.serviceCache.get(r.funder) ?? false);
    }
  }
}

