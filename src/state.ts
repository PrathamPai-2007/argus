import { chainInfo, priceRef, quoteInfo, type DexVersion } from "./chains.ts";
import { BURN_ADDRESSES, ZERO_ADDRESS, type Address, type ChainEvent, type LiquidityEvent, type PoolCreatedEvent, type ReservesEvent, type SwapEvent, type TransferEvent } from "./model.ts";

// Per-chain market state derived from events. Pure (no I/O) and rewindable:
// every event mutation records an undo closure tagged with its block, so a
// reorg can restore exact prior state (invariant 2). Facts that are not
// block-scoped (token metadata, wallet funders, labels) come in via setters.
//
// Rules never read this object directly; they read TokenMetrics snapshots
// produced by metrics(), which keeps rule logic pure and trivially testable.

export interface Trade {
  block: number;
  ts: number;
  txHash: string;
  trader: Address;
  nonce: number | null;
  side: "buy" | "sell";
  tokenAmount: bigint;
  usd: number;
  /** USD per raw token unit at execution (decimals-free; ratios give returns). */
  unitUsd: number;
}

export interface TraderPosition {
  bought: bigint;
  sold: bigint;
  costUsd: number;
  proceedsUsd: number;
  buys: number;
  sells: number;
  firstBuyTs: number | null;
  firstBuyBlock: number | null;
  firstNonce: number | null;
}

interface PoolState {
  address: Address;
  dex: DexVersion;
  token: Address;
  quote: Address;
  tokenIs0: boolean;
  createdBlock: number | null;
  tokenBalance: bigint;
  quoteBalance: bigint;
  sqrtPriceX96: bigint | null;
}

interface LiquidityChange {
  ts: number;
  block: number;
  action: "add" | "remove";
  usd: number;
  provider: Address;
  /** Share of the pool's quote side removed by this event (0..1). */
  fraction: number;
}

interface TokenState {
  token: Address;
  firstSeenTs: number;
  launch: { block: number; ts: number; creator: Address | null } | null;
  pools: Set<Address>;
  trades: Trade[];
  traders: Map<Address, TraderPosition>;
  holders: Map<Address, bigint>;
  liquidity: LiquidityChange[];
  initialLiquidityUsd: number | null;
  peakLiquidityUsd: number;
}

export interface TokenMeta {
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  totalSupply: bigint | null;
}

export interface WalletFunding {
  funder: Address | null;
  /** True when the funder is an exchange/bridge/hot wallet: not evidence of common control. */
  funderIsService: boolean;
}

type Undo = () => void;

const DAY = 86_400;
const Q96 = 2 ** 96;

export class ChainState {
  readonly chainId: number;
  /** USD per whole token for every reference-priced token (wrapped native, ZORA, …). */
  private refPrices = new Map<Address, number>();
  private pools = new Map<Address, PoolState>();
  private tokens = new Map<Address, TokenState>();
  private meta = new Map<Address, TokenMeta>();
  private funding = new Map<Address, WalletFunding>();
  private serviceLabels = new Map<Address, string>();
  private smart = new Set<Address>();
  private history: Array<{ block: number; undo: Undo }> = [];

  constructor(chainId: number) {
    this.chainId = chainId;
  }

  get nativeUsd(): number {
    return this.refPrices.get(chainInfo(this.chainId).wrappedNative) ?? 0;
  }

  /** Seed a reference price (e.g. before the first reference swap is seen). */
  setRefPrice(token: Address, usd: number): void {
    if (usd > 0 && Number.isFinite(usd)) this.refPrices.set(token, usd);
  }

  refPrice(token: Address): number | null {
    return this.refPrices.get(token) ?? null;
  }

  // ---- non-event facts -----------------------------------------------------------

  setTokenMeta(token: Address, meta: TokenMeta): void {
    this.meta.set(token, meta);
  }

  tokenMeta(token: Address): TokenMeta | undefined {
    return this.meta.get(token);
  }

