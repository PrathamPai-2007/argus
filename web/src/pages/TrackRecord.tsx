import { Bar, BarChart, CartesianGrid, Legend, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Badge, Empty, ErrorNote, Panel, Skeleton } from "@/components/ui.tsx";
import { useQuery } from "@/lib/api.ts";
import { ago, CHAINS, cn, pct, shortAddr } from "@/lib/format.ts";
import { useLive } from "@/lib/live.ts";
import { Link } from "@/lib/router.tsx";
import type { AlertRow, CohortStats, Horizon, TrackRecordResponse } from "@/lib/types.ts";
import { useQuery as useAlerts } from "@/lib/api.ts";

const HORIZONS: Array<[Horizon, string]> = [["m15", "15 min"], ["h1", "1 hour"], ["h6", "6 hours"], ["h24", "24 hours"]];

function Headline({ alerts, baseline }: { alerts: CohortStats; baseline: CohortStats }) {
  const a = alerts.median.h1;
  const b = baseline.median.h1;
  if (alerts.count === 0) return <p className="text-[14px] text-muted">No alerts have fired yet. Every alert is paper-traded from the moment it fires, next to a baseline of liquid tokens that never alerted.</p>;
  if (a === null || b === null) return <p className="text-[14px] text-muted">{alerts.count} alert{alerts.count === 1 ? "" : "s"} so far; returns appear once positions are an hour old.</p>;
  const edge = a - b;
  return (
    <p className="max-w-3xl text-[15px] leading-relaxed">
      After one hour, the median alert is <b className={a >= 0 ? "text-gain" : "text-loss"}>{pct(a)}</b> against <b className={b >= 0 ? "text-gain" : "text-loss"}>{pct(b)}</b> for comparable tokens that never alerted:{" "}
      {edge >= 0 ? <>an edge of <b className="text-amber">{pct(edge)}</b></> : <>no edge yet (<b className="text-loss">{pct(edge)}</b>)</>} across {alerts.count} alert{alerts.count === 1 ? "" : "s"} and {baseline.count} baseline token{baseline.count === 1 ? "" : "s"}.
    </p>
  );
}

function Metric({ label, a, b, format }: { label: string; a: number | null; b: number | null; format: (n: number | null) => string }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3.5">
      <p className="text-[12.5px] text-muted">{label}</p>
      <p className="num mt-1 font-display text-[24px] font-semibold text-amber">{format(a)}</p>
      <p className="num text-[12px] text-faint">baseline {format(b)}</p>
    </div>
  );
}

