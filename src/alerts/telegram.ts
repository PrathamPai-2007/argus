import { log } from "../logger.ts";

// Telegram = one fetch POST to api.telegram.org — no SDK.

export interface AlertSink {
  name: string;
  sendText(html: string): Promise<void>;
}

export class TelegramSink implements AlertSink {
  name = "telegram";
  private base: string;

  constructor(botToken: string, private chatId: string) {
    this.base = `https://api.telegram.org/bot${botToken}`;
  }

  async sendText(html: string): Promise<void> {
    const res = await fetch(`${this.base}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: this.chatId, text: html, parse_mode: "HTML", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`telegram sendMessage failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
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
    log.debug("telegram probe failed", { err });
    return { ok: false, error: String(err) };
  }
}
