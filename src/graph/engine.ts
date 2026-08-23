import type { Address, FundingEvent, StandardEvent, StandardTransferEvent, SwapEvent } from "../types.ts";
import { DEAD_ADDRESSES, ZERO_ADDRESS } from "../types.ts";
import { RollbackDSU } from "./dsu.ts";

// In-memory graph engine (PLAN.md §4 layer 4, §6).
// Events are facts, state is derived: every mutation records an undo closure so
// unfinalized state can be rewound on reorg; finalized history is trimmed.

export interface WalletRec {
  address: Address;
  firstSeenBlock: number;
  firstSeenAt: number;
  funder: Address | null;
  nonce: number | null;
}

export interface Label {
  label: string;
  kind: string; // cex | disperse | router | bridge | instant_swap | deployer | generic
}

export interface BuyEntry {
  token: Address;
  addr: Address;
  amount: bigint;
  ts: number;
  block: number;
}

export interface SendEntry {
  token: Address;
  amount: bigint;
  to: Address;
  ts: number;
  block: number;
}

export interface ExchangeFundingEntry {
  funded: Address;
  amount: bigint;
  ts: number;
  block: number;
}

export interface FanoutEffect {
  type: "fanout";
  sender: Address;
  token: Address | null; // null = native-token (funding) fanout
  amount: bigint;
  receivers: Address[];
  ts: number;
  block: number;
}

export interface IdenticalAmountEffect {
  type: "identical_amount";
  amount: bigint;
  wallets: Address[];
  ts: number;
  block: number;
}

export type GraphEffect = FanoutEffect | IdenticalAmountEffect;

export interface SwapVolumeEntry {
  token: Address;
  pool: Address;
  buyer: Address;
  amount: bigint;
  dir: "buy" | "sell";
  ts: number;
  block: number;
}

export interface ClusterStat {
  clusterId: Address; // lexicographically smallest member — stable across merges
  root: Address;
  members: Address[];
  memberCount: number;
  balance: bigint;
  pctOfSupply: number;
}

type UndoFn = () => void;

const INFRA_KINDS = new Set(["cex", "router", "bridge", "disperse", "instant_swap"]);

export interface GraphTuning {
  fanoutMinRecipients: number;
  fanoutWindowSecs: number;
  identicalAmountMin: number;
  identicalAmountWindowSecs: number;
}

export const DEFAULT_GRAPH_TUNING: GraphTuning = {
  fanoutMinRecipients: 10,
  fanoutWindowSecs: 15 * 60,
  identicalAmountMin: 3,
  identicalAmountWindowSecs: 60 * 60,
};

export class GraphEngine {
  readonly wallets = new Map<Address, WalletRec>();
  readonly dsu = new RollbackDSU();
  labels = new Map<Address, Label>();

  private balances = new Map<Address, Map<Address, bigint>>(); // token -> addr -> balance
  private burned = new Map<Address, bigint>();
  private totalSupply = new Map<Address, bigint>();
  private deployers = new Map<Address, Address>();
  private pools = new Set<Address>();
  private poolCreated = new Map<Address, { block: number; ts: number }>();
  private lpMinted = new Map<Address, bigint>(); // pool address (LP token) -> total minted
  private swapVolume: SwapVolumeEntry[] = [];

  private buys: BuyEntry[] = [];
  private buysByToken = new Map<Address, BuyEntry[]>();
  private tokensBoughtByWallet = new Map<Address, Map<Address, number>>();

  getTokensBoughtBy(wallet: Address): Set<Address> {
    return new Set(this.tokensBoughtByWallet.get(wallet)?.keys() ?? []);
  }

  /** Compact buyer-quality view used before a candidate is promoted to a watch. */
  candidateBuyerStats(token: Address, sinceTs: number, refTs: number): {
    earlyBuyerCount: number;
    retainedBuyerCount: number;
    independentBuyerCount: number;
    exchangeBuyerCount: number;
    commonFunderRatio: number;
  } {
    const buyers = new Set((this.buysByToken.get(token) ?? [])
      .filter((buy) => buy.ts >= sinceTs && buy.ts <= refTs)
      .map((buy) => buy.addr));
    const funders = new Map<Address, number>();
    const independentFunders = new Set<Address>();
    let unfundedCount = 0;
    let exchangeBuyerCount = 0;
    for (const addr of buyers) {
      const wallet = this.wallets.get(addr);
      if (wallet?.funder) {
        funders.set(wallet.funder, (funders.get(wallet.funder) ?? 0) + 1);
        if (this.labels.get(wallet.funder)?.kind === "cex") exchangeBuyerCount++;
        else independentFunders.add(wallet.funder);
      } else {
        unfundedCount++;
      }
    }
    const largestGroup = Math.max(0, ...funders.values());
    return {
      earlyBuyerCount: buyers.size,
      retainedBuyerCount: [...buyers].filter((addr) => this.balanceOf(token, addr) > 0n).length,
      independentBuyerCount: independentFunders.size + unfundedCount,
      exchangeBuyerCount,
      commonFunderRatio: buyers.size === 0 ? 0 : largestGroup / buyers.size,
    };
  }
  private sends = new Map<Address, SendEntry[]>();
  private exchangeFundings = new Map<Address, ExchangeFundingEntry[]>();
  private fundingAmountIndex = new Map<string, Array<{ funded: Address; funder: Address; ts: number; block: number }>>();
  private fanoutSenders = new Map<string, number>(); // key → last union timestamp
  private identicalAmountUnioned = new Map<string, number>(); // amount key → last union timestamp
  private fundingDegree = new Map<Address, Set<Address>>(); // wallet -> distinct counterparties

