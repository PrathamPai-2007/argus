import { describe, expect, test } from "bun:test";
import { parseAbiItem } from "viem";
import type { ChainConfig } from "../src/config.ts";
import { EvmAdapter, type AdapterCallbacks } from "../src/ingest/evm.ts";
import type { FundingEvent, StandardEvent } from "../src/types.ts";
import type { PublicClient } from "viem";

// Regression: the swap loop used to live inside the `shouldRun("lp")` gate, so
// backfillRange resumed from phase "swap" (lp already done) skipped swap data.
// Resuming at phase "swap" must still request Swap logs for known pools.

const TOKEN = "0x" + "aa".repeat(20);
const POOL = "0x" + "dd".repeat(20);
const TOKEN0 = TOKEN;
const TOKEN1 = "0x" + "ee".repeat(20);

function makeConfig(): ChainConfig {
  return {
    chainId: 1,
    name: "test",
    enabled: true,
    rpcs: ["https://example.test"],
    finalityDepth: 64,
    staleAfterMs: 30_000,
    backfill: {
      etherscan: { enabled: false, apiUrl: "", apiKey: null, requestsPerSecond: 3 },
      bigquery: { enabled: false, projectId: null, credentialsPath: null, dataset: "x", maxBytesBilled: null },
      bigqueryThresholdHours: 1,
    },
  };
}

function callbacks(overrides: Partial<AdapterCallbacks> = {}): AdapterCallbacks {
  return {
    onEvents: async () => {},
    onFinalized: () => {},
    onReorg: async () => {},
    onHead: () => {},
    onStatus: () => {},
    ...overrides,
  };
}

