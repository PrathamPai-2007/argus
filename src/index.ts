import { loadConfig } from "./config.ts";
import { DashboardServer } from "./dashboard/server.ts";
import { openDb, closeDb } from "./db.ts";
import { ArgusEngine } from "./engine.ts";
import { log } from "./logger.ts";
import { runDoctor } from "./cli/doctor.ts";
import { runReplay } from "./cli/replay.ts";
import { runBackfill } from "./cli/backfill.ts";

// CLI entrypoints (PLAN.md §4): run | replay | backfill | doctor

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function usage(): void {
  console.log(`argus — real-time on-chain intelligence pipeline

usage:
  bun run src/index.ts run [--config path] [--no-dashboard]
  bun run src/index.ts doctor [--config path]
  bun run src/index.ts replay --chain 1 --from <block> --to <block> [--token 0x...] [--preset name] [--config path]
  bun run src/index.ts backfill --chain 1 --from <block> --to <block> [--config path]

flags:
  --verbose   debug logging
`);
}

async function main(): Promise<number> {
  const cmd = process.argv[2] ?? "run";
  const configPath = argValue("--config");

  switch (cmd) {
    case "doctor":
      return runDoctor(configPath);

    case "replay": {
      const chainId = Number(argValue("--chain") ?? "1");
      const from = Number(argValue("--from"));
      const to = Number(argValue("--to"));
      if (!from || !to || to < from) {
        console.error("replay requires --from <block> --to <block>");
        return 1;
      }
      const token = argValue("--token");
      const preset = argValue("--preset");
      return runReplay({ chainId, from, to, ...(token ? { token } : {}), ...(preset ? { preset } : {}), ...(configPath ? { configPath } : {}) });
    }

    case "backfill": {
      const chainId = Number(argValue("--chain") ?? "1");
      const from = Number(argValue("--from"));
      const to = Number(argValue("--to"));
      if (!from || !to || to < from) {
        console.error("backfill requires --from <block> --to <block>");
        return 1;
      }
      return runBackfill({ chainId, from, to, ...(configPath ? { configPath } : {}) });
    }

    case "run": {
      const cfg = await loadConfig(configPath);
      openDb(cfg.dbPath);
      const engine = new ArgusEngine(cfg);
      await engine.start();

      let dashboard: DashboardServer | null = null;
      if (!hasFlag("--no-dashboard")) {
        dashboard = new DashboardServer(engine, { port: cfg.dashboard.port });
        dashboard.start();
      }

      const shutdown = () => {
        log.info("shutting down");
        dashboard?.stop();
        void engine.stop().then(() => {
          closeDb();
          process.exit(0);
        });
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      // periodic status line
      setInterval(() => {
        const s = engine.status();
        log.info("engine status", s as Record<string, unknown>);
      }, 60_000);
      return 0;
    }

    default:
      usage();
      return cmd === "help" || cmd === "--help" ? 0 : 1;
  }
}

main()
  .then((code) => {
    if (process.argv[2] !== "run") process.exit(code);
  })
  .catch((err) => {
    console.error("fatal:", err);
    process.exit(1);
  });
