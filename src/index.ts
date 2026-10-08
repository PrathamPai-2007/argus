import { watch } from "node:fs";
import { runDoctor } from "./cli/doctor.ts";
import { runReplay } from "./cli/replay.ts";
import { loadConfig, reloadConfig } from "./config.ts";
import { DashboardServer } from "./dashboard/server.ts";
import { closeDb, openDb } from "./db.ts";
import { ArgusEngine } from "./engine.ts";
import { log } from "./logger.ts";

// CLI: run | doctor | replay

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function intArg(flag: string): number | null {
  const v = argValue(flag);
  if (v === undefined || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

function usage(): void {
  console.log(`argus — on-chain opportunity scanner (Ethereum + Base, Uniswap V2/V3)

usage:
  bun run start                      live engine + dashboard (http://127.0.0.1:3737)
  bun run src/index.ts run [--rewind <blocks>] [--no-dashboard] [--config path]
        --rewind N   start N blocks behind the head and catch up through the live
                     path (seeds launches and wallet track records; PublicNode
                     serves ~9k blocks of logs keyless)
  bun run doctor                     pre-flight: config, DB, RPC/WS, explorer keys, Telegram
  bun run replay --chain <id> [--from <block>] [--to <block>]
                                     re-score stored events offline with the current config

flags:
  --verbose   debug logging
`);
}

async function run(configPath: string | undefined): Promise<void> {
  const cfg = await loadConfig(configPath);
  openDb(cfg.dbPath);
  const rewind = intArg("--rewind");
  const engine = new ArgusEngine(cfg, rewind ? { rewindBlocks: rewind } : {});
  await engine.start();

  let dashboard: DashboardServer | null = null;
  if (!process.argv.includes("--no-dashboard")) {
    dashboard = new DashboardServer(engine, cfg);
    dashboard.start();
  }

  let debounce: ReturnType<typeof setTimeout> | null = null;
  const watcher = watch(configPath ?? "argus.config.ts", () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(async () => {
      const next = await reloadConfig(configPath);
      if (next) engine.updateConfig(next);
      else log.warn("config reload failed validation — keeping the previous config");
    }, 500);
  });

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    log.info("shutting down");
    watcher.close();
    dashboard?.stop();
    void engine.stop().finally(() => {
      closeDb();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  setInterval(() => log.info("engine status", { chains: engine.status().chains.map((c) => ({ chain: c.name, status: c.status, lag: c.lag, tokens: c.watchedTokens, nativeUsd: c.nativeUsd, rpc: c.rpc })) }), 60_000);
}

async function main(): Promise<number | null> {
  const cmd = process.argv[2] ?? "run";
  const configPath = argValue("--config");
  switch (cmd) {
    case "run":
      await run(configPath);
      return null; // keep the process alive
    case "doctor":
      return runDoctor(configPath);
    case "replay": {
      const chainId = intArg("--chain");
      if (chainId === null) {
        console.error("replay requires --chain <id>");
        return 1;
      }
      const from = intArg("--from");
      const to = intArg("--to");
      return runReplay({ chainId, ...(from !== null ? { from } : {}), ...(to !== null ? { to } : {}), ...(configPath ? { configPath } : {}) });
    }
    default:
      usage();
      return cmd === "help" || cmd === "--help" ? 0 : 1;
  }
}

main()
  .then((code) => {
    if (code !== null) process.exit(code);
  })
  .catch((err) => {
    console.error("fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
