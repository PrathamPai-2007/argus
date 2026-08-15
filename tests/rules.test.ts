import { describe, expect, test } from "bun:test";
import type { RulesConfig } from "../src/config.ts";
import { GraphEngine, DEFAULT_GRAPH_TUNING } from "../src/graph/engine.ts";
import { R1, R2, R3, R4, R5, R6, R7, R8 } from "../src/rules/index.ts";
import type { Address, FundingEvent, StandardTransferEvent, SwapEvent } from "../src/types.ts";
import { ZERO_ADDRESS } from "../src/types.ts";

const TOKEN = "0x" + "aa".repeat(20) as Address;
const DEPLOYER = "0x" + "de".repeat(20) as Address;
const CEX = "0x" + "ce".repeat(20) as Address;

let block = 1_000;
let ts = 1_700_000_000;

function testRules(): RulesConfig {
  return {
    R1: { enabled: true, supplyPct: 15, windowHours: 2, walletAgeDays: 7, weight: 35 },
    R2: { enabled: false, volumeSpikePct: 300, windowMinutes: 15, weight: 25 },
    R3: { enabled: true, minRecipients: 3, windowMinutes: 15, weight: 30 },
    R4: { enabled: true, warnPct: 10, critPct: 20, critWeight: 45, weight: 30 },
    R5: { enabled: true, minBuyers: 3, walletAgeDays: 7, weight: 25 },
    R6: { enabled: true, maxHops: 2, minClusterPct: 1, weight: 50 },
    R7: { enabled: false, minLockedPct: 30, minPoolAgeHours: 48, weight: 20 },
    R8: { enabled: true, minWallets: 3, windowMinutes: 60, weight: 20 },
  };
}

function addr(tag: string): Address {
  return ("0x" + tag.padEnd(40, "0").slice(0, 40)) as Address;
}

function funding(funder: Address, funded: Address, amount: bigint, atTs?: number, atBlock?: number): FundingEvent {
  return {
    kind: "funding",
    chainId: 1,
    funder,
    funded,
    amount,
    method: "native_transfer",
    txHash: "0x" + "00".repeat(32),
    blockNumber: atBlock ?? ++block,
    logIndex: 10_000_001,
    timestamp: atTs ?? (ts += 12),
  };
}

function transfer(from: Address, to: Address, amount: bigint, atTs?: number, atBlock?: number): StandardTransferEvent {
  return {
    kind: "transfer",
    chainId: 1,
    tokenAddress: TOKEN,
    sender: from,
    receiver: to,
    amount,
    txHash: "0x" + "00".repeat(32),
    blockNumber: atBlock ?? ++block,
    logIndex: 1,
    timestamp: atTs ?? (ts += 12),
  };
}

