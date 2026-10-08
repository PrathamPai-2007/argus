import { toEventSelector, type Hex } from "viem";
import type { DexVersion, FactoryInfo } from "../chains.ts";
import type { Address, ChainEvent, EventBase, LiquidityEvent, PoolCreatedEvent, ReservesEvent, SwapEvent, TransferEvent } from "../model.ts";

// Raw EVM logs → normalized ChainEvents. Pure: all chain knowledge (which
// pools are registered, how they are oriented, who signed each tx) arrives via
// DecodeContext, so every branch is testable against recorded fixtures.

export const TOPICS = {
  transfer: toEventSelector("Transfer(address,address,uint256)"),
  pairCreated: toEventSelector("PairCreated(address,address,address,uint256)"),
  poolCreated: toEventSelector("PoolCreated(address,address,uint24,int24,address)"),
  v2Swap: toEventSelector("Swap(address,uint256,uint256,uint256,uint256,address)"),
  v2Sync: toEventSelector("Sync(uint112,uint112)"),
  v2Mint: toEventSelector("Mint(address,uint256,uint256)"),
  v2Burn: toEventSelector("Burn(address,uint256,uint256,address)"),
  v3Swap: toEventSelector("Swap(address,address,int256,int256,uint160,uint128,int24)"),
  v3Mint: toEventSelector("Mint(address,address,int24,int24,uint128,uint256,uint256)"),
  v3Burn: toEventSelector("Burn(address,int24,int24,uint128,uint256,uint256)"),
} as const;

export const ALL_TOPICS: Hex[] = Object.values(TOPICS);

export interface RawLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: number;
  transactionIndex: number;
  logIndex: number;
  transactionHash: Hex;
}

/** A registered pool, already oriented: `token` is traded, `quote` prices it. */
export interface PoolRef {
  address: Address;
  dex: DexVersion;
  token0: Address;
  token1: Address;
  token: Address;
  quote: Address;
}

export interface TxInfo {
  from: Address;
  nonce: number;
}

export interface DecodeContext {
  chainId: number;
  timestamp: number;
  pool(address: Address): PoolRef | undefined;
  factory(address: Address): FactoryInfo | undefined;
  isWatchedToken(address: Address): boolean;
  tx(hash: string): TxInfo | undefined;
}

const HEX_RE = /^0x[0-9a-f]*$/i;

function word(data: Hex, i: number): bigint {
  return BigInt("0x" + data.slice(2 + i * 64, 2 + (i + 1) * 64));
}

function signedWord(data: Hex, i: number): bigint {
  return BigInt.asIntN(256, word(data, i));
}

function topicAddress(topic: Hex): Address {
  return ("0x" + topic.slice(26)).toLowerCase();
}

function wordAddress(data: Hex, i: number): Address {
  return ("0x" + data.slice(2 + i * 64 + 24, 2 + (i + 1) * 64)).toLowerCase();
}

function shapeOk(log: RawLog, topics: number, words: number): boolean {
  return log.topics.length === topics && HEX_RE.test(log.data) && log.data.length === 2 + words * 64;
}

function base(log: RawLog, ctx: DecodeContext): EventBase {
  return {
    chainId: ctx.chainId,
    blockNumber: log.blockNumber,
    transactionIndex: log.transactionIndex,
    logIndex: log.logIndex,
    txHash: log.transactionHash.toLowerCase(),
    timestamp: ctx.timestamp,
  };
}

/** Pool-perspective deltas (positive = pool received) → oriented trade, or null for a no-op. */
function orientTrade(pool: PoolRef, delta0: bigint, delta1: bigint): Pick<SwapEvent, "side" | "tokenAmount" | "quoteAmount"> | null {
  const tokenIs0 = pool.token === pool.token0;
  const tokenDelta = tokenIs0 ? delta0 : delta1;
  const quoteDelta = tokenIs0 ? delta1 : delta0;
  if (tokenDelta < 0n && quoteDelta > 0n) return { side: "buy", tokenAmount: -tokenDelta, quoteAmount: quoteDelta };
  if (tokenDelta > 0n && quoteDelta < 0n) return { side: "sell", tokenAmount: tokenDelta, quoteAmount: -quoteDelta };
  return null;
}

function swap(log: RawLog, ctx: DecodeContext, pool: PoolRef, delta0: bigint, delta1: bigint, routerOrRecipient: Address, sqrtPriceX96: bigint | null): SwapEvent | null {
  const trade = orientTrade(pool, delta0, delta1);
  if (!trade) return null;
  const tx = ctx.tx(log.transactionHash.toLowerCase());
  return {
    kind: "swap",
    ...base(log, ctx),
    pool: pool.address,
    dex: pool.dex,
    token: pool.token,
    quote: pool.quote,
    ...trade,
    trader: tx?.from ?? routerOrRecipient,
    traderNonce: tx?.nonce ?? null,
    recipient: routerOrRecipient,
    sqrtPriceX96,
  };
}