  private clusterBalances = new Map<Address, Map<Address, bigint>>(); 
  private clusterTokens = new Map<Address, Set<Address>>(); 

  private history: Array<{ block: number; undo: UndoFn }> = [];

  constructor(private tuning: GraphTuning = DEFAULT_GRAPH_TUNING) {}

  private updateClusterBalance(token: Address, root: Address, delta: bigint, undos: UndoFn[]): void {
    let balances = this.clusterBalances.get(token);
    if (!balances) { balances = new Map(); this.clusterBalances.set(token, balances); }
    const prev = balances.get(root) ?? 0n;
    const next = prev + delta;
    balances.set(root, next);

    let tokens = this.clusterTokens.get(root);
    if (!tokens) { tokens = new Set(); this.clusterTokens.set(root, tokens); }
    const wasInSet = tokens.has(token);
    if (next > 0n && !wasInSet) tokens.add(token);
    else if (next <= 0n && wasInSet) tokens.delete(token);

    undos.push(() => {
      balances!.set(root, prev);
      if (wasInSet) tokens!.add(token);
      else tokens!.delete(token);
    });
  }

  private unionAndMergeBalances(a: Address, b: Address, undos: UndoFn[]): void {
    const ra = this.dsu.find(a);
    const rb = this.dsu.find(b);
    if (ra === rb) return;
    
    this.dsu.union(a, b);
    const newRoot = this.dsu.find(a);
    const lostRoot = newRoot === ra ? rb : ra;

    const tokensToMerge = Array.from(this.clusterTokens.get(lostRoot) ?? []);
    for (const t of tokensToMerge) {
      const bal = this.clusterBalances.get(t)?.get(lostRoot) ?? 0n;
      if (bal > 0n) {
        this.updateClusterBalance(t, newRoot, bal, undos);
        this.updateClusterBalance(t, lostRoot, -bal, undos);
      }
    }
  }

  prune(activeTokens: Set<Address>): void {
    const activeWallets = new Set<Address>();
    
    for (const [token, ledger] of this.balances) {
      if (!activeTokens.has(token)) {
        this.balances.delete(token);
        this.burned.delete(token);
        this.totalSupply.delete(token);
        this.deployers.delete(token);
        this.clusterBalances.delete(token);
      } else {
        for (const [addr, bal] of ledger) {
          if (bal > 0n) activeWallets.add(addr);
        }
      }
    }

    this.buys = this.buys.filter((b) => activeTokens.has(b.token));
    this.buysByToken.clear();
    this.tokensBoughtByWallet.clear();
    for (const b of this.buys) {
      let tBuys = this.buysByToken.get(b.token);
      if (!tBuys) { tBuys = []; this.buysByToken.set(b.token, tBuys); }
      tBuys.push(b);
      let wTokens = this.tokensBoughtByWallet.get(b.addr);
      if (!wTokens) { wTokens = new Map(); this.tokensBoughtByWallet.set(b.addr, wTokens); }
      wTokens.set(b.token, (wTokens.get(b.token) ?? 0) + 1);
    }

    for (const [addr, list] of this.sends) {
      const filtered = list.filter((s) => activeTokens.has(s.token));
      if (filtered.length === 0) this.sends.delete(addr);
      else this.sends.set(addr, filtered);
    }
    
    for (const b of this.buys) activeWallets.add(b.addr);
    for (const list of this.sends.values()) for (const s of list) activeWallets.add(s.to);
    for (const pool of this.pools) activeWallets.add(pool);
    for (const addr of this.labels.keys()) activeWallets.add(addr);

    for (const addr of this.wallets.keys()) {
      if (!activeWallets.has(addr)) {
        this.wallets.delete(addr);
        this.fundingDegree.delete(addr);
      }
    }
  }

