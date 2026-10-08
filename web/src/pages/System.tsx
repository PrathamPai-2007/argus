import { Badge, Panel, Skeleton } from "@/components/ui.tsx";
import { ago, cn, usd } from "@/lib/format.ts";
import { useLive } from "@/lib/live.ts";

const STATUS_TONE: Record<string, "gain" | "warn" | "loss" | "neutral"> = { live: "gain", catching_up: "warn", starting: "neutral", degraded: "loss", stopped: "neutral" };

export function System() {
  const status = useLive((s) => s.status);
  const connection = useLive((s) => s.connection);
  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-[28px] font-bold tracking-tight md:text-[34px]">System</h1>
        <p className="mt-1 text-[13.5px] text-muted">
          Dashboard {connection === "live" ? "connected" : "reconnecting"}{status ? `, engine up since ${ago(status.startedAt)}` : ""}.
          {status && status.failedEvents > 0 && <span className="text-loss"> {status.failedEvents} event(s) failed to apply and are queued for review.</span>}
        </p>
      </div>
      {!status && <Skeleton className="h-64" />}
      <div className="grid gap-5 lg:grid-cols-2">
        {status?.chains.map((c) => (
          <Panel key={c.chainId} title={c.name} aside={<Badge tone={STATUS_TONE[c.status] ?? "neutral"}>{c.status.replace("_", " ")}</Badge>}>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 px-4 py-4 sm:grid-cols-3">
              <Item label="Head" value={c.head.toLocaleString("en-US")} />
              <Item label="Behind head" value={`${c.lag} block${c.lag === 1 ? "" : "s"}`} tone={c.lag > 10 ? "loss" : c.lag > 3 ? "warn" : undefined} />
              <Item label="Last block processed" value={c.lastBlockAt ? ago(c.lastBlockAt / 1000) : "—"} />
              <Item label={`${c.chainId === 1 ? "ETH" : "ETH (Base)"} price`} value={c.nativeUsd ? usd(c.nativeUsd) : "—"} />
              <Item label="Tokens watched" value={String(c.watchedTokens)} />
              <Item label="Pools tracked" value={String(c.pools)} />
              <Item label="Events applied" value={c.eventsApplied.toLocaleString("en-US")} />
              <Item label="Head stream" value={c.headStream} tone={c.headStream === "live" ? undefined : "warn"} />
              <Item label="Funder lookups" value={c.funderQueue === null ? "off" : `${c.funderQueue} queued`} hint={c.funderCoverage} />
            </dl>
            <div className="border-t border-line px-4 py-3">
              <p className="mb-2 text-[12px] text-faint">RPC endpoints, in failover order. {c.rpc.requests.toLocaleString("en-US")} requests carried {c.rpc.calls.toLocaleString("en-US")} calls; {c.rpc.failovers} failovers.</p>
              <ul className="space-y-1.5">
                {c.endpoints.map((e) => (
                  <li key={e.url} className="flex items-center gap-2 text-[13px]">
                    <span className={cn("size-2 rounded-full", e.healthy ? "bg-gain" : "bg-loss")} />
                    <span className="truncate font-mono text-[12px]">{e.url}</span>
                    {e.failures > 0 && <span className="ml-auto text-[12px] text-warn">{e.failures} recent failure{e.failures === 1 ? "" : "s"}</span>}
                  </li>
                ))}
              </ul>
            </div>
          </Panel>
        ))}
      </div>
    </div>
  );
}

function Item({ label, value, tone, hint }: { label: string; value: string; tone?: "warn" | "loss" | undefined; hint?: string }) {
  return (
    <div title={hint}>
      <dt className="text-[12px] text-faint">{label}</dt>
      <dd className={cn("num mt-0.5 text-[15px]", tone === "warn" && "text-warn", tone === "loss" && "text-loss")}>{value}</dd>
    </div>
  );
}
