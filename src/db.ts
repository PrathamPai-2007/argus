import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "./logger.ts";
import type { Address, ChainEvent, DexVersion } from "./model.ts";
import type { Horizon, Position, PositionKind } from "./positions.ts";
import type { Assessment, Signal } from "./signals.ts";

// bun:sqlite (WAL) with plain .sql migrations. Events are facts; every other
// table is derived and either rebuildable (scores, signal log) or a durable
// journal (alerts, positions, wallet track records, funder lookups).

let db: Database | null = null;

export function openDb(path: string): Database {
  if (db) return db;
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
    backupV1(path);
  }
  db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = NORMAL;");
  migrate(db);
  return db;
}

export function getDb(): Database {
  if (!db) throw new Error("database not open — call openDb() first");
  return db;
}

export function closeDb(): void {
  db?.close();
  db = null;
}

/** The v2 migration drops v1 tables; keep a copy of any v1 database first. */
function backupV1(path: string): void {
  if (!existsSync(path)) return;
  const probe = new Database(path, { readonly: true });
  try {
    const names = probe.query("SELECT name FROM _migrations").all() as { name: string }[];
    if (names.length > 0 && !names.some((n) => n.name.startsWith("0014_"))) {
      const backup = path.replace(/\.db$/, "") + `.v1-backup-${Date.now()}.db`;
      probe.close();
      copyFileSync(path, backup);
      log.warn("v1 database detected — backed up before the v2 migration", { backup });
      return;
    }
  } catch {
    /* fresh or foreign file: nothing to back up */
  }
  probe.close();
}

function migrate(d: Database): void {
  d.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch()));");
  const dir = join(import.meta.dir, "..", "migrations");
  const applied = new Set((d.query("SELECT name FROM _migrations").all() as { name: string }[]).map((r) => r.name));
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (applied.has(f)) continue;
    const sql = readFileSync(join(dir, f), "utf8");
    d.transaction(() => {
      d.exec(sql);
      d.run("INSERT INTO _migrations (name) VALUES (?)", [f]);
    })();
    if (f.startsWith("0014_") || !f.startsWith("00")) log.info("applied migration", { migration: f });
  }
}

const now = () => Math.floor(Date.now() / 1000);
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

// ---- events -----------------------------------------------------------------------

const BIGINT_FIELDS = ["amount", "tokenAmount", "quoteAmount", "tokenReserve", "quoteReserve", "sqrtPriceX96"] as const;

export function reviveEvent(payload: string): ChainEvent {
  const e = JSON.parse(payload) as Record<string, unknown>;
  for (const k of BIGINT_FIELDS) if (typeof e[k] === "string") e[k] = BigInt(e[k] as string);
  return e as unknown as ChainEvent;
}

function eventToken(e: ChainEvent): Address | null {
  switch (e.kind) {
    case "transfer": case "swap": case "reserves": case "liquidity": return e.token;
    case "pool_created": return e.pool;
    case "funding": return null;
  }
}

