import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CHAINS } from "./chains.ts";
import { DEFAULT_SIGNALS, type SignalsConfig } from "./signals.ts";

// argus.config.ts → validated, typed config. Hand-rolled validation (no zod).
// Secrets stay in .env and are referenced as ${VAR} / ${VAR:-default}.

export interface ChainConfig {
  chainId: number;
  name: string;
  enabled: boolean;
  /** HTTP JSON-RPC endpoints in priority order (sync, reads, failover). */
  http: string[];
  /** WebSocket endpoints for newHeads (latency only; HTTP polling backs them up). */
  ws: string[];
  finalityDepth: number;
  blockTimeMs: number;
}

export interface DiscoveryConfig {
  /** Auto-watch tokens from new V2/V3 pools against known quotes. */
  newPools: boolean;
  watchHours: number;
  /** Active tokens keep extending their watch up to this age. */
  maxWatchHours: number;
  maxWatchedPerChain: number;
  /** Liquidity a never-alerted token needs to enter the baseline cohort. */
  baselineLiquidityUsd: number;
}

export interface SmartMoneyConfig {
  minClosedTrades: number;
  minWinRate: number;
  minPnlUsd: number;
}

export interface AlertsConfig {
  telegram: boolean;
  cooldownMinutes: number;
  /** Re-alert inside the cooldown only when the score rises this much. */
  rescoreDelta: number;
  maxPerHour: number;
}

export interface WebhookConfig {
  url: string;
  events: Array<"alert" | "exit">;
  secret: string | null;
  timeoutMs: number;
  retries: number;
}

export interface ArgusConfig {
  chains: ChainConfig[];
  watchlist: Array<{ chainId: number; address: string }>;
  discovery: DiscoveryConfig;
  signals: SignalsConfig;
  smartMoney: SmartMoneyConfig;
  alerts: AlertsConfig;
  dashboard: { port: number };
  retention: { eventDays: number };
  webhooks: WebhookConfig[];
  dbPath: string;
  explorerKeys: { etherscan: string | null; blockscout: string | null };
}

const CHAIN_DEFAULTS: Record<number, { finalityDepth: number; blockTimeMs: number }> = {
  1: { finalityDepth: 12, blockTimeMs: 12_000 },
  8453: { finalityDepth: 32, blockTimeMs: 2_000 },
};

export class ConfigError extends Error {}

function fail(msg: string): never {
  throw new ConfigError(`argus.config: ${msg}`);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function num(obj: Obj, key: string, ctx: string, def: number | undefined, opts: { min?: number; max?: number; int?: boolean } = {}): number {
  const v = obj[key] ?? def;
  if (typeof v !== "number" || !Number.isFinite(v)) fail(`${ctx}.${key} must be a finite number`);
  if (opts.int && !Number.isInteger(v)) fail(`${ctx}.${key} must be an integer`);
  if (opts.min !== undefined && v < opts.min) fail(`${ctx}.${key} must be >= ${opts.min}`);
  if (opts.max !== undefined && v > opts.max) fail(`${ctx}.${key} must be <= ${opts.max}`);
  return v;
}

function bool(obj: Obj, key: string, ctx: string, def: boolean): boolean {
  const v = obj[key] ?? def;
  if (typeof v !== "boolean") fail(`${ctx}.${key} must be a boolean`);
  return v;
}

/** ${VAR} / ${VAR:-default}; an unset variable without a default removes the entry (returns null). */
function interpolate(value: string): string | null {
  let missing = false;
  const out = value.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (_, name: string, def?: string) => {
    const v = process.env[name];
    if (v) return v;
    if (def !== undefined) return def;
    missing = true;
    return "";
  });
  return missing ? null : out;
}

function urls(raw: unknown, ctx: string, schemes: RegExp): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail(`${ctx} must be an array of URLs`);
  const out: string[] = [];
  raw.forEach((r, i) => {
    if (typeof r !== "string") fail(`${ctx}[${i}] must be a string`);
    const url = interpolate(r);
    if (url === null) return; // optional endpoint whose env var is unset
    if (!schemes.test(url)) fail(`${ctx}[${i}] has an unsupported scheme`);
    try {
      if (!new URL(url).hostname) throw new Error();
    } catch {
      fail(`${ctx}[${i}] must be a valid URL`);
    }
    out.push(url);
  });
  return out;
}