  setFunding(wallet: Address, funding: WalletFunding): void {
    this.funding.set(wallet, funding);
  }

  fundingOf(wallet: Address): WalletFunding | undefined {
    return this.funding.get(wallet);
  }

  setServiceLabels(labels: Map<Address, string>): void {
    this.serviceLabels = labels;
  }

  setSmartWallets(wallets: Set<Address>): void {
    this.smart = wallets;
  }

  /** Seed a V3 pool's balances when it was registered after creation. */
  setPoolBalances(pool: Address, tokenBalance: bigint, quoteBalance: bigint): void {
    const p = this.pools.get(pool);
    if (p) {
      p.tokenBalance = tokenBalance;
      p.quoteBalance = quoteBalance;
    }
  }

  registerPool(ref: { address: Address; dex: DexVersion; token0: Address; token: Address; quote: Address }, createdBlock: number | null = null): void {
    if (this.pools.has(ref.address)) return;
    this.pools.set(ref.address, {
      address: ref.address,
      dex: ref.dex,
      token: ref.token,
      quote: ref.quote,
      tokenIs0: ref.token === ref.token0,
      createdBlock,
      tokenBalance: 0n,
      quoteBalance: 0n,
      sqrtPriceX96: null,
    });
    if (!priceRef(this.chainId, ref.address)) this.tokenState(ref.token, 0).pools.add(ref.address);
  }

  isPool(addr: Address): boolean {
    return this.pools.has(addr);
  }

  knownTokens(): Address[] {
    return [...this.tokens.keys()];
  }

  /** Forget a token entirely (unwatched); not rewindable by design. */
  dropToken(token: Address): void {
    const t = this.tokens.get(token);
    if (!t) return;
    for (const p of t.pools) this.pools.delete(p);
    this.tokens.delete(token);
    this.meta.delete(token);
  }

  // ---- events --------------------------------------------------------------------

  apply(evt: ChainEvent): void {
    const undos: Undo[] = [];
    switch (evt.kind) {
      case "pool_created": this.applyPoolCreated(evt, undos); break;
      case "swap": this.applySwap(evt, undos); break;
      case "reserves": this.applyReserves(evt, undos); break;
      case "liquidity": this.applyLiquidity(evt, undos); break;
      case "transfer": this.applyTransfer(evt, undos); break;
      case "funding": break; // funders arrive via setFunding (durable, not block-scoped)
    }
    if (undos.length > 0) {
      this.history.push({ block: evt.blockNumber, undo: () => { for (let i = undos.length - 1; i >= 0; i--) undos[i]!(); } });
    }
  }

  /** Undo every transition at blocks >= fromBlock. Returns transitions undone. */
  rewindTo(fromBlock: number): number {
    let n = 0;
    while (this.history.length > 0 && this.history[this.history.length - 1]!.block >= fromBlock) {
      this.history.pop()!.undo();
      n++;
    }
    return n;
  }

  /** Blocks <= boundary are final: drop their undo log and prune stale windows. */
  finalize(boundary: number, nowTs: number): void {
    this.history = this.history.filter((h) => h.block > boundary);
    const cutoff = nowTs - DAY;
    for (const t of this.tokens.values()) {
      if (t.trades.length > 0 && t.trades[0]!.ts < cutoff) {
        t.trades = t.trades.filter((tr) => tr.ts >= cutoff || tr.block > boundary);
      }
    }
  }

  private tokenState(token: Address, ts: number): TokenState {
    let t = this.tokens.get(token);
    if (!t) {
      t = { token, firstSeenTs: ts, launch: null, pools: new Set(), trades: [], traders: new Map(), holders: new Map(), liquidity: [], initialLiquidityUsd: null, peakLiquidityUsd: 0 };
      this.tokens.set(token, t);
    }
    if (t.firstSeenTs === 0 && ts > 0) t.firstSeenTs = ts;
    return t;
  }