/** Inserts new events; returns those not already stored (idempotent re-ingest). */
export function insertEvents(events: ChainEvent[]): ChainEvent[] {
  const d = getDb();
  const stmt = d.prepare("INSERT OR IGNORE INTO events (chain_id, block_number, tx_index, log_index, kind, token, timestamp, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const inserted: ChainEvent[] = [];
  d.transaction(() => {
    for (const e of events) {
      if (stmt.run(e.chainId, e.blockNumber, e.transactionIndex, e.logIndex, e.kind, eventToken(e), e.timestamp, json(e)).changes > 0) inserted.push(e);
    }
  })();
  return inserted;
}

export function loadEvents(chainId: number, opts: { tokens?: Address[]; fromBlock?: number; toBlock?: number; finalizedOnly?: boolean } = {}): ChainEvent[] {
  const where = ["chain_id = ?"];
  const params: (number | string)[] = [chainId];
  if (opts.fromBlock !== undefined) { where.push("block_number >= ?"); params.push(opts.fromBlock); }
  if (opts.toBlock !== undefined) { where.push("block_number <= ?"); params.push(opts.toBlock); }
  if (opts.finalizedOnly) where.push("finalized = 1");
  if (opts.tokens) {
    if (opts.tokens.length === 0) return [];
    where.push(`token IN (${opts.tokens.map(() => "?").join(",")})`);
    params.push(...opts.tokens);
  }
  const rows = getDb().query(`SELECT payload FROM events WHERE ${where.join(" AND ")} ORDER BY block_number, tx_index, log_index`).all(...params) as { payload: string }[];
  return rows.map((r) => reviveEvent(r.payload));
}

/** Finalize facts and the outputs derived from them. */
export function markFinalized(chainId: number, upToBlock: number): void {
  const d = getDb();
  d.transaction(() => {
    d.run("UPDATE events SET finalized = 1 WHERE chain_id = ? AND finalized = 0 AND block_number <= ?", [chainId, upToBlock]);
    d.run("UPDATE signal_log SET finalized = 1 WHERE chain_id = ? AND finalized = 0 AND block <= ?", [chainId, upToBlock]);
    d.run("UPDATE token_scores SET finalized = 1 WHERE chain_id = ? AND finalized = 0 AND block <= ?", [chainId, upToBlock]);
    d.run("UPDATE alerts SET confirmed = 1 WHERE chain_id = ? AND confirmed = 0 AND retracted = 0 AND block <= ?", [chainId, upToBlock]);
    d.run(
      "INSERT INTO sync_cursors (chain_id, finalized_block, updated_at) VALUES (?, ?, ?) ON CONFLICT(chain_id) DO UPDATE SET finalized_block = MAX(finalized_block, excluded.finalized_block), updated_at = excluded.updated_at",
      [chainId, upToBlock, now()],
    );
  })();
}

/** Reorg / restart: forget unfinalized facts and derived rows at or after a block. */
export function deleteUnfinalizedFrom(chainId: number, fromBlock: number): void {
  const d = getDb();
  d.transaction(() => {
    d.run("DELETE FROM events WHERE chain_id = ? AND finalized = 0 AND block_number >= ?", [chainId, fromBlock]);
    d.run("DELETE FROM signal_log WHERE chain_id = ? AND finalized = 0 AND block >= ?", [chainId, fromBlock]);
    d.run("DELETE FROM token_scores WHERE chain_id = ? AND finalized = 0 AND block >= ?", [chainId, fromBlock]);
  })();
}

export function finalizedCursor(chainId: number): number | null {
  const row = getDb().query("SELECT finalized_block FROM sync_cursors WHERE chain_id = ?").get(chainId) as { finalized_block: number } | null;
  return row?.finalized_block ?? null;
}

export function pruneEvents(olderThan: number): number {
  return getDb().run("DELETE FROM events WHERE finalized = 1 AND timestamp < ?", [olderThan]).changes;
}

// ---- tokens & pools ------------------------------------------------------------------

export interface TokenRow {
  chainId: number;
  address: Address;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  totalSupply: bigint | null;
  source: "launch" | "manual" | "pool";
  firstSeenAt: number;
  launchBlock: number | null;
  launchAt: number | null;
  watchUntil: number | null;
}

interface TokenDbRow {
  chain_id: number; address: string; symbol: string | null; name: string | null; decimals: number | null; total_supply: string | null;
  source: TokenRow["source"]; first_seen_at: number; launch_block: number | null; launch_at: number | null; watch_until: number | null;
}

const mapToken = (r: TokenDbRow): TokenRow => ({
  chainId: r.chain_id, address: r.address, symbol: r.symbol, name: r.name, decimals: r.decimals,
  totalSupply: r.total_supply === null ? null : BigInt(r.total_supply), source: r.source, firstSeenAt: r.first_seen_at,
  launchBlock: r.launch_block, launchAt: r.launch_at, watchUntil: r.watch_until,
});

export function upsertToken(t: Pick<TokenRow, "chainId" | "address" | "source" | "firstSeenAt"> & Partial<TokenRow>): void {
  getDb().run(
    `INSERT INTO tokens (chain_id, address, symbol, name, decimals, total_supply, source, first_seen_at, launch_block, launch_at, watch_until)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chain_id, address) DO UPDATE SET
       symbol = COALESCE(excluded.symbol, symbol), name = COALESCE(excluded.name, name),
       decimals = COALESCE(excluded.decimals, decimals), total_supply = COALESCE(excluded.total_supply, total_supply),
       source = CASE WHEN source = 'manual' THEN 'manual' ELSE excluded.source END,
       launch_block = COALESCE(launch_block, excluded.launch_block), launch_at = COALESCE(launch_at, excluded.launch_at),
       watch_until = CASE WHEN source = 'manual' OR excluded.source = 'manual' THEN NULL ELSE MAX(COALESCE(watch_until, 0), COALESCE(excluded.watch_until, 0)) END`,
    [t.chainId, t.address, t.symbol ?? null, t.name ?? null, t.decimals ?? null, t.totalSupply?.toString() ?? null, t.source, t.firstSeenAt, t.launchBlock ?? null, t.launchAt ?? null, t.source === "manual" ? null : (t.watchUntil ?? null)],
  );
}

export function setWatchUntil(chainId: number, address: Address, until: number): void {
  getDb().run("UPDATE tokens SET watch_until = ? WHERE chain_id = ? AND address = ? AND source != 'manual'", [until, chainId, address]);
}

export function getToken(chainId: number, address: Address): TokenRow | null {
  const r = getDb().query("SELECT * FROM tokens WHERE chain_id = ? AND address = ?").get(chainId, address) as TokenDbRow | null;
  return r ? mapToken(r) : null;
}

export function listWatchedTokens(chainId: number, at = now()): TokenRow[] {
  return (getDb().query("SELECT * FROM tokens WHERE chain_id = ? AND (watch_until IS NULL OR watch_until > ?)").all(chainId, at) as TokenDbRow[]).map(mapToken);
}

export function listTokens(addresses: Array<{ chainId: number; address: Address }>): Map<string, TokenRow> {
  const out = new Map<string, TokenRow>();
  const q = getDb().query("SELECT * FROM tokens WHERE chain_id = ? AND address = ?");
  for (const a of addresses) {
    const r = q.get(a.chainId, a.address) as TokenDbRow | null;
    if (r) out.set(`${a.chainId}:${a.address}`, mapToken(r));
  }
  return out;
}

export interface PoolRow {
  chainId: number;
  address: Address;
  dex: DexVersion;
  token0: Address;
  token1: Address;
  token: Address;
  quote: Address;
  createdBlock: number | null;
}

export function insertPool(p: PoolRow): void {
  getDb().run(
    "INSERT OR IGNORE INTO pools (chain_id, address, dex, token0, token1, token, quote, created_block) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [p.chainId, p.address, p.dex, p.token0, p.token1, p.token, p.quote, p.createdBlock],
  );
}

export function listPools(chainId: number, token?: Address): PoolRow[] {
  const rows = (token
    ? getDb().query("SELECT * FROM pools WHERE chain_id = ? AND token = ?").all(chainId, token)
    : getDb().query("SELECT * FROM pools WHERE chain_id = ?").all(chainId)) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    chainId: r["chain_id"] as number, address: r["address"] as string, dex: r["dex"] as DexVersion, token0: r["token0"] as string,
    token1: r["token1"] as string, token: r["token"] as string, quote: r["quote"] as string, createdBlock: r["created_block"] as number | null,
  }));
}

