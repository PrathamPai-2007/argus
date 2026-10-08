import { describe, expect, test } from "bun:test";
import { decodeEventLog, encodeAbiParameters, encodeEventTopics, parseAbi, type Hex } from "viem";
import { CHAINS, orientPair } from "../src/chains.ts";
import { decodeLog, TOPICS, type DecodeContext, type PoolRef, type RawLog } from "../src/ingest/decode.ts";
import fixtures from "./fixtures/dex-logs.json";

// Real mainnet logs (see fixtures/dex-logs.json) decoded by viem as an
// independent oracle; our decoder must agree on direction and magnitudes.

const ABI = parseAbi([
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
  "event Sync(uint112 reserve0, uint112 reserve1)",
  "event Mint(address indexed sender, uint256 amount0, uint256 amount1)",
  "event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)",
  "event PairCreated(address indexed token0, address indexed token1, address pair, uint256 allPairsLength)",
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
]);
const V3_ABI = parseAbi([
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
  "event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
  "event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
]);

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" as const;
const MEME = `0x${"77".repeat(20)}` as const;
const SIGNER = `0x${"5e".repeat(20)}` as const;

type Fixture = Omit<RawLog, "address"> & { address: string };
const fx = fixtures as unknown as Record<string, Fixture>;

function ctx(pools: PoolRef[], opts: { watched?: string[]; signer?: boolean } = {}): DecodeContext {
  return {
    chainId: 1,
    timestamp: 1_700_000_000,
    pool: (a) => pools.find((p) => p.address === a.toLowerCase()),
    factory: (a) => CHAINS[1]!.factories.find((f) => f.address === a.toLowerCase()),
    isWatchedToken: (a) => (opts.watched ?? []).includes(a.toLowerCase()),
    tx: () => (opts.signer === false ? undefined : { from: SIGNER, nonce: 7 }),
  };
}

function poolRef(address: string, dex: "v2" | "v3", token0: string, token1: string, token: string): PoolRef {
  return { address: address.toLowerCase(), dex, token0, token1, token, quote: token === token0 ? token1 : token0 };
}

function raw(f: Fixture): RawLog {
  return { ...f, address: f.address.toLowerCase(), topics: f.topics as Hex[], data: f.data as Hex, transactionHash: f.transactionHash as Hex };
}

describe("chain registry", () => {
  test("orientPair picks the non-quote side regardless of address order", () => {
    expect(orientPair(1, WETH, MEME)).toEqual({ token: MEME, quote: WETH });
    expect(orientPair(1, MEME, USDC)).toEqual({ token: MEME, quote: USDC });
    expect(orientPair(1, WETH, USDC)).toBeNull(); // quote/quote pool
    expect(orientPair(1, MEME, "0x" + "88".repeat(20))).toBeNull(); // no quote at all
  });
});

describe("decodeLog — real mainnet fixtures", () => {
  test("V2 swap: direction and amounts follow pool deltas; trader is tx.from", () => {
    const log = raw(fx["v2Swap"]!);
    const pool = poolRef(log.address, "v2", USDC, WETH, WETH); // treat WETH as the traded side
    const evt = decodeLog(log, ctx([pool]));
    const a = decodeEventLog({ abi: ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]] }).args as { amount0In: bigint; amount1In: bigint; amount0Out: bigint; amount1Out: bigint; to: string };
    expect(evt?.kind).toBe("swap");
    if (evt?.kind !== "swap") return;
    const wethOut = a.amount1Out - a.amount1In;
    expect(evt.side).toBe(wethOut > 0n ? "buy" : "sell");
    expect(evt.tokenAmount).toBe(wethOut > 0n ? wethOut : -wethOut);
    expect(evt.quoteAmount).toBe(wethOut > 0n ? a.amount0In - a.amount0Out : a.amount0Out - a.amount0In);
    expect(evt.trader).toBe(SIGNER);
    expect(evt.traderNonce).toBe(7);
    expect(evt.recipient).toBe(a.to.toLowerCase());
  });

  test("V2 swap orientation flips when the traded token is token0", () => {
    const log = raw(fx["v2Swap"]!);
    const asWeth = decodeLog(log, ctx([poolRef(log.address, "v2", USDC, WETH, WETH)]));
    const asUsdc = decodeLog(log, ctx([poolRef(log.address, "v2", USDC, WETH, USDC)]));
    if (asWeth?.kind !== "swap" || asUsdc?.kind !== "swap") throw new Error("expected swaps");
    expect(asUsdc.side).not.toBe(asWeth.side);
    expect(asUsdc.tokenAmount).toBe(asWeth.quoteAmount);
    expect(asUsdc.quoteAmount).toBe(asWeth.tokenAmount);
  });

  test("V2 sync maps reserves to token/quote sides", () => {
    const log = raw(fx["v2Sync"]!);
    const evt = decodeLog(log, ctx([poolRef(log.address, "v2", USDC, WETH, WETH)]));
    const a = decodeEventLog({ abi: ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]] }).args as { reserve0: bigint; reserve1: bigint };
    expect(evt).toMatchObject({ kind: "reserves", tokenReserve: a.reserve1, quoteReserve: a.reserve0 });
  });

  test("V3 swap: signed deltas, sqrtPrice carried, recipient fallback without tx info", () => {
    const log = raw(fx["v3Swap"]!);
    const evt = decodeLog(log, ctx([poolRef(log.address, "v3", USDC, WETH, WETH)], { signer: false }));
    const a = decodeEventLog({ abi: V3_ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]] }).args as { amount0: bigint; amount1: bigint; sqrtPriceX96: bigint; recipient: string };
    if (evt?.kind !== "swap") throw new Error("expected swap");
    expect(evt.side).toBe(a.amount1 < 0n ? "buy" : "sell");
    expect(evt.tokenAmount).toBe(a.amount1 < 0n ? -a.amount1 : a.amount1);
    expect(evt.quoteAmount).toBe(a.amount0 < 0n ? -a.amount0 : a.amount0);
    expect(evt.sqrtPriceX96).toBe(a.sqrtPriceX96);
    expect(evt.trader).toBe(a.recipient.toLowerCase());
    expect(evt.traderNonce).toBeNull();
  });

  test("V3 mint and burn become liquidity add/remove", () => {
    for (const [key, action] of [["v3Mint", "add"], ["v3Burn", "remove"]] as const) {
      const log = raw(fx[key]!);
      const evt = decodeLog(log, ctx([poolRef(log.address, "v3", USDC, WETH, WETH)]));
      const a = decodeEventLog({ abi: V3_ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]] }).args as { amount0: bigint; amount1: bigint };
      if (a.amount0 === 0n && a.amount1 === 0n) expect(evt).toBeNull();
      else expect(evt).toMatchObject({ kind: "liquidity", action, tokenAmount: a.amount1, quoteAmount: a.amount0, provider: SIGNER });
    }
  });

  test("V2 PairCreated from a registered factory", () => {
    const log = raw(fx["pairCreated"]!);
    const evt = decodeLog(log, ctx([]));
    const a = decodeEventLog({ abi: ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]] }).args as { token0: string; token1: string; pair: string };
    expect(evt).toMatchObject({ kind: "pool_created", dex: "v2", pool: a.pair.toLowerCase(), token0: a.token0.toLowerCase(), token1: a.token1.toLowerCase(), fee: null });
  });
});