  // ---- label / pool / metadata administration ---------------------------------

  setLabels(labels: Map<Address, Label>): void {
    this.labels = labels;
  }

  addLabel(addr: Address, label: Label): void {
    this.labels.set(addr, label);
  }

  labelOf(addr: Address): Label | undefined {
    return this.labels.get(addr);
  }

  isInfra(addr: Address): boolean {
    const l = this.labels.get(addr);
    return l !== undefined && INFRA_KINDS.has(l.kind);
  }

  registerPool(addr: Address, block?: number, ts?: number): void {
    this.pools.add(addr.toLowerCase());
    if (block !== undefined && ts !== undefined && !this.poolCreated.has(addr)) {
      this.poolCreated.set(addr, { block, ts });
    }
  }

  isPool(addr: Address): boolean {
    return this.pools.has(addr.toLowerCase());
  }

  setTotalSupply(token: Address, supply: bigint): void {
    this.totalSupply.set(token, supply);
  }

  setDeployer(token: Address, deployer: Address): void {
    if (!this.deployers.has(token)) this.deployers.set(token, deployer);
  }

  deployerOf(token: Address): Address | undefined {
    return this.deployers.get(token);
  }

  nonceOf(addr: Address): number | null {
    return this.wallets.get(addr)?.nonce ?? null;
  }

  setNonce(addr: Address, nonce: number): void {
    const w = this.wallets.get(addr);
    if (w) w.nonce = nonce;
  }

  // ---- event application ---------------------------------------------------------

  applyEvent(evt: StandardEvent): GraphEffect[] {
    switch (evt.kind) {
      case "transfer":
        return this.applyTransfer(evt);
      case "funding":
        return this.applyFunding(evt);
      case "pool_created": {
        const key = evt.poolAddress.toLowerCase();
        const had = this.pools.has(key);
        const createdPrev = this.poolCreated.get(evt.poolAddress);
        this.registerPool(evt.poolAddress, evt.blockNumber, evt.timestamp);
        this.pushUndo(evt.blockNumber, () => {
          if (!had) this.pools.delete(key);
          if (createdPrev === undefined) this.poolCreated.delete(evt.poolAddress);
          else this.poolCreated.set(evt.poolAddress, createdPrev);
        });
        return [];
      }
      case "swap":
        return this.applySwap(evt);
    }
  }

  private pushUndo(block: number, undo: UndoFn): void {
    this.history.push({ block, undo });
  }

  private ensureWallet(addr: Address, block: number, ts: number, funder: Address | null, undos: UndoFn[]): WalletRec {
    const existing = this.wallets.get(addr);
    if (existing) return existing;
    const rec: WalletRec = { address: addr, firstSeenBlock: block, firstSeenAt: ts, funder, nonce: null };
    this.wallets.set(addr, rec);
    undos.push(() => this.wallets.delete(addr));
    return rec;
  }

