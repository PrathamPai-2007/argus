import { describe, expect, test } from "bun:test";
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Hex } from "viem";
import { CHAINS } from "../src/chains.ts";
import { ChainSync, type SyncRpc } from "../src/ingest/sync.ts";
import type { ChainEvent } from "../src/model.ts";

const ABI = parseAbi([
  "event PairCreated(address indexed token0, address indexed token1, address pair, uint256 n)",
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
]);
const V2_FACTORY = CHAINS[1]!.factories[0]!.address;
const WETH = CHAINS[1]!.wrappedNative as Hex;
const MEME = `0x${"11".repeat(20)}` as const; // sorts below WETH → token0
const PAIR = `0x${"ab".repeat(20)}` as const;
const SNIPER = `0x${"5a".repeat(20)}`;
const ROUTER = `0x${"7e".repeat(20)}` as const;

interface FakeLog { address: string; topics: Hex[]; data: Hex; txHash: string; logIndex: number }
interface FakeBlock { number: number; hash: string; parentHash: string; logs: FakeLog[] }

/** Minimal chain that answers the four calls ChainSync makes. */
class FakeChain implements SyncRpc {
  blocks: FakeBlock[] = [];
  txs = new Map<string, { from: string; nonce: string }>();
  limits = { maxBatch: 100, maxLogRange: 100, rps: 100 };
  constructor(n: number) {
    for (let i = 0; i <= n; i++) this.push([]);
  }
  push(logs: FakeLog[], salt = "a"): FakeBlock {
    const number = this.blocks.length;
    const b = { number, hash: `0x${salt}${number.toString(16).padStart(63, "0")}`, parentHash: this.blocks[number - 1]?.hash ?? "0x0", logs };
    this.blocks.push(b);
    return b;
  }
  /** Replace blocks >= n with a fork. */
  fork(n: number, salt: string): void {
    const tail = this.blocks.splice(n);
    for (const b of tail) this.push(b.logs, salt);
  }
  endpointStatus() { return []; }
  async request<T>(method: string, params: unknown[]): Promise<T> {
    return (await this.batch([{ method, params }]))[0] as T;
  }
  async batch(calls: Array<{ method: string; params: unknown[] }>): Promise<unknown[]> {
    return calls.map(({ method, params }) => {
      if (method === "eth_blockNumber") return "0x" + (this.blocks.length - 1).toString(16);
      if (method === "eth_getBlockByNumber") {
        const b = this.blocks[Number(BigInt(params[0] as string))];
        return b ? { number: "0x" + b.number.toString(16), hash: b.hash, parentHash: b.parentHash, timestamp: "0x" + (1_700_000_000 + b.number * 12).toString(16) } : null;
      }
      if (method === "eth_getTransactionByHash") return this.txs.get(params[0] as string) ?? null;
      if (method === "eth_getLogs") {
        const f = params[0] as { fromBlock: string; toBlock: string; address: string[] };
        const out = [];
        for (let n = Number(BigInt(f.fromBlock)); n <= Number(BigInt(f.toBlock)); n++) {
          const b = this.blocks[n];
          for (const l of b?.logs ?? []) {
            if (!f.address.includes(l.address)) continue;
            out.push({ address: l.address, topics: l.topics, data: l.data, blockNumber: "0x" + n.toString(16), blockHash: b!.hash, transactionIndex: "0x0", logIndex: "0x" + l.logIndex.toString(16), transactionHash: l.txHash });
          }
        }
        return out;
      }
      throw new Error(`unexpected ${method}`);
    });
  }
}

function harness(chain: FakeChain) {
  const events: ChainEvent[] = [];
  const reorgs: number[] = [];
  const finalized: number[] = [];
  const sync = new ChainSync({ chainId: 1, rpc: chain, wsUrls: [], finalityDepth: 2, blockTimeMs: 3_600_000 }, {
    onEvents: async (_c, evts) => { events.push(...evts); },
    onReorg: async (_c, from) => { reorgs.push(from); events.splice(0, events.length, ...events.filter((e) => e.blockNumber < from)); },
    onFinalized: (_c, n) => { finalized.push(n); },
  });
  return { sync, events, reorgs, finalized };
}

const tx = (i: number) => `0x${i.toString(16).padStart(64, "0")}`;

describe("ChainSync", () => {
  test("starts at the head, follows new blocks and reports finality", async () => {
    const chain = new FakeChain(10);
    const { sync, finalized } = harness(chain);
    await sync.start();
    await sync.idle();
    expect(sync.status().cursor).toBe(10);
    chain.push([]); chain.push([]); chain.push([]);
    sync.notifyHead(13);
    await sync.idle();
    expect(sync.status().cursor).toBe(13);
    expect(finalized.at(-1)).toBe(11);
    await sync.stop();
  });

  test("captures a launch: pool created and sniped in the same block", async () => {
    const chain = new FakeChain(5);
    const { sync, events } = harness(chain);
    await sync.start();
    await sync.idle();
    chain.txs.set(tx(2), { from: SNIPER, nonce: "0x0" });
    chain.push([
      { address: V2_FACTORY, txHash: tx(1), logIndex: 0, topics: encodeEventTopics({ abi: ABI, eventName: "PairCreated", args: { token0: MEME, token1: WETH } }) as Hex[], data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [PAIR, 1n]) },
      // sniper buys MEME (token0) with 1 WETH (token1)
      { address: PAIR, txHash: tx(2), logIndex: 1, topics: encodeEventTopics({ abi: ABI, eventName: "Swap", args: { sender: ROUTER, to: ROUTER } }) as Hex[], data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [0n, 10n ** 18n, 5_000n, 0n]) },
    ]);
    sync.notifyHead(6);
    await sync.idle();
    const swap = events.find((e) => e.kind === "swap");
    expect(events.map((e) => e.kind)).toEqual(["pool_created", "swap"]);
    expect(swap).toMatchObject({ side: "buy", token: MEME, quote: WETH.toLowerCase(), tokenAmount: 5_000n, quoteAmount: 10n ** 18n, trader: SNIPER, traderNonce: 0 });
    expect(sync.registeredPools().some((p) => p.address === PAIR)).toBe(true);
    await sync.stop();
  });

  test("detects a reorg via parent hash, rewinds, and re-ingests the canonical fork", async () => {
    const chain = new FakeChain(5);
    const { sync, reorgs } = harness(chain);
    await sync.start();
    await sync.idle();
    chain.push([]); chain.push([]);
    sync.notifyHead(7);
    await sync.idle();
    chain.fork(6, "b"); // replace 6..7
    chain.push([], "b");
    sync.notifyHead(8);
    await sync.idle();
    expect(reorgs).toEqual([6]);
    expect(sync.status().cursor).toBe(8);
    await sync.stop();
  });

  test("ignores factory pools whose pair has no known quote", async () => {
    const chain = new FakeChain(3);
    const { sync } = harness(chain);
    await sync.start();
    await sync.idle();
    chain.push([{ address: V2_FACTORY, txHash: tx(9), logIndex: 0, topics: encodeEventTopics({ abi: ABI, eventName: "PairCreated", args: { token0: MEME, token1: ROUTER } }) as Hex[], data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [PAIR, 1n]) }]);
    sync.notifyHead(4);
    await sync.idle();
    expect(sync.registeredPools().some((p) => p.address === PAIR)).toBe(false);
    await sync.stop();
  });
});
