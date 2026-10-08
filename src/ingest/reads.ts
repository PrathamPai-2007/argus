import { decodeFunctionResult, encodeFunctionData, parseAbi, type Hex } from "viem";
import { chainInfo, orientPair } from "../chains.ts";
import type { Address, ZERO_ADDRESS } from "../model.ts";
import type { PoolRef } from "./decode.ts";
import type { RpcPool } from "./rpc.ts";

// Batched eth_call reads. One JSON-RPC batch per logical question keeps
// metadata and pool discovery to a single round trip on providers that batch.

const ERC20 = parseAbi([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const FACTORY = parseAbi([
  "function getPair(address,address) view returns (address)",
  "function getPool(address,address,uint24) view returns (address)",
]);
const V3_FEES = [100, 500, 3000, 10_000];
const NONE: typeof ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

type Rpc = Pick<RpcPool, "settle">;
type Call = { to: Address; data: Hex };

/** eth_call each item; failures (reverts, non-contracts) come back as null. */
async function callAll(rpc: Rpc, calls: Call[]): Promise<Array<Hex | null>> {
  return (await rpc.settle(calls.map((c) => ({ method: "eth_call", params: [{ to: c.to, data: c.data }, "latest"] })))) as Array<Hex | null>;
}

function decode<T>(fn: "symbol" | "name" | "decimals" | "totalSupply" | "balanceOf", data: Hex | null): T | null {
  if (!data || data === "0x") return null;
  try {
    return decodeFunctionResult({ abi: ERC20, functionName: fn, data }) as T;
  } catch {
    return null;
  }
}

export interface TokenMetaRead {
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  totalSupply: bigint | null;
}

export async function readTokenMeta(rpc: Rpc, token: Address): Promise<TokenMetaRead> {
  const fns = ["symbol", "name", "decimals", "totalSupply"] as const;
  const out = await callAll(rpc, fns.map((fn) => ({ to: token, data: encodeFunctionData({ abi: ERC20, functionName: fn }) })));
  const clean = (s: string | null) => (s === null ? null : s.replace(/[\u0000-\u001f]/g, "").slice(0, 64) || null);
  const decimals = decode<number>("decimals", out[2] ?? null);
  return {
    symbol: clean(decode<string>("symbol", out[0] ?? null)),
    name: clean(decode<string>("name", out[1] ?? null)),
    decimals: decimals !== null && decimals >= 0 && decimals <= 36 ? Number(decimals) : null,
    totalSupply: decode<bigint>("totalSupply", out[3] ?? null),
  };
}

/** Every V2/V3 pool of `token` against the chain's known quotes. */
export async function discoverPools(rpc: Rpc, chainId: number, token: Address): Promise<PoolRef[]> {
  const info = chainInfo(chainId);
  const asks: Array<{ call: Call; dex: "v2" | "v3"; quote: Address }> = [];
  for (const quote of Object.keys(info.quotes)) {
    if (quote === token) continue;
    for (const f of info.factories) {
      if (f.dex === "v2") asks.push({ dex: "v2", quote, call: { to: f.address, data: encodeFunctionData({ abi: FACTORY, functionName: "getPair", args: [token as Hex, quote as Hex] }) } });
      else for (const fee of V3_FEES) asks.push({ dex: "v3", quote, call: { to: f.address, data: encodeFunctionData({ abi: FACTORY, functionName: "getPool", args: [token as Hex, quote as Hex, fee] }) } });
    }
  }
  const results = await callAll(rpc, asks.map((a) => a.call));
  const pools: PoolRef[] = [];
  results.forEach((data, i) => {
    if (!data || data.length < 66) return;
    const pool = ("0x" + data.slice(-40)).toLowerCase();
    if (pool === NONE) return;
    const ask = asks[i]!;
    const [token0, token1] = token < ask.quote ? [token, ask.quote] : [ask.quote, token];
    const orient = orientPair(chainId, token0, token1);
    if (orient) pools.push({ address: pool, dex: ask.dex, token0, token1, ...orient });
  });
  return pools;
}

/** Token/quote balances held by a pool (V3 liquidity baseline). */
export async function readPoolBalances(rpc: Rpc, pool: PoolRef): Promise<{ tokenBalance: bigint; quoteBalance: bigint } | null> {
  const [t, q] = await callAll(rpc, [pool.token, pool.quote].map((to) => ({ to, data: encodeFunctionData({ abi: ERC20, functionName: "balanceOf", args: [pool.address as Hex] }) })));
  const tokenBalance = decode<bigint>("balanceOf", t ?? null);
  const quoteBalance = decode<bigint>("balanceOf", q ?? null);
  return tokenBalance === null || quoteBalance === null ? null : { tokenBalance, quoteBalance };
}