  private applyTransfer(evt: StandardTransferEvent): GraphEffect[] {
    const undos: UndoFn[] = [];
    const effects: GraphEffect[] = [];
    const token = evt.tokenAddress;
    const from = evt.sender;
    const to = evt.receiver;

    // Pool LP tokens: track mint/burn only (feeds R7). No balance ledger, no
    // accumulation log, no fan-out — the pool is the LP token itself.
    if (this.pools.has(token)) {
      if (from === ZERO_ADDRESS) {
        const prev = this.lpMinted.get(token) ?? 0n;
        this.lpMinted.set(token, prev + evt.amount);
        undos.push(() => this.lpMinted.set(token, prev));
      }
      if (DEAD_ADDRESSES.has(to)) {
        const prevB = this.burned.get(token) ?? 0n;
        this.burned.set(token, prevB + evt.amount);
        undos.push(() => this.burned.set(token, prevB));
      }
      this.pushUndo(evt.blockNumber, () => {
        for (let i = undos.length - 1; i >= 0; i--) (undos[i] as UndoFn)();
      });
      return effects;
    }

    // wallets
    this.ensureWallet(from, evt.blockNumber, evt.timestamp, null, undos);
    this.ensureWallet(to, evt.blockNumber, evt.timestamp, null, undos);

    // deployer heuristic: receiver of the initial mint from 0x0
    if (from === ZERO_ADDRESS && !this.deployers.has(token)) {
      this.deployers.set(token, to);
      undos.push(() => this.deployers.delete(token));
    }

    // balance ledger
    const ledger = this.balances.get(token) ?? new Map<Address, bigint>();
    if (!this.balances.has(token)) {
      this.balances.set(token, ledger);
      undos.push(() => this.balances.delete(token));
    }
    if (from !== ZERO_ADDRESS && !DEAD_ADDRESSES.has(from)) {
      const prev = ledger.get(from) ?? 0n;
      ledger.set(from, prev - evt.amount);
      undos.push(() => ledger.set(from, prev));
      if (!this.pools.has(from)) this.updateClusterBalance(token, this.dsu.find(from), -evt.amount, undos);
    }
    if (!DEAD_ADDRESSES.has(to)) {
      const prev = ledger.get(to) ?? 0n;
      ledger.set(to, prev + evt.amount);
      undos.push(() => ledger.set(to, prev));
      if (!this.pools.has(to)) this.updateClusterBalance(token, this.dsu.find(to), evt.amount, undos);
    } else {
      const prevB = this.burned.get(token) ?? 0n;
      this.burned.set(token, prevB + evt.amount);
      undos.push(() => this.burned.set(token, prevB));
    }

    // accumulation log: plain wallet receiving tokens (mints from 0x0 are distribution, not accumulation)
    const receiverIsPlain = !this.isInfra(to) && !this.pools.has(to) && this.pools.has(from);
    if (receiverIsPlain && evt.amount > 0n) {
      const entry = { token, addr: to, amount: evt.amount, ts: evt.timestamp, block: evt.blockNumber };
      this.buys.push(entry);
      
      let tBuys = this.buysByToken.get(token);
      if (!tBuys) { tBuys = []; this.buysByToken.set(token, tBuys); }
      tBuys.push(entry);

      let wTokens = this.tokensBoughtByWallet.get(to);
      if (!wTokens) { wTokens = new Map(); this.tokensBoughtByWallet.set(to, wTokens); }
      wTokens.set(token, (wTokens.get(token) ?? 0) + 1);

      undos.push(() => {
        this.buys.pop();
        this.buysByToken.get(token)!.pop();
        const wt = this.tokensBoughtByWallet.get(to)!;
        const count = wt.get(token)!;
        if (count === 1) wt.delete(token);
        else wt.set(token, count - 1);
      });
    }

    // token fan-out detection (linkage signal #3, feeds R3)
    if (from !== ZERO_ADDRESS && !this.isInfra(from)) {
      const list = this.sends.get(from) ?? [];
      if (!this.sends.has(from)) {
        this.sends.set(from, list);
        undos.push(() => this.sends.delete(from));
      }
      list.push({ token, amount: evt.amount, to, ts: evt.timestamp, block: evt.blockNumber });
      undos.push(() => void list.pop());
      const cutoff = evt.timestamp - this.tuning.fanoutWindowSecs;
      const recent = list.filter((s) => s.ts >= cutoff && s.token === token && s.amount === evt.amount);
      const distinct = [...new Set(recent.map((s) => s.to))].filter((a) => !this.isInfra(a));
      const fanoutKey = `${from}:${token}:${evt.amount}`;
      if (distinct.length >= this.tuning.fanoutMinRecipients && !this.fanoutSenders.has(fanoutKey)) {
        const key = `${from}:${token}:${evt.amount}`;
        this.fanoutSenders.set(key, evt.timestamp);
        undos.push(() => this.fanoutSenders.delete(key));
        const mark = this.dsu.mark();
        for (let i = 1; i < distinct.length; i++) this.unionAndMergeBalances(distinct[0] as Address, distinct[i] as Address, undos);
        undos.push(() => this.dsu.rollback(mark));
        effects.push({ type: "fanout", sender: from, token, amount: evt.amount, receivers: distinct, ts: evt.timestamp, block: evt.blockNumber });
      }
    }

    this.pushUndo(evt.blockNumber, () => {
      for (let i = undos.length - 1; i >= 0; i--) (undos[i] as UndoFn)();
    });
    return effects;
  }

