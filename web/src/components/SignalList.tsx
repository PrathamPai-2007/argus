import { Check, OctagonX, TriangleAlert } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import type { Signal } from "@/lib/types.ts";
import { cn } from "@/lib/format.ts";

const EVIDENCE_LABELS: Record<string, string> = {
  independentBuyers: "independent buyers",
  netBuyUsd: "net inflow $",
  buySellRatio: "buy/sell",
  freshBuyers: "fresh wallets",
  smartWallets: "proven wallets",
  holdingPct: "% holding",
  earlyBuyers: "early buyers",
  growthPct: "liquidity growth %",
  growthX: "volume ×",
  traders: "traders",
  launchSupplyPct: "% bought at launch",
  largestFundedGroup: "share a funder",
  stillHeldPct: "% still held",
  clusterPct: "% in one cluster",
  clusterWallets: "wallets",
  removedPct: "% removed",
  distinctBuyers: "buyers",
  creatorSoldPct: "% sold by creator",
  topTraderSharePct: "% by one wallet",
};

function evidenceChips(e: Signal["evidence"]): Array<[string, string]> {
  return Object.entries(EVIDENCE_LABELS)
    .filter(([k]) => typeof e[k] === "number")
    .slice(0, 4)
    .map(([k, label]) => [label, (e[k] as number).toLocaleString("en-US", { maximumFractionDigits: 2 })]);
}

/** Opportunity checks and risk flags, each with the numbers that triggered it. */
export function SignalList({ signals, compact = false }: { signals: Signal[]; compact?: boolean }) {
  const sorted = [...signals].sort((a, b) => (a.kind === b.kind ? b.points - a.points : a.kind === "risk" ? 1 : -1));
  if (sorted.length === 0) {
    return <p className="px-4 py-6 text-[13px] text-muted">No signals yet. Argus scores a token once real trading starts.</p>;
  }
  return (
    <ul className="divide-y divide-line">
      <AnimatePresence initial={false}>
        {sorted.map((s) => {
          const Icon = s.kind === "opportunity" ? Check : s.severity === "critical" ? OctagonX : TriangleAlert;
          const tone = s.kind === "opportunity" ? "text-gain" : s.severity === "critical" ? "text-loss" : "text-warn";
          return (
            <motion.li key={s.id} layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex gap-3 px-4 py-3">
              <Icon className={cn("mt-0.5 size-4 shrink-0", tone)} aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-[13.5px] leading-snug">{s.title}</p>
                  <span className={cn("num shrink-0 text-[12.5px]", s.points > 0 ? "text-amber" : s.points < 0 ? "text-warn" : "text-loss")}>
                    {s.points > 0 ? `+${s.points}` : s.points < 0 ? s.points : "veto"}
                  </span>
                </div>
                {!compact && (
                  <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-muted">
                    {evidenceChips(s.evidence).map(([label, v]) => (
                      <span key={label}><span className="num text-text">{v}</span> {label}</span>
                    ))}
                  </div>
                )}
              </div>
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ul>
  );
}
