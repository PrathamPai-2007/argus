import { LayoutGroup, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { Iris } from "@/components/Iris.tsx";
import { Sparkline } from "@/components/Sparkline.tsx";
import { Badge, Empty, ErrorNote, Segmented, Skeleton, Tip } from "@/components/ui.tsx";
import { useQuery } from "@/lib/api.ts";
import { age, CHAINS, cn, price, shortAddr, usd } from "@/lib/format.ts";
import { key, seedScores, useLive } from "@/lib/live.ts";
import { Link } from "@/lib/router.tsx";
import type { BoardMetrics, Opportunity, ScoreRow } from "@/lib/types.ts";

type View = "worth" | "watching" | "avoid" | "all";
const VIEW_MATCH: Record<View, (v: ScoreRow["verdict"]) => boolean> = {
  worth: (v) => v === "alert" || v === "high_conviction",
  watching: (v) => v === "watch",
  avoid: (v) => v === "avoid",
  all: () => true,
};
const RANK: Record<string, number> = { high_conviction: 0, alert: 1, watch: 2, avoid: 3, quiet: 4 };

export function Opportunities() {
  const { data, error, reload } = useQuery<Opportunity[]>("/api/opportunities?limit=600", { refreshMs: 60_000 });
  const scores = useLive((s) => s.scores);
  const version = useLive((s) => s.scoreVersion);
  const status = useLive((s) => s.status);
  const [chain, setChain] = useState<"all" | "1" | "8453">("all");
  const [view, setView] = useState<View>("worth");

  useEffect(() => {
    if (data) seedScores(data);
  }, [data]);

  const extras = useMemo(() => new Map((data ?? []).map((o) => [key(o.chainId, o.token), o])), [data]);
  const rows = useMemo(() => {
    return [...scores.values()]
      .filter((s) => (chain === "all" || s.chainId === Number(chain)) && VIEW_MATCH[view](s.verdict))
      .sort((a, b) => (RANK[a.verdict] ?? 9) - (RANK[b.verdict] ?? 9) || b.score - a.score || b.at - a.at)
      .slice(0, 150);
  }, [scores, version, chain, view]);

  const counts = useMemo(() => {
    const c: Record<View, number> = { worth: 0, watching: 0, avoid: 0, all: 0 };
    for (const s of scores.values()) {
      if (chain !== "all" && s.chainId !== Number(chain)) continue;
      c.all++;
      for (const v of ["worth", "watching", "avoid"] as const) if (VIEW_MATCH[v](s.verdict)) c[v]++;
    }
    return c;
  }, [scores, version, chain]);

  const watched = (status?.chains ?? []).reduce((n, c) => n + c.watchedTokens, 0);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-[28px] font-bold leading-tight tracking-tight md:text-[34px]">Opportunities</h1>
          <p className="mt-1 max-w-2xl text-[13.5px] text-muted">
            New tokens ranked by independent demand. A token is worth a look only when two or more unrelated signals agree and nothing critical is wrong.
          </p>
        </div>
        <Segmented label="Chain" value={chain} onChange={setChain} options={[{ value: "all", label: "All chains" }, { value: "1", label: "Ethereum" }, { value: "8453", label: "Base" }]} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {([["worth", "Worth a look"], ["watching", "Watching"], ["avoid", "Avoid"], ["all", "All scored"]] as const).map(([v, label]) => (
          <button
            key={v}
            onClick={() => setView(v)}
            aria-pressed={view === v}
            className={cn("rounded-full border px-3 py-1 text-[13px] transition-colors", view === v ? "border-amber/60 bg-amber-soft text-text" : "border-line text-muted hover:text-text")}
          >
            {label} <span className="num ml-1 text-faint">{counts[v]}</span>
          </button>
        ))}
      </div>

      {error && <ErrorNote message={error} onRetry={reload} />}

      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        <div className="hidden grid-cols-[48px_minmax(160px,1.4fr)_minmax(110px,1fr)_96px_90px_minmax(110px,0.9fr)_minmax(120px,1fr)] items-center gap-4 border-b border-line px-4 py-2.5 text-[12px] text-faint lg:grid">
          <span>Score</span><span>Token</span><span>Price</span><span>1h</span><span>Liquidity</span><span>Buyers, 15m</span><span>Net flow, 15m</span>
        </div>
        {!data && !error && Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="m-4 h-12" />)}
        {data && rows.length === 0 && (
          <Empty title={view === "worth" ? "Nothing clears the bar right now" : "No tokens in this view"}>
            {view === "worth"
              ? `Argus is watching ${watched.toLocaleString("en-US")} tokens. Opportunities appear here the moment a token shows independent buyers, net inflow and no critical risk.`
              : "Switch views or chains to see more."}
          </Empty>
        )}
        <LayoutGroup>
          <ul>
            {rows.map((s) => <Row key={key(s.chainId, s.token)} s={s} extra={extras.get(key(s.chainId, s.token))} />)}
          </ul>
        </LayoutGroup>
      </div>
    </div>
  );
}