  private applyFunding(evt: FundingEvent): GraphEffect[] {
    const undos: UndoFn[] = [];
    const effects: GraphEffect[] = [];
    const funderLabel = this.labels.get(evt.funder);
    const funderIsCex = funderLabel?.kind === "cex";

    const fresh = this.isFresh(evt.funded, evt.timestamp, 1);
    this.ensureWallet(evt.funded, evt.blockNumber, evt.timestamp, evt.funder, undos);
    this.ensureWallet(evt.funder, evt.blockNumber, evt.timestamp, null, undos);
    
    let fundedDeg = this.fundingDegree.get(evt.funded);
    if (!fundedDeg) { fundedDeg = new Set(); this.fundingDegree.set(evt.funded, fundedDeg); }
    if (!fundedDeg.has(evt.funder)) {
      fundedDeg.add(evt.funder);
      undos.push(() => fundedDeg.delete(evt.funder));
    }
    
    let funderDeg = this.fundingDegree.get(evt.funder);
    if (!funderDeg) { funderDeg = new Set(); this.fundingDegree.set(evt.funder, funderDeg); }
    if (!funderDeg.has(evt.funded)) {
      funderDeg.add(evt.funded);
      undos.push(() => funderDeg.delete(evt.funded));
    }
    
    const isFunderHub = funderDeg.size > 25;
    const isFundedHub = fundedDeg.size > 25;

    const wFunded = this.wallets.get(evt.funded);
    if (wFunded && !wFunded.funder && evt.funder) {
      wFunded.funder = evt.funder;
      undos.push(() => { wFunded.funder = null; });
    }

    if (funderIsCex) {
      // Exchange-funded: NEVER hard-merge (PLAN.md §6). Track weak edge for R8.
      const list = this.exchangeFundings.get(evt.funder) ?? [];
      if (!this.exchangeFundings.has(evt.funder)) {
        this.exchangeFundings.set(evt.funder, list);
        undos.push(() => this.exchangeFundings.delete(evt.funder));
      }
      list.push({ funded: evt.funded, amount: evt.amount, ts: evt.timestamp, block: evt.blockNumber });
      undos.push(() => void list.pop());
    } else if (fresh && !this.isInfra(evt.funded) && !this.isInfra(evt.funder) && !isFunderHub && !isFundedHub && !this.pools.has(evt.funded) && !this.pools.has(evt.funder)) {
      // common gas funder → hard cluster edge (linkage signal #1), up to 2 hops
      const mark = this.dsu.mark();
      this.unionAndMergeBalances(evt.funded, evt.funder, undos);
      const w = this.wallets.get(evt.funder);
      if (w?.funder && !this.isInfra(w.funder) && this.labels.get(w.funder)?.kind !== "cex") {
        this.unionAndMergeBalances(evt.funded, w.funder, undos);
      }
      undos.push(() => this.dsu.rollback(mark));
    }

    // identical-amount fingerprinting (linkage signal #2) — different funders, same size, short window
    if (fresh && evt.amount > 0n && !this.pools.has(evt.funded) && !this.pools.has(evt.funder)) {
      const key = evt.amount.toString();
      const list = this.fundingAmountIndex.get(key) ?? [];
      if (!this.fundingAmountIndex.has(key)) {
        this.fundingAmountIndex.set(key, list);
        undos.push(() => this.fundingAmountIndex.delete(key));
      }
      list.push({ funded: evt.funded, funder: evt.funder, ts: evt.timestamp, block: evt.blockNumber });
      undos.push(() => void list.pop());
      const cutoff = evt.timestamp - this.tuning.identicalAmountWindowSecs;
      const recent = list.filter((x) => x.ts >= cutoff && this.labels.get(x.funder)?.kind !== "cex");
      const distinctFunded = [...new Set(recent.map((x) => x.funded))].filter((a) => !this.isInfra(a));
       if (distinctFunded.length >= this.tuning.identicalAmountMin && !this.identicalAmountUnioned.has(key)) {
         this.identicalAmountUnioned.set(key, evt.timestamp);
         undos.push(() => this.identicalAmountUnioned.delete(key));
        const mark = this.dsu.mark();
        for (let i = 1; i < distinctFunded.length; i++) this.unionAndMergeBalances(distinctFunded[0] as Address, distinctFunded[i] as Address, undos);
        undos.push(() => this.dsu.rollback(mark));
        effects.push({ type: "identical_amount", amount: evt.amount, wallets: distinctFunded, ts: evt.timestamp, block: evt.blockNumber });
      }
    }

    this.pushUndo(evt.blockNumber, () => {
      for (let i = undos.length - 1; i >= 0; i--) (undos[i] as UndoFn)();
    });
    return effects;
  }

  private applySwap(evt: SwapEvent): GraphEffect[] {
    const undos: UndoFn[] = [];
    const entry: SwapVolumeEntry = {
      token: evt.tokenAddress,
      pool: evt.poolAddress,
      buyer: evt.buyer,
      amount: evt.tokenAmount,
      dir: evt.direction,
      ts: evt.timestamp,
      block: evt.blockNumber,
    };
    this.swapVolume.push(entry);
    undos.push(() => void this.swapVolume.pop());
    this.pushUndo(evt.blockNumber, () => {
      for (let i = undos.length - 1; i >= 0; i--) (undos[i] as UndoFn)();
    });
    return [];
  }

  // ---- R2 / R7 views -------------------------------------------------------------

  /** Sum of watched-token swap volume (in token units) within [sinceTs, untilTs), per direction. */
  swapVolumeBetween(token: Address, sinceTs: number, untilTs: number): { buy: bigint; sell: bigint } {
    let buy = 0n;
    let sell = 0n;
    for (const s of this.swapVolume) {
      if (s.token !== token) continue;
      if (s.ts < sinceTs || s.ts >= untilTs) continue;
      if (s.dir === "buy") buy += s.amount;
      else sell += s.amount;
    }
    return { buy, sell };
  }

