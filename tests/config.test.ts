import { describe, expect, test } from "bun:test";
import { validateConfig, ConfigError } from "../src/config.ts";

function baseConfig(): Record<string, unknown> {
  return {
    chains: [{ chainId: 1, name: "ethereum", enabled: true, rpcs: ["wss://example.com"], finalityDepth: 12, staleAfterMs: 15_000 }],
    watchlist: [{ chainId: 1, address: "0x" + "ab".repeat(20) }],
    autoWatch: { enabled: true, factories: ["uniswap-v2"], watchHours: 24 },
    rules: {
      R1: { enabled: true, supplyPct: 15, windowHours: 2, walletAgeDays: 7, weight: 35 },
      R2: { enabled: false, volumeSpikePct: 300, windowMinutes: 15, weight: 25 },
      R3: { enabled: true, minRecipients: 10, windowMinutes: 15, weight: 30 },
      R4: { enabled: true, warnPct: 10, critPct: 20, critWeight: 45, weight: 30 },
      R5: { enabled: true, minBuyers: 5, walletAgeDays: 7, weight: 25 },
      R6: { enabled: true, maxHops: 2, minClusterPct: 1, weight: 50 },
      R7: { enabled: false, minLockedPct: 30, minPoolAgeHours: 48, weight: 20 },
      R8: { enabled: true, minWallets: 3, windowMinutes: 60, weight: 20 },
    },
    scoring: { info: 40, alert: 60, critical: 80, signalWindowHours: 6 },
    alerts: { telegram: false, cooldownMinutes: 30, escalationDelta: 20, maxAlertsPerMinute: 10 },
    dashboard: { port: 3737 },
  };
}

describe("validateConfig", () => {
  test("valid config passes", () => {
    const cfg = validateConfig(baseConfig());
    expect(cfg.chains[0]?.chainId).toBe(1);
    expect(cfg.rules.R1.supplyPct).toBe(15);
    expect(cfg.dbPath).toBe("data/argus.db"); // default
  });

  test("rejects bad scoring order", () => {
    const c = baseConfig();
    (c["scoring"] as Record<string, unknown>)["alert"] = 90;
    expect(() => validateConfig(c)).toThrow(ConfigError);
  });

  test("rejects invalid watchlist address", () => {
    const c = baseConfig();
    ((c["watchlist"] as unknown[])[0] as Record<string, unknown>)["address"] = "0xnotanaddress";
    expect(() => validateConfig(c)).toThrow(/not a valid address/);
  });

  test("rejects watchlist chainId without matching chain", () => {
    const c = baseConfig();
    ((c["watchlist"] as unknown[])[0] as Record<string, unknown>)["chainId"] = 999;
    expect(() => validateConfig(c)).toThrow(/no matching chain/);
  });

  test("rejects R4 warnPct >= critPct", () => {
    const c = baseConfig();
    ((c["rules"] as Record<string, Record<string, unknown>>)["R4"] as Record<string, unknown>)["warnPct"] = 25;
    expect(() => validateConfig(c)).toThrow(/warnPct/);
  });

  test("env var interpolation in rpc urls", () => {
    process.env.ARGUS_TEST_RPC = "wss://secret.example.com/key123";
    const c = baseConfig();
    ((c["chains"] as unknown[])[0] as Record<string, unknown>)["rpcs"] = ["${ARGUS_TEST_RPC}"];
    const cfg = validateConfig(c);
    expect(cfg.chains[0]?.rpcs[0]).toBe("wss://secret.example.com/key123");
    delete process.env.ARGUS_TEST_RPC;
  });

  test("missing env var fails loudly", () => {
    const c = baseConfig();
    ((c["chains"] as unknown[])[0] as Record<string, unknown>)["rpcs"] = ["${ARGUS_DEFINITELY_UNSET}"];
    expect(() => validateConfig(c)).toThrow(/ARGUS_DEFINITELY_UNSET/);
  });

  test("disabled chains may defer endpoint secrets", () => {
    const c = baseConfig();
    ((c["chains"] as unknown[])[0] as Record<string, unknown>).enabled = false;
    ((c["chains"] as unknown[])[0] as Record<string, unknown>).rpcs = ["${ARGUS_DISABLED_RPC}"];
    expect(validateConfig(c).chains[0]?.enabled).toBe(false);
  });

  test("rejects private webhook destinations", () => {
    const c = baseConfig();
    c["webhooks"] = [{ url: "http://127.0.0.1:9000/hook", events: ["alert"] }];
    expect(() => validateConfig(c)).toThrow(/private hosts/);
  });

  test("autoWatch.factories accepts a raw address", () => {
    const c = baseConfig();
    ((c["autoWatch"] as Record<string, unknown>)["factories"]) = ["0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f"];
    const cfg = validateConfig(c);
    expect(cfg.autoWatch.factories[0]).toBe("0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f");
  });

  test("rejects unknown autoWatch factory name", () => {
    const c = baseConfig();
    ((c["autoWatch"] as Record<string, unknown>)["factories"]) = ["unicorn-factory"];
    expect(() => validateConfig(c)).toThrow(/known factory name/);
  });

  test("rejects non-string autoWatch factory entry", () => {
    const c = baseConfig();
    ((c["autoWatch"] as Record<string, unknown>)["factories"]) = [42];
    expect(() => validateConfig(c)).toThrow(/known factory name/);
  });

  test("rejects non-ws/http rpc url", () => {
    const c = baseConfig();
    ((c["chains"] as unknown[])[0] as Record<string, unknown>)["rpcs"] = ["ftp://nope"];
    expect(() => validateConfig(c)).toThrow(/ws\(s\)/);
  });
});
