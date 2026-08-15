import { loadConfig } from "../config.ts";
import * as db from "../db.ts";
import { EvmAdapter } from "../ingest/evm.ts";
import { log } from "../logger.ts";
import { seedLabels } from "../seeds.ts";
import { resolveFactories } from "../factories.ts";

// `backfill` — ingest a historical range via eth_getLogs to build training data (PLAN.md §10).

export interface BackfillArgs {
  chainId: number;
  from: number;
  to: number;
  configPath?: string;
}

export async function runBackfill(args: BackfillArgs): Promise<number> {
  const cfg = await loadConfig(args.configPath);
  const chain = cfg.chains.find((c) => c.chainId === args.chainId && c.enabled);
  if (!chain) {
    console.error(`chain ${args.chainId} not found/enabled in config`);
    return 1;
  }
  db.openDb(cfg.dbPath);
  seedLabels([args.chainId]);

  let total = 0;
  const adapter = new EvmAdapter(chain, {
    onEvents: (_chainId, events) => {
      total += events.length;
      db.insertEvents(events, true);
    },
    onFinalized: () => {},
    onReorg: () => {},
    onHead: () => {},
    onStatus: (_c, status, detail) => log.info("backfill adapter status", { status, ...detail }),
  });
  const labels = db.loadLabels(args.chainId);
  adapter.setDisperseContracts([...labels.entries()].filter(([, l]) => l.kind === "disperse").map(([a]) => a));
  const now = Math.floor(Date.now() / 1000);
  adapter.setWatchedTokens(db.listWatchedTokens(args.chainId, now + 10 * 365 * 86_400).map((t) => t.address));
  if (cfg.autoWatch.enabled) {
    adapter.setFactories(resolveFactories(args.chainId, cfg.autoWatch.factories));
  }
  adapter.addRelevantAddresses([...labels.keys()]);

  // connect without subscribing, then pull the historical range
  await adapter.connect();
  await adapter.backfillRange(BigInt(args.from), BigInt(args.to));

  console.log(`backfill complete: ${total} events ingested for chain ${args.chainId} blocks [${args.from}..${args.to}]`);
  await adapter.stop();
  db.closeDb();
  return 0;
}