  /** R7 inputs for a pool's LP token. */
  lpStatus(pool: Address): { createdBlock: number; createdTs: number; lpMinted: bigint; lpBurned: bigint } | null {
    const created = this.poolCreated.get(pool);
    if (!created) return null;
    return { createdBlock: created.block, createdTs: created.ts, lpMinted: this.lpMinted.get(pool) ?? 0n, lpBurned: this.burned.get(pool) ?? 0n };
  }

  /** @internal for rewind coverage — used by rewindTo/finalize via history; snapshot reads it directly. */
  getPoolInfo(): Map<Address, { block: number; ts: number }> {
    return this.poolCreated;
  }

  // ---- reorg / finality (PLAN.md §11.1) ---------------------------------------------

  /** Undo all state transitions at blocks >= fromBlock. */
  rewindTo(fromBlock: number): number {
    let rewound = 0;
    while (this.history.length > 0) {
      const top = this.history[this.history.length - 1];
      if (!top || top.block < fromBlock) break;
      this.history.pop();
      top.undo();
      rewound++;
    }
    return rewound;
  }

  /** Blocks ≤ boundary are final: their undo history can be discarded. */
  finalize(boundary: number, nowTs?: number): number {
    const before = this.history.length;
    this.history = this.history.filter((h) => h.block > boundary);

    // prune stale rolling windows (buys/sends/indices older than 24h are useless to rules)
    let maxTs = nowTs ?? 0;
    if (!maxTs) {
      for (const b of this.buys) if (b.ts > maxTs) maxTs = b.ts;
      for (const s of this.swapVolume) if (s.ts > maxTs) maxTs = s.ts;
      for (const list of this.sends.values()) for (const s of list) if (s.ts > maxTs) maxTs = s.ts;
      for (const list of this.exchangeFundings.values()) for (const x of list) if (x.ts > maxTs) maxTs = x.ts;
      for (const list of this.fundingAmountIndex.values()) for (const x of list) if (x.ts > maxTs) maxTs = x.ts;
    }
    const cutoffTs = maxTs - 86_400;
    if (cutoffTs > 0) {
      this.buys = this.buys.filter((b) => b.block > boundary || b.ts >= cutoffTs);
      this.buysByToken.clear();
      this.tokensBoughtByWallet.clear();
      for (const b of this.buys) {
        let tBuys = this.buysByToken.get(b.token);
        if (!tBuys) { tBuys = []; this.buysByToken.set(b.token, tBuys); }
        tBuys.push(b);
        let wTokens = this.tokensBoughtByWallet.get(b.addr);
        if (!wTokens) { wTokens = new Map(); this.tokensBoughtByWallet.set(b.addr, wTokens); }
        wTokens.set(b.token, (wTokens.get(b.token) ?? 0) + 1);
      }

      this.swapVolume = this.swapVolume.filter((s) => s.block > boundary || s.ts >= cutoffTs);
      for (const [addr, list] of this.sends) {
        const filtered = list.filter((s) => s.block > boundary || s.ts >= cutoffTs);
        if (filtered.length === 0) this.sends.delete(addr);
        else this.sends.set(addr, filtered);
      }
      for (const [funder, list] of this.exchangeFundings) {
        const filtered = list.filter((x) => x.block > boundary || x.ts >= cutoffTs);
        if (filtered.length === 0) this.exchangeFundings.delete(funder);
        else this.exchangeFundings.set(funder, filtered);
      }
      for (const [key, list] of this.fundingAmountIndex) {
        const filtered = list.filter((x) => x.block > boundary || x.ts >= cutoffTs);
        if (filtered.length === 0) this.fundingAmountIndex.delete(key);
        else this.fundingAmountIndex.set(key, filtered);
        if (filtered.length === 0) this.identicalAmountUnioned.delete(key);
      }
      for (const [key, ts] of this.fanoutSenders) {
        if (ts < cutoffTs) this.fanoutSenders.delete(key);
      }
      for (const [key, ts] of this.identicalAmountUnioned) {
        if (ts < cutoffTs) this.identicalAmountUnioned.delete(key);
      }
    }

    return before - this.history.length;
  }


  // ---- rule-facing views ----------------------------------------------------------

  isFresh(addr: Address, refTs: number, ageDays: number): boolean {
    const w = this.wallets.get(addr);
    if (!w) return true; // unseen before this event = fresh
    if (refTs - w.firstSeenAt >= ageDays * 86_400) return false;
    // Nonce check (PLAN.md §6): a wallet with nonce > 1 is established, not fresh —
    // this kills the cold-start bias where every wallet looks new on first run.
    if (w.nonce !== null && w.nonce > 1) return false;
    return true;
  }