describe("decodeLog — synthesized logs", () => {
  const POOL = `0x${"aa".repeat(20)}` as const;
  const pool = poolRef(POOL, "v2", MEME, WETH, MEME);
  const at = { blockNumber: 10, transactionIndex: 2, logIndex: 5, transactionHash: ("0x" + "11".repeat(32)) as Hex };

  test("V2 mint/burn orient amounts to token/quote", () => {
    const mint: RawLog = { address: POOL, ...at, topics: encodeEventTopics({ abi: ABI, eventName: "Mint", args: { sender: SIGNER } }) as Hex[], data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [1000n, 5n]) };
    expect(decodeLog(mint, ctx([pool]))).toMatchObject({ kind: "liquidity", action: "add", tokenAmount: 1000n, quoteAmount: 5n });
    const burn: RawLog = { ...mint, topics: encodeEventTopics({ abi: ABI, eventName: "Burn", args: { sender: SIGNER, to: SIGNER } }) as Hex[] };
    expect(decodeLog(burn, ctx([pool]))).toMatchObject({ kind: "liquidity", action: "remove", tokenAmount: 1000n, quoteAmount: 5n });
  });

  test("V3 PoolCreated carries the fee tier and pool address", () => {
    const v3Factory = CHAINS[1]!.factories.find((f) => f.dex === "v3")!.address as Hex;
    const log: RawLog = {
      address: v3Factory, ...at,
      topics: encodeEventTopics({ abi: ABI, eventName: "PoolCreated", args: { token0: MEME, token1: WETH, fee: 10_000 } }) as Hex[],
      data: encodeAbiParameters([{ type: "int24" }, { type: "address" }], [200, POOL]),
    };
    expect(decodeLog(log, ctx([]))).toMatchObject({ kind: "pool_created", dex: "v3", pool: POOL, token0: MEME, token1: WETH, fee: 10_000 });
  });

  test("Transfer only for watched tokens; ERC-721 shape ignored", () => {
    const log: RawLog = {
      address: MEME, ...at,
      topics: [TOPICS.transfer, ("0x" + "0".repeat(24) + "1".repeat(40)) as Hex, ("0x" + "0".repeat(24) + "2".repeat(40)) as Hex],
      data: encodeAbiParameters([{ type: "uint256" }], [42n]),
    };
    expect(decodeLog(log, ctx([]))).toBeNull();
    expect(decodeLog(log, ctx([], { watched: [MEME] }))).toMatchObject({ kind: "transfer", token: MEME, amount: 42n, from: "0x" + "1".repeat(40) });
    expect(decodeLog({ ...log, topics: [...log.topics, log.topics[1]!] }, ctx([], { watched: [MEME] }))).toBeNull();
  });

  test("unregistered pool and unknown factory logs are ignored", () => {
    expect(decodeLog(raw(fx["v2Swap"]!), ctx([]))).toBeNull();
    expect(decodeLog({ ...raw(fx["pairCreated"]!), address: "0x" + "99".repeat(20) }, ctx([]))).toBeNull();
  });
});
