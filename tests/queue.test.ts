import { describe, expect, test } from "bun:test";
import { EventQueue } from "../src/queue.ts";

describe("EventQueue", () => {
  test("FIFO push/drain", () => {
    const q = new EventQueue<number>(16);
    q.push(1);
    q.push(2);
    q.push(3);
    expect(q.depth).toBe(3);
    expect(q.drain(2)).toEqual([1, 2]);
    expect(q.depth).toBe(1);
    expect(q.drain()).toEqual([3]);
    expect(q.depth).toBe(0);
  });

  test("overflow drops oldest and counts", () => {
    const q = new EventQueue<number>(16);
    for (let i = 0; i < 20; i++) q.push(i);
    expect(q.depth).toBe(16);
    expect(q.dropped).toBe(4);
    expect(q.drain()).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });

  test("weighted capacity bounds event count, not batch count", () => {
    const q = new EventQueue<{ id: number; events: number[] }>(16, (item) => item.events.length);
    q.push({ id: 1, events: Array.from({ length: 15 }, (_, i) => i) });
    q.push({ id: 2, events: [16, 17] });
    expect(q.depth).toBe(2);
    expect(q.dropped).toBe(15);
    expect(q.drain()).toEqual([{ id: 2, events: [16, 17] }]);
  });

  test("reports the chain-bearing item that overflow dropped", () => {
    const dropped: number[] = [];
    const q = new EventQueue<{ chainId: number }>(16, () => 1, (item) => dropped.push(item.chainId));
    q.push({ chainId: 1 });
    for (let i = 0; i < 16; i++) q.push({ chainId: 2 });
    expect(dropped).toEqual([1]);
  });
});