describe("rules", () => {
  test("R1 fires when fresh wallets accumulate > supplyPct", () => {
    const g = new GraphEngine();
    g.setTotalSupply(TOKEN, 1_000n);
    const cfg = testRules();
    const t0 = ts + 100;
    const b0 = block + 1;
    g.applyEvent(transfer(ZERO_ADDRESS, DEPLOYER, 1_000n, t0, b0));
    // 3 fresh wallets accumulate 16% total
    let last: StandardTransferEvent | null = null;
    for (let i = 1; i <= 3; i++) {
      const w = addr(`f${i}`);
      g.applyEvent(funding(addr("fund"), w, 10n ** 16n, t0 + i, b0 + i));
      last = transfer(DEPLOYER, w, 60n, t0 + 100 + i, b0 + 10 + i);
      g.applyEvent(last);
    }
    // 180/1000 = 18% ≥ 15%
    const sig = R1(last as StandardTransferEvent, g, cfg);
    expect(sig).not.toBeNull();
    expect(sig?.ruleId).toBe("R1");
    expect(sig?.weight).toBe(35);
    expect(sig?.evidence["freshWalletCount"]).toBe(3);
  });

  test("R1 does not fire below threshold", () => {
    const g = new GraphEngine();
    g.setTotalSupply(TOKEN, 1_000n);
    const cfg = testRules();
    const t0 = ts + 100;
    g.applyEvent(transfer(ZERO_ADDRESS, DEPLOYER, 1_000n, t0));
    const w = addr("g1");
    g.applyEvent(funding(addr("fund"), w, 10n, t0 + 1));
    const t = transfer(DEPLOYER, w, 100n, t0 + 2); // 10% < 15%
    g.applyEvent(t);
    expect(R1(t, g, cfg)).toBeNull();
  });

  test("R3 fires on identical-amount fan-out", () => {
    const g = new GraphEngine({ ...DEFAULT_GRAPH_TUNING, fanoutMinRecipients: 3 });
    const cfg = testRules();
    const sender = addr("boss");
    const t0 = ts + 100;
    g.applyEvent(transfer(ZERO_ADDRESS, sender, 10_000n, t0));
    let last: StandardTransferEvent | null = null;
    for (let i = 1; i <= 3; i++) {
      last = transfer(sender, addr(`s${i}`), 77n, t0 + i * 30);
      g.applyEvent(last);
    }
    const sig = R3(last as StandardTransferEvent, g, cfg);
    expect(sig).not.toBeNull();
    expect(sig?.evidence["recipientCount"]).toBe(3);
    expect(sig?.evidence["sender"]).toBe(sender);
  });

  test("R4 fires at warn and crit tiers", () => {
    const g = new GraphEngine();
    g.setTotalSupply(TOKEN, 1_000n);
    const cfg = testRules();
    const t0 = ts + 100;
    const funder = addr("hf");
    g.applyEvent(funding(funder, addr("h1"), 10n, t0));
    g.applyEvent(funding(funder, addr("h2"), 10n, t0 + 1));
    g.applyEvent(transfer(ZERO_ADDRESS, DEPLOYER, 1_000n, t0 + 2));
    const t1 = transfer(DEPLOYER, addr("h1"), 110n, t0 + 3); // cluster {h1,h2,funder} = 11%
    g.applyEvent(t1);
    const warn = R4(t1, g, cfg);
    expect(warn?.weight).toBe(30);
    const t2 = transfer(DEPLOYER, addr("h2"), 110n, t0 + 4); // cluster = 22%
    g.applyEvent(t2);
    const crit = R4(t2, g, cfg);
    expect(crit?.weight).toBe(45);
    expect(crit?.evidence["pctOfSupply"]).toBeGreaterThanOrEqual(20);
  });

  test("R5 fires on bundled same-block fresh buys", () => {
    const g = new GraphEngine();
    const cfg = testRules();
    const t0 = ts + 100;
    const b0 = block + 50;
    g.applyEvent(transfer(ZERO_ADDRESS, DEPLOYER, 1_000n, t0, b0));
    let last: StandardTransferEvent | null = null;
    for (let i = 1; i <= 3; i++) {
      const w = addr(`bb${i}`);
      g.applyEvent(funding(addr("fund"), w, 10n, t0 - 50, b0 - 1)); // fresh
      last = transfer(DEPLOYER, w, 10n, t0, b0); // same block
      g.applyEvent(last);
    }
    const sig = R5(last as StandardTransferEvent, g, cfg);
    expect(sig).not.toBeNull();
    expect(sig?.evidence["freshBuyerCount"]).toBe(3);
    expect(sig?.evidence["block"]).toBe(b0);
  });

  test("R6 fires when accumulating cluster is deployer-funded", () => {
    const g = new GraphEngine();
    g.setTotalSupply(TOKEN, 1_000n);
    const cfg = testRules();
    const t0 = ts + 100;
    g.applyEvent(transfer(ZERO_ADDRESS, DEPLOYER, 1_000n, t0)); // deployer = DEPLOYER
    const insider = addr("insider");
    g.applyEvent(funding(DEPLOYER, insider, 10n ** 16n, t0 + 1)); // funded BY deployer
    const t = transfer(DEPLOYER, insider, 100n, t0 + 2); // insider holds 10% ≥ minClusterPct 1
    g.applyEvent(t);
    const sig = R6(t, g, cfg);
    expect(sig).not.toBeNull();
    expect(sig?.ruleId).toBe("R6");
    expect(sig?.weight).toBe(50);
    expect(sig?.evidence["deployer"]).toBe(DEPLOYER);
  });

  test("R6 does not fire for unrelated funders", () => {
    const g = new GraphEngine();
    g.setTotalSupply(TOKEN, 1_000n);
    const cfg = testRules();
    const t0 = ts + 100;
    g.applyEvent(transfer(ZERO_ADDRESS, DEPLOYER, 1_000n, t0));
    const w = addr("innocent");
    g.applyEvent(funding(addr("someone"), w, 10n, t0 + 1));
    const t = transfer(DEPLOYER, w, 100n, t0 + 2);
    g.applyEvent(t);
    expect(R6(t, g, cfg)).toBeNull();
  });

  test("R8 fires on same-size CEX fan-out", () => {
    const g = new GraphEngine();
    g.setLabels(new Map([[CEX, { label: "Binance 14", kind: "cex" }]]));
    const cfg = testRules();
    const t0 = ts + 100;
    for (let i = 1; i <= 3; i++) g.applyEvent(funding(CEX, addr(`x${i}`), 5n * 10n ** 16n, t0 + i * 60));
    const t = transfer(DEPLOYER, addr("x1"), 10n, t0 + 500);
    g.applyEvent(t);
    const sig = R8(t, g, cfg);
    expect(sig).not.toBeNull();
    expect(sig?.evidence["walletCount"]).toBe(3);
    expect(sig?.evidence["exchangeFunder"]).toBe(CEX);
  });
});

