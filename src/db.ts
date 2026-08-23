import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Address, AlertPayload, CandidateStatus, EventKind, Signal, StandardEvent, SwapEvent, TokenCandidate, TokenMeta } from "./types.ts";
import { log } from "./logger.ts";
import type { PerformanceOutcome, PerformanceSession } from "./performance.ts";

// bun:sqlite (WAL mode), plain .sql migrations — no ORM (PLAN.md §2).

let db: Database | null = null;

export function openDb(path: string): Database {
  if (db) return db;
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
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

function migrate(d: Database): void {
  d.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch()));");
  const dir = join(process.cwd(), "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const applied = new Set((d.query("SELECT name FROM _migrations").all() as { name: string }[]).map((r) => r.name));
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(join(dir, f), "utf8");
    d.transaction(() => {
      d.exec(sql);
      d.run("INSERT INTO _migrations (name) VALUES (?)", [f]);
    })();
    log.info("applied migration", { migration: f });
  }
}

// ---- Events ----------------------------------------------------------------

const INSERT_EVENT = `
  INSERT OR IGNORE INTO events (chain_id, block_number, log_index, tx_hash, type, payload_json, finalized)
  VALUES (?, ?, ?, ?, ?, ?, ?)`;

/** Serialize an event for storage — bigints become decimal strings. */
function eventPayload(evt: StandardEvent): string {
  return JSON.stringify(evt, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

export function insertEvents(events: StandardEvent[], finalized: boolean): StandardEvent[] {
  const d = getDb();
  const stmt = d.prepare(INSERT_EVENT);
  const inserted: StandardEvent[] = [];
  d.transaction(() => {
    for (const e of events) {
      const result = stmt.run(e.chainId, e.blockNumber, e.logIndex, e.txHash, e.kind, eventPayload(e), finalized ? 1 : 0);
      if (Number(result.changes) > 0) inserted.push(e);
    }
  })();
  return inserted;
}

export function markEventsFinalized(chainId: number, upToBlock: number): number {
  const res = getDb().run(
    "UPDATE events SET finalized = 1 WHERE chain_id = ? AND finalized = 0 AND block_number <= ?",
    [chainId, upToBlock],
  );
  return Number(res.changes);
}

export function deleteUnfinalizedFrom(chainId: number, fromBlock: number): number {
  const res = getDb().run("DELETE FROM events WHERE chain_id = ? AND finalized = 0 AND block_number >= ?", [chainId, fromBlock]);
  return Number(res.changes);
}

/** Remove durable projections created by a forked block range. */
export function deleteDerivedFrom(chainId: number, fromBlock: number): void {
  const d = getDb();
  d.transaction(() => {
    const pools = d.query("SELECT pool_address, token_address FROM pools WHERE chain_id = ? AND created_block >= ?").all(chainId, fromBlock) as {
      pool_address: string;
      token_address: string;
    }[];
    d.run("DELETE FROM funding_edges WHERE chain_id = ? AND block_number >= ?", [chainId, fromBlock]);
    d.run("DELETE FROM wallets WHERE chain_id = ? AND first_seen_block >= ?", [chainId, fromBlock]);
    d.run("DELETE FROM signals WHERE chain_id = ? AND block_number >= ?", [chainId, fromBlock]);
    d.run("DELETE FROM pools WHERE chain_id = ? AND created_block >= ?", [chainId, fromBlock]);
    for (const pool of pools) {
      d.run("DELETE FROM tokens WHERE chain_id = ? AND source = 'factory' AND address = ? AND NOT EXISTS (SELECT 1 FROM pools WHERE chain_id = ? AND token_address = ?)", [chainId, pool.token_address, chainId, pool.token_address]);
    }
  })();
}

export function loadEvents(chainId: number, fromBlock: number, toBlock: number, opts?: { finalizedOnly?: boolean; kinds?: EventKind[] }): StandardEvent[] {
  let sql = "SELECT payload_json FROM events WHERE chain_id = ? AND block_number >= ? AND block_number <= ?";
  const params: (string | number)[] = [chainId, fromBlock, toBlock];
  if (opts?.finalizedOnly) sql += " AND finalized = 1";
  if (opts?.kinds?.length) sql += ` AND type IN (${opts.kinds.map(() => "?").join(",")})`;
  sql += " ORDER BY block_number, log_index";
  if (opts?.kinds?.length) params.push(...opts.kinds);
  const rows = getDb().query(sql).all(...params) as { payload_json: string }[];
  return rows.map((r) => reviveEvent(JSON.parse(r.payload_json, (_k, v) => v) as Record<string, unknown>) as StandardEvent);
}

export function latestSwapForToken(chainId: number, tokenAddress: Address): SwapEvent | null {
  const row = getDb().query(
    `SELECT payload_json FROM events
     WHERE chain_id = ? AND type = 'swap' AND json_extract(payload_json, '$.tokenAddress') = ?
     ORDER BY block_number DESC, log_index DESC LIMIT 1`,
  ).get(chainId, tokenAddress) as { payload_json: string } | null;
  return row ? reviveEvent(JSON.parse(row.payload_json) as Record<string, unknown>) as SwapEvent : null;
}

// payload_json round-trips bigints to decimal strings; revive the amount fields so
// graph.applyEvent/replay get real BigInts (was: "Invalid mix of BigInt and other type").
const BIGINT_FIELDS: Partial<Record<EventKind, string[]>> = {
  transfer: ["amount"],
  swap: ["tokenAmount", "quoteAmount"],
  funding: ["amount"],
};

function reviveEvent(e: Record<string, unknown>): StandardEvent {
  if (typeof e["timestamp"] === "string") e["timestamp"] = Number(e["timestamp"]);
  for (const f of BIGINT_FIELDS[e["kind"] as EventKind] ?? []) {
    const v = e[f];
    if (typeof v === "string" || typeof v === "number") e[f] = BigInt(v);
  }
  return e as unknown as StandardEvent;
}

export function pruneEvents(olderThanSecs: number): number {
  const cutoff = Math.floor(Date.now() / 1000) - olderThanSecs;
  // events carry their timestamp inside payload; use block-time proxy via created rows is unavailable,
  // so prune by parsed timestamp stored in payload json_extract.
  const res = getDb().run(
    "DELETE FROM events WHERE finalized = 1 AND CAST(json_extract(payload_json, '$.timestamp') AS INTEGER) < ?",
    [cutoff],
  );
  return Number(res.changes);
}

// ---- Wallets / funding -----------------------------------------------------

export interface WalletRow {
  address: Address;
  chain_id: number;
  first_seen_block: number;
  first_seen_at: number;
  funder_address: Address | null;
  cluster_id: string | null;
}

export function upsertWallet(w: { address: Address; chainId: number; firstSeenBlock: number; firstSeenAt: number; funder?: Address | null }): void {
  getDb().run(
    `INSERT INTO wallets (address, chain_id, first_seen_block, first_seen_at, funder_address)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(address, chain_id) DO NOTHING`,
    [w.address, w.chainId, w.firstSeenBlock, w.firstSeenAt, w.funder ?? null],
  );
}

export function getWallet(address: Address, chainId: number): WalletRow | null {
  return (getDb().query("SELECT * FROM wallets WHERE address = ? AND chain_id = ?").get(address, chainId) as WalletRow | null);
}

export function insertFundingEdge(e: { funder: Address; funded: Address; chainId: number; amount: bigint; blockNumber: number; method: string }): void {
  getDb().run("INSERT INTO funding_edges (funder, funded, chain_id, amount, block_number, method) VALUES (?, ?, ?, ?, ?, ?)", [
    e.funder,
    e.funded,
    e.chainId,
    e.amount.toString(),
    e.blockNumber,
    e.method,
  ]);
}

export function loadFundingEdges(chainId: number): { funder: Address; funded: Address; amount: bigint; block_number: number; method: string }[] {
  const rows = getDb().query("SELECT funder, funded, amount, block_number, method FROM funding_edges WHERE chain_id = ?").all(chainId) as {
    funder: Address;
    funded: Address;
    amount: string;
    block_number: number;
    method: string;
  }[];
  return rows.map((r) => ({ ...r, amount: BigInt(r.amount) }));
}

/** Funding edges touching any of the given wallets (for the graph API). */
export function listFundingEdgesForWallets(chainId: number, addresses: Address[], limit = 500): { funder: Address; funded: Address; amount: bigint; block_number: number; method: string }[] {
  if (addresses.length === 0) return [];
  const placeholders = addresses.map(() => "?").join(",");
  const rows = getDb()
    .query(
      `SELECT funder, funded, amount, block_number, method FROM funding_edges
       WHERE chain_id = ? AND (funder IN (${placeholders}) OR funded IN (${placeholders}))
       ORDER BY block_number DESC LIMIT ?`,
    )
    .all(chainId, ...addresses, ...addresses, limit) as { funder: Address; funded: Address; amount: string; block_number: number; method: string }[];
  return rows.map((r) => ({ ...r, amount: BigInt(r.amount) }));
}

/** Clean up transient unfinalized events and un-alerted expired ranked tokens on startup while preserving alerts, alerted tokens, pools, and active performance tracking across sessions. */
export function resetSessionData(): void {
  const d = getDb();
  d.transaction(() => {
    d.run("DELETE FROM events WHERE finalized = 0");
    d.run(
      "DELETE FROM tokens WHERE source = 'ranked' AND expires_at IS NOT NULL AND address NOT IN (SELECT token_address FROM alerts)",
    );
    d.run(
      "DELETE FROM pools WHERE token_address NOT IN (SELECT address FROM tokens)",
    );
  })();
}

export interface ClusterMaterialized {
  clusterId: string;
  memberCount: number;
  members: Address[];
}

/** Materialize in-memory DSU cluster state into SQL clusters and cluster_members tables. */
export function syncClusters(clusters: ClusterMaterialized[]): void {
  const d = getDb();
  d.transaction(() => {
    const insCluster = d.prepare("INSERT OR REPLACE INTO clusters (id, member_count) VALUES (?, ?)");
    const insMember = d.prepare("INSERT OR REPLACE INTO cluster_members (cluster_id, address) VALUES (?, ?)");
    const delMember = d.prepare("DELETE FROM cluster_members WHERE cluster_id = ?");
    for (const c of clusters) {
      delMember.run(c.clusterId);
      insCluster.run(c.clusterId, c.memberCount);
      for (const m of c.members) {
        insMember.run(c.clusterId, m);
      }
    }
  })();
}

// ---- Tokens / pools ----------------------------------------------------------

export function upsertToken(t: TokenMeta & { expiresAt?: number | null }): void {
  getDb().run(
    `INSERT INTO tokens (chain_id, address, symbol, decimals, total_supply, source, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chain_id, address) DO UPDATE SET
       symbol = COALESCE(excluded.symbol, tokens.symbol),
       decimals = COALESCE(excluded.decimals, tokens.decimals),
       total_supply = COALESCE(excluded.total_supply, tokens.total_supply),
       expires_at = COALESCE(excluded.expires_at, tokens.expires_at)`,
    [t.chainId, t.address, t.symbol, t.decimals, t.totalSupply?.toString() ?? null, t.source, t.expiresAt ?? null],
  );
}

export function getToken(chainId: number, address: Address): (TokenMeta & { expires_at: number | null }) | null {
  const row = getDb().query("SELECT * FROM tokens WHERE chain_id = ? AND address = ?").get(chainId, address) as
    | { chain_id: number; address: Address; symbol: string | null; decimals: number | null; total_supply: string | null; source: TokenMeta["source"]; expires_at: number | null }
    | null;
  if (!row) return null;
  return {
    chainId: row.chain_id,
    address: row.address,
    symbol: row.symbol,
    decimals: row.decimals,
    totalSupply: row.total_supply !== null ? BigInt(row.total_supply) : null,
    source: row.source,
    expires_at: row.expires_at,
  };
}

export function listWatchedTokens(chainId: number, nowSecs: number): TokenMeta[] {
  const rows = getDb()
    .query("SELECT * FROM tokens WHERE chain_id = ? AND source <> 'candidate' AND (expires_at IS NULL OR expires_at > ?)")
    .all(chainId, nowSecs) as { chain_id: number; address: Address; symbol: string | null; decimals: number | null; total_supply: string | null; source: Exclude<TokenMeta["source"], "candidate"> }[];
  return rows.map((r) => ({
    chainId: r.chain_id,
    address: r.address,
    symbol: r.symbol,
    decimals: r.decimals,
    totalSupply: r.total_supply !== null ? BigInt(r.total_supply) : null,
    source: r.source,
  }));
}

// ---- Candidate discovery ----------------------------------------------------

export function upsertCandidate(c: Omit<TokenCandidate, "status" | "score" | "evidence" | "lastEvaluatedAt"> & {
  status?: CandidateStatus;
  score?: number;
  evidence?: Record<string, unknown>;
  lastEvaluatedAt?: number | null;
}): void {
  getDb().run(
    `INSERT INTO token_candidates
      (chain_id, address, discovery_source, status, score, evidence_json, first_seen_at, last_evaluated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chain_id, address) DO UPDATE SET
       discovery_source = excluded.discovery_source,
       score = excluded.score,
       evidence_json = excluded.evidence_json,
       last_evaluated_at = COALESCE(excluded.last_evaluated_at, token_candidates.last_evaluated_at),
       expires_at = excluded.expires_at,
       status = CASE WHEN token_candidates.status = 'promoted' THEN 'promoted' ELSE excluded.status END`,
    [c.chainId, c.address, c.source, c.status ?? "discovered", c.score ?? 0, JSON.stringify(c.evidence ?? {}), c.firstSeenAt, c.lastEvaluatedAt ?? null, c.expiresAt],
  );
}

export function getCandidate(chainId: number, address: Address): TokenCandidate | null {
  const row = getDb().query("SELECT * FROM token_candidates WHERE chain_id = ? AND address = ?").get(chainId, address) as {
    chain_id: number; address: Address; discovery_source: TokenCandidate["source"]; status: CandidateStatus; score: number;
    evidence_json: string; first_seen_at: number; last_evaluated_at: number | null; expires_at: number;
  } | null;
  if (!row) return null;
  return { chainId: row.chain_id, address: row.address, source: row.discovery_source, status: row.status, score: row.score,
    evidence: JSON.parse(row.evidence_json) as Record<string, unknown>, firstSeenAt: row.first_seen_at,
    lastEvaluatedAt: row.last_evaluated_at, expiresAt: row.expires_at };
}

export function listCandidates(chainId?: number, status?: CandidateStatus): TokenCandidate[] {
  const clauses = ["1 = 1"]; const params: (number | string)[] = [];
  if (chainId !== undefined) { clauses.push("chain_id = ?"); params.push(chainId); }
  if (status !== undefined) { clauses.push("status = ?"); params.push(status); }
  const rows = getDb().query(`SELECT * FROM token_candidates WHERE ${clauses.join(" AND ")} ORDER BY score DESC, last_evaluated_at DESC`).all(...params) as {
    chain_id: number; address: Address; discovery_source: TokenCandidate["source"]; status: CandidateStatus; score: number;
    evidence_json: string; first_seen_at: number; last_evaluated_at: number | null; expires_at: number;
  }[];
  return rows.map((row) => ({ chainId: row.chain_id, address: row.address, source: row.discovery_source, status: row.status, score: row.score,
    evidence: JSON.parse(row.evidence_json) as Record<string, unknown>, firstSeenAt: row.first_seen_at,
    lastEvaluatedAt: row.last_evaluated_at, expiresAt: row.expires_at }));
}

export function updateCandidateScore(chainId: number, address: Address, score: number, evidence: Record<string, unknown>, status: CandidateStatus): void {
  getDb().run("UPDATE token_candidates SET score = ?, evidence_json = ?, status = CASE WHEN status = 'promoted' THEN 'promoted' ELSE ? END, last_evaluated_at = ? WHERE chain_id = ? AND address = ?",
    [score, JSON.stringify(evidence), status, Math.floor(Date.now() / 1000), chainId, address]);
}

export function expireCandidates(nowSecs: number): number {
  const result = getDb().run("UPDATE token_candidates SET status = 'expired' WHERE status IN ('discovered','evaluating','rejected') AND expires_at <= ?", [nowSecs]);
  getDb().run("UPDATE tokens SET expires_at = ? WHERE source = 'candidate' AND expires_at IS NOT NULL AND expires_at <= ?", [nowSecs, nowSecs]);
  return Number(result.changes);
}

export function promoteCandidate(chainId: number, address: Address, source: "factory" | "ranked", expiresAt: number | null): void {
  getDb().transaction(() => {
    getDb().run("UPDATE token_candidates SET status = 'promoted', last_evaluated_at = ? WHERE chain_id = ? AND address = ?", [Math.floor(Date.now() / 1000), chainId, address]);
    getDb().run("UPDATE tokens SET source = ?, expires_at = ? WHERE chain_id = ? AND address = ? AND source = 'candidate'", [source, expiresAt, chainId, address]);
  })();
}

/** Expire ranked tokens that were not returned by the latest volume poll. */
export function expireRankedTokens(chainId: number, nowSecs: number, keep: Address[]): void {
  if (keep.length === 0) {
    getDb().run("UPDATE tokens SET expires_at = ? WHERE chain_id = ? AND source = 'ranked'", [nowSecs, chainId]);
    return;
  }
  const placeholders = keep.map(() => "?").join(",");
  getDb().run(
    `UPDATE tokens SET expires_at = ? WHERE chain_id = ? AND source = 'ranked' AND address NOT IN (${placeholders})`,
    [nowSecs, chainId, ...keep],
  );
}

export function insertPool(p: {
  chainId: number;
  poolAddress: Address;
  tokenAddress: Address;
  quoteToken: Address | null;
  factory: string;
  createdBlock: number;
  createdTs?: number;
  token0?: Address;
  token1?: Address;
}): void {
  getDb().run(
    `INSERT OR IGNORE INTO pools (chain_id, pool_address, token_address, quote_token, factory, created_block, created_ts, token0, token1)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [p.chainId, p.poolAddress, p.tokenAddress, p.quoteToken, p.factory, p.createdBlock, p.createdTs ?? null, p.token0 ?? null, p.token1 ?? null],
  );
}

export function listPoolsForToken(chainId: number, tokenAddress: Address): { pool_address: Address; quote_token: Address | null; factory: string }[] {
  return getDb().query("SELECT pool_address, quote_token, factory FROM pools WHERE chain_id = ? AND token_address = ?").all(chainId, tokenAddress) as {
    pool_address: Address;
    quote_token: Address | null;
    factory: string;
  }[];
}

export interface PoolRow {
  poolAddress: Address;
  tokenAddress: Address;
  quoteToken: Address | null;
  factory: string;
  createdBlock: number;
  createdTs: number | null;
  token0: Address | null;
  token1: Address | null;
}

/** All registered pools for a chain (for adapter pool subscriptions + graph pool metadata). */
export function listPools(chainId: number): PoolRow[] {
  const rows = getDb()
    .query("SELECT pool_address, token_address, quote_token, factory, created_block, created_ts, token0, token1 FROM pools WHERE chain_id = ?")
    .all(chainId) as {
    pool_address: Address;
    token_address: Address;
    quote_token: Address | null;
    factory: string;
    created_block: number;
    created_ts: number | null;
    token0: Address | null;
    token1: Address | null;
  }[];
  return rows.map((r) => ({
    poolAddress: r.pool_address,
    tokenAddress: r.token_address,
    quoteToken: r.quote_token,
    factory: r.factory,
    createdBlock: r.created_block,
    createdTs: r.created_ts,
    token0: r.token0,
    token1: r.token1,
  }));
}

// ---- Labels ------------------------------------------------------------------

export function insertLabel(address: Address, chainId: number, label: string, kind: string): void {
  getDb().run("INSERT OR REPLACE INTO labels (address, chain_id, label, kind) VALUES (?, ?, ?, ?)", [address, chainId, label, kind]);
}

export function loadLabels(chainId: number): Map<Address, { label: string; kind: string }> {
  const rows = getDb().query("SELECT address, label, kind FROM labels WHERE chain_id = ?").all(chainId) as { address: Address; label: string; kind: string }[];
  return new Map(rows.map((r) => [r.address, { label: r.label, kind: r.kind }]));
}

// ---- Signals / alerts ---------------------------------------------------------

type SignalRow = {
  chain_id: number;
  token_address: Address;
  rule_id: string;
  weight: number;
  evidence_json: string;
  block_number: number;
  created_at: number;
};

function mapSignalRow(r: SignalRow): Signal {
  return {
    chainId: r.chain_id,
    tokenAddress: r.token_address,
    ruleId: r.rule_id as Signal["ruleId"],
    weight: r.weight,
    evidence: JSON.parse(r.evidence_json) as Record<string, unknown>,
    blockNumber: r.block_number,
    timestamp: r.created_at,
  };
}

export function insertSignal(s: Signal): number {
  const res = getDb().run(
    "INSERT INTO signals (chain_id, token_address, rule_id, weight, evidence_json, block_number, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [s.chainId, s.tokenAddress, s.ruleId, s.weight, JSON.stringify(s.evidence), s.blockNumber, s.timestamp],
  );
  return Number(res.lastInsertRowid);
}

export function recentSignals(chainId: number, tokenAddress: Address, sinceSecs: number): Signal[] {
  const rows = getDb()
    .query("SELECT * FROM signals WHERE chain_id = ? AND token_address = ? AND created_at >= ? ORDER BY created_at")
    .all(chainId, tokenAddress, sinceSecs) as SignalRow[];
  return rows.map(mapSignalRow);
}

export function insertAlert(p: AlertPayload, confirmed: boolean, blockNumber: number | null): number {
  const res = getDb().run(
    "INSERT INTO alerts (chain_id, token_address, score, severity, payload_json, confirmed, block_number) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [p.chainId, p.tokenAddress, p.score, p.severity, JSON.stringify(p), confirmed ? 1 : 0, blockNumber],
  );
  return Number(res.lastInsertRowid);
}

/** Confirm alerts whose triggering block is now final (block-scoped, PLAN.md §11.1).
 *  Legacy rows without a block_number are treated as confirmable. */
export function confirmAlertsUpTo(chainId: number, upToBlock: number): void {
  getDb().run(
    "UPDATE alerts SET confirmed = 1 WHERE chain_id = ? AND confirmed = 0 AND (block_number IS NULL OR block_number <= ?)",
    [chainId, upToBlock],
  );
}

export function retractAlert(id: number): void {
  getDb().run("UPDATE alerts SET retracted = 1 WHERE id = ?", [id]);
}

export function lastAlertForToken(chainId: number, tokenAddress: Address): { id: number; score: number; created_at: number; payload_json: string } | null {
  return getDb()
    .query("SELECT id, score, created_at, payload_json FROM alerts WHERE chain_id = ? AND token_address = ? AND retracted = 0 ORDER BY id DESC LIMIT 1")
    .get(chainId, tokenAddress) as { id: number; score: number; created_at: number; payload_json: string } | null;
}

export function getAlert(id: number): AlertRow | null {
  return getDb().query("SELECT * FROM alerts WHERE id = ?").get(id) as AlertRow | null;
}

export function alertsInLastMinute(): number {
  const row = getDb().query("SELECT COUNT(*) AS n FROM alerts WHERE created_at >= ? AND retracted = 0").get(Math.floor(Date.now() / 1000) - 60) as { n: number };
  return row.n;
}

export interface AlertRow {
  id: number;
  chain_id: number;
  token_address: Address;
  score: number;
  severity: string;
  payload_json: string;
  confirmed: number;
  retracted: number;
  created_at: number;
  block_number: number | null;
}

export function listAlerts(limit = 100): AlertRow[] {
  return getDb().query("SELECT * FROM alerts ORDER BY id DESC LIMIT ?").all(limit) as AlertRow[];
}

export function listAlertsForToken(chainId: number, tokenAddress: Address, limit = 50): AlertRow[] {
  return getDb().query("SELECT * FROM alerts WHERE chain_id = ? AND token_address = ? ORDER BY id DESC LIMIT ?").all(chainId, tokenAddress, limit) as AlertRow[];
}

// ---- Alert performance ------------------------------------------------------

type PerformanceRow = Omit<PerformanceSession, "entry_price" | "current_price" | "target_price" | "stop_price" | "min_price" | "max_price"> & {
  entry_price: string;
  current_price: string;
  target_price: string;
  stop_price: string;
  min_price: string;
  max_price: string;
  last_poll_at: number | null;
  missing_observations: number;
  close_reason: string | null;
};

function mapPerformance(row: PerformanceRow): PerformanceSession {
  return {
    ...row,
    entry_price: BigInt(row.entry_price),
    current_price: BigInt(row.current_price),
    target_price: BigInt(row.target_price),
    stop_price: BigInt(row.stop_price),
    min_price: BigInt(row.min_price),
    max_price: BigInt(row.max_price),
  };
}

export function createPerformanceSession(input: {
  alertId: number;
  chainId: number;
  tokenAddress: Address;
  poolAddress: Address;
  quoteToken: Address | null;
  entryPrice: bigint;
  targetPrice: bigint;
  stopPrice: bigint;
  openedAt: number;
  expiresAt: number;
  entryBlock: number;
}): number {
  const result = getDb().run(
    `INSERT OR IGNORE INTO performance_sessions
      (alert_id, chain_id, token_address, pool_address, quote_token, entry_price, current_price,
       target_price, stop_price, opened_at, expires_at, outcome, entry_block, last_block, min_price, max_price)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    [
      input.alertId,
      input.chainId,
      input.tokenAddress,
      input.poolAddress,
      input.quoteToken,
      input.entryPrice.toString(),
      input.entryPrice.toString(),
      input.targetPrice.toString(),
      input.stopPrice.toString(),
      input.openedAt,
      input.expiresAt,
      input.entryBlock,
      input.entryBlock,
      input.entryPrice.toString(),
      input.entryPrice.toString(),
    ],
  );
  if (Number(result.changes) > 0) return Number(result.lastInsertRowid);
  const existing = getPerformanceForAlert(input.alertId);
  if (!existing) throw new Error(`performance session missing for alert ${input.alertId}`);
  return existing.id;
}

export function getPerformanceSession(id: number): PerformanceSession | null {
  const row = getDb().query("SELECT * FROM performance_sessions WHERE id = ?").get(id) as PerformanceRow | null;
  return row ? mapPerformance(row) : null;
}

export function getPerformanceForAlert(alertId: number): PerformanceSession | null {
  const row = getDb().query("SELECT * FROM performance_sessions WHERE alert_id = ?").get(alertId) as PerformanceRow | null;
  return row ? mapPerformance(row) : null;
}

export function listPerformanceSessions(opts: { chainId?: number; tokenAddress?: Address; activeOnly?: boolean; limit?: number } = {}): PerformanceSession[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.chainId !== undefined) { where.push("chain_id = ?"); params.push(opts.chainId); }
  if (opts.tokenAddress !== undefined) { where.push("token_address = ?"); params.push(opts.tokenAddress); }
  if (opts.activeOnly) where.push("outcome = 'active'");
  const sql = `SELECT * FROM performance_sessions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`;
  params.push(opts.limit ?? 100);
  return (getDb().query(sql).all(...params) as PerformanceRow[]).map(mapPerformance);
}

export function updatePerformanceSession(input: {
  id: number;
  outcome: PerformanceOutcome;
  currentPrice: bigint;
  minPrice: bigint;
  maxPrice: bigint;
  lastBlock: number;
  updatedAt: number;
  closedAt: number | null;
  lastPollAt?: number;
  missingObservations?: number;
  closeReason?: string | null;
}): void {
  getDb().run(
    `UPDATE performance_sessions
     SET outcome = ?, current_price = ?, min_price = ?, max_price = ?, last_block = ?,
          closed_at = ?, updated_at = ?,
          last_poll_at = COALESCE(?, last_poll_at),
          missing_observations = COALESCE(?, missing_observations),
          close_reason = COALESCE(?, close_reason)
      WHERE id = ?`,
    [input.outcome, input.currentPrice.toString(), input.minPrice.toString(), input.maxPrice.toString(), input.lastBlock, input.closedAt, input.updatedAt,
      input.lastPollAt ?? null, input.missingObservations ?? null, input.closeReason ?? null, input.id],
  );
}

export function expirePerformanceSessions(now: number): number[] {
  const rows = getDb().query("SELECT id FROM performance_sessions WHERE outcome = 'active' AND expires_at <= ?").all(now) as { id: number }[];
  if (rows.length === 0) return [];
  getDb().run("UPDATE performance_sessions SET outcome = 'expired', closed_at = expires_at, updated_at = ? WHERE outcome = 'active' AND expires_at <= ?", [now, now]);
  return rows.map((r) => r.id);
}

export function retractPerformanceForAlerts(alertIds: number[]): number[] {
  if (alertIds.length === 0) return [];
  const placeholders = alertIds.map(() => "?").join(",");
  const rows = getDb().query(`SELECT id FROM performance_sessions WHERE alert_id IN (${placeholders}) AND outcome <> 'retracted'`).all(...alertIds) as { id: number }[];
  if (rows.length > 0) getDb().run(`UPDATE performance_sessions SET outcome = 'retracted', closed_at = COALESCE(closed_at, unixepoch()), updated_at = unixepoch() WHERE alert_id IN (${placeholders}) AND outcome <> 'retracted'`, alertIds);
  return rows.map((r) => r.id);
}

export function retractPerformanceFrom(chainId: number, fromBlock: number): number[] {
  const d = getDb();
  const rows = d.query(
    "SELECT id FROM performance_sessions WHERE chain_id = ? AND outcome <> 'retracted' AND (entry_block >= ? OR last_block >= ?)",
  ).all(chainId, fromBlock, fromBlock) as { id: number }[];
  if (rows.length > 0) {
    d.run(
      "UPDATE performance_sessions SET outcome = 'retracted', closed_at = COALESCE(closed_at, unixepoch()), updated_at = unixepoch() WHERE chain_id = ? AND outcome <> 'retracted' AND (entry_block >= ? OR last_block >= ?)",
      [chainId, fromBlock, fromBlock],
    );
  }
  return rows.map((r) => r.id);
}

export function listSignals(chainId?: number, limit = 50): Signal[] {
  const rows = (chainId
    ? getDb().query("SELECT * FROM signals WHERE chain_id = ? ORDER BY id DESC LIMIT ?").all(chainId, limit)
    : getDb().query("SELECT * FROM signals ORDER BY id DESC LIMIT ?").all(limit)) as SignalRow[];
  return rows.map(mapSignalRow);
}

export function listSignalsForToken(chainId: number, tokenAddress: Address, limit = 100): Signal[] {
  return (getDb().query("SELECT * FROM signals WHERE chain_id = ? AND token_address = ? ORDER BY id DESC LIMIT ?").all(chainId, tokenAddress, limit) as SignalRow[]).map(mapSignalRow);
}

export function listRecentEvents(limit = 100): { block_number: number; type: string; tx_hash: string; finalized: number }[] {
  return getDb()
    .query("SELECT block_number, type, tx_hash, finalized FROM events ORDER BY block_number DESC, log_index DESC LIMIT ?")
    .all(limit) as { block_number: number; type: string; tx_hash: string; finalized: number }[];
}
