import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { Activity, LineChart, Moon, Radar, Search, Server, Sun, Wallet } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { onAuthChange, signIn } from "@/lib/api.ts";
import { CHAINS, cn, shortAddr } from "@/lib/format.ts";
import { reconnectLive, useLive } from "@/lib/live.ts";
import { Link, navigate, usePath } from "@/lib/router.tsx";
import type { AlertRow } from "@/lib/types.ts";
import { Iris } from "./Iris.tsx";
import { Button, Tip } from "./ui.tsx";

const NAV = [
  { to: "/", label: "Opportunities", icon: Radar },
  { to: "/track-record", label: "Track record", icon: LineChart },
  { to: "/activity", label: "Activity", icon: Activity },
  { to: "/wallets", label: "Wallets", icon: Wallet },
  { to: "/system", label: "System", icon: Server },
];

function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <circle cx="16" cy="16" r="12.5" fill="none" stroke="var(--amber)" strokeWidth="3" />
      <circle cx="16" cy="16" r="5" fill="var(--amber)" />
    </svg>
  );
}

function ChainPulse() {
  const status = useLive((s) => s.status);
  const connection = useLive((s) => s.connection);
  return (
    <div className="space-y-2">
      {(status?.chains ?? []).map((c) => {
        const healthy = connection === "live" && (c.status === "live" || c.status === "catching_up") && c.lag <= 5;
        return (
          <Tip key={c.chainId} side="right" content={`${c.name}: ${c.status.replace("_", " ")}, ${c.lag} block${c.lag === 1 ? "" : "s"} behind head, ${c.watchedTokens} tokens watched`}>
            <div className="flex items-center gap-2.5 text-[12.5px] text-muted">
              <span className="relative flex size-2">
                {healthy && <span className="absolute inline-flex size-full animate-ping rounded-full bg-gain opacity-40" />}
                <span className={cn("relative inline-flex size-2 rounded-full", healthy ? "bg-gain" : c.status === "degraded" ? "bg-loss" : "bg-warn")} />
              </span>
              <span className="hidden lg:inline">{c.name}</span>
              <span className="num ml-auto hidden text-faint lg:inline">#{c.cursor.toLocaleString("en-US")}</span>
            </div>
          </Tip>
        );
      })}
      {connection !== "live" && <p className="hidden text-[12px] text-warn lg:block">Reconnecting to Argus…</p>}
    </div>
  );
}

function useTheme(): [boolean, () => void] {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  return [dark, () => {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    try { localStorage.setItem("argus-theme", next ? "dark" : "light"); } catch { /* private mode */ }
    setDark(next);
  }];
}