  walletAge(addr: Address, refTs: number): number | null {
    const w = this.wallets.get(addr);
    return w ? refTs - w.firstSeenAt : null;
  }

  circulatingSupply(token: Address): bigint | null {
    const supply = this.totalSupply.get(token);
    if (supply === undefined) return null;
    return supply - (this.burned.get(token) ?? 0n);
  }

  balanceOf(token: Address, addr: Address): bigint {
    return this.balances.get(token)?.get(addr) ?? 0n;
  }

  /** Fresh-wallet accumulation within a window (R1). */
  freshAccumulation(token: Address, windowStartTs: number, refTs: number, ageDays: number): { amount: bigint; wallets: Address[]; perWallet: Map<Address, bigint> } {
    const perWallet = new Map<Address, bigint>();
    for (const b of this.buysByToken.get(token) ?? []) {
      if (b.ts < windowStartTs || b.ts > refTs) continue;
      if (!this.isFresh(b.addr, refTs, ageDays)) continue;
      perWallet.set(b.addr, (perWallet.get(b.addr) ?? 0n) + b.amount);
    }
    let amount = 0n;
    for (const v of perWallet.values()) amount += v;
    return { amount, wallets: [...perWallet.keys()], perWallet };
  }

  /** Fresh receivers of a token within a specific block (R5). */
  freshReceiversInBlock(token: Address, block: number, refTs: number, ageDays: number): Address[] {
    const set = new Set<Address>();
    for (const b of this.buysByToken.get(token) ?? []) {
      if (b.block !== block) continue;
      if (this.isFresh(b.addr, refTs, ageDays)) set.add(b.addr);
    }
    return [...set];
  }

  /** Recent identical-amount sends from a sender (R3). */
  recentFanout(sender: Address, token: Address, amount: bigint, windowSecs: number, refTs: number): SendEntry[] {
    const list = this.sends.get(sender) ?? [];
    return list.filter((s) => s.token === token && s.amount === amount && s.ts >= refTs - windowSecs && s.ts <= refTs);
  }

  /** Same-size exchange fundings within a window (R8). */
  exchangeFanout(funder: Address, amount: bigint, windowSecs: number, refTs: number): ExchangeFundingEntry[] {
    const list = this.exchangeFundings.get(funder) ?? [];
    return list.filter((x) => x.amount === amount && x.ts >= refTs - windowSecs && x.ts <= refTs);
  }

  /** How was this wallet exchange-funded? (R8 evidence) */
  exchangeFundingOf(addr: Address): { funder: Address; amount: bigint; ts: number } | null {
    const w = this.wallets.get(addr);
    if (!w?.funder) return null;
    if (this.labels.get(w.funder)?.kind !== "cex") return null;
    const entry = (this.exchangeFundings.get(w.funder) ?? []).find((x) => x.funded === addr);
    return entry ? { funder: w.funder, amount: entry.amount, ts: entry.ts } : null;
  }

  /** Funder chain up to maxHops (R6): [funder, funder-of-funder, ...]. */
  funderChain(addr: Address, maxHops: number): Address[] {
    const out: Address[] = [];
    let cur: Address | undefined = addr;
    for (let i = 0; i < maxHops; i++) {
      const w: WalletRec | undefined = this.wallets.get(cur);
      if (!w?.funder) break;
      out.push(w.funder);
      cur = w.funder;
    }
    return out;
  }

  /** Cluster of an address (empty if it's a singleton). */
  clusterOf(addr: Address): Address[] {
    if (!this.dsu.has(addr)) return [];
    const members = this.dsu.members(addr);
    return members.length > 1 ? members : [];
  }

  /** Per-cluster balance breakdown for a token (R4 + alerts, PLAN.md §6 "Supply % per cluster"). */
  clusterBreakdown(token: Address): ClusterStat[] {
    const circ = this.circulatingSupply(token);
    if (circ === null || circ <= 0n) return [];
    
    const stats: ClusterStat[] = [];
    const balances = this.clusterBalances.get(token);
    if (!balances) return [];

    const dsu = this.dsu;
    for (const [root, balance] of balances) {
      if (balance <= 0n) continue;
      const stat = { root, balance, memberCount: dsu.memberCount(root), pctOfSupply: (Number(balance) / Number(circ)) * 100 } as ClusterStat;
      
      let _members: Address[] | null = null;
      let _clusterId: Address | null = null;
      Object.defineProperty(stat, 'members', {
        get: () => { if (!_members) _members = dsu.members(root); return _members; },
        enumerable: true
      });
      Object.defineProperty(stat, 'clusterId', {
        get: () => {
          if (_clusterId) return _clusterId;
          let min = root;
          for (const m of stat.members) if (m < min) min = m;
          return (_clusterId = min);
        },
        enumerable: true
      });
      stats.push(stat);
    }
    return stats.sort((a, b) => b.pctOfSupply - a.pctOfSupply);
  }

