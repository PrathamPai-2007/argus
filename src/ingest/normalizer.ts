import { decodeFunctionData, toEventSelector, toFunctionSelector, type Hex } from "viem";
import type { Address, FundingEvent, PoolCreatedEvent, StandardTransferEvent, SwapEvent } from "../types.ts";

// Chain-specific raw logs → typed standard events (PLAN.md §4, layer 2).
// Pure functions — fully testable offline against recorded fixtures.

export interface RawLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: number;
  transactionIndex?: number;
  logIndex: number;
  transactionHash: Hex;
}

export const ERC20_TRANSFER_TOPIC: Hex = toEventSelector("Transfer(address,address,uint256)");
export const UNIV2_PAIR_CREATED_TOPIC: Hex = toEventSelector("PairCreated(address,address,address,uint256)");
export const UNIV2_SWAP_TOPIC: Hex = toEventSelector("Swap(address,uint256,uint256,uint256,uint256,address)");

function topicToAddress(topic: Hex): Address {
  return ("0x" + topic.slice(26)).toLowerCase();
}

function validHex(value: unknown, bytes?: number): value is Hex {
  return typeof value === "string" && /^0x[0-9a-f]*$/i.test(value) && value.length % 2 === 0 && (bytes === undefined || value.length === 2 + bytes * 2);
}

function validRawLog(log: RawLog, dataBytes: number, topicCount: number): boolean {
  return validHex(log.address, 20) && validHex(log.transactionHash, 32) &&
    Number.isSafeInteger(log.blockNumber) && log.blockNumber >= 0 &&
    Number.isSafeInteger(log.logIndex) && log.logIndex >= 0 &&
    (log.transactionIndex === undefined || (Number.isSafeInteger(log.transactionIndex) && log.transactionIndex >= 0)) &&
    Array.isArray(log.topics) && log.topics.length === topicCount && log.topics.every((topic) => validHex(topic, 32)) && validHex(log.data, dataBytes);
}

/** ERC-20 Transfer log → StandardTransferEvent. Returns null for non-Transfer or ERC-721 (4 topics). */
export function normalizeTransfer(log: RawLog, chainId: number, timestamp: number, tokenAddress?: Address): StandardTransferEvent | null {
  if (!validRawLog(log, 32, 3) || log.topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC) return null;
  return {
    kind: "transfer",
    chainId,
    tokenAddress: (tokenAddress ?? log.address).toLowerCase(),
    sender: topicToAddress(log.topics[1] as Hex),
    receiver: topicToAddress(log.topics[2] as Hex),
    amount: BigInt(log.data),
    txHash: log.transactionHash,
    blockNumber: log.blockNumber,
    ...(log.transactionIndex === undefined ? {} : { transactionIndex: log.transactionIndex }),
    logIndex: log.logIndex,
    timestamp,
  };
}

/** Uniswap V2-style factory PairCreated log → PoolCreatedEvent. */
export function normalizePairCreated(log: RawLog, chainId: number, factoryName: string, timestamp: number): PoolCreatedEvent | null {
  if (!validRawLog(log, 64, 3) || log.topics[0]?.toLowerCase() !== UNIV2_PAIR_CREATED_TOPIC) return null;
  // data = abi.encode(address pair, uint256)
  const pair = ("0x" + (log.data as string).slice(26, 66)).toLowerCase();
  return {
    kind: "pool_created",
    chainId,
    factory: factoryName,
    poolAddress: pair,
    token0: topicToAddress(log.topics[1] as Hex),
    token1: topicToAddress(log.topics[2] as Hex),
    txHash: log.transactionHash,
    blockNumber: log.blockNumber,
    ...(log.transactionIndex === undefined ? {} : { transactionIndex: log.transactionIndex }),
    logIndex: log.logIndex,
    timestamp,
  };
}

/**
 * Uniswap V2-style pool Swap log → SwapEvent (PLAN.md §7, R2/R7 inputs).
 * `watchedIsToken0` tells the adapter which side of the pair is the watched
 * token so buy/sell direction can be derived from the amount0/amount1 fields.
 */
