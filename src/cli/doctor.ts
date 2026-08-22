import { existsSync, statfsSync } from "node:fs";
import { loadConfig, type ArgusConfig } from "../config.ts";
import { openDb, getDb, closeDb, listWatchedTokens } from "../db.ts";
import { probeEndpoint } from "../ingest/probe.ts";
import { probeTelegram } from "../alerts/telegram.ts";
import { redactUrl } from "../logger.ts";

// `doctor` — one-command pre-flight (PLAN.md §11.4): RPC connectivity (incl. trace
// capability per endpoint), Telegram token, DB integrity, disk space.

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

function fmt(c: Check): string {
  return `${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`;
}

export async function runDoctor(configPath?: string): Promise<number> {
  const checks: Check[] = [];
  let cfg: ArgusConfig | null = null;

  // 1. config
  try {
    cfg = await loadConfig(configPath);
    checks.push({ name: "config", ok: true, detail: `valid — ${cfg.chains.length} chain(s), ${cfg.watchlist.length} watched token(s)` });
  } catch (err) {
    checks.push({ name: "config", ok: false, detail: redactUrl(String(err)) });
    report(checks);
    return 1;
  }

  // 2. database
  try {
    openDb(cfg.dbPath);
    const row = getDb().query("PRAGMA integrity_check").get() as { integrity_check: string };
    const ok = row.integrity_check === "ok";
    checks.push({ name: "database", ok, detail: `${cfg.dbPath} integrity: ${row.integrity_check}` });
  } catch (err) {
    checks.push({ name: "database", ok: false, detail: redactUrl(String(err)) });
  }

  // 3. RPC endpoints (per chain, per endpoint)
  for (const chain of cfg.chains) {
    if (!chain.enabled) {
      checks.push({ name: `rpc[${chain.name}]`, ok: true, detail: "disabled — skipped" });
      continue;
    }
    if (chain.rpcs.length === 0) {
      checks.push({ name: `rpc[${chain.name}]`, ok: false, detail: "no endpoints configured" });
      continue;
    }
    let anyOk = false;
    for (const url of chain.rpcs) {
      const p = await probeEndpoint(url);
      anyOk = anyOk || p.reachable;
      const redacted = url.replace(/\/([A-Za-z0-9_-]{16,})$/, "/***");
      checks.push({
        name: `rpc[${chain.name}]`,
        ok: p.reachable,
        detail: p.reachable
          ? `${redacted} block=${p.blockNumber} latency=${p.latencyMs}ms traces=${p.tracesAvailable ? "yes" : "no"} archiveDepth=${p.maxArchiveDepth >= 100000 ? "full" : `${p.maxArchiveDepth}b`}`
          : `${redacted} unreachable: ${p.error}`,
      });
    }
    for (const url of chain.httpRpcs) {
      const p = await probeEndpoint(url, false);
      const redacted = url.replace(/\/([A-Za-z0-9_-]{16,})$/, "/***");
      checks.push({
        name: `http-rpc[${chain.name}]`,
        ok: p.reachable,
        detail: p.reachable ? `${redacted} block=${p.blockNumber} latency=${p.latencyMs}ms` : `${redacted} unreachable: ${p.error}`,
      });
    }
    if (!anyOk) checks.push({ name: `rpc[${chain.name}] pool`, ok: false, detail: "no working endpoint for an ENABLED chain" });
  }

  // 4. telegram
  if (cfg.alerts.telegram) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
      checks.push({ name: "telegram", ok: false, detail: "alerts.telegram=true but TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID missing in .env" });
    } else {
      const p = await probeTelegram(token);
      checks.push({ name: "telegram", ok: p.ok, detail: p.ok ? `bot @${p.username} reachable` : `getMe failed: ${p.error}` });
    }
  } else {
    checks.push({ name: "telegram", ok: true, detail: "disabled in config" });
  }

  // 5. historical backfill providers
  for (const chain of cfg.chains.filter((c) => c.enabled)) {
    const bf = chain.backfill;
    if (bf.etherscan.enabled) {
      let validUrl = false;
      try { validUrl = new URL(bf.etherscan.apiUrl).protocol === "https:"; } catch { /* invalid below */ }
      checks.push({ name: `etherscan[${chain.name}]`, ok: validUrl && Boolean(bf.etherscan.apiKey), detail: validUrl && bf.etherscan.apiKey ? "configured" : "enabled but URL or API key is invalid" });
    } else {
      checks.push({ name: `etherscan[${chain.name}]`, ok: true, detail: "disabled" });
    }
    if (bf.bigquery.enabled) {
      const ok = Boolean(bf.bigquery.projectId && bf.bigquery.credentialsPath && existsSync(bf.bigquery.credentialsPath ?? ""));
      checks.push({ name: `bigquery[${chain.name}]`, ok, detail: ok ? `configured — threshold ${bf.bigqueryThresholdHours}h` : "enabled but credentials/project are unavailable" });
    } else {
      checks.push({ name: `bigquery[${chain.name}]`, ok: true, detail: "disabled" });
    }
  }

  // 6. disk space
  try {
    const s = statfsSync(process.cwd());
    const freeGb = (Number(s.bavail) * Number(s.bsize)) / 1e9;
    checks.push({ name: "disk", ok: freeGb > 1, detail: `${freeGb.toFixed(1)} GB free` });
  } catch (err) {
    checks.push({ name: "disk", ok: true, detail: `could not stat fs: ${String(err)}` });
  }

  // 6. watchlist sanity
  try {
    const now = Math.floor(Date.now() / 1000);
    for (const chain of cfg.chains.filter((c) => c.enabled)) {
      const tokens = listWatchedTokens(chain.chainId, now);
      checks.push({ name: `watchlist[${chain.name}]`, ok: true, detail: `${tokens.length} active token(s)` });
    }
  } catch {
    /* db may be unavailable */
  }

  report(checks);
  closeDb();
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed === 0 ? "\ndoctor: all checks green" : `\ndoctor: ${failed} check(s) FAILED`);
  return failed === 0 ? 0 : 1;
}

function report(checks: Check[]): void {
  for (const c of checks) console.log(fmt(c));
}
