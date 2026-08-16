import { log } from "../logger.ts";
import type { AlertPayload } from "../types.ts";

// Telegram = one fetch POST to api.telegram.org — no SDK (PLAN.md §8).

export interface AlertSink {
  name: string;
  send(payload: AlertPayload, alertId: number, confirmed?: boolean): Promise<void>;
  sendText(text: string): Promise<void>;
}

const CHAIN_SLUGS: Record<number, { dex: string; bubblemaps: string; name: string }> = {
  1: { dex: "ethereum", bubblemaps: "eth", name: "Ethereum" },
  56: { dex: "bsc", bubblemaps: "bsc", name: "BNB Chain" },
  8453: { dex: "base", bubblemaps: "base", name: "Base" },
};

export function chainSlug(chainId: number): { dex: string; bubblemaps: string; name: string } {
  return CHAIN_SLUGS[chainId] ?? { dex: String(chainId), bubblemaps: String(chainId), name: `chain ${chainId}` };
}

export function buildAlertLinks(chainId: number, token: string, dashboardPort: number): AlertPayload["links"] {
  const slug = chainSlug(chainId);
  return {
    dexscreener: `https://dexscreener.com/${slug.dex}/${token}`,
    bubblemaps: `https://app.bubblemaps.io/${slug.bubblemaps}/token/${token}`,
    dashboard: `http://127.0.0.1:${dashboardPort}/api/token/${chainId}/${token}`,
  };
}

const SEVERITY_EMOJI: Record<string, string> = { info: "ℹ️", alert: "⚠️", critical: "🚨" };

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatAlertMessage(p: AlertPayload, alertId: number, confirmed: boolean): string {
  const emoji = SEVERITY_EMOJI[p.severity] ?? "🔔";
  const chain = chainSlug(p.chainId);
  const lines = [
    `${emoji} <b>ARGUS — ${p.severity.toUpperCase()} (${p.score}/100)</b>${confirmed ? "" : " <i>(unconfirmed)</i>"}`,
    "",
    `<b>Token:</b> <code>${esc(p.tokenAddress)}</code>`,
    `<b>Chain:</b> ${esc(chain.name)}`,
    `<b>Finding:</b> ${esc(p.headline)}`,
    "<b>Evidence:</b>",
    ...p.lines.map((l) => ` • ${esc(l)}`),
    "",
    `<a href="${esc(p.links.dexscreener)}">DEXScreener</a> · <a href="${esc(p.links.bubblemaps)}">Bubblemaps</a> · <a href="${esc(p.links.dashboard)}">Dashboard</a>`,
    `<i>alert #${alertId}</i>`,
  ];
  return lines.join("\n");
}

export function formatPerformanceOutcomeMessage(s: {
  outcome: string;
  token_address: string;
  chain_id: number;
  entry_price: bigint;
  current_price: bigint;
  alert_id: number;
}): string {
  const chain = chainSlug(s.chain_id);
  const entry = Number(s.entry_price) / 1e18;
  const current = Number(s.current_price) / 1e18;
  const pct = entry > 0 ? (((current - entry) / entry) * 100).toFixed(2) : "0.00";
  const sign = Number(pct) >= 0 ? "+" : "";

  let emoji = "⏱️";
  let title = "PERFORMANCE WATCH EXPIRED (12h)";
  if (s.outcome === "target_hit") {
    emoji = "🎯";
    title = "TAKE PROFIT TARGET HIT (+50%)";
  } else if (s.outcome === "stop_hit") {
    emoji = "🛑";
    title = "STOP LOSS HIT (-20%)";
  }

  return [
    `${emoji} <b>ARGUS — ${title}</b>`,
    "",
    `<b>Token:</b> <code>${esc(s.token_address)}</code>`,
    `<b>Chain:</b> ${esc(chain.name)}`,
    `<b>Return:</b> ${sign}${pct}%`,
    `<b>Entry price:</b> $${entry > 0 ? entry.toFixed(6) : "—"}`,
    `<b>Final price:</b> $${current > 0 ? current.toFixed(6) : "—"}`,
    "",
    `<i>linked to alert #${s.alert_id}</i>`,
  ].join("\n");
}

export class TelegramSink implements AlertSink {
  name = "telegram";
  private base: string;

  constructor(
    botToken: string,
    private chatId: string,
  ) {
    this.base = `https://api.telegram.org/bot${botToken}`;
  }

  async send(payload: AlertPayload, alertId: number, confirmed = true): Promise<void> {
    await this.sendText(formatAlertMessage(payload, alertId, confirmed));
  }

  async sendText(text: string): Promise<void> {
    const res = await fetch(`${this.base}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: this.chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`telegram sendMessage failed: ${res.status} ${body}`);
    }
  }
}

/** Verify a bot token (doctor). */
export async function probeTelegram(botToken: string): Promise<{ ok: boolean; username?: string; error?: string }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, { signal: AbortSignal.timeout(15_000) });
    const j = (await res.json()) as { ok: boolean; result?: { username?: string }; description?: string };
    if (j.ok) return j.result?.username ? { ok: true, username: j.result.username } : { ok: true };
    return { ok: false, error: j.description ?? `http ${res.status}` };
  } catch (err) {
    log.debug("telegram probe failed", { err: String(err) });
    return { ok: false, error: String(err) };
  }
}