// ---- labels & funders ------------------------------------------------------------------

export function insertLabel(address: Address, chainId: number, label: string, kind: string): void {
  getDb().run("INSERT OR IGNORE INTO labels (chain_id, address, label, kind) VALUES (?, ?, ?, ?)", [chainId, address.toLowerCase(), label, kind]);
}

export function loadLabels(chainId: number): Map<Address, { label: string; kind: string }> {
  const rows = getDb().query("SELECT address, label, kind FROM labels WHERE chain_id = ?").all(chainId) as Array<{ address: string; label: string; kind: string }>;
  return new Map(rows.map((r) => [r.address, { label: r.label, kind: r.kind }]));
}

export interface FundingRow {
  wallet: Address;
  funder: Address | null;
  fundedBlock: number | null;
  funderIsService: boolean;
}

export function saveFunding(chainId: number, f: FundingRow): void {
  getDb().run(
    "INSERT OR REPLACE INTO wallet_funding (chain_id, wallet, funder, funded_block, funder_is_service, resolved_at) VALUES (?, ?, ?, ?, ?, ?)",
    [chainId, f.wallet, f.funder, f.fundedBlock, f.funderIsService ? 1 : 0, now()],
  );
}

export function loadFunding(chainId: number): FundingRow[] {
  return (getDb().query("SELECT wallet, funder, funded_block, funder_is_service FROM wallet_funding WHERE chain_id = ?").all(chainId) as Array<{ wallet: string; funder: string | null; funded_block: number | null; funder_is_service: number }>)
    .map((r) => ({ wallet: r.wallet, funder: r.funder, fundedBlock: r.funded_block, funderIsService: r.funder_is_service === 1 }));
}

