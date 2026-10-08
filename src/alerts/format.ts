import { chainInfo } from "../chains.ts";
import type { AlertPayload } from "../db.ts";
import type { Position } from "../positions.ts";
import type { Assessment } from "../signals.ts";
import type { TokenMetrics } from "../state.ts";

// Human-facing text: number formatting, alert payloads and Telegram HTML.

export function formatUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

/** Token price with enough significant digits for micro-caps ($0.0₅1234 style collapsed to plain). */
export function formatPrice(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
  return `$${n.toPrecision(4)}`;
}

export function formatPct(r: number | null | undefined, digits = 1): string {
  if (r === null || r === undefined || !Number.isFinite(r)) return "—";
  return `${r >= 0 ? "+" : ""}${(r * 100).toFixed(digits)}%`;
}

export function formatAge(secs: number): string {
  if (secs < 3600) return `${Math.max(1, Math.round(secs / 60))}m`;
  if (secs < 86_400) return `${(secs / 3600).toFixed(1)}h`;
  return `${(secs / 86_400).toFixed(1)}d`;
}

export function tokenLinks(chainId: number, token: string, dashboardPort: number): Record<string, string> {
  const info = chainInfo(chainId);
  return {
    dexscreener: `https://dexscreener.com/${info.dexscreener}/${token}`,
    explorer: `${info.explorer}/token/${token}`,
    dashboard: `http://127.0.0.1:${dashboardPort}/token/${chainId}/${token}`,
  };
}

/** USD price of one whole token, when decimals are known. */
export function wholeTokenUsd(unitUsd: number | null, decimals: number | null): number | null {
  return unitUsd === null || decimals === null ? null : unitUsd * 10 ** decimals;
}

export function buildAlertPayload(
  kind: AlertPayload["kind"],
  a: Assessment,
  m: TokenMetrics,
  decimals: number | null,
  dashboardPort: number,
): AlertPayload {
  const opps = a.signals.filter((s) => s.kind === "opportunity").sort((x, y) => y.points - x.points);
  const risks = a.signals.filter((s) => s.kind === "risk");
  const headline = kind === "exit"
    ? risks.filter((s) => s.severity === "critical").map((s) => s.title).join(" · ") || "Critical risk detected"
    : opps.slice(0, 2).map((s) => s.title).join(" · ");
  return {
    chainId: a.chainId,
    token: a.token,
    kind,
    verdict: a.verdict,
    score: a.score,
    symbol: m.symbol,
    headline,
    signals: a.signals,
    priceUsd: wholeTokenUsd(m.priceUnitUsd, decimals),
    liquidityUsd: m.liquidityUsd,
    ageSec: m.ageSec,
    links: tokenLinks(a.chainId, a.token, dashboardPort),
  };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function telegramAlert(p: AlertPayload, id: number, confirmed: boolean): string {
  const chain = chainInfo(p.chainId).name;
  const name = p.symbol ? `$${esc(p.symbol)}` : esc(p.token.slice(0, 10));
  const title = p.kind === "exit"
    ? `⚠️ <b>EXIT WARNING</b> · ${name} · ${chain}`
    : `${p.verdict === "high_conviction" ? "🟢" : "🔵"} <b>${p.verdict === "high_conviction" ? "HIGH CONVICTION" : "OPPORTUNITY"} ${p.score}/100</b> · ${name} · ${chain}`;
  const opps = p.signals.filter((s) => s.kind === "opportunity");
  const risks = p.signals.filter((s) => s.kind === "risk");
  return [
    `${title}${confirmed ? "" : " <i>(unconfirmed)</i>"}`,
    `<b>${esc(p.headline)}</b>`,
    "",
    `Price ${formatPrice(p.priceUsd)} · Liquidity ${formatUsd(p.liquidityUsd)} · Age ${formatAge(p.ageSec)}`,
    ...(opps.length ? ["", ...opps.map((s) => `✅ ${esc(s.title)}`)] : []),
    ...(risks.length ? risks.map((s) => `${s.severity === "critical" ? "⛔" : "⚠️"} ${esc(s.title)}`) : ["🛡 No risk flags"]),
    "",
    `<code>${esc(p.token)}</code>`,
    `<a href="${esc(p.links["dexscreener"] ?? "")}">DexScreener</a> · <a href="${esc(p.links["explorer"] ?? "")}">Explorer</a> · <a href="${esc(p.links["dashboard"] ?? "")}">Argus</a> · #${id}`,
  ].join("\n");
}

export function telegramOutcome(pos: Position, symbol: string | null): string {
  const peak = pos.peakUnitUsd / pos.entryUnitUsd;
  const r = pos.returns;
  return [
    `📊 <b>24h result</b> · ${symbol ? `$${esc(symbol)}` : esc(pos.token.slice(0, 10))} · alert #${pos.alertId ?? "—"}`,
    `1h ${formatPct(r.h1)} · 6h ${formatPct(r.h6)} · 24h ${formatPct(r.h24)}`,
    `Peak ${peak.toFixed(2)}× · Trough ${formatPct(pos.troughUnitUsd / pos.entryUnitUsd - 1)}`,
  ].join("\n");
}
