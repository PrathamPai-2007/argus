import type { Log as ViemLog } from "viem";
import type { Address } from "../types.ts";

export type IndexedEvent = "transfer" | "pair_created" | "swap";

interface EtherscanRow {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  transactionIndex: string;
  logIndex: string;
  timeStamp?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const INITIAL_RANGE_BLOCKS = 256n;

function asNumber(value: string): number {
  const n = value.startsWith("0x") ? Number.parseInt(value, 16) : Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`Etherscan log has invalid numeric field: ${value}`);
  return n;
}

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Etherscan log missing ${field}`);
  return value;
}

function validateQuery(args: { addresses: Address[]; topic0: string; fromBlock: bigint; toBlock: bigint }): void {
  if (args.fromBlock < 0n || args.toBlock < args.fromBlock) throw new Error("Etherscan log range is invalid");
  if (args.addresses.length === 0 || args.addresses.some((a) => !/^0x[0-9a-f]{40}$/i.test(a))) throw new Error("Etherscan log address is invalid");
  if (!/^0x[0-9a-f]{64}$/i.test(args.topic0)) throw new Error("Etherscan topic0 is invalid");
}

export async function fetchEtherscanLogs(args: {
  apiUrl: string;
  apiKey: string;
  chainId: number;
  addresses: Address[];
  topic0: `0x${string}`;
  fromBlock: bigint;
  toBlock: bigint;
  requestsPerSecond?: number;
  signal?: AbortSignal;
  onRequest?: () => void;
}): Promise<ViemLog[]> {
  validateQuery(args);
  const out: ViemLog[] = [];
  const delay = Math.ceil(1000 / Math.max(1, args.requestsPerSecond ?? 3));
  let requestCount = 0;
  const fetchRange = async (address: Address, fromBlock: bigint, toBlock: bigint): Promise<ViemLog[]> => {
    // Start with a useful range and recursively split only when Etherscan says
    // the result window is too large. The previous unconditional four-block
    // split turned a few hundred blocks and dozens of tokens into thousands of
    // sequential requests before any cursor progress was reported.
    if (toBlock - fromBlock + 1n > INITIAL_RANGE_BLOCKS) {
      const mid = fromBlock + (toBlock - fromBlock) / 2n;
      return [...await fetchRange(address, fromBlock, mid), ...await fetchRange(address, mid + 1n, toBlock)];
    }
    const rangeLogs: ViemLog[] = [];
    let page = 1;
    let rateRetries = 0;
    while (true) {
      if (requestCount++ > 0) await sleep(delay);
      const url = new URL(args.apiUrl);
      url.searchParams.set("chainid", String(args.chainId));
      url.searchParams.set("module", "logs");
      url.searchParams.set("action", "getLogs");
      url.searchParams.set("address", address);
      url.searchParams.set("fromBlock", String(fromBlock));
      url.searchParams.set("toBlock", String(toBlock));
      url.searchParams.set("topic0", args.topic0);
      url.searchParams.set("page", String(page));
      url.searchParams.set("offset", "1000");
      url.searchParams.set("apikey", args.apiKey);
      const response = await fetch(url, args.signal ? { signal: args.signal } : undefined);
      if (!response.ok) throw new Error(`Etherscan HTTP ${response.status}`);
      const body = await response.json() as { status?: string; message?: string; result?: EtherscanRow[] | string };
      args.onRequest?.();
      const responseText = `${body.message ?? ""} ${typeof body.result === "string" ? body.result : ""}`.toLowerCase();
      if (responseText.includes("max calls per sec") || responseText.includes("rate limit")) {
        if (rateRetries++ >= 5) throw new Error(`Etherscan rate limit persisted for ${address} ${fromBlock}..${toBlock}`);
        await sleep(Math.max(delay, 1_500));
        continue;
      }
      if (body.status === "0" && body.message === "No records found") break;
      if (body.status !== "1" || !Array.isArray(body.result)) {
        const detail = typeof body.result === "string" ? `: ${body.result}` : "";
        if ((body.message?.includes("NOTOK") || body.message?.includes("Result window is too large") || body.result?.toString().includes("Result window is too large")) && fromBlock < toBlock) {
          const mid = fromBlock + (toBlock - fromBlock) / 2n;
          return [...await fetchRange(address, fromBlock, mid), ...await fetchRange(address, mid + 1n, toBlock)];
        }
        // A single block that still exceeds the 10k-row window cannot be split
        // further here — the adapter falls back to the RPC for the session.
        throw new Error(`Etherscan logs failed (${address} ${fromBlock}..${toBlock}): ${body.message ?? "invalid response"}${detail}`);
      }
      for (const row of body.result) {
        const blockNumber = asNumber(required(row.blockNumber, "blockNumber"));
        const transactionHash = required(row.transactionHash, "transactionHash");
        const transactionIndex = asNumber(required(row.transactionIndex, "transactionIndex"));
        const logIndex = asNumber(required(row.logIndex, "logIndex"));
        rangeLogs.push({
          address: row.address as `0x${string}`,
          topics: row.topics as `0x${string}`[],
          data: row.data as `0x${string}`,
          blockNumber: BigInt(blockNumber),
          transactionHash: transactionHash as `0x${string}`,
          transactionIndex,
          logIndex,
          ...(row.timeStamp ? { blockTimestamp: asNumber(row.timeStamp) } : {}),
        } as unknown as ViemLog);
      }
      if (body.result.length < 1000) break;
      page++;
    }
    return rangeLogs;
  };
  for (const address of args.addresses) {
    out.push(...await fetchRange(address, args.fromBlock, args.toBlock));
  }
  return out.sort((a, b) => Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n)) || (a.transactionIndex ?? 0) - (b.transactionIndex ?? 0) || (a.logIndex ?? 0) - (b.logIndex ?? 0));
}
