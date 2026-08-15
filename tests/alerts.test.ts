import { beforeEach, describe, expect, test } from "bun:test";
import { AlertManager } from "../src/alerts/manager.ts";
import { buildAlertLinks, formatAlertMessage, type AlertSink } from "../src/alerts/telegram.ts";
import { closeDb, getDb, insertEvents, openDb, pruneEvents } from "../src/db.ts";
import type { AlertPayload } from "../src/types.ts";

const ALERTS_CFG = { telegram: false, cooldownMinutes: 30, escalationDelta: 20, maxAlertsPerMinute: 3 };
const SCORING_CFG = { info: 40, alert: 60, critical: 80, signalWindowHours: 6 };

class FakeSink implements AlertSink {
  name = "fake";
  sent: { payload: AlertPayload; id: number; confirmed: boolean }[] = [];
  texts: string[] = [];
  async send(payload: AlertPayload, id: number, confirmed = true): Promise<void> {
    this.sent.push({ payload, id, confirmed });
  }
  async sendText(text: string): Promise<void> {
    this.texts.push(text);
  }
}

function payload(token: string, score: number, severity: AlertPayload["severity"]): AlertPayload {
  return {
    chainId: 1,
    tokenAddress: token,
    score,
    severity,
    signals: [],
    headline: "test",
    lines: [],
    links: { dexscreener: "", bubblemaps: "", dashboard: "" },
  };
}

describe("AlertManager", () => {
  beforeEach(() => {
    closeDb();
    openDb(":memory:");
  });

  test("below-threshold scores never alert", async () => {
    const sink = new FakeSink();
    const m = new AlertManager(ALERTS_CFG, SCORING_CFG, [sink]);
    expect(await m.maybeAlert(payload("0xt1", 39, "info"), false)).toBeNull();
    expect(sink.sent.length).toBe(0);
  });

  test("cooldown suppresses same-token re-alert at similar score", async () => {
    const sink = new FakeSink();
    const m = new AlertManager(ALERTS_CFG, SCORING_CFG, [sink]);
    const id1 = await m.maybeAlert(payload("0xt2", 65, "alert"), false);
    expect(id1).not.toBeNull();
    const id2 = await m.maybeAlert(payload("0xt2", 70, "alert"), false);
    expect(id2).toBeNull(); // 70 < 65+20
    expect(sink.sent.length).toBe(1);
  });

  test("escalation re-alerts inside cooldown when score jumps ≥ delta", async () => {
    const sink = new FakeSink();
    const m = new AlertManager(ALERTS_CFG, SCORING_CFG, [sink]);
    await m.maybeAlert(payload("0xt3", 60, "alert"), false);
    const id = await m.maybeAlert(payload("0xt3", 85, "critical"), false); // 85 ≥ 60+20
    expect(id).not.toBeNull();
    expect(sink.sent.length).toBe(2);
  });

  test("global rate limit suppresses non-critical, critical bypasses", async () => {
    const sink = new FakeSink();
    const m = new AlertManager(ALERTS_CFG, SCORING_CFG, [sink]);
    // maxAlertsPerMinute = 3
    expect(await m.maybeAlert(payload("0xa", 90, "critical"), false)).not.toBeNull();
    expect(await m.maybeAlert(payload("0xb", 90, "critical"), false)).not.toBeNull();
    expect(await m.maybeAlert(payload("0xc", 90, "critical"), false)).not.toBeNull();
    expect(await m.maybeAlert(payload("0xd", 65, "alert"), false)).toBeNull(); // rate-limited
    expect(await m.maybeAlert(payload("0xe", 95, "critical"), false)).not.toBeNull(); // critical bypasses
  });

  test("retractUnconfirmed marks and notifies", async () => {
    const sink = new FakeSink();
    const m = new AlertManager(ALERTS_CFG, SCORING_CFG, [sink]);
    await m.maybeAlert(payload("0xt4", 90, "critical"), false);
    const ids = await m.retractUnconfirmed(1, "reorg at block 123");
    expect(ids.length).toBe(1);
    expect(sink.texts[0]).toContain("retraction");
    const row = getDb().query("SELECT retracted FROM alerts WHERE id = ?").get(ids[0] as number) as { retracted: number };
    expect(row.retracted).toBe(1);
    // confirmed alerts are not retracted
    const ids2 = await m.retractUnconfirmed(1, "another reorg");
    expect(ids2.length).toBe(0);
  });

  test("formatAlertMessage includes (unconfirmed) tag iff confirmed is false", () => {
    const p = payload("0xt5", 80, "critical");
    const msgConfirmed = formatAlertMessage(p, 1, true);
    const msgUnconfirmed = formatAlertMessage(p, 1, false);
    expect(msgConfirmed).not.toContain("(unconfirmed)");
    expect(msgUnconfirmed).toContain("(unconfirmed)");
  });

  test("sink.send receives correct confirmed flag from maybeAlert", async () => {
    const sink = new FakeSink();
    const m = new AlertManager(ALERTS_CFG, SCORING_CFG, [sink]);
    await m.maybeAlert(payload("0xt6", 90, "critical"), false);
    expect(sink.sent.length).toBe(1);
    expect(sink.sent[0]?.confirmed).toBe(false);
  });

  test("buildAlertLinks uses the real /api/token dashboard route", () => {
    const links = buildAlertLinks(1, "0x" + "aa".repeat(20), 3737);
    expect(links.dashboard).toBe(`http://127.0.0.1:3737/api/token/1/${"0x" + "aa".repeat(20)}`);
  });

  test("pruneEvents removes finalized events older than threshold", () => {
    const now = Math.floor(Date.now() / 1000);
    const oldTs = now - 10 * 86_400; // 10 days ago
    const newTs = now - 1 * 86_400; // 1 day ago
    insertEvents(
      [
        { chainId: 1, blockNumber: 10, logIndex: 0, txHash: "0x1", timestamp: oldTs, kind: "transfer", tokenAddress: "0xt", sender: "0xa", receiver: "0xb", amount: 100n },
        { chainId: 1, blockNumber: 20, logIndex: 0, txHash: "0x2", timestamp: newTs, kind: "transfer", tokenAddress: "0xt", sender: "0xa", receiver: "0xb", amount: 100n },
      ],
      true,
    );
    const pruned = pruneEvents(7 * 86_400); // 7 days cutoff
    expect(pruned).toBe(1);
  });
});
