import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isIP } from "node:net";
import { isFactoryRef, KNOWN_FACTORY_NAMES } from "./factories.ts";

// ---- Types ----------------------------------------------------------------

export interface ChainConfig {
  chainId: number;
  name: string;
  enabled: boolean;
  rpcs: string[];
  httpRpcs: string[];
  infuraRetryMinutes: number;
  finalityDepth: number;
  staleAfterMs: number;
  backfill: BackfillConfig;
}

export interface BackfillConfig {
  etherscan: { enabled: boolean; apiUrl: string; apiKey: string | null; requestsPerSecond: number };
  bigquery: { enabled: boolean; projectId: string | null; credentialsPath: string | null; dataset: string; maxBytesBilled: number | null };
  bigqueryThresholdHours: number;
}

export interface WatchlistEntry {
  chainId: number;
  address: string;
}

export interface AutoWatchConfig {
  enabled: boolean;
  factories: string[];
  watchHours: number;
}

export interface CandidateDiscoveryConfig {
  enabled: boolean;
  maxCandidatesPerCycle: number;
  evaluationMinutes: number;
  candidateTtlHours: number;
  promotionScore: number;
  minimumLiquidityUsd: number;
  minimumIndependentBuyers: number;
}

export interface RuleConfig {
  enabled: boolean;
  weight: number;
  [key: string]: number | boolean | string;
}

export interface RulesConfig {
  R1: RuleConfig & { supplyPct: number; windowHours: number; walletAgeDays: number };
  R2: RuleConfig & { volumeSpikePct: number; windowMinutes: number };
  R3: RuleConfig & { minRecipients: number; windowMinutes: number };
  R4: RuleConfig & { warnPct: number; critPct: number; critWeight: number };
  R5: RuleConfig & { minBuyers: number; walletAgeDays: number };
  R6: RuleConfig & { maxHops: number; minClusterPct: number };
  R7: RuleConfig & { minLockedPct: number; minPoolAgeHours: number };
  R8: RuleConfig & { minWallets: number; windowMinutes: number };
}

export interface ScoringConfig {
  info: number;
  alert: number;
  critical: number;
  signalWindowHours: number;
}

export interface AlertsConfig {
  telegram: boolean;
  cooldownMinutes: number;
  escalationDelta: number;
  maxAlertsPerMinute: number;
}

export interface RetentionConfig {
  eventDays: number;
}

export interface WebhookConfig {
  url: string;
  events: Array<"alert" | "signal">;
  secret: string | null;
  timeoutMs: number;
  retries: number;
}

export interface ArgusConfig {
  chains: ChainConfig[];
  watchlist: WatchlistEntry[];
  autoWatch: AutoWatchConfig;
  candidateDiscovery: CandidateDiscoveryConfig;
  volumeRanking: { pollMinutes: number; topN: number; backfillHours: number };
  rules: RulesConfig;
  scoring: ScoringConfig;
  alerts: AlertsConfig;
  dashboard: { port: number };
  retention: RetentionConfig;
  webhooks: WebhookConfig[];
  dbPath: string;
}

// ---- .env loading (no dependency) -----------------------------------------

function loadDotEnv(): void {
  const path = join(process.cwd(), ".env");
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

// ---- Validation (hand-rolled, per PLAN §2) ---------------------------------

export class ConfigError extends Error {}

function fail(msg: string): never {
  throw new ConfigError(`argus.config: ${msg}`);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function reqNumber(obj: Record<string, unknown>, key: string, ctx: string, opts?: { min?: number; max?: number; int?: boolean }): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v)) fail(`${ctx}.${key} must be a finite number`);
  if (opts?.int && !Number.isInteger(v)) fail(`${ctx}.${key} must be an integer`);
  if (opts?.min !== undefined && v < opts.min) fail(`${ctx}.${key} must be >= ${opts.min}`);
  if (opts?.max !== undefined && v > opts.max) fail(`${ctx}.${key} must be <= ${opts.max}`);
  return v;
}

function reqBool(obj: Record<string, unknown>, key: string, ctx: string): boolean {
  const v = obj[key];
  if (typeof v !== "boolean") fail(`${ctx}.${key} must be a boolean`);
  return v;
}