  private applyPoolCreated(evt: PoolCreatedEvent, undos: Undo[]): void {
    // Launch facts are recorded when the pool's first liquidity arrives (the
    // creator is the tx signer there); registration itself happens via registerPool.
    const p = this.pools.get(evt.pool);
    if (!p) return;
    const [created, sqrt] = [p.createdBlock, p.sqrtPriceX96];
    if (p.createdBlock === null) p.createdBlock = evt.blockNumber;
    // V4 pools are priced at Initialize, before any liquidity or swap.
    if (p.sqrtPriceX96 === null && evt.sqrtPriceX96 !== undefined) p.sqrtPriceX96 = evt.sqrtPriceX96;
    undos.push(() => { p.createdBlock = created; p.sqrtPriceX96 = sqrt; });
  }

  /** USD value of one raw unit of a quote token. */
  private quoteUnitUsd(quote: Address): number {
    const q = quoteInfo(this.chainId, quote);
    if (!q) return 0;
    const price = q.pricing === "stable" ? 1 : q.pricing === "native" ? this.nativeUsd : (this.refPrices.get(quote) ?? 0);
    return price / 10 ** q.decimals;
  }

  /** Reference pool swap → USD price of its base token, from the post-swap pool price. */
  private applyRefSwap(evt: SwapEvent, undos: Undo[]): void {
    const ref = priceRef(this.chainId, evt.pool);
    const base = ref ? quoteInfo(this.chainId, ref.base) : undefined;
    const usd = ref ? quoteInfo(this.chainId, ref.usd) : undefined;
    if (!ref || !base || !usd) return;
    let price: number;
    if (evt.sqrtPriceX96 !== null) {
      const ratio = (Number(evt.sqrtPriceX96) / Q96) ** 2; // raw token1 per raw token0
      const usdPerBaseRaw = ref.base === ref.token0 ? ratio : 1 / ratio;
      price = (usdPerBaseRaw * 10 ** base.decimals) / 10 ** usd.decimals;
    } else {
      if (evt.tokenAmount <= 0n) return;
      price = (Number(evt.quoteAmount) / 10 ** usd.decimals) / (Number(evt.tokenAmount) / 10 ** base.decimals);
    }
    if (!(price > 0) || !Number.isFinite(price)) return;
    const prev = this.refPrices.get(ref.base);
    this.refPrices.set(ref.base, price);
    undos.push(() => { if (prev === undefined) this.refPrices.delete(ref.base); else this.refPrices.set(ref.base, prev); });
  }

  private applySwap(evt: SwapEvent, undos: Undo[]): void {
    const pool = this.pools.get(evt.pool);
    if (!pool) return;
    const prevSqrt = pool.sqrtPriceX96;
    if (evt.sqrtPriceX96 !== null) pool.sqrtPriceX96 = evt.sqrtPriceX96;
    if (pool.dex !== "v2") {
      const [tb, qb] = [pool.tokenBalance, pool.quoteBalance];
      pool.tokenBalance += evt.side === "buy" ? -evt.tokenAmount : evt.tokenAmount;
      pool.quoteBalance += evt.side === "buy" ? evt.quoteAmount : -evt.quoteAmount;
      undos.push(() => { pool.tokenBalance = tb; pool.quoteBalance = qb; });
    }
    undos.push(() => { pool.sqrtPriceX96 = prevSqrt; });

    if (priceRef(this.chainId, evt.pool)) {
      this.applyRefSwap(evt, undos);
      return;
    }

    const t = this.tokenState(evt.token, evt.timestamp);
    const usd = Number(evt.quoteAmount) * this.quoteUnitUsd(evt.quote);
    const trade: Trade = {
      block: evt.blockNumber,
      ts: evt.timestamp,
      txHash: evt.txHash,
      trader: evt.trader,
      nonce: evt.traderNonce,
      side: evt.side,
      tokenAmount: evt.tokenAmount,
      usd,
      unitUsd: evt.tokenAmount > 0n ? usd / Number(evt.tokenAmount) : 0,
    };
    t.trades.push(trade);
    undos.push(() => { t.trades.pop(); });

    const prevPos = t.traders.get(evt.trader);
    const pos: TraderPosition = prevPos ? { ...prevPos } : { bought: 0n, sold: 0n, costUsd: 0, proceedsUsd: 0, buys: 0, sells: 0, firstBuyTs: null, firstBuyBlock: null, firstNonce: null };
    if (evt.side === "buy") {
      pos.bought += evt.tokenAmount;
      pos.costUsd += usd;
      pos.buys++;
      if (pos.firstBuyTs === null) {
        pos.firstBuyTs = evt.timestamp;
        pos.firstBuyBlock = evt.blockNumber;
        pos.firstNonce = evt.traderNonce;
      }
    } else {
      pos.sold += evt.tokenAmount;
      pos.proceedsUsd += usd;
      pos.sells++;
    }
    t.traders.set(evt.trader, pos);
    undos.push(() => { if (prevPos) t.traders.set(evt.trader, prevPos); else t.traders.delete(evt.trader); });
  }

