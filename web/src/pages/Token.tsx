import { ArrowUpRight, Copy } from "lucide-react";
import { motion } from "motion/react";
import { useMemo, useState } from "react";
import { FundingGraph } from "@/components/FundingGraph.tsx";
import { Iris } from "@/components/Iris.tsx";
import { PriceChart } from "@/components/PriceChart.tsx";
import { SignalList } from "@/components/SignalList.tsx";
import { Badge, Button, Empty, ErrorNote, Panel, Segmented, Skeleton, Tip } from "@/components/ui.tsx";
import { WalletSheet } from "@/pages/Wallets.tsx";
import { useQuery } from "@/lib/api.ts";
import { age, ago, CHAINS, cn, pct, price, shortAddr, usd, VERDICT_LABEL } from "@/lib/format.ts";
import { key, useLive } from "@/lib/live.ts";
import type { BoardMetrics, GraphData, TokenDetail, TradeRow } from "@/lib/types.ts";

function verdictSentence(verdict: string, gate: string | null): string {
  switch (verdict) {
    case "high_conviction": return "Several independent signals agree and no risk is flagged.";
    case "alert": return "Independent signals agree. Check the risks below before acting.";
    case "avoid": return gate ? `Avoid: ${gate.replace("critical risk: ", "").replaceAll("_", " ")}.` : "A critical risk is flagged.";
    case "watch": return gate ? `Watching: ${gate}.` : "Activity is building but has not cleared the bar.";
    default: return "No meaningful trading yet.";
  }
}

