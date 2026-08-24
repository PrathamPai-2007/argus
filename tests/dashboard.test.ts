import { beforeEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
import { closeDb, insertEvents, openDb, upsertToken, insertPool, insertAlert, insertSignal, insertFundingEdge } from "../src/db.ts";
import { ArgusEngine } from "../src/engine.ts";
import { DashboardServer } from "../src/dashboard/server.ts";
import { renderPage } from "../src/dashboard/page.ts";
import { ZERO_ADDRESS } from "../src/types.ts";

describe("DashboardServer", () => {
  beforeEach(() => {
    closeDb();
    openDb(":memory:");
  });

  test("generated dashboard script is valid JavaScript", () => {
    const html = renderPage();
    const start = html.indexOf("<script>");
    const end = html.indexOf("</script>");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(() => new Function(html.slice(start + "<script>".length, end))).not.toThrow();
    expect(html).not.toContain("sideStatus");
  });

  test("serves endpoints and serializes BigInts without throwing", async () => {
    const cfg = await loadConfig();
    const testToken = "0x1111111111111111111111111111111111111111";

    upsertToken({
      chainId: 1,
      address: testToken,
      symbol: "TEST",
      decimals: 18,
      totalSupply: 1_000_000_000_000_000_000_000_000n,
      source: "manual",
    });

    insertPool({
      chainId: 1,
      poolAddress: "0x2222222222222222222222222222222222222222",
      tokenAddress: testToken,
      quoteToken: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
      factory: "uniswap-v2",
      createdBlock: 100,
    });

    insertEvents(
      [
        {
          chainId: 1,
          blockNumber: 100,
          logIndex: 0,
          txHash: "0xabc",
          timestamp: Math.floor(Date.now() / 1000),
          kind: "transfer",
          tokenAddress: testToken,
          sender: "0x3333333333333333333333333333333333333333",
          receiver: "0x4444444444444444444444444444444444444444",
          amount: 500_000_000_000_000_000_000n,
        },
      ],
      true,
    );

    insertSignal({
      chainId: 1,
      tokenAddress: testToken,
      ruleId: "R1",
      weight: 35,
      evidence: { supplyPct: 20 },
      blockNumber: 100,
      timestamp: Math.floor(Date.now() / 1000),
    });

    insertAlert(
      {
        chainId: 1,
        tokenAddress: testToken,
        score: 75,
        severity: "alert",
        signals: [],
        headline: "Cluster accumulation detected",
        lines: [],
        links: { dexscreener: "", bubblemaps: "", dashboard: "" },
      },
      true,
      100,
    );

    const engine = new ArgusEngine(cfg);
    const dashboard = new DashboardServer(engine, { port: 3740 });
    dashboard.start();

    try {
      // GET /
      const resRoot = await fetch("http://127.0.0.1:3740/");
      expect(resRoot.status).toBe(200);
      expect(resRoot.headers.get("content-type")).toContain("text/html");
      const html = await resRoot.text();
      expect(html).toContain("ARGUS");

      // GET /token/1/0x...
      const resTokenPage = await fetch(`http://127.0.0.1:3740/token/1/${testToken}`);
      expect(resTokenPage.status).toBe(200);
      expect(await resTokenPage.text()).toContain("ARGUS");

      // GET /api/status
      const resStatus = await fetch("http://127.0.0.1:3740/api/status");
      expect(resStatus.status).toBe(200);

      const resMetrics = await fetch("http://127.0.0.1:3740/api/metrics");
      expect(resMetrics.status).toBe(200);
      expect(((await resMetrics.json()) as any).activeWatches).toBe(1);

      const resSnapshot = await fetch("http://127.0.0.1:3740/api/snapshot");
      expect(resSnapshot.status).toBe(200);
      const snapshot = (await resSnapshot.json()) as any;
      expect(snapshot.tokens).toHaveLength(1);
      expect(snapshot.metrics.activeWatches).toBe(1);

      // GET /api/tokens (tests BigInt serialization of totalSupply)
      const resTokens = await fetch("http://127.0.0.1:3740/api/tokens");
      expect(resTokens.status).toBe(200);
      const tokensJson = (await resTokens.json()) as any[];
      expect(tokensJson.length).toBeGreaterThan(0);
      expect(tokensJson[0].totalSupply).toBe("1000000000000000000000000");

      // GET /api/events/recent
      const resEvents = await fetch("http://127.0.0.1:3740/api/events/recent");
      expect(resEvents.status).toBe(200);
      const eventsJson = (await resEvents.json()) as any[];
      expect(eventsJson.length).toBe(1);
      expect(eventsJson[0].type).toBe("transfer");
      expect(eventsJson[0].tx_hash).toBe("0xabc");

      // GET /api/alerts
      const resAlerts = await fetch("http://127.0.0.1:3740/api/alerts");
      expect(resAlerts.status).toBe(200);
      const alertsJson = (await resAlerts.json()) as any[];
      expect(alertsJson.length).toBe(1);

      // GET /api/signals
      const resSignals = await fetch("http://127.0.0.1:3740/api/signals");
      expect(resSignals.status).toBe(200);

      // GET /api/token/1/:token
      const resTokenDetail = await fetch(`http://127.0.0.1:3740/api/token/1/${testToken}`);
      expect(resTokenDetail.status).toBe(200);
      const detailJson = (await resTokenDetail.json()) as any;
      expect(detailJson.token).not.toBeNull();
      expect(detailJson.token.totalSupply).toBe("1000000000000000000000000");
      expect(detailJson.pools.length).toBe(1);
      expect(detailJson.alerts.length).toBe(1);
      expect(detailJson.signals.length).toBe(1);
      expect(detailJson.recentEvents).toHaveLength(1);
      expect(detailJson.recentEventSummary).toMatchObject({ count: 1, finalized: 1, latestBlock: 100, kinds: { transfer: 1 } });
      expect(detailJson.availability).toEqual({ metadata: true, graph: false, history: true, events: true });

      // GET /api/token/1/:token with Accept: text/html
      const resTokenHtml = await fetch(`http://127.0.0.1:3740/api/token/1/${testToken}`, {
        headers: { accept: "text/html" },
      });
      expect(resTokenHtml.status).toBe(200);
      expect(resTokenHtml.headers.get("content-type")).toContain("text/html");
    } finally {
      dashboard.stop();
    }
  });

  test("token deep-link reports missing persisted data without backfilling", async () => {
    const cfg = await loadConfig();
    const address = "0x9999999999999999999999999999999999999999";
    const dashboard = new DashboardServer(new ArgusEngine(cfg), { port: 3744 });
    dashboard.start();
    try {
      const res = await fetch(`http://127.0.0.1:3744/api/token/1/${address}`);
      expect(res.status).toBe(200);
      const detail = (await res.json()) as any;
      expect(detail.token).toBeNull();
      expect(detail.recentEvents).toEqual([]);
      expect(detail.recentEventSummary).toMatchObject({ count: 0, latestBlock: null, latestTimestamp: null });
      expect(detail.availability).toEqual({ metadata: false, graph: false, history: false, events: false });
      expect(renderPage()).toContain("Missing projections are reported, not backfilled");
    } finally {
      dashboard.stop();
    }
  });

  test("SSE event stream sends hello message and alert broadcast", async () => {
    const cfg = await loadConfig();
    const engine = new ArgusEngine(cfg);
    const dashboard = new DashboardServer(engine, { port: 3741 });
    dashboard.start();

    try {
      const resStream = await fetch("http://127.0.0.1:3741/events/stream");
      expect(resStream.status).toBe(200);
      expect(resStream.headers.get("content-type")).toContain("text/event-stream");

      const reader = resStream.body?.getReader();
      expect(reader).not.toBeUndefined();

      const chunk = await reader!.read();
      const text = new TextDecoder().decode(chunk.value);
      expect(text).toContain("data: {\"type\":\"hello\"");
    } finally {
      dashboard.stop();
    }
  });

  test("graph API exposes clusters and funding edges", async () => {
    const cfg = await loadConfig();
    const token = "0x1111111111111111111111111111111111111111";
    const funder = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const walletA = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const walletB = "0xcccccccccccccccccccccccccccccccccccccccc";

    upsertToken({ chainId: 1, address: token, symbol: "TEST", decimals: 18, totalSupply: 1000n, source: "manual" });
    insertFundingEdge({ funder, funded: walletA, chainId: 1, amount: 50n, blockNumber: 90, method: "native_transfer" });
    insertFundingEdge({ funder, funded: walletB, chainId: 1, amount: 50n, blockNumber: 91, method: "native_transfer" });

    const engine = new ArgusEngine(cfg);
    const graph = engine.graphView();
    graph.setTotalSupply(token, 1000n);
    const ts = Math.floor(Date.now() / 1000);
    graph.applyEvent({ chainId: 1, blockNumber: 90, logIndex: 0, txHash: "0x1", timestamp: ts, kind: "funding", funder, funded: walletA, amount: 50n, method: "native_transfer" });
    graph.applyEvent({ chainId: 1, blockNumber: 91, logIndex: 0, txHash: "0x2", timestamp: ts, kind: "funding", funder, funded: walletB, amount: 50n, method: "native_transfer" });
    graph.applyEvent({ chainId: 1, blockNumber: 92, logIndex: 0, txHash: "0x3", timestamp: ts, kind: "transfer", tokenAddress: token, sender: ZERO_ADDRESS, receiver: walletA, amount: 100n });
    graph.applyEvent({ chainId: 1, blockNumber: 93, logIndex: 0, txHash: "0x4", timestamp: ts, kind: "transfer", tokenAddress: token, sender: ZERO_ADDRESS, receiver: walletB, amount: 200n });

    const dashboard = new DashboardServer(engine, { port: 3742 });
    dashboard.start();
    try {
      const res = await fetch(`http://127.0.0.1:3742/api/graph/token/1/${token}`);
      expect(res.status).toBe(200);
      const g = (await res.json()) as any;
      expect(g.totalSupply).toBe("1000");
      expect(g.circulatingSupply).toBe("1000");
      expect(g.clusters.length).toBe(1);
      const cluster = g.clusters[0] as any;
      expect(cluster.memberCount).toBe(3);
      expect(cluster.pctOfSupply).toBe(30);
      const memberAddrs = (cluster.members as any[]).map((m: any) => m.address).sort();
      expect(memberAddrs).toEqual([funder, walletA, walletB].sort());
      const memberBalances = (cluster.members as any[]).reduce<Record<string, string>>((acc, m) => ({ ...acc, [m.address]: m.balance }), {});
      expect(memberBalances[walletA]).toBe("100");
      expect(memberBalances[walletB]).toBe("200");
      // funding edges for the cluster members
      const edgePairs = (g.funding as any[]).map((e: any) => `${e.funder}->${e.funded}`).sort();
      expect(edgePairs).toEqual([`${funder}->${walletA}`, `${funder}->${walletB}`].sort());
      expect(g.funding[0].method).toBe("native_transfer");
    } finally {
      dashboard.stop();
    }
  });

  test("graph API wallet endpoint returns cluster, funder chain and edges", async () => {
    const cfg = await loadConfig();
    const funder = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const walletB = "0xcccccccccccccccccccccccccccccccccccccccc";

    const engine = new ArgusEngine(cfg);
    const graph = engine.graphView();
    const ts = Math.floor(Date.now() / 1000);
    graph.applyEvent({ chainId: 1, blockNumber: 90, logIndex: 0, txHash: "0x1", timestamp: ts, kind: "funding", funder, funded: walletB, amount: 50n, method: "native_transfer" });
    insertFundingEdge({ funder, funded: walletB, chainId: 1, amount: 50n, blockNumber: 90, method: "native_transfer" });

    const dashboard = new DashboardServer(engine, { port: 3743 });
    dashboard.start();
    try {
      const res = await fetch(`http://127.0.0.1:3743/api/graph/wallet/1/${walletB}`);
      expect(res.status).toBe(200);
      const g = (await res.json()) as any;
      expect(g.funder).toBe(funder);
      expect(g.funderChain).toEqual([funder]);
      expect(g.cluster.length).toBe(2);
      expect(g.funding.length).toBe(1);
      expect(g.funding[0].funder).toBe(funder);
    } finally {
      dashboard.stop();
    }
  });
});