// ---- scores & signal log ------------------------------------------------------------

export interface ScoreRow {
  chainId: number;
  token: Address;
  at: number;
  block: number;
  score: number;
  verdict: Assessment["verdict"];
  gate: string | null;
  signals: Signal[];
  metrics: Record<string, unknown>;
}

export function upsertScore(a: Assessment, block: number, metrics: Record<string, unknown>): void {
  getDb().run(
    `INSERT INTO token_scores (chain_id, token, at, block, score, verdict, gate, signals, metrics, finalized) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(chain_id, token) DO UPDATE SET at = excluded.at, block = excluded.block, score = excluded.score, verdict = excluded.verdict,
       gate = excluded.gate, signals = excluded.signals, metrics = excluded.metrics, finalized = 0`,
    [a.chainId, a.token, a.at, block, a.score, a.verdict, a.gate, json(a.signals), json(metrics)],
  );
}

const mapScore = (r: Record<string, unknown>): ScoreRow => ({
  chainId: r["chain_id"] as number, token: r["token"] as string, at: r["at"] as number, block: r["block"] as number, score: r["score"] as number,
  verdict: r["verdict"] as ScoreRow["verdict"], gate: r["gate"] as string | null, signals: JSON.parse(r["signals"] as string) as Signal[],
  metrics: JSON.parse(r["metrics"] as string) as Record<string, unknown>,
});

export function listScores(opts: { chainId?: number; tokens?: Array<{ chainId: number; address: Address }>; limit?: number } = {}): ScoreRow[] {
  if (opts.tokens) {
    const q = getDb().query("SELECT * FROM token_scores WHERE chain_id = ? AND token = ?");
    return opts.tokens.map((t) => q.get(t.chainId, t.address) as Record<string, unknown> | null).filter((r): r is Record<string, unknown> => r !== null).map(mapScore);
  }
  const rows = opts.chainId === undefined
    ? getDb().query("SELECT * FROM token_scores ORDER BY score DESC, at DESC LIMIT ?").all(opts.limit ?? 200)
    : getDb().query("SELECT * FROM token_scores WHERE chain_id = ? ORDER BY score DESC, at DESC LIMIT ?").all(opts.chainId, opts.limit ?? 200);
  return (rows as Array<Record<string, unknown>>).map(mapScore);
}

export function getScore(chainId: number, token: Address): ScoreRow | null {
  const r = getDb().query("SELECT * FROM token_scores WHERE chain_id = ? AND token = ?").get(chainId, token) as Record<string, unknown> | null;
  return r ? mapScore(r) : null;
}

export function deleteScore(chainId: number, token: Address): void {
  getDb().run("DELETE FROM token_scores WHERE chain_id = ? AND token = ?", [chainId, token]);
}

export interface SignalLogRow {
  id: number;
  chainId: number;
  token: Address;
  signalId: string;
  kind: string;
  severity: string;
  change: "fired" | "escalated" | "cleared";
  title: string;
  evidence: Record<string, unknown>;
  block: number;
  at: number;
}

export function logSignal(chainId: number, token: Address, s: Signal, change: SignalLogRow["change"], block: number, at: number): number {
  return Number(getDb().run(
    "INSERT INTO signal_log (chain_id, token, signal_id, kind, severity, change, title, evidence, block, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [chainId, token, s.id, s.kind, s.severity, change, s.title, json(s.evidence), block, at],
  ).lastInsertRowid);
}

