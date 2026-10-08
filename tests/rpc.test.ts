import { afterEach, describe, expect, test } from "bun:test";
import { limitsFor, RpcPool } from "../src/ingest/rpc.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

type Body = { id: number; method: string } | Array<{ id: number; method: string }>;

function mockFetch(handler: (url: string, body: Body) => Response | Promise<Response>): string[] {
  const seen: string[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push(url);
    return handler(url, JSON.parse(String(init.body)) as Body);
  }) as unknown as typeof fetch;
  return seen;
}

const ok = (body: Body, result: (m: string) => unknown) =>
  new Response(JSON.stringify(Array.isArray(body) ? body.map((b) => ({ id: b.id, result: result(b.method) })) : { id: body.id, result: result(body.method) }));

describe("RpcPool", () => {
  test("infers provider limits from the host", () => {
    expect(limitsFor("https://base.drpc.org").maxBatch).toBe(3);
    expect(limitsFor("https://ethereum-rpc.publicnode.com").maxBatch).toBe(500);
  });

  test("splits batches by the endpoint's max batch size and preserves order", async () => {
    const sizes: number[] = [];
    mockFetch((_u, body) => {
      sizes.push(Array.isArray(body) ? body.length : 1);
      return ok(body, (m) => m);
    });
    const pool = new RpcPool(["https://eth.drpc.org"]);
    const out = await pool.batch(Array.from({ length: 7 }, (_, i) => ({ method: `m${i}`, params: [] })));
    expect(out).toEqual(["m0", "m1", "m2", "m3", "m4", "m5", "m6"]);
    expect(sizes).toEqual([3, 3, 1]);
  });

  test("fails over on rate limiting and cools the failing endpoint", async () => {
    const seen = mockFetch((url, body) => url.includes("a.test")
      ? new Response(JSON.stringify({ id: (body as { id: number }).id, error: { code: -32005, message: "rate limit" } }))
      : ok(body, () => "0x10"));
    const pool = new RpcPool(["https://a.test", "https://b.test"]);
    expect(await pool.request<string>("eth_blockNumber", [])).toBe("0x10");
    expect(await pool.request<string>("eth_blockNumber", [])).toBe("0x10");
    expect(seen).toEqual(["https://a.test", "https://b.test", "https://b.test"]);
    expect(pool.endpointStatus()[0]?.healthy).toBe(false);
  });

  test("non-retryable errors surface immediately without failover", async () => {
    const seen = mockFetch((_u, body) => new Response(JSON.stringify({ id: (body as { id: number }).id, error: { code: -32602, message: "invalid argument 0" } })));
    const pool = new RpcPool(["https://a.test", "https://b.test"]);
    await expect(pool.request("eth_getLogs", [{}])).rejects.toThrow("invalid argument");
    expect(seen).toHaveLength(1);
  });

  test("coalesces identical in-flight requests", async () => {
    let calls = 0;
    mockFetch(async (_u, body) => { calls++; await new Promise((r) => setTimeout(r, 10)); return ok(body, () => "0x1"); });
    const pool = new RpcPool(["https://a.test"]);
    await Promise.all([pool.request("eth_chainId", []), pool.request("eth_chainId", []), pool.request("eth_chainId", [])]);
    expect(calls).toBe(1);
  });
});

test("settle() nulls out reverted calls without failing the batch", async () => {
  mockFetch((_u, body) => new Response(JSON.stringify((body as Array<{ id: number }>).map((b, i) =>
    i === 1 ? { id: b.id, error: { code: 3, message: "execution reverted" } } : { id: b.id, result: "0x01" }))));
  const pool = new RpcPool(["https://a.test"]);
  expect(await pool.settle([{ method: "eth_call", params: [] }, { method: "eth_call", params: [] }, { method: "eth_call", params: [] }])).toEqual(["0x01", null, "0x01"]);
  await expect(pool.batch([{ method: "eth_call", params: [] }, { method: "eth_call", params: [] }])).rejects.toThrow("reverted");
});
