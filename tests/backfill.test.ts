import { afterEach, describe, expect, test } from "bun:test";
import { fetchEtherscanLogs } from "../src/ingest/etherscan.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("historical providers", () => {
  test("parses paginated Etherscan logs", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      const result = calls === 1
        ? Array.from({ length: 1000 }, (_, i) => ({
            address: "0x" + "aa".repeat(20), topics: ["0x" + "11".repeat(32)], data: "0x", blockNumber: String(100 + i),
            transactionHash: "0x" + "22".repeat(32), transactionIndex: "0", logIndex: String(i), timeStamp: "1700000000",
          }))
        : [{
            address: "0x" + "aa".repeat(20), topics: ["0x" + "11".repeat(32)], data: "0x", blockNumber: "103",
            transactionHash: "0x" + "33".repeat(32), transactionIndex: "0", logIndex: "0", timeStamp: "1700000001",
          }];
      return new Response(JSON.stringify({ status: "1", message: "OK", result }));
    }) as unknown as typeof fetch;

    const logs = await fetchEtherscanLogs({
      apiUrl: "https://example.test/api",
      apiKey: "secret",
      chainId: 1,
      addresses: ["0x" + "aa".repeat(20)],
      topic0: ("0x" + "11".repeat(32)) as `0x${string}`,
      fromBlock: 100n,
      toBlock: 103n,
    });
    expect(calls).toBe(2);
    expect(logs).toHaveLength(1001);
    expect(logs[0]?.blockNumber).toBe(100n);
  });

  test("reports per-request progress via onRequest", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ status: "1", message: "OK", result: [{
        address: "0x" + "aa".repeat(20), topics: ["0x" + "11".repeat(32)], data: "0x", blockNumber: "100",
        transactionHash: "0x" + "22".repeat(32), transactionIndex: "0", logIndex: "0", timeStamp: "1700000000",
      }] }));
    }) as unknown as typeof fetch;
    let onRequestCalls = 0;
    await fetchEtherscanLogs({
      apiUrl: "https://example.test/api", apiKey: "secret", chainId: 1,
      addresses: ["0x" + "aa".repeat(20)], topic0: ("0x" + "11".repeat(32)) as `0x${string}`, fromBlock: 100n, toBlock: 108n,
      onRequest: () => { onRequestCalls++; },
    });
    expect(onRequestCalls).toBe(calls);
    expect(onRequestCalls).toBeGreaterThan(0);
  });

  test("does not treat an empty Etherscan result as an error", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ status: "0", message: "No records found", result: [] }))) as unknown as typeof fetch;
    const logs = await fetchEtherscanLogs({
      apiUrl: "https://example.test/api", apiKey: "secret", chainId: 1,
      addresses: ["0x" + "aa".repeat(20)], topic0: ("0x" + "11".repeat(32)) as `0x${string}`, fromBlock: 1n, toBlock: 2n,
    });
    expect(logs).toHaveLength(0);
  });

  test("single-block ranges that still exceed the 10k window throw a descriptive error", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ status: "0", message: "NOTOK", result: "Result window is too large" }))) as unknown as typeof fetch;
    await expect(
      fetchEtherscanLogs({
        apiUrl: "https://example.test/api", apiKey: "secret", chainId: 1,
        addresses: ["0x" + "aa".repeat(20)], topic0: ("0x" + "11".repeat(32)) as `0x${string}`, fromBlock: 100n, toBlock: 100n,
      }),
    ).rejects.toThrow(/Etherscan logs failed \(0xaa/);
  });
});