export function Token({ chainId, address }: { chainId: number; address: string }) {
  const { data, error, reload } = useQuery<TokenDetail>(`/api/tokens/${chainId}/${address}`, { refreshMs: 15_000 });
  const graph = useQuery<GraphData>(`/api/tokens/${chainId}/${address}/graph`, { refreshMs: 30_000 });
  const liveScore = useLive((s) => s.scores.get(key(chainId, address)));
  const liveTrades = useLive((s) => s.trades.get(key(chainId, address)));
  const [wallet, setWallet] = useState<string | null>(null);
  const [tab, setTab] = useState<"graph" | "holders">("graph");

  const score = liveScore ?? data?.score ?? null;
  const m = score?.metrics as unknown as BoardMetrics | undefined;
  const chain = CHAINS[chainId];
  const symbol = m?.symbol ?? data?.token?.symbol ?? null;
  const markers = useMemo(() => (data?.alerts ?? []).map((a) => ({ time: a.createdAt, label: a.kind === "exit" ? "Exit" : `Alert ${a.score}`, kind: a.kind === "exit" ? "exit" as const : "alert" as const })), [data?.alerts]);
  const trades: TradeRow[] = useMemo(() => {
    const live = liveTrades ?? [];
    const seen = new Set(live.map((t) => t.txHash));
    return [...live, ...(data?.trades ?? []).filter((t) => !seen.has(t.txHash))].slice(0, 120);
  }, [liveTrades, data?.trades]);

  if (error) return <ErrorNote message={error} onRetry={reload} />;
  if (!data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-28" />
        <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]"><Skeleton className="h-96" /><Skeleton className="h-96" /></div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Hero: the iris carries the verdict; everything else is quiet facts. */}
      <section className="relative overflow-hidden rounded-2xl border border-line bg-surface p-5 md:p-7">
        {score && (score.verdict === "high_conviction" || score.verdict === "alert") && (
          <div aria-hidden className="pointer-events-none absolute -left-24 -top-24 size-80 rounded-full" style={{ background: "radial-gradient(closest-side, var(--amber-soft), transparent)" }} />
        )}
        <div className="relative flex flex-col gap-6 md:flex-row md:items-center">
          <motion.div initial={{ scale: 0.92, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 160, damping: 18 }}>
            <Iris score={score?.score ?? 0} verdict={score?.verdict ?? "quiet"} size={112} />
          </motion.div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h1 className="font-display text-[34px] font-bold leading-none tracking-tight md:text-[42px]">{symbol ? `$${symbol}` : shortAddr(address)}</h1>
              <span className="text-[15px] text-muted">{data.token?.name}</span>
              <Badge tone={score?.verdict === "avoid" ? "loss" : score?.verdict === "high_conviction" || score?.verdict === "alert" ? "amber" : "neutral"}>{VERDICT_LABEL[score?.verdict ?? "quiet"]}</Badge>
            </div>
            <p className="mt-2 max-w-2xl text-[14px] text-muted">{verdictSentence(score?.verdict ?? "quiet", score?.gate ?? null)}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
              <span>{chain?.name}</span>
              <button onClick={() => void navigator.clipboard.writeText(address)} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[12px] hover:bg-raised" aria-label="Copy token address">
                {shortAddr(address)} <Copy className="size-3" />
              </button>
              <Button asChild size="sm" variant="outline"><a href={`https://dexscreener.com/${chain?.dexscreener}/${address}`} target="_blank" rel="noreferrer">DexScreener <ArrowUpRight /></a></Button>
              <Button asChild size="sm" variant="outline"><a href={`${chain?.explorer}/token/${address}`} target="_blank" rel="noreferrer">Explorer <ArrowUpRight /></a></Button>
            </div>
          </div>
          {m && (
            <dl className="grid shrink-0 grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-4 md:grid-cols-2">
              <Fact label="Price" value={price(m.priceUsd)} />
              <Fact label="Liquidity" value={usd(m.liquidityUsd)} />
              <Fact label="Market cap" value={usd(m.marketCapUsd)} />
              <Fact label="Age" value={m.launchObserved ? age(m.ageSec) : `${age(m.ageSec)}+`} hint={m.launchObserved ? "Watched since its pool launched" : "Watched since discovery; earlier history unknown"} />
            </dl>
          )}
        </div>
      </section>

      {!data.watched && (
        <ErrorNote message="Argus is not watching this token, so there is no live data. Add it to the watchlist in argus.config.ts to track it." />
      )}

      <div className="grid gap-5 lg:grid-cols-[1.6fr_1fr]">
        <Panel className="flex min-h-[420px] flex-col">
          <PriceChart chainId={chainId} token={address} markers={markers} />
        </Panel>
        <Panel title="Why this score" aside={score ? `${score.signals.filter((s) => s.kind === "opportunity").length} for, ${score.signals.filter((s) => s.kind === "risk").length} against` : null}>
          <SignalList signals={score?.signals ?? []} />
        </Panel>
      </div>

      {m && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Independent buyers, 15m" value={`${m.w15m.organicBuyers}`} sub={`of ${m.w15m.buyers} buyers, ${m.w15m.freshBuyers} brand-new wallets`} />
          <Stat label="Net flow, 15m" value={usd(m.w15m.buyUsd - m.w15m.sellUsd, { sign: true })} tone={m.w15m.buyUsd >= m.w15m.sellUsd ? "gain" : "loss"} sub={`${usd(m.w15m.buyUsd)} in, ${usd(m.w15m.sellUsd)} out`} />
          <Stat label="Early buyers still holding" value={m.earlyBuyers ? `${m.earlyBuyersHolding} / ${m.earlyBuyers}` : "—"} sub="first 30 buyers after launch" />
          <Stat label="Largest funded cluster" value={m.topClusterPct === null ? "—" : `${m.topClusterPct.toFixed(1)}%`} sub={m.topClusterPct === null ? "needs launch history" : `of supply; funders known for ${Math.round(m.funderCoverage * 100)}% of holders`} />
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[1.6fr_1fr]">
        <Panel
          title={tab === "graph" ? "Who funded the holders" : "Top holders"}
          aside={<Segmented label="Holder view" value={tab} onChange={setTab} options={[{ value: "graph", label: "Funding map" }, { value: "holders", label: "Table" }]} />}
        >
          {tab === "graph" ? (
            graph.data ? <FundingGraph data={graph.data} onSelect={setWallet} /> : <Skeleton className="m-4 h-[340px]" />
          ) : (
            <HolderTable detail={data} onSelect={setWallet} />
          )}
        </Panel>
        <Panel title="Live trades" aside={trades.length ? `${trades.length} most recent` : null}>
          <TradeTape trades={trades} onSelect={setWallet} />
        </Panel>
      </div>

      {data.positions.length > 0 && (
        <Panel title="How the alerts played out">
          <div className="divide-y divide-line">
            {data.positions.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center gap-x-6 gap-y-1 px-4 py-3 text-[13px]">
                <span className="w-28 font-medium">{p.kind === "alert" ? `Alert #${p.alertId}` : "Baseline"}</span>
                <span className="text-muted">entered {ago(p.entryAt)}</span>
                {(["m15", "h1", "h6", "h24"] as const).map((h) => (
                  <span key={h} className="num"><span className="text-faint">{h.replace("m15", "15m").replace("h", "")}{h.startsWith("h") ? "h" : ""} </span><span className={cn(p.returns[h] === null ? "text-faint" : p.returns[h]! >= 0 ? "text-gain" : "text-loss")}>{pct(p.returns[h])}</span></span>
                ))}
                <span className="num text-muted">peak {(p.peakUnitUsd / p.entryUnitUsd).toFixed(2)}×</span>
              </div>
            ))}
          </div>
        </Panel>
      )}

      <WalletSheet chainId={chainId} address={wallet} onClose={() => setWallet(null)} />
    </div>
  );
}

