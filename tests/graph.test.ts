import { describe, expect, test } from "bun:test";
import { GraphEngine, DEFAULT_GRAPH_TUNING } from "../src/graph/engine.ts";
import type { Address, FundingEvent, StandardTransferEvent } from "../src/types.ts";
import { ZERO_ADDRESS } from "../src/types.ts";

const TOKEN = "0x" + "aa".repeat(20) as Address;
const FUNDER = "0x" + "f1".repeat(20) as Address;
const CEX = "0x" + "ce".repeat(20) as Address;

let block = 100;
let ts = 1_700_000_000;

function funding(funder: Address, funded: Address, amount: bigint, opts?: { block?: number; ts?: number; method?: FundingEvent["method"] }): FundingEvent {
  return {
    kind: "funding",
    chainId: 1,
    funder,
    funded,
    amount,
    method: opts?.method ?? "native_transfer",
    txHash: "0x" + "00".repeat(32),
    blockNumber: opts?.block ?? ++block,
    logIndex: 10_000_001,
    timestamp: opts?.ts ?? (ts += 12),
  };
}

function transfer(from: Address, to: Address, amount: bigint, opts?: { block?: number; ts?: number; token?: Address }): StandardTransferEvent {
  return {
    kind: "transfer",
    chainId: 1,
    tokenAddress: opts?.token ?? TOKEN,
    sender: from,
    receiver: to,
    amount,
    txHash: "0x" + "00".repeat(32),
    blockNumber: opts?.block ?? ++block,
    logIndex: 1,
    timestamp: opts?.ts ?? (ts += 12),
  };
}

function addr(tag: string): Address {
  return ("0x" + tag.padEnd(40, "0").slice(0, 40)) as Address;
}

