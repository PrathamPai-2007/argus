import { describe, expect, test } from "bun:test";
import type { WebhookConfig } from "../src/config.ts";
import { WebhookDispatcher } from "../src/webhooks.ts";
import type { AlertPayload, Signal } from "../src/types.ts";

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

function alertPayload(): AlertPayload {
  return {
    chainId: 1,
    tokenAddress: TOKEN,
    score: 75,
    severity: "alert",
    signals: [],
    headline: "cluster accumulation",
    lines: ["R4 cluster holds 20% of supply"],
    links: { dexscreener: "https://dexscreener.com/ethereum/" + TOKEN, bubblemaps: "", dashboard: "http://127.0.0.1:3737" },
  };
}

function signal(): Signal {
  return { chainId: 1, tokenAddress: TOKEN, ruleId: "R4", weight: 30, evidence: { pctOfSupply: 20, memberCount: 5 }, blockNumber: 100, timestamp: Math.floor(Date.now() / 1000) };
}

describe("WebhookDispatcher", () => {
  test("POSTs alert and signal payloads with HMAC signature", async () => {
    interface Received {
      url: string;
      event: string;
      signature: string | null;
      body: Record<string, unknown>;
    }
    const received: Received[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.text()) as string;
        received.push({
          url: req.url,
          event: req.headers.get("x-argus-event") ?? "",
          signature: req.headers.get("x-argus-signature"),
          body: JSON.parse(body) as Record<string, unknown>,
        });
        return new Response("ok");
      },
    });
    try {
      const targets: WebhookConfig[] = [{ url: `http://127.0.0.1:${server.port}/hook`, events: ["alert", "signal"], secret: "s3cret-key", timeoutMs: 5000, retries: 0 }];
      const dispatcher = new WebhookDispatcher();
      dispatcher.setTargets(targets);

      dispatcher.dispatchAlert(alertPayload(), 7, false);
      dispatcher.dispatchSignal(signal());
      dispatcher.dispatchRetraction(7, 1, TOKEN, "reorg at block 200");

      await waitFor(() => received.length >= 3);

      const alertReq = received.find((r) => r.body["type"] === "alert");
      expect(alertReq).toBeDefined();
      expect(alertReq!.event).toBe("alert");
      expect(alertReq!.body["id"]).toBe(7);
      expect(alertReq!.body["confirmed"]).toBe(false);
      expect(alertReq!.body["score"]).toBe(75);
      expect(alertReq!.body["tokenAddress"]).toBe(TOKEN);
      // body sent over the wire must be byte-identical to what we signed
      const sigAlert = alertReq!.signature;
      expect(sigAlert).toBe(`sha256=${await hmacHex("s3cret-key", JSON.stringify(alertReq!.body))}`);

      const signalReq = received.find((r) => r.body["type"] === "signal");
      expect(signalReq).toBeDefined();
      expect(signalReq!.event).toBe("signal");
      expect(signalReq!.body["ruleId"]).toBe("R4");
      expect(signalReq!.body["evidence"]).toEqual({ pctOfSupply: 20, memberCount: 5 });
      expect(signalReq!.signature).toBe(`sha256=${await hmacHex("s3cret-key", JSON.stringify(signalReq!.body))}`);

      const retractReq = received.find((r) => r.body["type"] === "alert_retracted");
      expect(retractReq).toBeDefined();
      expect(retractReq!.event).toBe("alert_retracted");
      expect(retractReq!.body["reason"]).toBe("reorg at block 200");
    } finally {
      server.stop(true);
    }
  });

  test("filters events per target and omits signature when no secret", async () => {
    const received: { event: string; signature: string | null }[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        await req.text();
        received.push({ event: req.headers.get("x-argus-event") ?? "", signature: req.headers.get("x-argus-signature") });
        return new Response("ok");
      },
    });
    try {
      const targets: WebhookConfig[] = [
        { url: `http://127.0.0.1:${server.port}/alert-only`, events: ["alert"], secret: null, timeoutMs: 5000, retries: 0 },
      ];
      const dispatcher = new WebhookDispatcher();
      dispatcher.setTargets(targets);

      dispatcher.dispatchSignal(signal()); // should be dropped
      dispatcher.dispatchAlert(alertPayload(), 1, true);

      await waitFor(() => received.length >= 1);
      await new Promise((r) => setTimeout(r, 30));
      expect(received.length).toBe(1);
      expect(received[0]!.event).toBe("alert");
      expect(received[0]!.signature).toBeNull();
    } finally {
      server.stop(true);
    }
  });
});
