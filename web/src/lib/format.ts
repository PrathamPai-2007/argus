import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export const CHAINS: Record<number, { name: string; short: string; explorer: string; dexscreener: string }> = {
  1: { name: "Ethereum", short: "ETH", explorer: "https://etherscan.io", dexscreener: "ethereum" },
  8453: { name: "Base", short: "Base", explorer: "https://basescan.org", dexscreener: "base" },
};

export function usd(n: number | null | undefined, opts: { sign?: boolean } = {}): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const sign = opts.sign && n > 0 ? "+" : n < 0 ? "−" : "";
  const a = Math.abs(n);
  const body = a >= 1e9 ? `${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}k` : a.toFixed(0);
  return `${sign}$${body}`;
}

/** Token prices span 20 orders of magnitude; collapse leading zeros: $0.0₅1234. */
export function price(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1) return `$${n.toLocaleString("en-US", { maximumFractionDigits: n >= 100 ? 2 : 4 })}`;
  const s = n.toFixed(20);
  const zeros = /^0\.(0*)/.exec(s)?.[1]?.length ?? 0;
  const digits = s.slice(2 + zeros, 2 + zeros + 4).replace(/0+$/, "") || "0";
  if (zeros < 4) return `$0.${"0".repeat(zeros)}${digits}`;
  const sub = String(zeros).split("").map((d) => "₀₁₂₃₄₅₆₇₈₉"[Number(d)]).join("");
  return `$0.0${sub}${digits}`;
}

export function pct(r: number | null | undefined, digits = 1): string {
  if (r === null || r === undefined || !Number.isFinite(r)) return "—";
  return `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r * 100).toFixed(digits)}%`;
}

export function age(secs: number): string {
  if (secs < 60) return `${Math.max(0, Math.round(secs))}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  if (secs < 86_400) return `${(secs / 3600).toFixed(secs < 36_000 ? 1 : 0)}h`;
  return `${Math.round(secs / 86_400)}d`;
}

export function ago(unixSecs: number): string {
  return `${age(Date.now() / 1000 - unixSecs)} ago`;
}

export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export const VERDICT_LABEL: Record<string, string> = {
  high_conviction: "High conviction",
  alert: "Worth a look",
  watch: "Watching",
  avoid: "Avoid",
  quiet: "Quiet",
};