describe("GraphEngine", () => {
  test("common gas funder joins wallets into one cluster", () => {
    const g = new GraphEngine();
    g.applyEvent(funding(FUNDER, addr("a1"), 5n * 10n ** 16n));
    g.applyEvent(funding(FUNDER, addr("a2"), 5n * 10n ** 16n));
    const cluster = g.clusterOf(addr("a1"));
    expect(cluster.length).toBeGreaterThanOrEqual(3); // a1, a2, funder
    expect(new Set(cluster)).toEqual(new Set([addr("a1"), addr("a2"), FUNDER]));
  });

  test("CEX-funded wallets are NOT hard-merged", () => {
    const g = new GraphEngine();
    g.setLabels(new Map([[CEX, { label: "Binance", kind: "cex" }]]));
    g.applyEvent(funding(CEX, addr("b1"), 10n ** 17n));
    g.applyEvent(funding(CEX, addr("b2"), 10n ** 17n));
    expect(g.clusterOf(addr("b1"))).toEqual([]);
    expect(g.clusterOf(addr("b2"))).toEqual([]);
    // but the weak edge is tracked for R8
    const f = g.exchangeFundingOf(addr("b1"));
    expect(f?.funder).toBe(CEX);
    expect(f?.amount).toBe(10n ** 17n);
  });

  test("identical-amount fingerprint unions wallets across different funders", () => {
    const g = new GraphEngine(DEFAULT_GRAPH_TUNING);
    const amt = 7n * 10n ** 16n;
    const t0 = ts + 100;
    g.applyEvent(funding(addr("fa"), addr("c1"), amt, { ts: t0 }));
    g.applyEvent(funding(addr("fb"), addr("c2"), amt, { ts: t0 + 60 }));
    const effects = g.applyEvent(funding(addr("fc"), addr("c3"), amt, { ts: t0 + 120 }));
    const effect = effects.find((e) => e.type === "identical_amount");
    expect(effect).toBeDefined();
    // c1, c2, c3 unioned (funders too, via common-funder rule... at least the funded wallets)
    const members = new Set(g.clusterOf(addr("c1")));
    expect(members.has(addr("c2"))).toBe(true);
    expect(members.has(addr("c3"))).toBe(true);
  });

  test("token fan-out unions receivers and emits effect", () => {
    const g = new GraphEngine({ ...DEFAULT_GRAPH_TUNING, fanoutMinRecipients: 3, fanoutWindowSecs: 900 });
    const sender = addr("d0");
    const mk = addr("mk");
    g.applyEvent(transfer(ZERO_ADDRESS, mk, 1_000_000n)); // mint to mk
    let effectFound = false;
    const t0 = ts + 100;
    for (let i = 1; i <= 3; i++) {
      const effects = g.applyEvent(transfer(sender, addr(`d${i}`), 55n, { ts: t0 + i * 10 }));
      if (effects.some((e) => e.type === "fanout")) effectFound = true;
    }
    // sender needs tokens for this to be realistic, but the fan-out heuristic tracks sends regardless
    expect(effectFound).toBe(true);
    expect(new Set(g.clusterOf(addr("d1")))).toEqual(new Set([addr("d1"), addr("d2"), addr("d3")]));
  });

  test("balance ledger + cluster breakdown + supply pct", () => {
    const g = new GraphEngine();
    g.setTotalSupply(TOKEN, 1_000_000n);
    g.applyEvent(funding(FUNDER, addr("e1"), 10n ** 16n));
    g.applyEvent(funding(FUNDER, addr("e2"), 10n ** 16n));
    g.applyEvent(transfer(ZERO_ADDRESS, addr("deployer"), 1_000_000n));
    g.applyEvent(transfer(addr("deployer"), addr("e1"), 150_000n));
    g.applyEvent(transfer(addr("deployer"), addr("e2"), 50_000n));
    expect(g.balanceOf(TOKEN, addr("e1"))).toBe(150_000n);
    const breakdown = g.clusterBreakdown(TOKEN);
    const top = breakdown.find((c) => c.memberCount > 1);
    expect(top).toBeDefined();
    // cluster = {e1, e2, funder} holds 200k of 1M = 20%
    expect(top?.pctOfSupply).toBeCloseTo(20, 1);
    expect(top?.members).toContain(addr("e1"));
    expect(top?.members).toContain(addr("e2"));
  });

  test("burned balances reduce circulating supply", () => {
    const g = new GraphEngine();
    g.setTotalSupply(TOKEN, 1_000n);
    const dead = "0x000000000000000000000000000000000000dead" as Address;
    g.applyEvent(transfer(ZERO_ADDRESS, addr("x"), 1_000n));
    g.applyEvent(transfer(addr("x"), dead, 400n));
    expect(g.circulatingSupply(TOKEN)).toBe(600n);
  });

  test("rewindTo undoes unfinalized state (reorg)", () => {
    const g = new GraphEngine();
    g.setTotalSupply(TOKEN, 1_000n);
    const b0 = block + 1;
    g.applyEvent(funding(FUNDER, addr("r1"), 10n, { block: b0, ts: ts + 1 }));
    g.applyEvent(funding(FUNDER, addr("r2"), 10n, { block: b0 + 1, ts: ts + 2 }));
    g.applyEvent(transfer(ZERO_ADDRESS, addr("r1"), 500n, { block: b0 + 2, ts: ts + 3 }));
    expect(g.clusterOf(addr("r1")).length).toBeGreaterThan(1);
    expect(g.balanceOf(TOKEN, addr("r1"))).toBe(500n);

    const rewound = g.rewindTo(b0 + 1); // drop blocks b0+1 and b0+2
    expect(rewound).toBe(2);
    // r2's union is gone; r1 keeps only its pre-fork union with the funder (block b0)
    expect(new Set(g.clusterOf(addr("r1")))).toEqual(new Set([addr("r1"), FUNDER]));
    expect(g.clusterOf(addr("r2"))).toEqual([]);
    expect(g.balanceOf(TOKEN, addr("r1"))).toBe(0n); // mint transfer gone
    expect(g.wallets.has(addr("r1"))).toBe(true); // from block b0 — kept
    expect(g.wallets.has(addr("r2"))).toBe(false);
  });

  test("deployer heuristic: receiver of initial mint", () => {
    const g = new GraphEngine();
    g.applyEvent(transfer(ZERO_ADDRESS, addr("dep"), 1_000n));
    expect(g.deployerOf(TOKEN)).toBe(addr("dep"));
  });

  test("snapshot roundtrip preserves balances and clusters", () => {
    const g = new GraphEngine();
    g.setTotalSupply(TOKEN, 1_000_000n);
    g.applyEvent(funding(FUNDER, addr("s1"), 10n));
    g.applyEvent(funding(FUNDER, addr("s2"), 10n));
    g.applyEvent(transfer(ZERO_ADDRESS, addr("s1"), 300_000n));
    const json = g.toJSON();
    const restored = GraphEngine.fromJSON(json);
    expect(restored.balanceOf(TOKEN, addr("s1"))).toBe(300_000n);
    expect(new Set(restored.clusterOf(addr("s1")))).toEqual(new Set([addr("s1"), addr("s2"), FUNDER]));
    expect(restored.circulatingSupply(TOKEN)).toBe(1_000_000n);
  });

  test("funderChain walks up to maxHops", () => {
    const g = new GraphEngine();
    const grand = addr("grand");
    const parent = addr("parent");
    g.applyEvent(funding(grand, parent, 10n));
    g.applyEvent(funding(parent, addr("child"), 5n));
    expect(g.funderChain(addr("child"), 2)).toEqual([parent, grand]);
    expect(g.funderChain(addr("child"), 1)).toEqual([parent]);
  });
});

