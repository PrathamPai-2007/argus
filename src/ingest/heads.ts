import { log, redactUrl } from "../logger.ts";

// eth_subscribe("newHeads") over the runtime's native WebSocket. Heads are only
// a wake-up signal for ChainSync, so this stays tiny: rotate endpoints with
// backoff, and treat a silent-but-open socket as dead.

export type HeadStreamState = "connecting" | "live" | "down" | "stopped";

const SILENCE_MS = 60_000;

export class HeadStream {
  state: HeadStreamState = "connecting";
  lastHeadAt = 0;
  private ws: WebSocket | null = null;
  private idx = 0;
  private attempt = 0;
  private running = false;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;

  constructor(private urls: string[], private onHead: (blockNumber: number) => void, private label = "heads") {}

  start(): void {
    this.running = true;
    this.connect();
    this.watchdog = setInterval(() => {
      if (this.state === "live" && Date.now() - this.lastHeadAt > SILENCE_MS) {
        log.warn(`${this.label}: socket silent — reconnecting`, { endpoint: redactUrl(this.urls[this.idx] ?? "") });
        this.reconnect();
      }
    }, 10_000);
  }

  stop(): void {
    this.running = false;
    this.state = "stopped";
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.retry) clearTimeout(this.retry);
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    if (!this.running) return;
    const url = this.urls[this.idx % this.urls.length]!;
    this.state = "connecting";
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      log.warn(`${this.label}: connect failed`, { endpoint: redactUrl(url), err: String(err) });
      this.reconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["newHeads"] }));
    };
    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(String(msg.data)) as { id?: number; result?: unknown; error?: { message: string }; params?: { result?: { number?: string } } };
        if (data.id === 1) {
          if (data.error) throw new Error(data.error.message);
          this.state = "live";
          this.attempt = 0;
          this.lastHeadAt = Date.now();
          return;
        }
        const n = data.params?.result?.number;
        if (n) {
          this.lastHeadAt = Date.now();
          this.onHead(Number(BigInt(n)));
        }
      } catch (err) {
        log.warn(`${this.label}: bad message`, { err: String(err).slice(0, 200) });
        this.reconnect();
      }
    };
    ws.onclose = () => {
      if (this.ws === ws) this.reconnect();
    };
    ws.onerror = () => {
      if (this.ws === ws) this.reconnect();
    };
  }

  private reconnect(): void {
    const old = this.ws;
    this.ws = null;
    try { old?.close(); } catch { /* already closed */ }
    if (!this.running || this.retry) return;
    this.state = "down";
    this.idx++;
    this.attempt++;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.attempt, 6));
    this.retry = setTimeout(() => {
      this.retry = null;
      this.connect();
    }, delay);
  }
}