function Row({ s, extra }: { s: ScoreRow; extra: Opportunity | undefined }) {
  const m = s.metrics as unknown as BoardMetrics;
  const opps = s.signals.filter((x) => x.kind === "opportunity").sort((a, b) => b.points - a.points);
  const risks = s.signals.filter((x) => x.kind === "risk");
  const net = m.w15m.buyUsd - m.w15m.sellUsd;
  const chain = CHAINS[s.chainId];
  return (
    <motion.li layout="position" transition={{ type: "spring", stiffness: 420, damping: 38 }} className="border-b border-line last:border-b-0">
      <Link to={`/token/${s.chainId}/${s.token}`} className="block px-4 py-3 transition-colors hover:bg-raised/50">
        <div className="grid grid-cols-[48px_1fr_auto] items-center gap-x-4 gap-y-1 lg:grid-cols-[48px_minmax(160px,1.4fr)_minmax(110px,1fr)_96px_90px_minmax(110px,0.9fr)_minmax(120px,1fr)]">
          <Iris score={s.score} verdict={s.verdict} size={42} />
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <span className="truncate font-display text-[16px] font-semibold">{m.symbol ? `$${m.symbol}` : shortAddr(s.token)}</span>
              <span className="text-[12px] text-muted">{chain?.short}</span>
            </div>
            <p className="truncate text-[12px] text-faint">{extra?.name ?? shortAddr(s.token)} · {age(m.ageSec)} old</p>
          </div>
          <div className="num text-right text-[13.5px] lg:text-left">{price(m.priceUsd)}</div>
          <div className="hidden lg:block"><Sparkline points={extra?.spark ?? []} width={88} height={26} /></div>
          <div className="num hidden text-[13.5px] lg:block">{usd(m.liquidityUsd)}</div>
          <div className="hidden text-[13.5px] lg:block">
            <Tip content={`${m.w15m.organicBuyers} independent of ${m.w15m.buyers} buyers (excludes bots and wallets sharing a funder); ${m.w15m.freshBuyers} brand-new wallets`}>
              <span><span className="num">{m.w15m.organicBuyers}</span><span className="text-faint"> / {m.w15m.buyers}</span></span>
            </Tip>
          </div>
          <div className={cn("num hidden text-[13.5px] lg:block", net > 0 ? "text-gain" : net < 0 ? "text-loss" : "text-muted")}>{usd(net, { sign: true })}</div>
        </div>
        {(opps.length > 0 || risks.length > 0) && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-[64px] text-[12.5px]">
            {opps.slice(0, 3).map((o) => <span key={o.id} className="text-muted">{o.title}</span>).reduce<React.ReactNode[]>((acc, el, i) => (i ? [...acc, <span key={`sep${i}`} className="text-faint">/</span>, el] : [el]), [])}
            {risks.map((r) => <Badge key={r.id} tone={r.severity === "critical" ? "loss" : "warn"}>{r.title}</Badge>)}
          </div>
        )}
        {s.verdict !== "alert" && s.verdict !== "high_conviction" && s.gate && opps.length === 0 && risks.length === 0 && (
          <p className="mt-1.5 pl-[64px] text-[12px] text-faint">{s.gate}</p>
        )}
      </Link>
    </motion.li>
  );
}
