import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { validateConfig } from "../src/config.ts";
import { DashboardServer } from "../src/dashboard/server.ts";
import * as db from "../src/db.ts";
import { ArgusEngine } from "../src/engine.ts";

const TOKEN = "0x" + "11".repeat(20);
const cfg = validateConfig({ chains: [{ chainId: 8453, http: ["https://base-rpc.publicnode.com"] }], dbPath: ":memory:" });
let open: DashboardServer;
let locked: DashboardServer;
let openUrl = "";
let lockedUrl = "";

beforeAll(() => {
  db.openDb(":memory:");
  db.upsertToken({ chainId: 8453, address: TOKEN, symbol: "MEME", name: "Meme", source: "launch", firstSeenAt: 1, watchUntil: 9_999_999_999 });
  db.upsertScore({ chainId: 8453, token: TOKEN, at: 1, score: 0, opportunityPoints: 0, penalty: 0, verdict: "quiet", signals: [], gate: null }, 100, { symbol: "MEME" });
  const engine = new ArgusEngine(cfg);
  open = new DashboardServer(engine, cfg);
  open.start(0);
  openUrl = `http://127.0.0.1:${open.port}`;
  process.env["ARGUS_DASHBOARD_TOKEN"] = "hunter2-hunter2";
  locked = new DashboardServer(engine, cfg);
  locked.start(0);
  lockedUrl = `http://127.0.0.1:${locked.port}`;
  delete process.env["ARGUS_DASHBOARD_TOKEN"];
});

afterAll(() => {
  open.stop();
  locked.stop();
  db.closeDb();
});

describe("dashboard API", () => {
  test("serves the SPA for deep links", async () => {
    for (const path of ["/", "/token/8453/" + TOKEN, "/track-record"]) {
      const res = await fetch(openUrl + path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain('id="root"');
    }
  });

  test("opportunities, token detail and unknown routes", async () => {
    const opps = (await (await fetch(`${openUrl}/api/opportunities`)).json()) as Array<Record<string, unknown>>;
    expect(opps[0]).toMatchObject({ chainId: 8453, token: TOKEN, name: "Meme", spark: [] });
    const detail = (await (await fetch(`${openUrl}/api/tokens/8453/${TOKEN}`)).json()) as Record<string, unknown>;
    expect(detail).toMatchObject({ chainId: 8453, address: TOKEN, watched: true, trades: [], holders: [] });
    expect((await fetch(`${openUrl}/api/tokens/8453/not-an-address`)).status).toBe(400);
    expect((await fetch(`${openUrl}/api/nope`)).status).toBe(404);
    expect((await (await fetch(`${openUrl}/api/track-record`)).json()) as Record<string, unknown>).toHaveProperty("summary.alerts.count", 0);
  });

  test("SSE stream opens with hello and status frames", async () => {
    const res = await fetch(`${openUrl}/api/stream`);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain('"type":"hello"');
    await reader.cancel();
  });
});

describe("dashboard auth", () => {
  test("API needs a token; the SPA shell does not", async () => {
    expect((await fetch(`${lockedUrl}/api/status`)).status).toBe(401);
    expect((await fetch(`${lockedUrl}/api/stream`)).status).toBe(401);
    expect((await fetch(`${lockedUrl}/`)).status).toBe(200);
    expect((await fetch(`${lockedUrl}/api/status`, { headers: { authorization: "Bearer hunter2-hunter2" } })).status).toBe(200);
    expect((await fetch(`${lockedUrl}/api/status`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
  });

  test("session login sets an HttpOnly cookie that authenticates fetch and SSE", async () => {
    expect((await fetch(`${lockedUrl}/api/session`, { method: "POST", body: JSON.stringify({ token: "nope" }) })).status).toBe(401);
    const res = await fetch(`${lockedUrl}/api/session`, { method: "POST", body: JSON.stringify({ token: "hunter2-hunter2" }) });
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    const session = cookie.split(";")[0]!;
    expect((await fetch(`${lockedUrl}/api/opportunities`, { headers: { cookie: session } })).status).toBe(200);
  });
});