  private applyReserves(evt: ReservesEvent, undos: Undo[]): void {
    const pool = this.pools.get(evt.pool);
    if (!pool) return;
    const [tb, qb] = [pool.tokenBalance, pool.quoteBalance];
    pool.tokenBalance = evt.tokenReserve;
    pool.quoteBalance = evt.quoteReserve;
    undos.push(() => { pool.tokenBalance = tb; pool.quoteBalance = qb; });
    this.trackLiquidity(pool, evt.timestamp, undos);
  }

  private applyLiquidity(evt: LiquidityEvent, undos: Undo[]): void {
    const pool = this.pools.get(evt.pool);
    if (!pool || priceRef(this.chainId, evt.pool)) return;
    const t = this.tokenState(evt.token, evt.timestamp);
    let { tokenAmount, quoteAmount } = evt;
    if (evt.range) {
      if (pool.sqrtPriceX96 === null) return;
      const [a0, a1] = rangeAmounts(pool.sqrtPriceX96, evt.range.liquidity, evt.range.tickLower, evt.range.tickUpper);
      [tokenAmount, quoteAmount] = pool.tokenIs0 ? [a0, a1] : [a1, a0];
    }
    const quoteBefore = evt.action === "add" ? pool.quoteBalance : pool.quoteBalance + (pool.dex === "v2" ? quoteAmount : 0n);
    if (pool.dex !== "v2") {
      const [tb, qb] = [pool.tokenBalance, pool.quoteBalance];
      const sign = evt.action === "add" ? 1n : -1n;
      pool.tokenBalance += sign * tokenAmount;
      pool.quoteBalance += sign * quoteAmount;
      undos.push(() => { pool.tokenBalance = tb; pool.quoteBalance = qb; });
    }
    const usd = 2 * Number(quoteAmount) * this.quoteUnitUsd(evt.quote);
    const fraction = evt.action === "remove" && quoteBefore > 0n ? Math.min(1, Number(quoteAmount) / Number(quoteBefore)) : 0;
    t.liquidity.push({ ts: evt.timestamp, block: evt.blockNumber, action: evt.action, usd, provider: evt.provider, fraction });
    undos.push(() => { t.liquidity.pop(); });
    if (evt.action === "add" && t.launch === null && pool.createdBlock !== null) {
      t.launch = { block: evt.blockNumber, ts: evt.timestamp, creator: evt.provider };
      undos.push(() => { t.launch = null; });
    }
    this.trackLiquidity(pool, evt.timestamp, undos);
  }

  private trackLiquidity(pool: PoolState, ts: number, undos: Undo[]): void {
    if (priceRef(this.chainId, pool.address)) return;
    const t = this.tokenState(pool.token, ts);
    const liq = this.tokenLiquidityUsd(t);
    const [init, peak] = [t.initialLiquidityUsd, t.peakLiquidityUsd];
    if (t.initialLiquidityUsd === null && liq > 0) t.initialLiquidityUsd = liq;
    if (liq > t.peakLiquidityUsd) t.peakLiquidityUsd = liq;
    undos.push(() => { t.initialLiquidityUsd = init; t.peakLiquidityUsd = peak; });
  }

