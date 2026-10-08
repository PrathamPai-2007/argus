import { Check, Minus, OctagonX, TriangleAlert } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { Empty, ErrorNote, Panel, Segmented, Skeleton } from "@/components/ui.tsx";
import { useQuery } from "@/lib/api.ts";
import { ago, CHAINS, cn, shortAddr } from "@/lib/format.ts";
import { useLive } from "@/lib/live.ts";
import { Link } from "@/lib/router.tsx";
import type { SignalLogRow } from "@/lib/types.ts";

export function ActivityPage() {
  const { data, error, reload } = useQuery<SignalLogRow[]>("/api/activity?limit=300");
  const live = useLive((s) => s.signals);
  const [kind, setKind] = useState<"all" | "opportunity" | "risk">("all");
  const rows = [...live, ...(data ?? []).filter((r) => !live.some((l) => l.id === r.id))].filter((r) => kind === "all" || r.kind === kind);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-[28px] font-bold tracking-tight md:text-[34px]">Activity</h1>
          <p className="mt-1 text-[13.5px] text-muted">Every time a signal fires, escalates or clears, with the numbers behind it.</p>
        </div>
        <Segmented label="Signal kind" value={kind} onChange={setKind} options={[{ value: "all", label: "All" }, { value: "opportunity", label: "Opportunity" }, { value: "risk", label: "Risk" }]} />
      </div>
      {error && <ErrorNote message={error} onRetry={reload} />}
      <Panel>
        {!data && !error && <Skeleton className="m-4 h-40" />}
        {data && rows.length === 0 && <Empty title="Quiet so far">Signals appear as watched tokens start trading.</Empty>}
        <ul className="divide-y divide-line">
          <AnimatePresence initial={false}>
            {rows.slice(0, 300).map((r) => {
              const Icon = r.change === "cleared" ? Minus : r.kind === "opportunity" ? Check : r.severity === "critical" ? OctagonX : TriangleAlert;
              const tone = r.change === "cleared" ? "text-faint" : r.kind === "opportunity" ? "text-gain" : r.severity === "critical" ? "text-loss" : "text-warn";
              return (
                <motion.li key={r.id} initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} className="flex items-start gap-3 px-4 py-3">
                  <Icon className={cn("mt-0.5 size-4 shrink-0", tone)} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className={cn("text-[13.5px]", r.change === "cleared" && "text-muted line-through decoration-faint")}>{r.title}</p>
                    <p className="mt-0.5 text-[12px] text-faint">
                      <Link to={`/token/${r.chainId}/${r.token}`} className="text-muted hover:text-amber">{String(r.evidence["symbol"] ?? shortAddr(r.token))}</Link>
                      {" on "}{CHAINS[r.chainId]?.name}, {r.change}{r.change === "escalated" ? ` to ${r.severity}` : ""}, block {r.block.toLocaleString("en-US")}
                    </p>
                  </div>
                  <span className="shrink-0 text-[12px] text-faint">{ago(r.at)}</span>
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ul>
      </Panel>
    </div>
  );
}