describe("GraphEngine pools (Phase 6)", () => {
  const POOL = "0x" + "ee".repeat(20) as Address;
  const DEAD = "0x000000000000000000000000000000000000dead" as Address;

  test("registerPool + isPool + poolCreated tracking", () => {
    const g = new GraphEngine();
    expect(g.isPool(POOL)).toBe(false);
    g.registerPool(POOL, 42, 1_700_000_000);
    expect(g.isPool(POOL)).toBe(true);
    expect(g.getPoolInfo().get(POOL)).toEqual({ block: 42, ts: 1_700_000_000 });
  });

  test("isPool matches regardless of address case", () => {
    const g = new GraphEngine();
    g.registerPool("0x" + "EE".repeat(20) as Address, 1, 0);
    expect(g.isPool(POOL)).toBe(true);
  });

  test("swapVolumeBetween reports only in-window volume", () => {
    const g = new GraphEngine();
    g.registerPool(POOL, 1, 0);
    const now = 1_800_000_000;
    const buy = { kind: "swap", chainId: 1, poolAddress: POOL, tokenAddress: TOKEN, buyer: addr("b1"), direction: "buy", tokenAmount: 500n, quoteAmount: 1000n, txHash: "0x" + "00".repeat(32), blockNumber: 2, logIndex: 1, timestamp: now - 60 } as const;
    const sell = { ...buy, buyer: addr("b2"), tokenAmount: 300n, direction: "sell", timestamp: now - 4000 } as const;
    g.applyEvent(buy);
    g.applyEvent(sell);
    // last 5 minutes: only the buy counts
    expect(g.swapVolumeBetween(TOKEN, now - 300, now)).toEqual({ buy: 500n, sell: 0n });
    // last 10 minutes: both count
    expect(g.swapVolumeBetween(TOKEN, now - 6000, now)).toEqual({ buy: 500n, sell: 300n });
  });

  test("lpStatus tracks mint/burn against dead addresses", () => {
    const g = new GraphEngine();
    const createdTs = 1_700_000_000;
    g.registerPool(POOL, 1, createdTs);
    // mint 1000 LP
    g.applyEvent(transfer(ZERO_ADDRESS, addr("lp1"), 1000n, { block: 2, ts: createdTs + 60, token: POOL }));
    const st = g.lpStatus(POOL);
    expect(st?.lpMinted).toBe(1000n);
    // burn 400 to dead
    g.applyEvent(transfer(addr("lp1"), DEAD, 400n, { block: 3, ts: createdTs + 120, token: POOL }));
    const st2 = g.lpStatus(POOL);
    expect(st2?.lpBurned).toBe(400n);
  });

  test("snapshot roundtrip preserves pool, lp, and swap state", () => {
    const g = new GraphEngine();
    const createdTs = 1_700_000_000;
    g.registerPool(POOL, 9, createdTs);
    g.applyEvent(transfer(ZERO_ADDRESS, addr("lp1"), 1000n, { block: 10, ts: createdTs + 60, token: POOL }));
    g.applyEvent(transfer(addr("lp1"), DEAD, 300n, { block: 11, ts: createdTs + 120, token: POOL }));
    g.applyEvent({
      kind: "swap", chainId: 1, poolAddress: POOL, tokenAddress: TOKEN, buyer: addr("b1"), direction: "buy",
      tokenAmount: 50n, quoteAmount: 100n, txHash: "0x" + "00".repeat(32), blockNumber: 12, logIndex: 1, timestamp: createdTs + 200,
    });
    const restored = GraphEngine.fromJSON(g.toJSON());
    expect(restored.isPool(POOL)).toBe(true);
    expect(restored.lpStatus(POOL)?.lpBurned).toBe(300n);
    expect(restored.swapVolumeBetween(TOKEN, createdTs, createdTs + 1000)).toEqual({ buy: 50n, sell: 0n });
  });

  test("rewindTo undoes pool registration and swaps", () => {
    const g = new GraphEngine();
    const b0 = block + 1;
    g.applyEvent({ kind: "pool_created", chainId: 1, poolAddress: POOL, token0: TOKEN, token1: addr("q"), factory: "uniswap-v2", txHash: "0x" + "00".repeat(32), blockNumber: b0, logIndex: 0, timestamp: ts + 1 });
    g.applyEvent({ kind: "swap", chainId: 1, poolAddress: POOL, tokenAddress: TOKEN, buyer: addr("b1"), direction: "buy", tokenAmount: 100n, quoteAmount: 200n, txHash: "0x" + "00".repeat(32), blockNumber: b0 + 1, logIndex: 1, timestamp: ts + 2 });
    expect(g.isPool(POOL)).toBe(true);
    // rewind past the swap only: pool (created at b0) survives, swap volume gone
    g.rewindTo(b0 + 1);
    expect(g.isPool(POOL)).toBe(true);
    expect(g.swapVolumeBetween(TOKEN, 0, ts + 999)).toEqual({ buy: 0n, sell: 0n });
    // rewind past the pool creation too
    g.rewindTo(b0);
    expect(g.isPool(POOL)).toBe(false);
    expect(g.getPoolInfo().has(POOL)).toBe(false);
  });

  test("negative balances survive snapshot roundtrip", () => {
    const g = new GraphEngine();
    g.setTotalSupply(TOKEN, 1_000n);
    g.applyEvent(transfer(ZERO_ADDRESS, addr("neg"), 100n, { block: 1, ts: ts + 1 }));
    g.applyEvent(transfer(addr("neg"), addr("other"), 200n, { block: 2, ts: ts + 2 })); // goes to -100n
    expect(g.balanceOf(TOKEN, addr("neg"))).toBe(-100n);
    const restored = GraphEngine.fromJSON(g.toJSON());
    expect(restored.balanceOf(TOKEN, addr("neg"))).toBe(-100n);
  });

  test("fromJSON tolerates legacy snapshots missing Phase 6 fields", () => {
    const g = new GraphEngine();
    g.registerPool(POOL, 1, 0);
    const j = JSON.parse(g.toJSON()) as Record<string, unknown>;
    delete j["pools"];
    delete j["poolCreated"];
    delete j["lpMinted"];
    delete j["swapVolume"];
    const restored = GraphEngine.fromJSON(JSON.stringify(j));
    // pool + swap application must not crash on a legacy-shaped graph
    expect(() =>
      restored.applyEvent({
        kind: "swap", chainId: 1, poolAddress: POOL, tokenAddress: TOKEN, buyer: addr("b1"), direction: "buy",
        tokenAmount: 50n, quoteAmount: 100n, txHash: "0x" + "00".repeat(32), blockNumber: 3, logIndex: 1, timestamp: ts + 5,
      }),
    ).not.toThrow();
    expect(restored.swapVolumeBetween(TOKEN, 0, ts + 999)).toEqual({ buy: 50n, sell: 0n });
    expect(() => restored.applyEvent({ kind: "pool_created", chainId: 1, poolAddress: POOL, token0: TOKEN, token1: addr("q"), factory: "uniswap-v2", txHash: "0x" + "00".repeat(32), blockNumber: 4, logIndex: 0, timestamp: ts + 6 })).not.toThrow();
    expect(restored.isPool(POOL)).toBe(true);
  });

  test("finalize prunes stale rolling window events older than 24h for finalized blocks", () => {
    const g = new GraphEngine();
    const pool = addr("pool");
    g.registerPool(pool, 1, 0);
    g.setTotalSupply(TOKEN, 1_000_000n);
    const now = 200_000;
    const oldTs = now - 100_000; // > 86,400s old
    const bOld = 10;
    const bRecent = 100;

    // Apply old buy (block 10) and recent buy (block 100)
    g.applyEvent(transfer(ZERO_ADDRESS, addr("acc1"), 500n, { block: bOld, ts: oldTs }));
    g.applyEvent(transfer(pool, addr("acc2"), 100n, { block: bOld, ts: oldTs }));
    g.applyEvent(transfer(pool, addr("acc3"), 200n, { block: bRecent, ts: now }));

    // Before finalize: fresh accumulation scans old buy
    expect(g.freshAccumulation(TOKEN, 0, now, 30).amount).toBe(300n);

    // Finalize up to block 50 (old events finalized, recent unfinalized)
    g.finalize(50, now);

    // Old buy pruned from accumulation window; recent buy kept
    expect(g.freshAccumulation(TOKEN, 0, now, 30).amount).toBe(200n);
  });
});