function Fact({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const body = (
    <div>
      <dt className="text-[12px] text-faint">{label}</dt>
      <dd className="num mt-0.5 text-[17px] font-medium">{value}</dd>
    </div>
  );
  return hint ? <Tip content={hint}>{body}</Tip> : body;
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: "gain" | "loss" }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3.5">
      <p className="text-[12.5px] text-muted">{label}</p>
      <p className={cn("num mt-1 font-display text-[24px] font-semibold", tone === "gain" && "text-gain", tone === "loss" && "text-loss")}>{value}</p>
      <p className="mt-0.5 text-[12px] text-faint">{sub}</p>
    </div>
  );
}

function HolderTable({ detail, onSelect }: { detail: TokenDetail; onSelect: (a: string) => void }) {
  if (detail.holders.length === 0) return <Empty title="No holders observed yet" />;
  const clusterSizes = new Map<string, number>();
  for (const h of detail.holders) clusterSizes.set(h.cluster, (clusterSizes.get(h.cluster) ?? 0) + 1);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead className="text-left text-[12px] text-faint">
          <tr><th className="px-4 py-2 font-normal">Wallet</th><th className="px-2 py-2 font-normal">Supply</th><th className="px-2 py-2 font-normal">Funded by</th><th className="px-4 py-2 text-right font-normal">Bought / sold</th></tr>
        </thead>
        <tbody className="divide-y divide-line">
          {detail.holders.map((h) => (
            <tr key={h.address} className="cursor-pointer hover:bg-raised/50" onClick={() => onSelect(h.address)}>
              <td className="px-4 py-2 font-mono text-[12px]">
                {shortAddr(h.address)}
                {h.address === (detail.score?.metrics["creator"] as string | undefined) && <Badge tone="loss" className="ml-2">creator</Badge>}
                {(clusterSizes.get(h.cluster) ?? 0) > 1 && <Badge tone="warn" className="ml-2">shared funder</Badge>}
              </td>
              <td className="num px-2 py-2">{h.pct === null ? "—" : `${h.pct.toFixed(2)}%`}</td>
              <td className="px-2 py-2 text-muted">{h.funder ? (h.funderIsService ? "exchange / service" : <span className="font-mono text-[12px]">{shortAddr(h.funder)}</span>) : "resolving…"}</td>
              <td className="num px-4 py-2 text-right text-muted">{usd(h.boughtUsd)} / {usd(h.soldUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TradeTape({ trades, onSelect }: { trades: TradeRow[]; onSelect: (a: string) => void }) {
  if (trades.length === 0) return <Empty title="No trades yet">Trades appear here within a block of hitting the chain.</Empty>;
  return (
    <ul className="max-h-[380px] divide-y divide-line overflow-y-auto">
      {trades.map((t) => (
        <motion.li key={`${t.txHash}:${t.side}:${t.usd}`} layout="position" initial={{ opacity: 0, backgroundColor: "var(--amber-soft)" }} animate={{ opacity: 1, backgroundColor: "rgba(0,0,0,0)" }} transition={{ duration: 1.2 }} className="flex items-center gap-3 px-4 py-2 text-[13px]">
          <span className={cn("w-9 font-medium", t.side === "buy" ? "text-gain" : "text-loss")}>{t.side === "buy" ? "Buy" : "Sell"}</span>
          <span className="num w-16">{usd(t.usd)}</span>
          <button onClick={() => onSelect(t.trader)} className="font-mono text-[12px] text-muted hover:text-text">{shortAddr(t.trader)}</button>
          {t.nonce !== undefined && t.nonce !== null && t.nonce <= 2 && <Badge tone="warn">new wallet</Badge>}
          <span className="num ml-auto text-[12px] text-faint">{age(Math.max(0, Date.now() / 1000 - t.ts))}</span>
        </motion.li>
      ))}
    </ul>
  );
}