function Palette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const scores = useLive((s) => s.scores);
  const version = useLive((s) => s.scoreVersion);
  const [query, setQuery] = useState("");
  const tokens = useMemo(() => [...scores.values()].sort((a, b) => b.score - a.score).slice(0, 400), [scores, version]);
  const go = (to: string) => {
    onOpenChange(false);
    setQuery("");
    navigate(to);
  };
  const asAddress = /^0x[0-9a-fA-F]{40}$/.test(query.trim()) ? query.trim().toLowerCase() : null;
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]" />
        <DialogPrimitive.Content className="fixed left-1/2 top-[15vh] z-50 w-[min(560px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-xl border border-line bg-surface shadow-2xl outline-none">
          <DialogPrimitive.Title className="sr-only">Find a token</DialogPrimitive.Title>
          <Command loop className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-[12px] [&_[cmdk-group-heading]]:text-faint">
            <div className="flex items-center gap-2 border-b border-line px-4">
              <Search className="size-4 text-muted" />
              <Command.Input value={query} onValueChange={setQuery} placeholder="Search by symbol or paste a token address" className="h-12 flex-1 bg-transparent text-[14px] outline-none placeholder:text-faint" />
            </div>
            <Command.List className="max-h-[50vh] overflow-y-auto p-1.5">
              <Command.Empty className="px-3 py-6 text-center text-[13px] text-muted">No watched token matches. Paste a full address to open it.</Command.Empty>
              {asAddress && (
                <Command.Group heading="Open address">
                  {Object.entries(CHAINS).map(([id, c]) => (
                    <Command.Item key={id} value={`open ${id} ${asAddress}`} onSelect={() => go(`/token/${id}/${asAddress}`)} className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-[13.5px] aria-selected:bg-raised">
                      {shortAddr(asAddress)} on {c.name}
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              <Command.Group heading="Tokens">
                {tokens.map((t) => (
                  <Command.Item key={`${t.chainId}:${t.token}`} value={`${String(t.metrics["symbol"] ?? "")} ${t.token} ${CHAINS[t.chainId]?.name ?? ""}`} onSelect={() => go(`/token/${t.chainId}/${t.token}`)} className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 aria-selected:bg-raised">
                    <Iris score={t.score} verdict={t.verdict} size={26} showLabel={false} />
                    <span className="font-medium">{String(t.metrics["symbol"] ?? shortAddr(t.token))}</span>
                    <span className="text-[12px] text-muted">{CHAINS[t.chainId]?.short}</span>
                    <span className="num ml-auto text-[12.5px] text-muted">{t.score}</span>
                  </Command.Item>
                ))}
              </Command.Group>
              <Command.Group heading="Go to">
                {NAV.map((n) => (
                  <Command.Item key={n.to} value={`go ${n.label}`} onSelect={() => go(n.to)} className="flex cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 text-[13.5px] aria-selected:bg-raised">
                    <n.icon className="size-4 text-muted" /> {n.label}
                  </Command.Item>
                ))}
              </Command.Group>
            </Command.List>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function AlertToast() {
  const lastId = useLive((s) => s.lastAlertId);
  const alerts = useLive((s) => s.alerts);
  const [shown, setShown] = useState<AlertRow | null>(null);
  const seen = useRef<number | null>(null);
  useEffect(() => {
    if (lastId === null || lastId === seen.current) return;
    seen.current = lastId;
    const a = alerts.find((x) => x.id === lastId) ?? null;
    setShown(a);
    const t = setTimeout(() => setShown(null), 7_000);
    return () => clearTimeout(t);
  }, [lastId, alerts]);
  return (
    <div className="pointer-events-none fixed right-4 top-4 z-50 w-[min(380px,calc(100vw-32px))]" aria-live="polite">
      <AnimatePresence>
        {shown && (
          <motion.div
            key={shown.id}
            initial={{ opacity: 0, y: -12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ type: "spring", stiffness: 380, damping: 30 }}
            className={cn("pointer-events-auto rounded-xl border bg-surface p-3.5 shadow-2xl", shown.kind === "exit" ? "border-loss/50" : "border-amber/50")}
            style={{ boxShadow: shown.kind === "exit" ? undefined : "0 0 0 1px var(--amber-soft), 0 12px 48px -12px var(--amber-soft)" }}
          >
            <Link to={`/token/${shown.chainId}/${shown.token}`} onClick={() => setShown(null)} className="flex gap-3">
              <Iris score={shown.score} verdict={shown.kind === "exit" ? "avoid" : shown.verdict} size={40} />
              <div className="min-w-0">
                <p className="text-[13px] text-muted">{shown.kind === "exit" ? "Exit warning" : shown.verdict === "high_conviction" ? "High-conviction opportunity" : "New opportunity"} on {CHAINS[shown.chainId]?.name}</p>
                <p className="font-display text-[17px] font-semibold leading-tight">{shown.symbol ? `$${shown.symbol}` : shortAddr(shown.token)}</p>
                <p className="mt-0.5 line-clamp-2 text-[12.5px] text-muted">{shown.headline}</p>
              </div>
            </Link>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function SignInGate() {
  const [needed, setNeeded] = useState(false);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => onAuthChange(setNeeded), []);
  return (
    <DialogPrimitive.Root open={needed}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-bg/80 backdrop-blur" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/3 z-50 w-[min(400px,calc(100vw-32px))] -translate-x-1/2 rounded-xl border border-line bg-surface p-6 shadow-2xl outline-none">
          <Mark className="mb-4 size-8" />
          <DialogPrimitive.Title className="font-display text-xl font-semibold">Sign in to Argus</DialogPrimitive.Title>
          <DialogPrimitive.Description className="mt-1 text-[13px] text-muted">This dashboard is protected. Enter the value of ARGUS_DASHBOARD_TOKEN from your .env.</DialogPrimitive.Description>
          <form
            className="mt-5 space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await signIn(token)) {
                setError(null);
                reconnectLive();
                location.reload();
              } else setError("That token doesn't match. Check ARGUS_DASHBOARD_TOKEN and try again.");
            }}
          >
            <input type="password" autoFocus value={token} onChange={(e) => setToken(e.target.value)} aria-label="Dashboard token" className="h-10 w-full rounded-md border border-line bg-bg px-3 outline-none focus:border-focus" />
            {error && <p className="text-[12.5px] text-loss">{error}</p>}
            <Button variant="primary" className="w-full" type="submit">Sign in</Button>
          </form>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const path = usePath();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [dark, toggleTheme] = useTheme();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const active = (to: string) => (to === "/" ? path === "/" || path.startsWith("/token") : path.startsWith(to));

  return (
    <div className="flex min-h-full">
      <aside className="fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-surface/95 backdrop-blur md:sticky md:top-0 md:h-screen md:w-16 md:flex-col md:border-r md:border-t-0 md:bg-transparent lg:w-56">
        <Link to="/" className="hidden items-center gap-2.5 px-5 pb-6 pt-5 md:flex">
          <Mark className="size-6 shrink-0" />
          <span className="hidden font-display text-[19px] font-bold tracking-tight lg:inline">Argus</span>
        </Link>
        <nav className="flex flex-1 justify-around md:flex-col md:justify-start md:gap-0.5 md:px-2.5" aria-label="Main">
          {NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              aria-current={active(n.to) ? "page" : undefined}
              className={cn(
                "flex flex-col items-center gap-0.5 rounded-lg px-3 py-2 text-[11px] text-muted transition-colors hover:text-text md:flex-row md:gap-2.5 md:text-[13.5px]",
                active(n.to) && "text-text md:bg-raised",
              )}
            >
              <n.icon className={cn("size-[18px]", active(n.to) && "text-amber")} />
              <span className="md:hidden lg:inline">{n.label}</span>
            </Link>
          ))}
        </nav>
        <div className="hidden px-5 pb-5 md:block">
          <ChainPulse />
        </div>
      </aside>

      <div className="min-w-0 flex-1 pb-20 md:pb-0">
        <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-line bg-bg/85 px-4 py-2.5 backdrop-blur md:px-8">
          <button onClick={() => setPaletteOpen(true)} className="flex h-9 w-full max-w-sm items-center gap-2 rounded-lg border border-line bg-surface px-3 text-[13px] text-faint transition-colors hover:border-muted/60">
            <Search className="size-4" />
            Find a token
            <kbd className="ml-auto hidden rounded border border-line px-1.5 text-[11px] text-muted sm:inline">Ctrl K</kbd>
          </button>
          <div className="ml-auto flex items-center gap-1">
            <Tip content={dark ? "Switch to light theme" : "Switch to dark theme"}>
              <Button size="icon" onClick={toggleTheme} aria-label="Toggle theme">{dark ? <Sun /> : <Moon />}</Button>
            </Tip>
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1400px] px-4 py-6 md:px-8">{children}</main>
      </div>

      <Palette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <AlertToast />
      <SignInGate />
    </div>
  );
}