  private applyTransfer(evt: TransferEvent, undos: Undo[]): void {
    if (evt.amount === 0n || evt.from === evt.to) return;
    const t = this.tokenState(evt.token, evt.timestamp);
    for (const [addr, delta] of [[evt.from, -evt.amount], [evt.to, evt.amount]] as const) {
      if (addr === ZERO_ADDRESS) continue;
      const prev = t.holders.get(addr);
      const next = (prev ?? 0n) + delta;
      if (next === 0n) t.holders.delete(addr);
      else t.holders.set(addr, next);
      undos.push(() => { if (prev === undefined) t.holders.delete(addr); else t.holders.set(addr, prev); });
    }
  }

  // ---- derived reads ---------------------------------------------------------------

  private poolLiquidityUsd(p: PoolState): number {
    return 2 * Number(p.quoteBalance > 0n ? p.quoteBalance : 0n) * this.quoteUnitUsd(p.quote);
  }

  private tokenLiquidityUsd(t: TokenState): number {
    let sum = 0;
    for (const addr of t.pools) {
      const p = this.pools.get(addr);
      if (p) sum += this.poolLiquidityUsd(p);
    }
    return sum;
  }

  /** Deepest pool of a token (by quote-side USD). */
  mainPool(token: Address): { address: Address; dex: DexVersion; quote: Address; liquidityUsd: number } | null {
    const t = this.tokens.get(token);
    if (!t) return null;
    let best: PoolState | null = null;
    for (const addr of t.pools) {
      const p = this.pools.get(addr);
      if (p && (!best || this.poolLiquidityUsd(p) > this.poolLiquidityUsd(best))) best = p;
    }
    return best ? { address: best.address, dex: best.dex, quote: best.quote, liquidityUsd: this.poolLiquidityUsd(best) } : null;
  }

  /** Spot USD per raw token unit from the deepest pool (null if unpriced). */
  spotUnitUsd(token: Address): number | null {
    const main = this.mainPool(token);
    if (!main) return null;
    const p = this.pools.get(main.address)!;
    const qUsd = this.quoteUnitUsd(p.quote);
    if (qUsd === 0) return null;
    if (p.dex !== "v2" && p.sqrtPriceX96 !== null) {
      const ratio = (Number(p.sqrtPriceX96) / Q96) ** 2; // raw token1 per raw token0
      const quotePerToken = p.tokenIs0 ? ratio : 1 / ratio;
      return Number.isFinite(quotePerToken) && quotePerToken > 0 ? quotePerToken * qUsd : null;
    }
    if (p.tokenBalance > 0n && p.quoteBalance > 0n) return (Number(p.quoteBalance) / Number(p.tokenBalance)) * qUsd;
    const last = this.tokens.get(token)?.trades.at(-1);
    return last && last.unitUsd > 0 ? last.unitUsd : null;
  }

  /** Cluster key: the topmost non-service funder within two hops, or the wallet itself. */
  clusterKey(wallet: Address): Address {
    let key = wallet;
    let cur = wallet;
    for (let hop = 0; hop < 2; hop++) {
      const f = this.funding.get(cur);
      if (!f?.funder || f.funderIsService || this.serviceLabels.has(f.funder)) break;
      key = f.funder;
      cur = f.funder;
    }
    return key;
  }

  tradesOf(token: Address): readonly Trade[] {
    return this.tokens.get(token)?.trades ?? [];
  }

  tradersOf(token: Address): ReadonlyMap<Address, TraderPosition> {
    return this.tokens.get(token)?.traders ?? new Map();
  }

  holdersOf(token: Address): ReadonlyMap<Address, bigint> {
    return this.tokens.get(token)?.holders ?? new Map();
  }

