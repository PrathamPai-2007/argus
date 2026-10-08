import { afterEach, expect, test } from "bun:test";
import { FunderResolver, type FunderResult } from "../src/ingest/funders.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const W = "0x" + "aa".repeat(20);
const HUMAN = "0x" + "bb".repeat(20);
const EXCHANGE = "0x" + "cc".repeat(20);

test("resolves the earliest inbound funding across normal and internal txs, and flags service funders", async () => {
  globalThis.fetch = (async (url: URL) => {
    const action = url.searchParams.get("action");
    const result = action === "txlist"
      ? [
          { blockNumber: "120", from: W, to: HUMAN, value: "5" }, // outgoing: ignored
          { blockNumber: "110", from: HUMAN, to: W, value: "0" }, // zero value: ignored
          { blockNumber: "130", from: HUMAN, to: W, value: "100" },
        ]
      : [{ blockNumber: "101", from: EXCHANGE, to: W, value: "7", isError: "0" }]; // internal (e.g. Disperse) and earlier
    return new Response(JSON.stringify({ status: "1", message: "OK", result }));
  }) as unknown as typeof fetch;

  const rpc = { batch: async (calls: Array<{ params: unknown[] }>) => calls.map((c) => (c.params[0] === EXCHANGE ? "0x2710" : "0x3")) };
  const results: FunderResult[] = [];
  const resolver = new FunderResolver(1, { apiUrl: "https://explorer.test/api", apiKey: "k", chainParam: { name: "chainid", value: 1 }, requestsPerSecond: 1000 }, rpc, (r) => results.push(r));
  resolver.enqueue(W);
  for (let i = 0; i < 50 && results.length === 0; i++) await new Promise((r) => setTimeout(r, 10));

  expect(results).toEqual([{ wallet: W, funder: EXCHANGE, fundedBlock: 101, funderIsService: true }]);
});