export function listSignalLog(opts: { chainId?: number; token?: Address; beforeId?: number; limit?: number } = {}): SignalLogRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.chainId !== undefined) { where.push("chain_id = ?"); params.push(opts.chainId); }
  if (opts.token !== undefined) { where.push("token = ?"); params.push(opts.token); }
  if (opts.beforeId !== undefined) { where.push("id < ?"); params.push(opts.beforeId); }
  params.push(opts.limit ?? 100);
  const rows = getDb().query(`SELECT * FROM signal_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`).all(...params) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r["id"] as number, chainId: r["chain_id"] as number, token: r["token"] as string, signalId: r["signal_id"] as string, kind: r["kind"] as string,
    severity: r["severity"] as string, change: r["change"] as SignalLogRow["change"], title: r["title"] as string,
    evidence: JSON.parse(r["evidence"] as string) as Record<string, unknown>, block: r["block"] as number, at: r["at"] as number,
  }));
}

// ---- alerts ----------------------------------------------------------------------------

export interface AlertPayload {
  chainId: number;
  token: Address;
  kind: "opportunity" | "exit";
  verdict: Assessment["verdict"];
  score: number;
  symbol: string | null;
  headline: string;
  signals: Signal[];
  priceUsd: number | null;
  liquidityUsd: number;
  ageSec: number;
  links: Record<string, string>;
}

export interface AlertRow extends AlertPayload {
  id: number;
  block: number;
  createdAt: number;
  confirmed: boolean;
  retracted: boolean;
}

export function insertAlert(p: AlertPayload, block: number, confirmed: boolean): number {
  return Number(getDb().run(
    "INSERT INTO alerts (chain_id, token, kind, verdict, score, block, created_at, confirmed, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [p.chainId, p.token, p.kind, p.verdict, p.score, block, now(), confirmed ? 1 : 0, json(p)],
  ).lastInsertRowid);
}

const mapAlert = (r: Record<string, unknown>): AlertRow => ({
  ...(JSON.parse(r["payload"] as string) as AlertPayload),
  id: r["id"] as number, block: r["block"] as number, createdAt: r["created_at"] as number,
  confirmed: r["confirmed"] === 1, retracted: r["retracted"] === 1,
});

export function getAlert(id: number): AlertRow | null {
  const r = getDb().query("SELECT * FROM alerts WHERE id = ?").get(id) as Record<string, unknown> | null;
  return r ? mapAlert(r) : null;
}

export function lastAlert(chainId: number, token: Address, kind: AlertPayload["kind"]): AlertRow | null {
  const r = getDb().query("SELECT * FROM alerts WHERE chain_id = ? AND token = ? AND kind = ? AND retracted = 0 ORDER BY id DESC LIMIT 1").get(chainId, token, kind) as Record<string, unknown> | null;
  return r ? mapAlert(r) : null;
}

export function alertsSince(ts: number): number {
  return (getDb().query("SELECT COUNT(*) AS n FROM alerts WHERE created_at >= ? AND retracted = 0").get(ts) as { n: number }).n;
}

export function listAlerts(opts: { chainId?: number; token?: Address; beforeId?: number; limit?: number } = {}): AlertRow[] {
  const where = ["1 = 1"];
  const params: (string | number)[] = [];
  if (opts.chainId !== undefined) { where.push("chain_id = ?"); params.push(opts.chainId); }
  if (opts.token !== undefined) { where.push("token = ?"); params.push(opts.token); }
  if (opts.beforeId !== undefined) { where.push("id < ?"); params.push(opts.beforeId); }
  params.push(opts.limit ?? 100);
  return (getDb().query(`SELECT * FROM alerts WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`).all(...params) as Array<Record<string, unknown>>).map(mapAlert);
}

/** Retract unconfirmed alerts at or after a reorg boundary; returns their ids. */
export function retractAlertsFrom(chainId: number, fromBlock: number): number[] {
  const d = getDb();
  const ids = (d.query("SELECT id FROM alerts WHERE chain_id = ? AND confirmed = 0 AND retracted = 0 AND block >= ?").all(chainId, fromBlock) as { id: number }[]).map((r) => r.id);
  if (ids.length > 0) {
    d.run(`UPDATE alerts SET retracted = 1 WHERE id IN (${ids.join(",")})`);
    d.run(`UPDATE positions SET retracted = 1, closed_at = COALESCE(closed_at, ?) WHERE alert_id IN (${ids.join(",")})`, [now()]);
  }
  return ids;
}