  // ---- snapshots (PLAN.md §11.3) -------------------------------------------------

  toJSON(): string {
    const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? `${v}n` : v);
    return JSON.stringify(
      {
        wallets: [...this.wallets.entries()],
        dsu: this.dsu.toJSON(),
        balances: [...this.balances.entries()].map(([t, m]) => [t, [...m.entries()]]),
        burned: [...this.burned.entries()],
        totalSupply: [...this.totalSupply.entries()],
        deployers: [...this.deployers.entries()],
        pools: [...this.pools],
        poolCreated: [...this.poolCreated.entries()],
        lpMinted: [...this.lpMinted.entries()],
        swapVolume: this.swapVolume,
        buys: this.buys,
        sends: [...this.sends.entries()],
        exchangeFundings: [...this.exchangeFundings.entries()],
        fundingAmountIndex: [...this.fundingAmountIndex.entries()],
        fanoutSenders: [...this.fanoutSenders.entries()],
        identicalAmountUnioned: [...this.identicalAmountUnioned.entries()],
        clusterBalances: [...this.clusterBalances.entries()].map(([t, m]) => [t, [...m.entries()]]),
        clusterTokens: [...this.clusterTokens.entries()].map(([r, s]) => [r, [...s]]),
      },
      replacer,
    );
  }

  static fromJSON(json: string, tuning: GraphTuning = DEFAULT_GRAPH_TUNING): GraphEngine {
    const reviver = (_k: string, v: unknown) => (typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);
    const j = JSON.parse(json, reviver) as Record<string, unknown>;
    const g = new GraphEngine(tuning);
    for (const [k, v] of (j["wallets"] as [Address, WalletRec][] ?? [])) g.wallets.set(k, v);
    (g as { dsu: RollbackDSU }).dsu = RollbackDSU.fromJSON(j["dsu"] as never);
    for (const [t, entries] of (j["balances"] as [Address, [Address, bigint][]][] ?? [])) g.balances.set(t, new Map(entries));
    g.burned = new Map((j["burned"] as [Address, bigint][]) ?? []);
    g.totalSupply = new Map((j["totalSupply"] as [Address, bigint][]) ?? []);
    g.deployers = new Map((j["deployers"] as [Address, Address][]) ?? []);
    g.pools = new Set((j["pools"] as Address[]) ?? []);
    g.poolCreated = new Map((j["poolCreated"] as [Address, { block: number; ts: number }][]) ?? []);
    g.lpMinted = new Map((j["lpMinted"] as [Address, bigint][]) ?? []);
    g.swapVolume = (j["swapVolume"] as SwapVolumeEntry[]) ?? [];
    g.buys = (j["buys"] as BuyEntry[]) ?? [];
    for (const b of g.buys) {
      let tBuys = g.buysByToken.get(b.token);
      if (!tBuys) { tBuys = []; g.buysByToken.set(b.token, tBuys); }
      tBuys.push(b);
      let wTokens = g.tokensBoughtByWallet.get(b.addr);
      if (!wTokens) { wTokens = new Map(); g.tokensBoughtByWallet.set(b.addr, wTokens); }
      wTokens.set(b.token, (wTokens.get(b.token) ?? 0) + 1);
    }
    g.sends = new Map((j["sends"] as [Address, SendEntry[]][]) ?? []);
    g.exchangeFundings = new Map((j["exchangeFundings"] as [Address, ExchangeFundingEntry[]][]) ?? []);
    g.fundingAmountIndex = new Map((j["fundingAmountIndex"] as [string, { funded: Address; funder: Address; ts: number; block: number }[]][]) ?? []);
    g.fanoutSenders = new Map((j["fanoutSenders"] as [string, number][] | string[] ?? []).map((v) => Array.isArray(v) ? v : [v, 0]));
    g.identicalAmountUnioned = new Map((j["identicalAmountUnioned"] as [string, number][] | string[] ?? []).map((v) => Array.isArray(v) ? v : [v, 0]));
    for (const [t, entries] of (j["clusterBalances"] as [Address, [Address, bigint][]][] ?? [])) g.clusterBalances.set(t, new Map(entries));
    for (const [r, entries] of (j["clusterTokens"] as [Address, Address[]][] ?? [])) g.clusterTokens.set(r, new Set(entries));
    return g;
  }
}