function validateChain(raw: unknown, i: number): ChainConfig {
  const ctx = `chains[${i}]`;
  if (!isObj(raw)) fail(`${ctx} must be an object`);
  const chainId = num(raw, "chainId", ctx, undefined, { int: true, min: 1 });
  const info = CHAINS[chainId];
  if (!info) fail(`${ctx}.chainId ${chainId} is not supported (supported: ${Object.keys(CHAINS).join(", ")})`);
  const enabled = bool(raw, "enabled", ctx, true);
  const http = urls(raw["http"], `${ctx}.http`, /^https?:\/\//);
  const ws = urls(raw["ws"], `${ctx}.ws`, /^wss?:\/\//);
  if (enabled && http.length === 0) fail(`${ctx}.http needs at least one reachable endpoint`);
  const d = CHAIN_DEFAULTS[chainId]!;
  return {
    chainId,
    name: info.name,
    enabled,
    http,
    ws,
    finalityDepth: num(raw, "finalityDepth", ctx, d.finalityDepth, { int: true, min: 1, max: 256 }),
    blockTimeMs: num(raw, "blockTimeMs", ctx, d.blockTimeMs, { int: true, min: 200 }),
  };
}

/** Deep-merge numeric overrides onto defaults, rejecting unknown keys and non-numbers. */
function mergeNumbers<T extends object>(defaults: T, raw: unknown, ctx: string): T {
  if (raw === undefined) return structuredClone(defaults);
  if (!isObj(raw)) fail(`${ctx} must be an object`);
  const out = structuredClone(defaults) as Record<string, unknown>;
  for (const [k, v] of Object.entries(raw)) {
    const d = (defaults as Record<string, unknown>)[k];
    if (d === undefined) fail(`${ctx}.${k} is not a known setting`);
    if (typeof d === "number") out[k] = num(raw, k, ctx, undefined, { min: 0 });
    else out[k] = mergeNumbers(d as object, v, `${ctx}.${k}`);
  }
  return out as T;
}

export function validateConfig(raw: unknown): ArgusConfig {
  if (!isObj(raw)) fail("config must be an object");
  if (!Array.isArray(raw["chains"]) || raw["chains"].length === 0) fail("chains must be a non-empty array");
  const chains = raw["chains"].map(validateChain);
  const ids = new Set(chains.map((c) => c.chainId));
  if (ids.size !== chains.length) fail("chains contain a duplicate chainId");

  const wl = raw["watchlist"] ?? [];
  if (!Array.isArray(wl)) fail("watchlist must be an array");
  const watchlist = wl.map((w, i) => {
    if (!isObj(w)) fail(`watchlist[${i}] must be an object`);
    const chainId = num(w, "chainId", `watchlist[${i}]`, undefined, { int: true });
    if (!ids.has(chainId)) fail(`watchlist[${i}].chainId ${chainId} has no matching chain`);
    const address = w["address"];
    if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) fail(`watchlist[${i}].address is not a valid address`);
    return { chainId, address: address.toLowerCase() };
  });

  const dRaw = isObj(raw["discovery"]) ? raw["discovery"] : {};
  const discovery: DiscoveryConfig = {
    newPools: bool(dRaw, "newPools", "discovery", true),
    watchHours: num(dRaw, "watchHours", "discovery", 6, { min: 0.5 }),
    maxWatchHours: num(dRaw, "maxWatchHours", "discovery", 48, { min: 1 }),
    maxWatchedPerChain: num(dRaw, "maxWatchedPerChain", "discovery", 400, { int: true, min: 10, max: 5_000 }),
    baselineLiquidityUsd: num(dRaw, "baselineLiquidityUsd", "discovery", 10_000, { min: 0 }),
  };
  if (discovery.maxWatchHours < discovery.watchHours) fail("discovery.maxWatchHours must be >= discovery.watchHours");

  const signals = mergeNumbers(DEFAULT_SIGNALS, raw["signals"], "signals");
  if (signals.alertScore > signals.highConvictionScore) fail("signals.alertScore must be <= signals.highConvictionScore");

  const smRaw = isObj(raw["smartMoney"]) ? raw["smartMoney"] : {};
  const smartMoney: SmartMoneyConfig = {
    minClosedTrades: num(smRaw, "minClosedTrades", "smartMoney", 5, { int: true, min: 1 }),
    minWinRate: num(smRaw, "minWinRate", "smartMoney", 0.55, { min: 0, max: 1 }),
    minPnlUsd: num(smRaw, "minPnlUsd", "smartMoney", 0),
  };

  const aRaw = isObj(raw["alerts"]) ? raw["alerts"] : {};
  const alerts: AlertsConfig = {
    telegram: bool(aRaw, "telegram", "alerts", Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID)),
    cooldownMinutes: num(aRaw, "cooldownMinutes", "alerts", 30, { min: 0 }),
    rescoreDelta: num(aRaw, "rescoreDelta", "alerts", 10, { min: 0, max: 100 }),
    maxPerHour: num(aRaw, "maxPerHour", "alerts", 30, { int: true, min: 1 }),
  };

  const dash = isObj(raw["dashboard"]) ? raw["dashboard"] : {};
  const ret = isObj(raw["retention"]) ? raw["retention"] : {};

  const whRaw = raw["webhooks"] ?? [];
  if (!Array.isArray(whRaw)) fail("webhooks must be an array");
  const webhooks: WebhookConfig[] = whRaw.flatMap((w, i) => {
    const ctx = `webhooks[${i}]`;
    if (!isObj(w) || typeof w["url"] !== "string") fail(`${ctx} must be an object with a url`);
    const url = interpolate(w["url"]);
    if (url === null) return [];
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      fail(`${ctx}.url must be a valid URL`);
    }
    if (!/^https?:$/.test(parsed.protocol)) fail(`${ctx}.url must be http(s)`);
    if (parsed.username || parsed.password || isPrivateHost(parsed.hostname)) fail(`${ctx}.url must not target private hosts or contain credentials`);
    const events = Array.isArray(w["events"]) ? w["events"] : ["alert", "exit"];
    for (const e of events) if (e !== "alert" && e !== "exit") fail(`${ctx}.events entries must be "alert" or "exit"`);
    const secret = typeof w["secret"] === "string" ? interpolate(w["secret"]) : null;
    return [{
      url,
      events: [...new Set(events)] as WebhookConfig["events"],
      secret: secret || null,
      timeoutMs: num(w, "timeoutMs", ctx, 10_000, { int: true, min: 500, max: 60_000 }),
      retries: num(w, "retries", ctx, 2, { int: true, min: 0, max: 5 }),
    }];
  });

  return {
    chains,
    watchlist,
    discovery,
    signals,
    smartMoney,
    alerts,
    dashboard: { port: num(dash, "port", "dashboard", 3737, { int: true, min: 1, max: 65_535 }) },
    retention: { eventDays: num(ret, "eventDays", "retention", 3, { min: 1 }) },
    webhooks,
    dbPath: typeof raw["dbPath"] === "string" ? raw["dbPath"] : "data/argus.db",
    explorerKeys: { etherscan: process.env.ETHERSCAN_API_KEY || null, blockscout: process.env.BLOCKSCOUT_API_KEY || null },
  };
}

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/[[\]]/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  const version = isIP(host);
  if (version === 4) {
    const [a, b] = host.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
  }
  if (version === 6) {
    if (host.startsWith("::ffff:")) return isPrivateHost(host.slice(7));
    return host === "::1" || host === "::" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  }
  return false;
}

// ---- loader ---------------------------------------------------------------------

export async function loadConfig(path = join(process.cwd(), "argus.config.ts")): Promise<ArgusConfig> {
  if (!existsSync(path)) fail(`config file not found at ${path}`);
  const mod = (await import(pathToFileURL(path).href + `?t=${Date.now()}`)) as { default: unknown };
  return validateConfig(mod.default);
}

/** Re-read and re-validate; null keeps the previous config when the new file is invalid. */
export async function reloadConfig(path?: string): Promise<ArgusConfig | null> {
  try {
    return await loadConfig(path);
  } catch {
    return null;
  }
}