  metrics(token: Address, now: number): TokenMetrics | null {
    const t = this.tokens.get(token);
    if (!t) return null;
    return computeMetrics(this, t, now);
  }

  // exposed to computeMetrics only
  _internals() {
    return { pools: this.pools, smart: this.smart, serviceLabels: this.serviceLabels, liquidityUsd: (t: TokenState) => this.tokenLiquidityUsd(t) };
  }
}

// ---- metrics ------------------------------------------------------------------------

export interface WindowStats {
  buys: number;
  sells: number;
  buyUsd: number;
  sellUsd: number;
  buyers: number;
  sellers: number;
  /** Distinct buyer clusters excluding same-block round-trippers (MEV). */
  organicBuyers: number;
  /** Buyers whose trade nonce shows a brand-new wallet. */
  freshBuyers: number;
  traders: number;
  /** Largest single trader's share of total volume (0..1). */
  topTraderShare: number;
}

export interface TokenMetrics {
  chainId: number;
  token: Address;
  now: number;
  symbol: string | null;
  ageSec: number;
  launchObserved: boolean;
  launchBlock: number | null;
  creator: Address | null;
  totalSupply: bigint | null;
  priceUnitUsd: number | null;
  liquidityUsd: number;
  initialLiquidityUsd: number | null;
  peakLiquidityUsd: number;
  /** Largest single liquidity removal as a fraction of the pool at the time. */
  maxRemovalFraction: number;
  lastRemovalTs: number | null;
  w5m: WindowStats;
  w15m: WindowStats;
  prev15m: WindowStats;
  w1h: WindowStats;
  trades: number;
  firstTradeTs: number | null;
  /** First buyers after launch (or first observed), excluding MEV. */
  earlyBuyers: number;
  earlyBuyersHolding: number;
  /** Distinct buyers in the first 3 blocks after launch. */
  launchBuyers: number;
  launchFreshBuyers: number;
  /** Share of supply bought in the first 3 blocks (null without supply). */
  launchSupplyPct: number | null;
  /** Largest launch-buyer cluster (by funder) size. */
  launchLargestCluster: number;
  /** Share of supply held by the largest multi-wallet cluster, holders excluding pools/burn. */
  topClusterPct: number | null;
  topClusterSize: number;
  topHolderPct: number | null;
  /** Share of holders whose funder is known (cluster evidence coverage). */
  funderCoverage: number;
  creatorSoldPct: number | null;
  /** Share of launch-buyer token amount already sold. */
  launchBuyersSoldPct: number | null;
  /** Buys from distinct traders vs successful sells from non-creator traders. */
  distinctBuyersTotal: number;
  nonCreatorSellers: number;
  smartBuyers: Address[];
  /** Traders with both a buy and a sell in the same block (sandwich/arbitrage). */
  mevTraders: number;
}

function windowStats(state: ChainState, trades: readonly Trade[], from: number, to: number, mev: Set<Address>): WindowStats {
  let buys = 0, sells = 0, buyUsd = 0, sellUsd = 0;
  const buyers = new Set<Address>();
  const sellers = new Set<Address>();
  const organic = new Set<Address>();
  const fresh = new Set<Address>();
  const volume = new Map<Address, number>();
  let total = 0;
  for (const tr of trades) {
    if (tr.ts < from || tr.ts >= to) continue;
    volume.set(tr.trader, (volume.get(tr.trader) ?? 0) + tr.usd);
    total += tr.usd;
    if (tr.side === "buy") {
      buys++;
      buyUsd += tr.usd;
      buyers.add(tr.trader);
      if (!mev.has(tr.trader)) organic.add(state.clusterKey(tr.trader));
      if (tr.nonce !== null && tr.nonce <= 2) fresh.add(tr.trader);
    } else {
      sells++;
      sellUsd += tr.usd;
      sellers.add(tr.trader);
    }
  }
  const top = Math.max(0, ...volume.values());
  return { buys, sells, buyUsd, sellUsd, buyers: buyers.size, sellers: sellers.size, organicBuyers: organic.size, freshBuyers: fresh.size, traders: volume.size, topTraderShare: total > 0 ? top / total : 0 };
}

