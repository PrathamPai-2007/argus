import { statfsSync } from "node:fs";
import { probeTelegram } from "../alerts/telegram.ts";
import { chainInfo } from "../chains.ts";
import { loadConfig, type ArgusConfig } from "../config.ts";
import { closeDb, getDb, listWatchedTokens, openDb } from "../db.ts";
import { ALL_TOPICS } from "../ingest/decode.ts";
import { defaultExplorer } from "../ingest/funders.ts";
import { hex, RpcPool } from "../ingest/rpc.ts";
import { redactUrl } from "../logger.ts";

// `doctor` — pre-flight for everything the live engine depends on.

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** Degraded but runnable. */
  warn?: boolean;
}

export async function runDoctor(configPath?: string): Promise<number> {
  const checks: Check[] = [];
  let cfg: ArgusConfig;
  try {
    cfg = await loadConfig(configPath);
    checks.push({ name: "config", ok: true, detail: `${cfg.chains.filter((c) => c.enabled).map((c) => c.name).join(", ")} · ${cfg.watchlist.length} manual watch(es)` });
  } catch (err) {
    checks.push({ name: "config", ok: false, detail: redactUrl(String(err)) });
    return report(checks);
  }

  try {
    openDb(cfg.dbPath);
    const row = getDb().query("PRAGMA integrity_check").get() as { integrity_check: string };
    const watched = cfg.chains.map((c) => `${c.name}: ${listWatchedTokens(c.chainId).length}`).join(", ");
    checks.push({ name: "database", ok: row.integrity_check === "ok", detail: `${cfg.dbPath} integrity ${row.integrity_check} · watched ${watched}` });
  } catch (err) {
    checks.push({ name: "database", ok: false, detail: String(err) });
  }

  for (const chain of cfg.chains.filter((c) => c.enabled)) {
    const info = chainInfo(chain.chainId);
    let anyHttp = false;
    for (const url of chain.http) {
      const rpc = new RpcPool([url], "doctor");
      const t0 = Date.now();
      try {
        const head = Number(BigInt(await rpc.request<string>("eth_blockNumber", [])));
        const latency = Date.now() - t0;
        const addresses = [...info.factories.map((f) => f.address), info.nativeUsdPool.address];
        const logs = await rpc.request<unknown[]>("eth_getLogs", [{ fromBlock: hex(head - 20), toBlock: hex(head - 1), address: addresses, topics: [ALL_TOPICS] }]);
        anyHttp = true;
        checks.push({ name: `http[${chain.name}]`, ok: true, detail: `${redactUrl(url)} head=${head} ${latency}ms · filtered getLogs ok (${logs.length} logs / 20 blocks)` });
      } catch (err) {
        checks.push({ name: `http[${chain.name}]`, ok: false, warn: true, detail: `${redactUrl(url)} — ${String(err).slice(0, 160)}` });
      }
    }
    if (!anyHttp) checks.push({ name: `http[${chain.name}]`, ok: false, detail: "no working HTTP endpoint — this chain cannot sync" });

    for (const url of chain.ws) {
      const r = await probeWs(url);
      checks.push({ name: `ws[${chain.name}]`, ok: r.ok, warn: !r.ok, detail: `${redactUrl(url)} — ${r.detail}` });
    }
    if (chain.ws.length === 0) checks.push({ name: `ws[${chain.name}]`, ok: true, warn: true, detail: "none configured — heads via HTTP polling" });

    const explorer = defaultExplorer(chain.chainId, cfg.explorerKeys);
    if (!explorer) {
      checks.push({ name: `funders[${chain.name}]`, ok: true, warn: true, detail: `no explorer key — clustering degrades (${chain.chainId === 1 ? "set ETHERSCAN_API_KEY" : "set BLOCKSCOUT_API_KEY, free at blockscout.com"})` });
    } else {
      const r = await probeExplorer(explorer.apiUrl, explorer.apiKey, explorer.chainParam);
      checks.push({ name: `funders[${chain.name}]`, ok: r.ok, warn: !r.ok, detail: r.detail });
    }
  }

  if (cfg.alerts.telegram) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token || !process.env.TELEGRAM_CHAT_ID) checks.push({ name: "telegram", ok: false, detail: "enabled but TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing" });
    else {
      const p = await probeTelegram(token);
      checks.push({ name: "telegram", ok: p.ok, detail: p.ok ? `bot @${p.username} reachable` : `getMe failed: ${p.error}` });
    }
  } else {
    checks.push({ name: "telegram", ok: true, warn: true, detail: "off — alerts go to the dashboard only" });
  }

  try {
    const s = statfsSync(process.cwd());
    const gb = (Number(s.bavail) * Number(s.bsize)) / 1e9;
    checks.push({ name: "disk", ok: gb > 1, detail: `${gb.toFixed(1)} GB free` });
  } catch { /* not fatal */ }

  closeDb();
  return report(checks);
}

function report(checks: Check[]): number {
  for (const c of checks) console.log(`${c.ok ? (c.warn ? "!" : "✓") : c.warn ? "!" : "✗"} ${c.name} — ${c.detail}`);
  const failed = checks.filter((c) => !c.ok && !c.warn).length;
  const warned = checks.filter((c) => c.warn).length;
  console.log(failed ? `\ndoctor: ${failed} check(s) failed` : `\ndoctor: ready${warned ? ` (${warned} warning${warned > 1 ? "s" : ""})` : ""}`);
  return failed ? 1 : 0;
}

function probeWs(url: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    const finish = (ok: boolean, detail: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* closed */ }
      resolve({ ok, detail });
    };
    const ws = new WebSocket(url);
    const timer = setTimeout(() => finish(false, "no newHeads subscription within 10s"), 10_000);
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["newHeads"] }));
    ws.onmessage = (m) => {
      const d = JSON.parse(String(m.data)) as { id?: number; error?: { message: string } };
      if (d.id === 1) finish(!d.error, d.error ? d.error.message : `newHeads subscribed in ${Date.now() - t0}ms`);
    };
    ws.onerror = () => finish(false, "connection failed");
  });
}

async function probeExplorer(apiUrl: string, apiKey: string | null, chainParam: { name: string; value: number } | null): Promise<{ ok: boolean; detail: string }> {
  const url = new URL(apiUrl);
  if (chainParam) url.searchParams.set(chainParam.name, String(chainParam.value));
  if (apiKey) url.searchParams.set("apikey", apiKey);
  for (const [k, v] of Object.entries({ module: "account", action: "txlist", address: "0x0000000000000000000000000000000000000001", page: "1", offset: "1", sort: "asc" })) url.searchParams.set(k, v);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const body = (await res.json()) as { status?: string; message?: string; result?: unknown };
    const ok = Array.isArray(body.result) || /no transactions/i.test(body.message ?? "");
    return { ok, detail: ok ? `${new URL(apiUrl).host} answering` : `${new URL(apiUrl).host}: ${body.message ?? "error"} ${typeof body.result === "string" ? body.result.slice(0, 100) : ""}` };
  } catch (err) {
    return { ok: false, detail: `${new URL(apiUrl).host} unreachable: ${String(err).slice(0, 120)}` };
  }
}