export function TrackRecord() {
  const { data, error, reload } = useQuery<TrackRecordResponse>("/api/track-record", { refreshMs: 30_000 });
  const alertsQ = useAlerts<AlertRow[]>("/api/alerts?limit=100", { refreshMs: 30_000 });
  const liveAlerts = useLive((s) => s.alerts);
  const alerts = [...liveAlerts, ...(alertsQ.data ?? []).filter((a) => !liveAlerts.some((l) => l.id === a.id))];
  const byAlert = new Map((data?.recent ?? []).filter((p) => p.alertId !== null).map((p) => [p.alertId!, p]));

  if (error) return <ErrorNote message={error} onRetry={reload} />;
  const s = data?.summary;
  const chart = s ? HORIZONS.map(([h, label]) => ({ label, alerts: s.alerts.median[h] === null ? null : s.alerts.median[h]! * 100, baseline: s.baseline.median[h] === null ? null : s.baseline.median[h]! * 100 })) : [];
  const ratio = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-[28px] font-bold tracking-tight md:text-[34px]">Track record</h1>
        <div className="mt-2">{s ? <Headline alerts={s.alerts} baseline={s.baseline} /> : <Skeleton className="h-6 w-2/3" />}</div>
      </div>

      {s && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Metric label="Up after 1 hour" a={s.alerts.winRate1h} b={s.baseline.winRate1h} format={ratio} />
          <Metric label="Doubled at some point" a={s.alerts.hit2x} b={s.baseline.hit2x} format={ratio} />
          <Metric label="Median peak" a={s.alerts.medianPeak} b={s.baseline.medianPeak} format={(n) => (n === null ? "—" : `${n.toFixed(2)}×`)} />
        </div>
      )}

      <Panel title="Median return by holding time" aside="alerts vs. tokens that never alerted">
        <div className="h-[280px] px-2 py-4">
          {!s ? <Skeleton className="h-full" /> : (
            <ResponsiveContainer>
              <BarChart data={chart} barGap={4} margin={{ left: 0, right: 12 }}>
                <CartesianGrid vertical={false} stroke="var(--line)" />
                <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: "var(--muted)", fontSize: 12 }} />
                <YAxis tickLine={false} axisLine={false} tick={{ fill: "var(--muted)", fontSize: 12 }} tickFormatter={(v: number) => `${v}%`} width={48} />
                <ReferenceLine y={0} stroke="var(--faint)" />
                <Tooltip cursor={{ fill: "var(--raised)" }} contentStyle={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 8, fontSize: 12.5 }} formatter={(v) => `${Number(v).toFixed(1)}%`} />
                <Legend wrapperStyle={{ fontSize: 12.5, color: "var(--muted)" }} />
                <Bar dataKey="alerts" name="Alerts" fill="var(--amber)" radius={[4, 4, 0, 0]} />
                <Bar dataKey="baseline" name="Baseline" fill="var(--faint)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </Panel>

      {s && s.alerts.count > 0 && (
        <Panel title="By score at alert time">
          <div className="grid divide-y divide-line sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            {s.byScore.map((b) => (
              <div key={b.bucket} className="px-4 py-3">
                <p className="text-[12.5px] text-muted">Score {b.bucket} <span className="text-faint">· {b.stats.count}</span></p>
                <p className="num mt-1 text-[18px]">{pct(b.stats.median.h1)} <span className="text-[12.5px] text-faint">median 1h</span></p>
              </div>
            ))}
          </div>
        </Panel>
      )}

      <Panel title="Alerts" aside={alerts.length ? `${alerts.length} most recent` : null}>
        {alerts.length === 0 ? (
          <Empty title="No alerts yet">They appear here and on Telegram the moment a token clears the bar.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-[13px]">
              <thead className="text-left text-[12px] text-faint">
                <tr>
                  <th className="px-4 py-2 font-normal">Token</th><th className="px-2 py-2 font-normal">Why</th><th className="px-2 py-2 font-normal">Fired</th>
                  <th className="px-2 py-2 text-right font-normal">15m</th><th className="px-2 py-2 text-right font-normal">1h</th><th className="px-2 py-2 text-right font-normal">24h</th><th className="px-4 py-2 text-right font-normal">Peak</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {alerts.map((a) => {
                  const p = byAlert.get(a.id);
                  return (
                    <tr key={a.id} className={cn("hover:bg-raised/50", a.retracted && "opacity-50")}>
                      <td className="px-4 py-2.5">
                        <Link to={`/token/${a.chainId}/${a.token}`} className="font-medium hover:text-amber">{a.symbol ? `$${a.symbol}` : shortAddr(a.token)}</Link>
                        <span className="ml-1.5 text-[12px] text-faint">{CHAINS[a.chainId]?.short}</span>
                        {a.kind === "exit" && <Badge tone="loss" className="ml-2">exit</Badge>}
                        {a.retracted && <Badge className="ml-2">retracted</Badge>}
                      </td>
                      <td className="max-w-[340px] truncate px-2 py-2.5 text-muted">{a.headline}</td>
                      <td className="px-2 py-2.5 text-muted">{ago(a.createdAt)}</td>
                      {(["m15", "h1", "h24"] as const).map((h) => (
                        <td key={h} className={cn("num px-2 py-2.5 text-right", !p || p.returns[h] === null ? "text-faint" : p.returns[h]! >= 0 ? "text-gain" : "text-loss")}>{p ? pct(p.returns[h]) : "—"}</td>
                      ))}
                      <td className="num px-4 py-2.5 text-right">{p ? `${(p.peakUnitUsd / p.entryUnitUsd).toFixed(2)}×` : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