export function normalizeSwap(
  log: RawLog,
  chainId: number,
  tokenAddress: Address,
  poolAddress: Address,
  watchedIsToken0: boolean,
  timestamp: number,
): SwapEvent | null {
  if (!validRawLog(log, 128, 3) || log.topics[0]?.toLowerCase() !== UNIV2_SWAP_TOPIC) return null;
  const data = log.data as string;
  const amount0In = BigInt("0x" + data.slice(2, 66));
  const amount1In = BigInt("0x" + data.slice(66, 130));
  const amount0Out = BigInt("0x" + data.slice(130, 194));
  const amount1Out = BigInt("0x" + data.slice(194, 258));
  const watchedIn = watchedIsToken0 ? amount0In : amount1In;
  const watchedOut = watchedIsToken0 ? amount0Out : amount1Out;
  const quoteIn = watchedIsToken0 ? amount1In : amount0In;
  const quoteOut = watchedIsToken0 ? amount1Out : amount0Out;
  const sender = topicToAddress(log.topics[1] as Hex);
  const to = topicToAddress(log.topics[2] as Hex);

  if (watchedOut > 0n) {
    return {
      kind: "swap",
      chainId,
      poolAddress,
      tokenAddress,
      buyer: to,
      direction: "buy",
      tokenAmount: watchedOut,
      quoteAmount: quoteIn,
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
      ...(log.transactionIndex === undefined ? {} : { transactionIndex: log.transactionIndex }),
      logIndex: log.logIndex,
      timestamp,
    };
  }
  if (watchedIn > 0n) {
    return {
      kind: "swap",
      chainId,
      poolAddress,
      tokenAddress,
      buyer: sender,
      direction: "sell",
      tokenAmount: watchedIn,
      quoteAmount: quoteOut,
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
      ...(log.transactionIndex === undefined ? {} : { transactionIndex: log.transactionIndex }),
      logIndex: log.logIndex,
      timestamp,
    };
  }
  return null;
}

// ---- Disperse / batch-sender calldata → funding edges (PLAN.md §6) ---------

const DISPERSE_ABI = [
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

export const DISPERSE_ETHER_SELECTOR: Hex = toFunctionSelector("disperseEther(address[],uint256[])");
export const DISPERSE_TOKEN_SELECTOR: Hex = toFunctionSelector("disperseToken(address,address[],uint256[])");

export interface DispersePayout {
  recipients: Address[];
  values: bigint[];
  kind: "ether" | "token";
  tokenAddress?: Address;
}

/** Decode disperseEther/disperseToken calldata. Returns null if not a disperse call. */
export function decodeDisperseCalldata(input: Hex): DispersePayout | null {
  const selector = input.slice(0, 10) as Hex;
  if (selector !== DISPERSE_ETHER_SELECTOR && selector !== DISPERSE_TOKEN_SELECTOR) return null;
  try {
    const decoded = decodeFunctionData({ abi: DISPERSE_ABI, data: input });
    if (decoded.functionName === "disperseEther") {
      const [recipients, values] = decoded.args as [Address[], bigint[]];
      return { recipients: recipients.map((r) => r.toLowerCase()), values: [...values], kind: "ether" };
    }
    const [token, recipients, values] = decoded.args as [Address, Address[], bigint[]];
    return { recipients: recipients.map((r) => r.toLowerCase()), values: [...values], kind: "token", tokenAddress: token.toLowerCase() };
  } catch {
    return null;
  }
}

/** Build a FundingEvent (shared by native transfers, disperse payouts, internal calls). */
export function fundingEvent(args: {
  chainId: number;
  funder: Address;
  funded: Address;
  amount: bigint;
  method: FundingEvent["method"];
  txHash: string;
  blockNumber: number;
  logIndex: number;
  timestamp: number;
}): FundingEvent {
  return { kind: "funding", ...args };
}
