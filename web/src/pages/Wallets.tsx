import { ArrowUpRight } from "lucide-react";
import { useState } from "react";
import { Badge, Button, Empty, ErrorNote, Panel, Segmented, Sheet, Skeleton } from "@/components/ui.tsx";
import { useQuery } from "@/lib/api.ts";
import { ago, CHAINS, cn, shortAddr, usd } from "@/lib/format.ts";
import { Link } from "@/lib/router.tsx";
import type { WalletStats } from "@/lib/types.ts";

interface WalletDetail {
  stats: WalletStats | null;
  positions: Array<{ token: string; bought: number; sold: number; cost_usd: number; proceeds_usd: number; buys: number; sells: number; first_at: number; last_at: number }>;
  funding: { funder: string | null; funderIsService: boolean } | null;
  cluster: string;
}

export function WalletSheet({ chainId, address, onClose }: { chainId: number; address: string | null; onClose: () => void }) {
  const { data } = useQuery<WalletDetail>(address ? `/api/wallets/${chainId}/${address}` : null);
  const chain = CHAINS[chainId];
  return (
    <Sheet open={address !== null} onOpenChange={(o) => !o && onClose()} title={address ? shortAddr(address) : ""}>
      {!data ? <Skeleton className="h-40" /> : (
        <div className="space-y-5">
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" variant="outline"><a href={`${chain?.explorer}/address/${address}`} target="_blank" rel="noreferrer">View on explorer <ArrowUpRight /></a></Button>
            {data.funding?.funder ? (
              <Badge tone={data.funding.funderIsService ? "neutral" : "warn"}>funded by {data.funding.funderIsService ? "an exchange or service" : shortAddr(data.funding.funder)}</Badge>
            ) : <Badge>funder not resolved yet</Badge>}
          </div>
          {data.stats ? (
            <dl className="grid grid-cols-3 gap-3">
              <div><dt className="text-[12px] text-faint">Realized PnL</dt><dd className={cn("num text-[18px] font-medium", data.stats.realizedPnlUsd >= 0 ? "text-gain" : "text-loss")}>{usd(data.stats.realizedPnlUsd, { sign: true })}</dd></div>
              <div><dt className="text-[12px] text-faint">Win rate</dt><dd className="num text-[18px] font-medium">{data.stats.closedTrades ? `${Math.round(data.stats.winRate * 100)}%` : "—"}</dd></div>
              <div><dt className="text-[12px] text-faint">Closed trades</dt><dd className="num text-[18px] font-medium">{data.stats.closedTrades}</dd></div>
            </dl>
          ) : <p className="text-[13px] text-muted">No finalized trades on watched tokens yet.</p>}
          {data.positions.length > 0 && (
            <table className="w-full text-[13px]">
              <thead className="text-left text-[12px] text-faint"><tr><th className="py-1.5 font-normal">Token</th><th className="py-1.5 text-right font-normal">In</th><th className="py-1.5 text-right font-normal">Out</th><th className="py-1.5 text-right font-normal">Last</th></tr></thead>
              <tbody className="divide-y divide-line">
                {data.positions.map((p) => (
                  <tr key={p.token}>
                    <td className="py-2"><Link to={`/token/${chainId}/${p.token}`} onClick={onClose} className="font-mono text-[12px] hover:text-amber">{shortAddr(p.token)}</Link></td>
                    <td className="num py-2 text-right">{usd(p.cost_usd)}</td>
                    <td className={cn("num py-2 text-right", p.proceeds_usd >= p.cost_usd ? "text-gain" : "text-muted")}>{usd(p.proceeds_usd)}</td>
                    <td className="py-2 text-right text-faint">{ago(p.last_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </Sheet>
  );
}

export function Wallets() {
  const [chain, setChain] = useState<"all" | "1" | "8453">("all");
  const { data, error, reload } = useQuery<WalletStats[]>(`/api/wallets${chain === "all" ? "" : `?chain=${chain}`}`, { refreshMs: 60_000 });
  const [selected, setSelected] = useState<{ chainId: number; address: string } | null>(null);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-[28px] font-bold tracking-tight md:text-[34px]">Wallets</h1>
          <p className="mt-1 max-w-2xl text-[13.5px] text-muted">Realized results of every wallet that traded tokens Argus watched, from finalized blocks only. Wallets with a strong record count as proven buyers in the scoring.</p>
        </div>
        <Segmented label="Chain" value={chain} onChange={setChain} options={[{ value: "all", label: "All chains" }, { value: "1", label: "Ethereum" }, { value: "8453", label: "Base" }]} />
      </div>
      {error && <ErrorNote message={error} onRetry={reload} />}
      <Panel>
        {!data && !error && <Skeleton className="m-4 h-40" />}
        {data && data.length === 0 && <Empty title="No track records yet">Wallets appear after they close a few trades on watched tokens. Running with --rewind seeds history faster.</Empty>}
        {data && data.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-[13px]">
              <thead className="text-left text-[12px] text-faint">
                <tr><th className="px-4 py-2 font-normal">Wallet</th><th className="px-2 py-2 text-right font-normal">Realized PnL</th><th className="px-2 py-2 text-right font-normal">Win rate</th><th className="px-2 py-2 text-right font-normal">Closed</th><th className="px-2 py-2 text-right font-normal">Volume</th><th className="px-4 py-2 text-right font-normal">Last trade</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.map((w) => (
                  <tr key={`${w.chainId}:${w.wallet}`} className="cursor-pointer hover:bg-raised/50" onClick={() => setSelected({ chainId: w.chainId, address: w.wallet })}>
                    <td className="px-4 py-2.5"><span className="font-mono text-[12px]">{shortAddr(w.wallet)}</span> <span className="ml-1 text-[12px] text-faint">{CHAINS[w.chainId]?.short}</span></td>
                    <td className={cn("num px-2 py-2.5 text-right", w.realizedPnlUsd >= 0 ? "text-gain" : "text-loss")}>{usd(w.realizedPnlUsd, { sign: true })}</td>
                    <td className="num px-2 py-2.5 text-right">{Math.round(w.winRate * 100)}%</td>
                    <td className="num px-2 py-2.5 text-right">{w.closedTrades}</td>
                    <td className="num px-2 py-2.5 text-right text-muted">{usd(w.volumeUsd)}</td>
                    <td className="px-4 py-2.5 text-right text-faint">{ago(w.lastAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <WalletSheet chainId={selected?.chainId ?? 1} address={selected?.address ?? null} onClose={() => setSelected(null)} />
    </div>
  );
}