describe("EvmAdapter backfill phase resume", () => {
  test("startup drains a head received before live transition", async () => {
    const adapter = new EvmAdapter(makeConfig(), callbacks());
    const a = adapter as unknown as {
      client: PublicClient;
      connect: () => Promise<void>;
      subscribe: () => Promise<void>;
      startHeartbeat: () => void;
      startWatchdog: () => void;
      backfillRange: (from: bigint, to: bigint) => Promise<number>;
    };
    let range: [bigint, bigint] | null = null;
    a.client = { getBlockNumber: async () => 100n } as unknown as PublicClient;
    a.connect = async () => {};
    a.startHeartbeat = () => {};
    a.startWatchdog = () => {};
    a.subscribe = async () => {
      await (adapter as unknown as { onNewHead: (block: unknown) => Promise<void> }).onNewHead({ number: 101n, hash: "0x11", parentHash: "0x10", timestamp: 1n });
    };
    a.backfillRange = async (from, to) => { range = [from, to]; return Number(to); };
    await adapter.start(null);
    expect(range as [bigint, bigint] | null).toEqual([101n, 101n]);
  });

  test("contiguous parent mismatch invokes reorg handling", async () => {
    const adapter = new EvmAdapter(makeConfig(), callbacks());
    const a = adapter as unknown as {
      running: boolean;
      _status: string;
      recentHeads: Array<{ number: number; hash: string; parentHash: string }>;
      handleReorg: (block: unknown) => Promise<void>;
    };
    a.running = true;
    a._status = "live";
    a.recentHeads = [{ number: 100, hash: "0xcanonical", parentHash: "0xold" }];
    let called = false;
    a.handleReorg = async () => { called = true; };
    await (adapter as unknown as { onNewHead: (block: unknown) => Promise<void> }).onNewHead({ number: 101n, hash: "0xnew", parentHash: "0xfork", timestamp: 1n });
    expect(called).toBe(true);
  });

  test("resuming from phase 'swap' ingests swap logs even though lp is done", async () => {
    const requested: string[] = [];
    const fakeClient = {
      getLogs: async (args: { event?: { name?: string } }) => {
        requested.push(args.event?.name ?? "?");
        return [];
      },
      getBlock: async () => ({ hash: "0x" + "11".repeat(32), parentHash: "0x" + "22".repeat(32), number: 1000n, timestamp: 1_700_000_000n, transactions: [] }),
    } as unknown as PublicClient;

    const adapter = new EvmAdapter(
      makeConfig(),
      callbacks({
        getBackfillProgress: () => ({ phase: "swap", nextBlock: 1010, fromBlock: 1000, toBlock: 1129, provider: "rpc" }),
      }),
    );
    (adapter as unknown as { client: PublicClient }).client = fakeClient;
    adapter.setWatchedTokens([TOKEN]);
    adapter.registerPool(POOL, TOKEN0, TOKEN1);

    await adapter.backfillRange(1000n, 1129n, "swap", 1000);

    expect(requested).toContain("Swap");
    expect(requested).not.toContain("Transfer");
    expect(requested).not.toContain("PairCreated");
  });

  test("buffered native funding is emitted retroactively when an address becomes relevant", () => {
    const events: StandardEvent[] = [];
    const adapter = new EvmAdapter(makeConfig(), callbacks({
      onEvents: async (_chainId, evts) => {
        events.push(...evts);
      },
    }));
    const funder = "0x" + "f1".repeat(20);
    const funded = "0x" + "f2".repeat(20);
    const funding: FundingEvent = {
      kind: "funding", chainId: 1, blockNumber: 100, logIndex: 10_000_000, txHash: "0x" + "33".repeat(32),
      funder, funded, amount: 5n, method: "native_transfer", timestamp: 1_700_000_000,
    };
    (adapter as unknown as { bufferFunding: (entries: FundingEvent[]) => void }).bufferFunding([funding]);
    expect(events).toHaveLength(0); // nothing relevant yet — parked, not dropped

    adapter.addRelevantAddresses([funded]);
    expect(events).toHaveLength(1);
    const emitted = events[0] as FundingEvent;
    expect(emitted.kind).toBe("funding");
    expect(emitted.funded).toBe(funded.toLowerCase());

    // the same edge must never re-emit when the other side later becomes relevant
    adapter.addRelevantAddresses([funder]);
    expect(events).toHaveLength(1);
  });

  test("unwraps single pool address from array format when querying getLogs", async () => {
    const requestedAddresses: (string | string[])[] = [];
    const fakeClient = {
      getLogs: async (args: { address?: string | string[] }) => {
        if (args.address) requestedAddresses.push(args.address);
        return [];
      },
      getBlock: async () => ({ hash: "0x" + "11".repeat(32), parentHash: "0x" + "22".repeat(32), number: 1000n, timestamp: 1_700_000_000n, transactions: [] }),
    } as unknown as PublicClient;

    const adapter = new EvmAdapter(
      makeConfig(),
      callbacks({
        getBackfillProgress: () => ({ phase: "lp", nextBlock: 1000, fromBlock: 1000, toBlock: 1001, provider: "rpc" }),
      }),
    );
    (adapter as unknown as { client: PublicClient }).client = fakeClient;
    adapter.setWatchedTokens([TOKEN]);
    adapter.registerPool(POOL, TOKEN0, TOKEN1);

    await adapter.backfillRange(1000n, 1001n, "lp", 1000);

    // Verify address was requested as a single string, not an array [POOL]
    expect(requestedAddresses.length).toBeGreaterThan(0);
    const lpReq = requestedAddresses.find((a) => (typeof a === "string" ? a.toLowerCase() === POOL.toLowerCase() : false));
    expect(lpReq).toBeDefined();
    expect(typeof lpReq).toBe("string");
  });

  test("Infura transient eth_getLogs errors are treated as throttle-like, not fatal", () => {
    const adapter = new EvmAdapter(makeConfig(), callbacks());
    const isThrottleError = (adapter as unknown as { isThrottleError: (e: unknown) => boolean }).isThrottleError;
    expect(isThrottleError(new Error("InvalidInputRpcError: Missing or invalid parameters.\n\nDetails: internal error"))).toBe(true);
    expect(isThrottleError(new Error("service temporarily unavailable"))).toBe(true);
    expect(isThrottleError(new Error("rate limit reached (3/sec)"))).toBe(true);
    expect(isThrottleError(new Error("some unrelated failure"))).toBe(false);
  });

  test("getLogsAdaptive fails over to the next endpoint on transient 'internal error'", async () => {
    const event = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
    const cfg = makeConfig();
    cfg.rpcs = ["https://rpc-a.test", "https://rpc-b.test"];
    const flaky = {
      getLogs: async () => {
        throw new Error("InvalidInputRpcError: Missing or invalid parameters.\n\nDetails: internal error");
      },
      getBlockNumber: async () => 1000n,
    } as unknown as PublicClient;
    const healthy = {
      getLogs: async () => [],
      getBlockNumber: async () => 1000n,
    } as unknown as PublicClient;

    const adapter = new EvmAdapter(cfg, callbacks());
    (adapter as unknown as { client: PublicClient }).client = flaky;
    (adapter as unknown as { buildClient: (url: string) => PublicClient }).buildClient = () => healthy;

    const logs = await (adapter as unknown as {
      getLogsAdaptive: (addrs: string | string[], e: unknown, from: bigint, to: bigint, allowFailover?: boolean) => Promise<unknown[]>;
    }).getLogsAdaptive([POOL], event, 1000n, 1001n);

    expect(logs).toEqual([]);
  });

  test("pool LP backfill failure is best-effort — backfill completes instead of aborting", async () => {
    const progress: string[] = [];
    const fakeClient = {
      getLogs: async () => {
        throw new Error("InvalidInputRpcError: Missing or invalid parameters.\n\nDetails: internal error");
      },
      getBlock: async () => ({ hash: "0x" + "11".repeat(32), parentHash: "0x" + "22".repeat(32), number: 1001n, timestamp: 1_700_000_000n, transactions: [] }),
    } as unknown as PublicClient;

    const adapter = new EvmAdapter(
      makeConfig(),
      callbacks({
        onBackfillProgress: (_chainId, p) => {
          progress.push(p.phase);
        },
        getBackfillProgress: () => ({ phase: "lp", nextBlock: 1000, fromBlock: 1000, toBlock: 1001, provider: "rpc" }),
      }),
    );
    (adapter as unknown as { client: PublicClient }).client = fakeClient;
    adapter.registerPool(POOL, TOKEN0, TOKEN1);

    await adapter.backfillRange(1000n, 1001n, "lp", 1000);

    expect(progress.at(-1)).toBe("complete");
  });

  test("tokens-phase backfill failure still throws (critical data stays fatal)", async () => {
    const fakeClient = {
      getLogs: async () => {
        throw new Error("boom");
      },
      getBlock: async () => ({ hash: "0x" + "11".repeat(32), parentHash: "0x" + "22".repeat(32), number: 1001n, timestamp: 1_700_000_000n, transactions: [] }),
    } as unknown as PublicClient;

    const adapter = new EvmAdapter(makeConfig(), callbacks());
    (adapter as unknown as { client: PublicClient }).client = fakeClient;
    adapter.setWatchedTokens([TOKEN]);

    await expect(adapter.backfillRange(1000n, 1001n)).rejects.toThrow("boom");
  });
});