describe("R2 volume spike", () => {
  const POOL = "0x" + "ee".repeat(20) as Address;

  function swap(buyer: Address, amount: bigint, atTs: number, atBlock: number): SwapEvent {
    return {
      kind: "swap",
      chainId: 1,
      poolAddress: POOL,
      tokenAddress: TOKEN,
      buyer,
      direction: "buy",
      tokenAmount: amount,
      quoteAmount: 1000n,
      txHash: "0x" + "00".repeat(32),
      blockNumber: atBlock,
      logIndex: 1,
      timestamp: atTs,
    };
  }

  test("fires when current window volume spikes >300% vs prior window", () => {
    const g = new GraphEngine();
    const cfg = testRules();
    cfg.R2.enabled = true;
    g.registerPool(POOL, 1, 0);
    const now = ts + 10_000;
    // prior window: 25 min ago, volume 10
    g.applyEvent(swap(addr("p1"), 10n, now - 25 * 60, block + 1));
    // current window: 5 min ago, volume 100
    g.applyEvent(swap(addr("p2"), 100n, now - 5 * 60, block + 2));
    const last = swap(addr("p3"), 1n, now, block + 3); // trigger event, now = reference
    g.applyEvent(last);
    const sig = R2(last, g, cfg);
    expect(sig).not.toBeNull();
    expect(sig?.ruleId).toBe("R2");
    expect(sig?.evidence["spikePct"]).toBeGreaterThanOrEqual(300);
  });

  test("does not fire without a baseline or below threshold", () => {
    const g = new GraphEngine();
    const cfg = testRules();
    cfg.R2.enabled = true;
    g.registerPool(POOL, 1, 0);
    const now = ts + 20_000;
    g.applyEvent(swap(addr("q1"), 10n, now - 5 * 60, block + 1));
    const last = swap(addr("q2"), 12n, now, block + 2); // +20% < 300%
    g.applyEvent(last);
    expect(R2(last, g, cfg)).toBeNull();
  });
});

describe("R7 LP-lock safety", () => {
  const POOL = "0x" + "ee".repeat(20) as Address;

  test("fires when LP is heavily burned on a mature pool", () => {
    const g = new GraphEngine();
    const cfg = testRules();
    cfg.R7.enabled = true;
    const now = ts + 30_000;
    const createdTs = now - 3 * 86_400; // 3 days old
    g.registerPool(POOL, 100, createdTs);
    // LP minted: 1000
    g.applyEvent(transferFrom(POOL, ZERO_ADDRESS, addr("lp1"), 1000n, now - 2 * 86_400));
    // LP burned to dead: 800 → locked 20% < minLockedPct 30%
    const burn = transferFrom(POOL, addr("lp1"), ZERO_ADDRESS, 800n, now, block + 1);
    g.applyEvent(burn);
    const sig = R7(burn, g, cfg);
    expect(sig).not.toBeNull();
    expect(sig?.ruleId).toBe("R7");
    expect(sig?.evidence["lockedPct"]).toBe(20);
  });

  test("does not fire while LP stays locked", () => {
    const g = new GraphEngine();
    const cfg = testRules();
    cfg.R7.enabled = true;
    const now = ts + 40_000;
    const createdTs = now - 3 * 86_400;
    g.registerPool(POOL, 100, createdTs);
    g.applyEvent(transferFrom(POOL, ZERO_ADDRESS, addr("lp1"), 1000n, now - 2 * 86_400));
    const burn = transferFrom(POOL, addr("lp1"), ZERO_ADDRESS, 100n, now, block + 1); // locked 90%
    g.applyEvent(burn);
    expect(R7(burn, g, cfg)).toBeNull();
  });

  test("does not fire on young pools (age gate)", () => {
    const g = new GraphEngine();
    const cfg = testRules();
    cfg.R7.enabled = true;
    const now = ts + 50_000;
    const createdTs = now - 1 * 3600; // 1 hour old < minPoolAgeHours 48
    g.registerPool(POOL, 100, createdTs);
    g.applyEvent(transferFrom(POOL, ZERO_ADDRESS, addr("lp1"), 1000n, now - 1800));
    const burn = transferFrom(POOL, addr("lp1"), ZERO_ADDRESS, 900n, now, block + 1);
    g.applyEvent(burn);
    expect(R7(burn, g, cfg)).toBeNull();
  });
});

describe("pool self-gating", () => {
  test("R1/R3/R4/R5/R6/R8 are silent for pool LP tokens", () => {
    const g = new GraphEngine();
    const cfg = testRules();
    const POOL = "0x" + "ee".repeat(20) as Address;
    g.registerPool(POOL, 1, 0);
    // mint LP, then fan out LP tokens like a token transfer would
    g.applyEvent(transferFrom(POOL, ZERO_ADDRESS, addr("boss"), 10_000n, ts + 1));
    const t = transferFrom(POOL, addr("boss"), addr("p1"), 100n, ts + 2);
    g.applyEvent(t);
    expect(R1(t, g, cfg)).toBeNull();
    expect(R3(t, g, cfg)).toBeNull();
    expect(R4(t, g, cfg)).toBeNull();
    expect(R5(t, g, cfg)).toBeNull();
    expect(R6(t, g, cfg)).toBeNull();
    expect(R8(t, g, cfg)).toBeNull();
  });
});

function transferFrom(token: Address, from: Address, to: Address, amount: bigint, atTs: number, atBlock?: number): StandardTransferEvent {
  return {
    kind: "transfer",
    chainId: 1,
    tokenAddress: token,
    sender: from,
    receiver: to,
    amount,
    txHash: "0x" + "00".repeat(32),
    blockNumber: atBlock ?? ++block,
    logIndex: 1,
    timestamp: atTs,
  };
}
