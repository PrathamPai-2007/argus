import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.ARGUS_LOG_LEVEL as LogLevel) ?? (process.argv.includes("--verbose") ? "debug" : "info")] ?? 20;

const LOG_DIR = join(process.cwd(), "logs");
mkdirSync(LOG_DIR, { recursive: true });

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Format log timestamps in UTC, independent of the host timezone. */
export function formatLogTimestamp(date = new Date()): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}-${pad(date.getUTCHours())}-${pad(date.getUTCMinutes())}-${pad(date.getUTCSeconds())}`;
}

const isTest = process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test" || process.argv.some((a) => a.includes("test"));
const file = join(LOG_DIR, isTest ? "argus-test.log" : `argus-${formatLogTimestamp()}.log`);

// Mask API keys / auth tokens embedded in URLs before anything hits the log file.
// viem error strings include the full request URL (e.g. `wss://.../ws/v3/<key>`),
// so error contexts were leaking Infura keys verbatim (observed 2026-08-14 18:22:39).
const URL_KEY_RE = /((?:wss?|https?):\/\/[^\s"'`]+\/)([A-Za-z0-9_-]{16,})/g;

export function redactUrl(s: string): string {
  return s.replace(URL_KEY_RE, "$1***");
}

function redactValue(v: unknown): unknown {
  if (typeof v === "string") return redactUrl(v);
  if (Array.isArray(v)) return v.map(redactValue);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = redactValue(val);
    return o;
  }
  return v;
}

function emit(level: LogLevel, msg: string, ctx?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const timestamp = formatLogTimestamp();
  const line = JSON.stringify({ ts: timestamp, level, msg: redactUrl(msg), ...(ctx ? (redactValue(ctx) as Record<string, unknown>) : {}) });
  appendFileSync(file, line + "\n");
  const c = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  c(`[${timestamp}] [${level}] ${redactUrl(msg)}${ctx ? " " + JSON.stringify(redactValue(ctx)) : ""}`);
}

export const log = {
  debug: (msg: string, ctx?: Record<string, unknown>) => emit("debug", msg, ctx),
  info: (msg: string, ctx?: Record<string, unknown>) => emit("info", msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => emit("warn", msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => emit("error", msg, ctx),
};

// Unhandled exceptions/rejections killed the 2026-08-14 run silently (trace went only to
// stderr). Always surface them into the log file — no more silent deaths.
process.on("uncaughtException", (err) => {
  emit("error", "uncaught exception", { err: String(err?.message ?? err), stack: err?.stack });
  process.exitCode = 1;
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  emit("error", "unhandled rejection", {
    err: String(reason instanceof Error ? reason.message : reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
  process.exitCode = 1;
  process.exit(1);
});
