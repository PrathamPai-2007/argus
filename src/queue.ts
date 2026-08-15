import { log } from "./logger.ts";

/**
 * In-process ring buffer with backpressure (PLAN.md §4, layer 3).
 * Full → drop-oldest with a dropped counter so the ingestion path never blocks;
 * consumers see the drop count and can trigger a gap backfill.
 */
export class EventQueue<T> {
  private buf: (T | undefined)[];
  private head = 0;
  private tail = 0;
  private size = 0;
  private warnEvery = 0;
  dropped = 0;

  constructor(readonly capacity = 50_000) {
    if (capacity < 16) throw new Error("queue capacity too small");
    this.buf = new Array<T | undefined>(capacity);
  }

  get depth(): number {
    return this.size;
  }

  push(item: T): void {
    if (this.size === this.capacity) {
      // drop oldest
      this.buf[this.head] = undefined;
      this.head = (this.head + 1) % this.capacity;
      this.size--;
      this.dropped++;
      if (this.dropped - this.warnEvery >= 1000) {
        this.warnEvery = this.dropped;
        log.warn("event queue overflow — dropping oldest events", { dropped: this.dropped, capacity: this.capacity });
      }
    }
    this.buf[this.tail] = item;
    this.tail = (this.tail + 1) % this.capacity;
    this.size++;
  }

  /** Remove and return up to `max` items, oldest first. */
  drain(max = Number.POSITIVE_INFINITY): T[] {
    const n = Math.min(max, this.size);
    const out = new Array<T>(n);
    for (let i = 0; i < n; i++) {
      out[i] = this.buf[this.head] as T;
      this.buf[this.head] = undefined;
      this.head = (this.head + 1) % this.capacity;
    }
    this.size -= n;
    return out;
  }

  clear(): void {
    this.buf = new Array(this.capacity);
    this.head = this.tail = this.size = 0;
  }
}
