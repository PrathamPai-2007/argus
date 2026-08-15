import { describe, expect, test } from "bun:test";
import { encodeFunctionData, padHex, toHex, type Hex } from "viem";
import {
  decodeDisperseCalldata,
  ERC20_TRANSFER_TOPIC,
  normalizePairCreated,
  normalizeSwap,
  normalizeTransfer,
  UNIV2_PAIR_CREATED_TOPIC,
  UNIV2_SWAP_TOPIC,
  type RawLog,
} from "../src/ingest/normalizer.ts";

const A = "0x" + "11".repeat(20);
const B = "0x" + "22".repeat(20);
const TOKEN = "0x" + "aa".repeat(20);

function transferLog(overrides?: Partial<RawLog>): RawLog {
  return {
    address: TOKEN,
    topics: [ERC20_TRANSFER_TOPIC, padHex(A as Hex, { size: 32 }), padHex(B as Hex, { size: 32 })],
    data: padHex(toHex(1000n), { size: 32 }),
    blockNumber: 19_000_000,
    logIndex: 7,
    transactionHash: ("0x" + "ff".repeat(32)) as Hex,
    ...overrides,
  };
}

describe("normalizeTransfer", () => {
  test("decodes ERC-20 Transfer", () => {
    const evt = normalizeTransfer(transferLog(), 1, 1_700_000_000);
    expect(evt).not.toBeNull();
    expect(evt?.kind).toBe("transfer");
    expect(evt?.tokenAddress).toBe(TOKEN);
    expect(evt?.sender).toBe(A);
    expect(evt?.receiver).toBe(B);
    expect(evt?.amount).toBe(1000n);
    expect(evt?.blockNumber).toBe(19_000_000);
    expect(evt?.logIndex).toBe(7);
    expect(evt?.timestamp).toBe(1_700_000_000);
  });

  test("rejects wrong topic", () => {
    const log = transferLog({ topics: [padHex("0x01" as Hex, { size: 32 }), padHex(A as Hex, { size: 32 }), padHex(B as Hex, { size: 32 })] });
    expect(normalizeTransfer(log, 1, 0)).toBeNull();
  });

  test("rejects ERC-721 style (4 topics)", () => {
    const log = transferLog();
    log.topics.push(padHex("0x05" as Hex, { size: 32 }));
    expect(normalizeTransfer(log, 1, 0)).toBeNull();
  });
});

describe("normalizePairCreated", () => {
  test("decodes Uniswap V2 PairCreated", () => {
    const pair = "0x" + "cc".repeat(20);
    const log: RawLog = {
      address: "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f",
      topics: [UNIV2_PAIR_CREATED_TOPIC, padHex(A as Hex, { size: 32 }), padHex(B as Hex, { size: 32 })],
      data: (padHex(pair as Hex, { size: 32 }) + padHex(toHex(42n), { size: 32 }).slice(2)) as Hex,
      blockNumber: 19_000_001,
      logIndex: 3,
      transactionHash: ("0x" + "ee".repeat(32)) as Hex,
    };
    const evt = normalizePairCreated(log, 1, "uniswap-v2", 1_700_000_100);
    expect(evt?.kind).toBe("pool_created");
    expect(evt?.poolAddress).toBe(pair);
    expect(evt?.token0).toBe(A);
    expect(evt?.token1).toBe(B);
  });
});

describe("normalizeSwap", () => {
  const POOL = "0x" + "dd".repeat(20);
  const SENDER = A;
  const TO = B;
  // Swap event: Swap(address indexed sender, amount0In, amount1In, amount0Out, amount1Out, address indexed to)
  // Layout: sender, amount0In, amount1In, amount0Out, amount1Out, to
  function swapLog(amount0In: bigint, amount1In: bigint, amount0Out: bigint, amount1Out: bigint): RawLog {
    const data =
      padHex(toHex(amount0In), { size: 32 }) +
      padHex(toHex(amount1In), { size: 32 }).slice(2) +
      padHex(toHex(amount0Out), { size: 32 }).slice(2) +
      padHex(toHex(amount1Out), { size: 32 }).slice(2);
    return {
      address: POOL,
      topics: [UNIV2_SWAP_TOPIC, padHex(SENDER as Hex, { size: 32 }), padHex(TO as Hex, { size: 32 })],
      data: data as Hex,
      blockNumber: 19_000_002,
      logIndex: 1,
      transactionHash: ("0x" + "aa".repeat(32)) as Hex,
    };
  }

  test("token0 is watched — buy detected (pay token1, receive token0)", () => {
    const evt = normalizeSwap(swapLog(0n, 500n, 100n, 0n), 1, A, POOL, true, 1_700_000_200);
    expect(evt?.kind).toBe("swap");
    expect(evt?.direction).toBe("buy");
    expect(evt?.tokenAmount).toBe(100n);
    expect(evt?.quoteAmount).toBe(500n);
    expect(evt?.buyer).toBe(TO);
    expect(evt?.poolAddress).toBe(POOL);
  });

  test("token0 is watched — sell detected (pay token0, receive token1)", () => {
    const evt = normalizeSwap(swapLog(200n, 0n, 0n, 300n), 1, A, POOL, true, 1_700_000_200);
    expect(evt?.kind).toBe("swap");
    expect(evt?.direction).toBe("sell");
    expect(evt?.tokenAmount).toBe(200n);
    expect(evt?.buyer).toBe(SENDER);
  });

  test("token1 is watched — buy detected (pay token0, receive token1)", () => {
    const evt = normalizeSwap(swapLog(100n, 0n, 0n, 500n), 1, B, POOL, false, 1_700_000_200);
    expect(evt?.kind).toBe("swap");
    expect(evt?.direction).toBe("buy");
    expect(evt?.tokenAmount).toBe(500n);
    expect(evt?.quoteAmount).toBe(100n);
  });

  test("rejects wrong topic", () => {
    expect(normalizeSwap(transferLog(), 1, A, POOL, true, 0)).toBeNull();
  });
});

describe("decodeDisperseCalldata", () => {
  const ABI = [
    {
      name: "disperseEther",
      type: "function",
      stateMutability: "payable",
      inputs: [
        { name: "recipients", type: "address[]" },
        { name: "values", type: "uint256[]" },
      ],
      outputs: [],
    },
    {
      name: "disperseToken",
      type: "function",
      stateMutability: "nonpayable",
      inputs: [
        { name: "token", type: "address" },
        { name: "recipients", type: "address[]" },
        { name: "values", type: "uint256[]" },
      ],
      outputs: [],
    },
  ] as const;

  test("decodes disperseEther", () => {
    const data = encodeFunctionData({
      abi: ABI,
      functionName: "disperseEther",
      args: [[A as Hex, B as Hex], [100n, 200n]],
    });
    const out = decodeDisperseCalldata(data);
    expect(out?.kind).toBe("ether");
    expect(out?.recipients).toEqual([A, B]);
    expect(out?.values).toEqual([100n, 200n]);
  });

  test("decodes disperseToken", () => {
    const data = encodeFunctionData({
      abi: ABI,
      functionName: "disperseToken",
      args: [TOKEN as Hex, [A as Hex], [555n]],
    });
    const out = decodeDisperseCalldata(data);
    expect(out?.kind).toBe("token");
    expect(out?.recipients).toEqual([A]);
  });

  test("returns null for unrelated calldata", () => {
    expect(decodeDisperseCalldata("0xdeadbeef")).toBeNull();
  });
});