function liquidity(log: RawLog, ctx: DecodeContext, pool: PoolRef, action: "add" | "remove", amount0: bigint, amount1: bigint, fallbackProvider: Address): LiquidityEvent | null {
  if (amount0 === 0n && amount1 === 0n) return null; // V3 fee poke
  const tokenIs0 = pool.token === pool.token0;
  return {
    kind: "liquidity",
    ...base(log, ctx),
    pool: pool.address,
    dex: pool.dex,
    token: pool.token,
    quote: pool.quote,
    action,
    tokenAmount: tokenIs0 ? amount0 : amount1,
    quoteAmount: tokenIs0 ? amount1 : amount0,
    provider: ctx.tx(log.transactionHash.toLowerCase())?.from ?? fallbackProvider,
  };
}

export function decodeLog(log: RawLog, ctx: DecodeContext): ChainEvent | null {
  const topic0 = log.topics[0]?.toLowerCase();
  const address = log.address.toLowerCase();

  if (topic0 === TOPICS.transfer) {
    // 4-topic Transfer is ERC-721; only fungible transfers of watched tokens matter.
    if (!shapeOk(log, 3, 1) || !ctx.isWatchedToken(address)) return null;
    const evt: TransferEvent = {
      kind: "transfer",
      ...base(log, ctx),
      token: address,
      from: topicAddress(log.topics[1] as Hex),
      to: topicAddress(log.topics[2] as Hex),
      amount: word(log.data, 0),
    };
    return evt;
  }

  if (topic0 === TOPICS.pairCreated || topic0 === TOPICS.poolCreated) {
    const factory = ctx.factory(address);
    if (!factory) return null;
    const v2 = topic0 === TOPICS.pairCreated;
    if (v2 ? factory.dex !== "v2" || !shapeOk(log, 3, 2) : factory.dex !== "v3" || !shapeOk(log, 4, 2)) return null;
    const evt: PoolCreatedEvent = {
      kind: "pool_created",
      ...base(log, ctx),
      pool: v2 ? wordAddress(log.data, 0) : wordAddress(log.data, 1),
      dex: factory.dex,
      factory: address,
      token0: topicAddress(log.topics[1] as Hex),
      token1: topicAddress(log.topics[2] as Hex),
      fee: v2 ? null : Number(BigInt(log.topics[3] as Hex)),
    };
    return evt;
  }

  const pool = ctx.pool(address);
  if (!pool) return null;

  if (pool.dex === "v2") {
    if (topic0 === TOPICS.v2Swap && shapeOk(log, 3, 4)) {
      const [in0, in1, out0, out1] = [word(log.data, 0), word(log.data, 1), word(log.data, 2), word(log.data, 3)];
      return swap(log, ctx, pool, in0 - out0, in1 - out1, topicAddress(log.topics[2] as Hex), null);
    }
    if (topic0 === TOPICS.v2Sync && shapeOk(log, 1, 2)) {
      const [r0, r1] = [word(log.data, 0), word(log.data, 1)];
      const tokenIs0 = pool.token === pool.token0;
      const evt: ReservesEvent = {
        kind: "reserves",
        ...base(log, ctx),
        pool: pool.address,
        token: pool.token,
        quote: pool.quote,
        tokenReserve: tokenIs0 ? r0 : r1,
        quoteReserve: tokenIs0 ? r1 : r0,
      };
      return evt;
    }
    if (topic0 === TOPICS.v2Mint && shapeOk(log, 2, 2)) {
      return liquidity(log, ctx, pool, "add", word(log.data, 0), word(log.data, 1), topicAddress(log.topics[1] as Hex));
    }
    if (topic0 === TOPICS.v2Burn && shapeOk(log, 3, 2)) {
      return liquidity(log, ctx, pool, "remove", word(log.data, 0), word(log.data, 1), topicAddress(log.topics[2] as Hex));
    }
    return null;
  }

  if (topic0 === TOPICS.v3Swap && shapeOk(log, 3, 5)) {
    return swap(log, ctx, pool, signedWord(log.data, 0), signedWord(log.data, 1), topicAddress(log.topics[2] as Hex), word(log.data, 2));
  }
  if (topic0 === TOPICS.v3Mint && shapeOk(log, 4, 4)) {
    return liquidity(log, ctx, pool, "add", word(log.data, 2), word(log.data, 3), topicAddress(log.topics[1] as Hex));
  }
  if (topic0 === TOPICS.v3Burn && shapeOk(log, 4, 3)) {
    return liquidity(log, ctx, pool, "remove", word(log.data, 1), word(log.data, 2), topicAddress(log.topics[1] as Hex));
  }
  return null;
}