// ---- positions -------------------------------------------------------------------------

interface PositionDbRow {
  id: number; chain_id: number; token: string; kind: PositionKind; alert_id: number | null; score: number | null;
  entry_unit_usd: number; entry_at: number; entry_block: number; last_unit_usd: number; last_at: number;
  peak_unit_usd: number; trough_unit_usd: number; r_m15: number | null; r_h1: number | null; r_h6: number | null; r_h24: number | null;
  closed_at: number | null; retracted: number;
}

const mapPosition = (r: PositionDbRow): Position => ({
  id: r.id, chainId: r.chain_id, token: r.token, kind: r.kind, alertId: r.alert_id, score: r.score,
  entryUnitUsd: r.entry_unit_usd, entryAt: r.entry_at, entryBlock: r.entry_block, lastUnitUsd: r.last_unit_usd, lastAt: r.last_at,
  peakUnitUsd: r.peak_unit_usd, troughUnitUsd: r.trough_unit_usd,
  returns: { m15: r.r_m15, h1: r.r_h1, h6: r.r_h6, h24: r.r_h24 } as Record<Horizon, number | null>, closedAt: r.closed_at,
});

/** Insert a position; returns its id, or 0 if a baseline already exists for the token. */
export function insertPosition(p: Position): number {
  const res = getDb().run(
    `INSERT OR IGNORE INTO positions (chain_id, token, kind, alert_id, score, entry_unit_usd, entry_at, entry_block, last_unit_usd, last_at, peak_unit_usd, trough_unit_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [p.chainId, p.token, p.kind, p.alertId, p.score, p.entryUnitUsd, p.entryAt, p.entryBlock, p.lastUnitUsd, p.lastAt, p.peakUnitUsd, p.troughUnitUsd],
  );
  return res.changes > 0 ? Number(res.lastInsertRowid) : 0;
}

export function savePosition(p: Position): void {
  getDb().run(
    "UPDATE positions SET last_unit_usd = ?, last_at = ?, peak_unit_usd = ?, trough_unit_usd = ?, r_m15 = ?, r_h1 = ?, r_h6 = ?, r_h24 = ?, closed_at = ? WHERE id = ?",
    [p.lastUnitUsd, p.lastAt, p.peakUnitUsd, p.troughUnitUsd, p.returns.m15, p.returns.h1, p.returns.h6, p.returns.h24, p.closedAt, p.id],
  );
}

export function listPositions(opts: { openOnly?: boolean; chainId?: number; token?: Address; limit?: number } = {}): Position[] {
  const where = ["retracted = 0"];
  const params: (string | number)[] = [];
  if (opts.openOnly) where.push("closed_at IS NULL");
  if (opts.chainId !== undefined) { where.push("chain_id = ?"); params.push(opts.chainId); }
  if (opts.token !== undefined) { where.push("token = ?"); params.push(opts.token); }
  params.push(opts.limit ?? 5_000);
  return (getDb().query(`SELECT * FROM positions WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`).all(...params) as PositionDbRow[]).map(mapPosition);
}

// ---- wallet track records -----------------------------------------------------------------

export interface WalletTradeDelta {
  wallet: Address;
  token: Address;
  side: "buy" | "sell";
  tokenAmount: number;
  usd: number;
  at: number;
}

export function applyWalletTrades(chainId: number, trades: WalletTradeDelta[]): void {
  const d = getDb();
  const stmt = d.prepare(
    `INSERT INTO wallet_positions (chain_id, wallet, token, bought, sold, cost_usd, proceeds_usd, buys, sells, first_at, last_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chain_id, wallet, token) DO UPDATE SET
       bought = bought + excluded.bought, sold = sold + excluded.sold, cost_usd = cost_usd + excluded.cost_usd,
       proceeds_usd = proceeds_usd + excluded.proceeds_usd, buys = buys + excluded.buys, sells = sells + excluded.sells,
       last_at = MAX(last_at, excluded.last_at)`,
  );
  d.transaction(() => {
    for (const t of trades) {
      const buy = t.side === "buy";
      stmt.run(chainId, t.wallet, t.token, buy ? t.tokenAmount : 0, buy ? 0 : t.tokenAmount, buy ? t.usd : 0, buy ? 0 : t.usd, buy ? 1 : 0, buy ? 0 : 1, t.at, t.at);
    }
  })();
}

export interface WalletStats {
  chainId: number;
  wallet: Address;
  tokensTraded: number;
  closedTrades: number;
  wins: number;
  winRate: number;
  realizedPnlUsd: number;
  volumeUsd: number;
  lastAt: number;
}

const mapStats = (r: Record<string, number | string>): WalletStats => ({
  chainId: r["chain_id"] as number, wallet: r["wallet"] as string, tokensTraded: r["tokens_traded"] as number, closedTrades: r["closed_trades"] as number,
  wins: r["wins"] as number, winRate: (r["closed_trades"] as number) > 0 ? (r["wins"] as number) / (r["closed_trades"] as number) : 0,
  realizedPnlUsd: r["realized_pnl_usd"] as number, volumeUsd: r["volume_usd"] as number, lastAt: r["last_at"] as number,
});

export function smartWallets(chainId: number, c: { minClosedTrades: number; minWinRate: number; minPnlUsd: number }): Set<Address> {
  const rows = getDb().query(
    "SELECT wallet FROM wallet_stats WHERE chain_id = ? AND closed_trades >= ? AND wins >= closed_trades * ? AND realized_pnl_usd > ?",
  ).all(chainId, c.minClosedTrades, c.minWinRate, c.minPnlUsd) as { wallet: string }[];
  return new Set(rows.map((r) => r.wallet));
}

export function walletLeaderboard(opts: { chainId?: number; minClosedTrades: number; limit?: number }): WalletStats[] {
  const rows = opts.chainId === undefined
    ? getDb().query("SELECT * FROM wallet_stats WHERE closed_trades >= ? ORDER BY realized_pnl_usd DESC LIMIT ?").all(opts.minClosedTrades, opts.limit ?? 100)
    : getDb().query("SELECT * FROM wallet_stats WHERE chain_id = ? AND closed_trades >= ? ORDER BY realized_pnl_usd DESC LIMIT ?").all(opts.chainId, opts.minClosedTrades, opts.limit ?? 100);
  return (rows as Array<Record<string, number | string>>).map(mapStats);
}

export function walletDetail(chainId: number, wallet: Address): { stats: WalletStats | null; positions: Array<Record<string, unknown>> } {
  const s = getDb().query("SELECT * FROM wallet_stats WHERE chain_id = ? AND wallet = ?").get(chainId, wallet) as Record<string, number | string> | null;
  const positions = getDb().query("SELECT token, bought, sold, cost_usd, proceeds_usd, buys, sells, first_at, last_at FROM wallet_positions WHERE chain_id = ? AND wallet = ? ORDER BY last_at DESC LIMIT 100").all(chainId, wallet) as Array<Record<string, unknown>>;
  return { stats: s ? mapStats(s) : null, positions };
}

// ---- failed events (invariant 12) -------------------------------------------------------------

export function recordFailedEvent(e: ChainEvent, err: unknown): void {
  getDb().run(
    `INSERT INTO failed_events (chain_id, block_number, tx_index, log_index, kind, payload, error, failed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO UPDATE SET attempts = attempts + 1, error = excluded.error, failed_at = excluded.failed_at`,
    [e.chainId, e.blockNumber, e.transactionIndex, e.logIndex, e.kind, json(e), String(err).slice(0, 1_000), now()],
  );
}

export function clearFailedEvent(e: ChainEvent): void {
  getDb().run("DELETE FROM failed_events WHERE chain_id = ? AND block_number = ? AND tx_index = ? AND log_index = ?", [e.chainId, e.blockNumber, e.transactionIndex, e.logIndex]);
}

export function countFailedEvents(): number {
  return (getDb().query("SELECT COUNT(*) AS n FROM failed_events").get() as { n: number }).n;
}

export function countFunding(chainId: number): number {
  return (getDb().query("SELECT COUNT(*) AS n FROM wallet_funding WHERE chain_id = ?").get(chainId) as { n: number }).n;
}
