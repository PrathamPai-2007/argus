import { describe, expect, test } from "bun:test";
import type { WebhookConfig } from "../src/config.ts";
import type { AlertPayload } from "../src/db.ts";
import { WebhookDispatcher } from "../src/webhooks.ts";

const TOKEN = "0x1111111111111111111111111111111111111111";

async function hmacHex(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("timeout waiting for webhook delivery");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function payload(kind: AlertPayload["kind"] = "opportunity"): AlertPayload {
  return {
    chainId: 8453, token: TOKEN, kind, verdict: kind === "exit" ? "avoid" : "alert", score: 72, symbol: "MEME",
    headline: "24 independent buyers, $18k net inflow in 15m", signals: [], priceUsd: 0.0012, liquidityUsd: 54_000, ageSec: 1_800,
    links: { dexscreener: `https://dexscreener.com/base/${TOKEN}` },
  };
}

function capture() {
  const received: Array<{ event: string; signature: string | null; body: Record<string, unknown>; raw: string }> = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const raw = await req.text();
      received.push({ event: req.headers.get("x-argus-event") ?? "", signature: req.headers.get("x-argus-signature"), body: JSON.parse(raw) as Record<string, unknown>, raw });
      return new Response("ok");
    },
  });
  return { received, server, url: `http://127.0.0.1:${server.port}/hook` };
}

describe("WebhookDispatcher", () => {
  test("signs alert, exit and retraction bodies byte-for-byte", async () => {
    const { received, server, url } = capture();
    try {
      const d = new WebhookDispatcher();
      d.setTargets([{ url, events: ["alert", "exit"], secret: "s3cret", timeoutMs: 5_000, retries: 0 } satisfies WebhookConfig]);
      d.dispatchAlert(payload(), 7, false);
      d.dispatchAlert(payload("exit"), 8, true);
      d.dispatchRetraction(7, 8453, TOKEN, "reorg at block 200");
      await waitFor(() => received.length >= 3);

      const alert = received.find((r) => r.body["type"] === "alert")!;
      expect(alert.body).toMatchObject({ id: 7, confirmed: false, score: 72, tokenAddress: TOKEN, symbol: "MEME" });
      expect(alert.signature).toBe(`sha256=${await hmacHex("s3cret", alert.raw)}`);
      expect(received.find((r) => r.body["type"] === "exit")?.event).toBe("exit");
      expect(received.find((r) => r.body["type"] === "alert_retracted")?.body["reason"]).toBe("reorg at block 200");
    } finally {
      server.stop(true);
    }
  });

  test("filters by subscribed event and omits the signature without a secret", async () => {
    const { received, server, url } = capture();
    try {
      const d = new WebhookDispatcher();
      d.setTargets([{ url, events: ["exit"], secret: null, timeoutMs: 5_000, retries: 0 }]);
      d.dispatchAlert(payload(), 1, true); // not subscribed
      d.dispatchAlert(payload("exit"), 2, true);
      await waitFor(() => received.length >= 1);
      await new Promise((r) => setTimeout(r, 30));
      expect(received.map((r) => r.event)).toEqual(["exit"]);
      expect(received[0]!.signature).toBeNull();
    } finally {
      server.stop(true);
    }
  });
});
