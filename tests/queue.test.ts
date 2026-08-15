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
});
