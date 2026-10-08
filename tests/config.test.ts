import { describe, expect, test } from "bun:test";
import { ConfigError, isPrivateHost, validateConfig } from "../src/config.ts";
import { DEFAULT_SIGNALS } from "../src/signals.ts";

const base = () => ({ chains: [{ chainId: 8453, http: ["https://base-rpc.publicnode.com"] }] }) as Record<string, unknown>;

describe("validateConfig", () => {
  test("fills chain facts from the registry and defaults the rest", () => {
    const cfg = validateConfig(base());
    expect(cfg.chains[0]).toMatchObject({ chainId: 8453, name: "Base", enabled: true, finalityDepth: 32, blockTimeMs: 2_000, ws: [] });
    expect(cfg.signals).toEqual(DEFAULT_SIGNALS);
    expect(cfg.discovery.watchHours).toBe(6);
    expect(cfg.dbPath).toBe("data/argus.db");
  });

  test("rejects unsupported chains and enabled chains without HTTP endpoints", () => {
    expect(() => validateConfig({ chains: [{ chainId: 56, http: ["https://x.example"] }] })).toThrow(ConfigError);
    expect(() => validateConfig({ chains: [{ chainId: 1, http: [] }] })).toThrow("needs at least one");
  });

  test("skips endpoints whose env var is unset, keeps defaults, substitutes set ones", () => {
    process.env["ARGUS_TEST_RPC"] = "https://rpc.example/key";
    const cfg = validateConfig({ chains: [{ chainId: 1, http: ["${ARGUS_TEST_RPC}", "${ARGUS_UNSET_RPC}", "${ARGUS_UNSET_2:-https://fallback.example}"] }] });
    expect(cfg.chains[0]!.http).toEqual(["https://rpc.example/key", "https://fallback.example"]);
    delete process.env["ARGUS_TEST_RPC"];
  });

  test("signal overrides deep-merge onto defaults and reject unknown or non-numeric keys", () => {
    const cfg = validateConfig({ ...base(), signals: { alertScore: 55, organic: { minBuyers: 20 } } });
    expect(cfg.signals.alertScore).toBe(55);
    expect(cfg.signals.organic).toEqual({ ...DEFAULT_SIGNALS.organic, minBuyers: 20 });
    expect(() => validateConfig({ ...base(), signals: { organc: {} } })).toThrow("not a known setting");
    expect(() => validateConfig({ ...base(), signals: { alertScore: "60" } })).toThrow("finite number");
    expect(() => validateConfig({ ...base(), signals: { alertScore: 90, highConvictionScore: 80 } })).toThrow(ConfigError);
  });

  test("watchlist entries must match a configured chain and be valid addresses", () => {
    expect(validateConfig({ ...base(), watchlist: [{ chainId: 8453, address: "0x" + "AB".repeat(20) }] }).watchlist[0]!.address).toBe("0x" + "ab".repeat(20));
    expect(() => validateConfig({ ...base(), watchlist: [{ chainId: 1, address: "0x" + "ab".repeat(20) }] })).toThrow("no matching chain");
    expect(() => validateConfig({ ...base(), watchlist: [{ chainId: 8453, address: "0x12" }] })).toThrow("not a valid address");
  });

  test("webhooks reject private, loopback and credentialed targets", () => {
    for (const url of ["http://127.0.0.1/x", "http://10.0.0.5/x", "http://[::1]/x", "http://169.254.169.254/latest", "https://user:pw@hooks.example/x", "http://metadata.google.internal/"]) {
      expect(() => validateConfig({ ...base(), webhooks: [{ url }] })).toThrow(ConfigError);
    }
    expect(validateConfig({ ...base(), webhooks: [{ url: "https://hooks.example/abc" }] }).webhooks[0]!.events).toEqual(["alert", "exit"]);
  });

  test("isPrivateHost unwraps IPv4-mapped IPv6", () => {
    expect(isPrivateHost("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateHost("hooks.slack.com")).toBe(false);
  });
});