function reqString(obj: Record<string, unknown>, key: string, ctx: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) fail(`${ctx}.${key} must be a non-empty string`);
  return v;
}

function isAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

/** Replace ${VAR} placeholders with environment variables (secrets stay in .env). Supports ${VAR:-default}. */
function interpolate(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)(?::-([^}]+))?\}/g, (_, name: string, def?: string) => {
    const v = process.env[name];
    if (!v && def === undefined) fail(`environment variable ${name} is referenced but not set`);
    return v || def || "";
  });
}

function validateChain(raw: unknown, i: number): ChainConfig {
  if (!isObj(raw)) fail(`chains[${i}] must be an object`);
  const ctx = `chains[${i}]`;
  const chainId = reqNumber(raw, "chainId", ctx, { int: true, min: 1 });
  const name = reqString(raw, "name", ctx);
  const enabled = reqBool(raw, "enabled", ctx);
  const rpcsRaw = raw["rpcs"];
  if (!Array.isArray(rpcsRaw) || rpcsRaw.length === 0) fail(`${ctx}.rpcs must be a non-empty array`);
  const rpcs = rpcsRaw.map((r, j) => {
    if (typeof r !== "string") fail(`${ctx}.rpcs[${j}] must be a string`);
     const url = enabled ? interpolate(r) : r;
     if (!enabled && /\$\{[A-Z0-9_]+\}/.test(url)) return url;
     if (!/^wss?:\/\//.test(url) && !/^https?:\/\//.test(url)) fail(`${ctx}.rpcs[${j}] must be a ws(s):// or http(s):// URL`);
    try {
      if (!new URL(url).hostname) throw new Error();
    } catch {
      fail(`${ctx}.rpcs[${j}] must include a valid host`);
    }
    return url;
  });
  const httpRpcsRaw = raw["httpRpcs"];
  const httpRpcs: string[] = Array.isArray(httpRpcsRaw)
    ? httpRpcsRaw.map((r, j) => {
        if (typeof r !== "string") fail(`${ctx}.httpRpcs[${j}] must be a string`);
        const url = enabled ? interpolate(r) : r;
        if (!enabled && /\$\{[A-Z0-9_]+\}/.test(url)) return url;
        if (!/^https?:\/\//.test(url)) fail(`${ctx}.httpRpcs[${j}] must be an http(s):// URL`);
        return url;
      })
    : [];
  const finalityDepth = reqNumber(raw, "finalityDepth", ctx, { int: true, min: 1 });
  const staleAfterMs = reqNumber(raw, "staleAfterMs", ctx, { int: true, min: 1000 });
  const infuraRetryMinutes = typeof raw["infuraRetryMinutes"] === "number"
    ? reqNumber(raw, "infuraRetryMinutes", ctx, { min: 1, max: 60 })
    : 5;
  const bfRaw = isObj(raw["backfill"]) ? raw["backfill"] as Record<string, unknown> : {};
  const esRaw = isObj(bfRaw["etherscan"]) ? bfRaw["etherscan"] as Record<string, unknown> : {};
  const bqRaw = isObj(bfRaw["bigquery"]) ? bfRaw["bigquery"] as Record<string, unknown> : {};
  const esEnabled = esRaw["enabled"] === true;
  const bqEnabled = bqRaw["enabled"] === true;
   const esUrl = typeof esRaw["apiUrl"] === "string" ? (esEnabled ? interpolate(esRaw["apiUrl"] as string) : esRaw["apiUrl"] as string) : "https://api.etherscan.io/v2/api";
  const esKeyRaw = esRaw["apiKey"];
  const esKey = esEnabled && typeof esKeyRaw === "string" ? interpolate(esKeyRaw) : null;
  if (esEnabled && !esKey) fail(`${ctx}.backfill.etherscan.apiKey is required when enabled`);
  const projectId = bqEnabled && typeof bqRaw["projectId"] === "string" ? interpolate(bqRaw["projectId"] as string) : null;
  const credentialsPath = bqEnabled && typeof bqRaw["credentialsPath"] === "string" ? interpolate(bqRaw["credentialsPath"] as string) : null;
  if (bqEnabled && (!projectId || !credentialsPath)) fail(`${ctx}.backfill.bigquery.projectId and credentialsPath are required when enabled`);
  return {
    chainId, name, enabled, rpcs, httpRpcs, infuraRetryMinutes, finalityDepth, staleAfterMs,
    backfill: {
      etherscan: { enabled: esEnabled, apiUrl: esUrl, apiKey: esKey, requestsPerSecond: typeof esRaw["requestsPerSecond"] === "number" ? reqNumber(esRaw, "requestsPerSecond", `${ctx}.backfill.etherscan`, { min: 0.1, max: 3 }) : 3 },
      bigquery: { enabled: bqEnabled, projectId, credentialsPath, dataset: typeof bqRaw["dataset"] === "string" ? bqRaw["dataset"] : "bigquery-public-data.crypto_ethereum", maxBytesBilled: typeof bqRaw["maxBytesBilled"] === "number" ? reqNumber(bqRaw, "maxBytesBilled", `${ctx}.backfill.bigquery`, { int: true, min: 1 }) : null },
      bigqueryThresholdHours: typeof bfRaw["bigqueryThresholdHours"] === "number" ? reqNumber(bfRaw, "bigqueryThresholdHours", `${ctx}.backfill`, { min: 1 }) : 6,
    },
  };
}

function validateRule(raw: unknown, id: string, numericKeys: string[]): RuleConfig {
  const ctx = `rules.${id}`;
  if (!isObj(raw)) fail(`${ctx} must be an object`);
  const out: RuleConfig = { enabled: reqBool(raw, "enabled", ctx), weight: reqNumber(raw, "weight", ctx, { min: 0, max: 100 }) };
  for (const k of numericKeys) out[k] = reqNumber(raw, k, ctx, { min: 0 });
  return out;
}

export function validateConfig(raw: unknown): ArgusConfig {
  if (!isObj(raw)) fail("config must be an object");

  if (!Array.isArray(raw["chains"]) || raw["chains"].length === 0) fail("chains must be a non-empty array");
  const chains = raw["chains"].map(validateChain);
  const ids = new Set(chains.map((c) => c.chainId));
  if (ids.size !== chains.length) fail("chains contain duplicate chainId");

  const wlRaw = raw["watchlist"];
  if (!Array.isArray(wlRaw)) fail("watchlist must be an array");
  const watchlist: WatchlistEntry[] = wlRaw.map((w, i) => {
    if (!isObj(w)) fail(`watchlist[${i}] must be an object`);
    const chainId = reqNumber(w, "chainId", `watchlist[${i}]`, { int: true, min: 1 });
    if (!ids.has(chainId)) fail(`watchlist[${i}].chainId ${chainId} has no matching chain`);
    const address = reqString(w, "address", `watchlist[${i}]`);
    if (!isAddress(address)) fail(`watchlist[${i}].address is not a valid address`);
    return { chainId, address: address.toLowerCase() };
  });

  const awRaw = raw["autoWatch"];
  if (!isObj(awRaw)) fail("autoWatch must be an object");
  const awFactoriesRaw = awRaw["factories"];
  if (!Array.isArray(awFactoriesRaw)) fail("autoWatch.factories must be an array");
  awFactoriesRaw.forEach((f, i) => {
    if (typeof f !== "string" || !isFactoryRef(f)) {
      fail(`autoWatch.factories[${i}] must be a 0x address or a known factory name (${KNOWN_FACTORY_NAMES.join(", ")})`);
    }
  });
  const autoWatch: AutoWatchConfig = {
    enabled: reqBool(awRaw, "enabled", "autoWatch"),
    factories: awFactoriesRaw as string[],
    watchHours: reqNumber(awRaw, "watchHours", "autoWatch", { min: 1 }),
  };

  const cdRaw = isObj(raw["candidateDiscovery"]) ? raw["candidateDiscovery"] as Record<string, unknown> : {};
  const candidateDiscovery: CandidateDiscoveryConfig = {
    enabled: cdRaw["enabled"] === undefined ? true : reqBool(cdRaw, "enabled", "candidateDiscovery"),
    maxCandidatesPerCycle: typeof cdRaw["maxCandidatesPerCycle"] === "number" ? reqNumber(cdRaw, "maxCandidatesPerCycle", "candidateDiscovery", { int: true, min: 1, max: 100 }) : 25,
    evaluationMinutes: typeof cdRaw["evaluationMinutes"] === "number" ? reqNumber(cdRaw, "evaluationMinutes", "candidateDiscovery", { min: 1 }) : 30,
    candidateTtlHours: typeof cdRaw["candidateTtlHours"] === "number" ? reqNumber(cdRaw, "candidateTtlHours", "candidateDiscovery", { min: 1 }) : 24,
    promotionScore: typeof cdRaw["promotionScore"] === "number" ? reqNumber(cdRaw, "promotionScore", "candidateDiscovery", { min: 0, max: 100 }) : 65,
    minimumLiquidityUsd: typeof cdRaw["minimumLiquidityUsd"] === "number" ? reqNumber(cdRaw, "minimumLiquidityUsd", "candidateDiscovery", { min: 0 }) : 100_000,
    minimumIndependentBuyers: typeof cdRaw["minimumIndependentBuyers"] === "number" ? reqNumber(cdRaw, "minimumIndependentBuyers", "candidateDiscovery", { int: true, min: 1, max: 50 }) : 3,
  };

  const vrRaw = isObj(raw["volumeRanking"]) ? raw["volumeRanking"] as Record<string, unknown> : {};
  const volumeRanking = {
    pollMinutes: typeof vrRaw["pollMinutes"] === "number" ? reqNumber(vrRaw, "pollMinutes", "volumeRanking", { min: 1 }) : 5,
    topN: typeof vrRaw["topN"] === "number" ? reqNumber(vrRaw, "topN", "volumeRanking", { int: true, min: 1, max: 100 }) : 10,
    backfillHours: typeof vrRaw["backfillHours"] === "number" ? reqNumber(vrRaw, "backfillHours", "volumeRanking", { min: 0.25, max: 24 }) : 1,
  };

  const rulesRaw = raw["rules"];
  if (!isObj(rulesRaw)) fail("rules must be an object");
  const rules: RulesConfig = {
    R1: validateRule(rulesRaw["R1"], "R1", ["supplyPct", "windowHours", "walletAgeDays"]) as RulesConfig["R1"],
    R2: validateRule(rulesRaw["R2"], "R2", ["volumeSpikePct", "windowMinutes"]) as RulesConfig["R2"],
    R3: validateRule(rulesRaw["R3"], "R3", ["minRecipients", "windowMinutes"]) as RulesConfig["R3"],
    R4: validateRule(rulesRaw["R4"], "R4", ["warnPct", "critPct", "critWeight"]) as RulesConfig["R4"],
    R5: validateRule(rulesRaw["R5"], "R5", ["minBuyers", "walletAgeDays"]) as RulesConfig["R5"],
    R6: validateRule(rulesRaw["R6"], "R6", ["maxHops", "minClusterPct"]) as RulesConfig["R6"],
    R7: validateRule(rulesRaw["R7"], "R7", ["minLockedPct", "minPoolAgeHours"]) as RulesConfig["R7"],
    R8: validateRule(rulesRaw["R8"], "R8", ["minWallets", "windowMinutes"]) as RulesConfig["R8"],
  };
  if (rules.R4.warnPct >= rules.R4.critPct) fail("rules.R4.warnPct must be < rules.R4.critPct");

  const scRaw = raw["scoring"];
  if (!isObj(scRaw)) fail("scoring must be an object");
  const scoring: ScoringConfig = {
    info: reqNumber(scRaw, "info", "scoring", { min: 0, max: 100 }),
    alert: reqNumber(scRaw, "alert", "scoring", { min: 0, max: 100 }),
    critical: reqNumber(scRaw, "critical", "scoring", { min: 0, max: 100 }),
    signalWindowHours: reqNumber(scRaw, "signalWindowHours", "scoring", { min: 1 }),
  };
  if (!(scoring.info < scoring.alert && scoring.alert < scoring.critical)) fail("scoring thresholds must satisfy info < alert < critical");

  const alRaw = raw["alerts"];
  if (!isObj(alRaw)) fail("alerts must be an object");
  const alerts: AlertsConfig = {
    telegram: reqBool(alRaw, "telegram", "alerts"),
    cooldownMinutes: reqNumber(alRaw, "cooldownMinutes", "alerts", { min: 0 }),
    escalationDelta: reqNumber(alRaw, "escalationDelta", "alerts", { min: 0 }),
    maxAlertsPerMinute: reqNumber(alRaw, "maxAlertsPerMinute", "alerts", { int: true, min: 1 }),
  };

  const dashRaw = raw["dashboard"];
  if (!isObj(dashRaw)) fail("dashboard must be an object");
  const dashboard = { port: reqNumber(dashRaw, "port", "dashboard", { int: true, min: 1, max: 65535 }) };

  const retRaw = raw["retention"] ?? {};
  if (!isObj(retRaw)) fail("retention must be an object");
  const retention: RetentionConfig = {
    eventDays: typeof retRaw["eventDays"] === "number" ? reqNumber(retRaw, "eventDays", "retention", { min: 1 }) : 7,
  };

  const whRaw = raw["webhooks"] ?? [];
  if (!Array.isArray(whRaw)) fail("webhooks must be an array");
  const webhooks: WebhookConfig[] = whRaw.map((w, i) => {
    const ctx = `webhooks[${i}]`;
    if (!isObj(w)) fail(`${ctx} must be an object`);
     const url = interpolate(reqString(w, "url", ctx));
     if (!/^https?:\/\//.test(url)) fail(`${ctx}.url must be an http(s):// URL`);
     let parsed: URL;
     try { parsed = new URL(url); } catch { fail(`${ctx}.url must be a valid URL`); }
     if (parsed.username || parsed.password || isPrivateHost(parsed.hostname)) fail(`${ctx}.url must not target private hosts or contain credentials`);
    const eventsRaw = w["events"];
    if (!Array.isArray(eventsRaw) || eventsRaw.length === 0) fail(`${ctx}.events must be a non-empty array`);
    const events = eventsRaw.map((e, j) => {
      if (e !== "alert" && e !== "signal") fail(`${ctx}.events[${j}] must be \"alert\" or \"signal\"`);
      return e;
    });
    const secretRaw = w["secret"];
    const secret = typeof secretRaw === "string" && secretRaw.length > 0 ? interpolate(secretRaw) : null;
    return {
      url,
      events: [...new Set(events)] as Array<"alert" | "signal">,
      secret,
      timeoutMs: typeof w["timeoutMs"] === "number" ? reqNumber(w, "timeoutMs", ctx, { int: true, min: 500, max: 60_000 }) : 10_000,
      retries: typeof w["retries"] === "number" ? reqNumber(w, "retries", ctx, { int: true, min: 0, max: 5 }) : 2,
    };
  });

  return {
    chains,
    watchlist,
    autoWatch,
    candidateDiscovery,
    volumeRanking,
    rules,
    scoring,
    alerts,
    dashboard,
    retention,
    webhooks,
    dbPath: typeof raw["dbPath"] === "string" ? (raw["dbPath"] as string) : "data/argus.db",
  };
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/[\[\]]/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "metadata.google.internal") return true;
  const version = isIP(host);
  if (version === 4) {
    const [a, b] = host.split(".").map(Number) as [number, number, number, number];
    return a === 10 || a === 127 || a === 0 || a === 169 && b === 254 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31;
  }
  return version === 6 && (host === "::1" || host === "::" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb"));
}

// ---- Loader ---------------------------------------------------------------

let cached: ArgusConfig | null = null;

export async function loadConfig(path = join(process.cwd(), "argus.config.ts")): Promise<ArgusConfig> {
  loadDotEnv();
  if (!existsSync(path)) fail(`config file not found at ${path}`);
  const mod = (await import(pathToFileURL(path).href + `?t=${Date.now()}`)) as { default: unknown };
  cached = validateConfig(mod.default);
  return cached;
}

export function getConfig(): ArgusConfig {
  if (!cached) fail("config not loaded — call loadConfig() first");
  return cached;
}

/** Re-read + re-validate config from disk. Returns null if the new file is invalid (old config stays active). */
export async function reloadConfig(path = join(process.cwd(), "argus.config.ts")): Promise<ArgusConfig | null> {
  const previous = cached;
  try {
    cached = null;
    return await loadConfig(path);
  } catch (err) {
    cached = previous;
    return null;
  }
}