function pctOf(amount: bigint, supply: bigint | null): number | null {
  if (supply === null || supply <= 0n) return null;
  return Number((amount * 1_000_000n) / supply) / 10_000;
}

function computeMetrics(state: ChainState, t: TokenState, now: number): TokenMetrics {
  const { pools, smart, serviceLabels, liquidityUsd } = state._internals();
  const meta = state.tokenMeta(t.token);
  const supply = meta?.totalSupply ?? null;
  const trades = t.trades;

  // MEV: buy and sell by the same trader inside one block.
  const sidesByTraderBlock = new Map<string, number>();
  const mev = new Set<Address>();
  for (const tr of trades) {
    const k = `${tr.trader}:${tr.block}`;
    const bits = (sidesByTraderBlock.get(k) ?? 0) | (tr.side === "buy" ? 1 : 2);
    sidesByTraderBlock.set(k, bits);
    if (bits === 3) mev.add(tr.trader);
  }

  const creator = t.launch?.creator ?? null;
  const launchBlock = t.launch?.block ?? null;
  const start = t.launch?.ts ?? t.firstSeenTs;

  // Early buyers: first 30 distinct non-MEV buyers.
  const early: Address[] = [];
  const launchBuyers = new Set<Address>();
  const launchFresh = new Set<Address>();
  let launchBought = 0n;
  for (const tr of trades) {
    if (tr.side !== "buy" || mev.has(tr.trader) || tr.trader === creator) continue;
    if (early.length < 30 && !early.includes(tr.trader)) early.push(tr.trader);
    if (launchBlock !== null && tr.block <= launchBlock + 2) {
      launchBuyers.add(tr.trader);
      launchBought += tr.tokenAmount;
      if (tr.nonce !== null && tr.nonce <= 2) launchFresh.add(tr.trader);
    }
  }
  const positions = t.traders;
  const holding = early.filter((a) => {
    const p = positions.get(a);
    return p !== undefined && p.sold * 10n < p.bought * 9n; // still holds >10% of what they bought
  }).length;

  const launchClusters = new Map<Address, number>();
  let launchSold = 0n;
  for (const a of launchBuyers) {
    const key = state.clusterKey(a);
    launchClusters.set(key, (launchClusters.get(key) ?? 0) + 1);
    launchSold += positions.get(a)?.sold ?? 0n;
  }

  // Holder concentration (exclude pools, burn addresses, the token contract itself).
  const clusterBal = new Map<Address, { bal: bigint; size: number }>();
  let topHolder = 0n;
  let holderCount = 0;
  let funded = 0;
  for (const [addr, bal] of t.holders) {
    if (bal <= 0n || pools.has(addr) || BURN_ADDRESSES.has(addr) || addr === t.token) continue;
    holderCount++;
    if (state.fundingOf(addr)) funded++;
    if (bal > topHolder) topHolder = bal;
    const key = state.clusterKey(addr);
    const c = clusterBal.get(key) ?? { bal: 0n, size: 0 };
    c.bal += bal;
    c.size++;
    clusterBal.set(key, c);
  }
  let topCluster = { bal: 0n, size: 0 };
  for (const c of clusterBal.values()) if (c.size > 1 && c.bal > topCluster.bal) topCluster = c;

  let maxRemoval = 0;
  let lastRemovalTs: number | null = null;
  for (const l of t.liquidity) {
    if (l.action !== "remove") continue;
    if (l.fraction > maxRemoval) maxRemoval = l.fraction;
    lastRemovalTs = l.ts;
  }

  const creatorPos = creator ? positions.get(creator) : undefined;
  const creatorHeld = creator ? (t.holders.get(creator) ?? 0n) : 0n;
  const creatorSold = creatorPos?.sold ?? 0n;
  const distinctBuyers = new Set<Address>();
  const nonCreatorSellers = new Set<Address>();
  const smartBuyers = new Set<Address>();
  for (const tr of trades) {
    if (tr.side === "buy") {
      distinctBuyers.add(tr.trader);
      if (smart.has(tr.trader) && tr.ts >= now - 3600) smartBuyers.add(tr.trader);
    } else if (tr.trader !== creator && !serviceLabels.has(tr.trader)) {
      nonCreatorSellers.add(tr.trader);
    }
  }

  return {
    chainId: state.chainId,
    token: t.token,
    now,
    symbol: meta?.symbol ?? null,
    ageSec: start > 0 ? Math.max(0, now - start) : 0,
    launchObserved: t.launch !== null,
    launchBlock,
    creator,
    totalSupply: supply,
    priceUnitUsd: state.spotUnitUsd(t.token),
    liquidityUsd: liquidityUsd(t),
    initialLiquidityUsd: t.initialLiquidityUsd,
    peakLiquidityUsd: t.peakLiquidityUsd,
    maxRemovalFraction: maxRemoval,
    lastRemovalTs,
    w5m: windowStats(state, trades, now - 300, now + 1, mev),
    w15m: windowStats(state, trades, now - 900, now + 1, mev),
    prev15m: windowStats(state, trades, now - 1800, now - 900, mev),
    w1h: windowStats(state, trades, now - 3600, now + 1, mev),
    trades: trades.length,
    firstTradeTs: trades[0]?.ts ?? null,
    earlyBuyers: early.length,
    earlyBuyersHolding: holding,
    launchBuyers: launchBuyers.size,
    launchFreshBuyers: launchFresh.size,
    launchSupplyPct: launchBlock === null ? null : pctOf(launchBought, supply),
    launchLargestCluster: Math.max(0, ...launchClusters.values()),
    topClusterPct: t.launch ? pctOf(topCluster.bal, supply) : null,
    topClusterSize: topCluster.size,
    topHolderPct: t.launch ? pctOf(topHolder, supply) : null,
    funderCoverage: holderCount === 0 ? 0 : funded / holderCount,
    creatorSoldPct: creatorPos && creatorPos.bought > 0n
      ? Number((creatorSold * 10_000n) / creatorPos.bought) / 100
      : creator && creatorHeld + creatorSold > 0n && creatorSold > 0n ? Number((creatorSold * 10_000n) / (creatorHeld + creatorSold)) / 100 : null,
    launchBuyersSoldPct: launchBought > 0n ? Number((launchSold * 10_000n) / launchBought) / 100 : null,
    distinctBuyersTotal: distinctBuyers.size,
    nonCreatorSellers: nonCreatorSellers.size,
    smartBuyers: [...smartBuyers],
    mevTraders: mev.size,
  };
}

/**
 * Token amounts (raw units) backing `liquidity` in [tickLower, tickUpper) at
 * the current price: standard concentrated-liquidity math, in floating point
 * (the amounts feed USD estimates, not settlement).
 */
export function rangeAmounts(sqrtPriceX96: bigint, liquidity: bigint, tickLower: number, tickUpper: number): [bigint, bigint] {
  const sp = Number(sqrtPriceX96) / Q96;
  const sa = 1.0001 ** (tickLower / 2);
  const sb = 1.0001 ** (tickUpper / 2);
  const l = Number(liquidity);
  let a0 = 0;
  let a1 = 0;
  if (sp <= sa) a0 = (l * (sb - sa)) / (sa * sb);
  else if (sp < sb) {
    a0 = (l * (sb - sp)) / (sp * sb);
    a1 = l * (sp - sa);
  } else a1 = l * (sb - sa);
  const big = (x: number) => (Number.isFinite(x) && x > 0 ? BigInt(Math.floor(x)) : 0n);
  return [big(a0), big(a1)];
}
