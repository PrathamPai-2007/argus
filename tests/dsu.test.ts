import { describe, expect, test } from "bun:test";
import { RollbackDSU } from "../src/graph/dsu.ts";

describe("RollbackDSU", () => {
  test("union + find", () => {
    const d = new RollbackDSU();
    expect(d.union("a", "b")).toBe(true);
    expect(d.find("a")).toBe(d.find("b"));
    expect(d.union("a", "b")).toBe(false); // already same set
    expect(d.memberCount("a")).toBe(2);
    d.union("c", "d");
    d.union("b", "c"); // merge two pairs
    expect(d.memberCount("a")).toBe(4);
    expect(d.componentCount).toBe(1);
  });

  test("rollback undoes unions in LIFO order", () => {
    const d = new RollbackDSU();
    d.union("a", "b");
    d.union("c", "d");
    const mark = d.mark();
    d.union("b", "c"); // all four connected
    expect(d.memberCount("a")).toBe(4);
    d.rollback(mark);
    expect(d.memberCount("a")).toBe(2);
    expect(d.memberCount("c")).toBe(2);
    expect(d.find("a")).not.toBe(d.find("c"));
  });

  test("rollback to zero fully splits", () => {
    const d = new RollbackDSU();
    d.union("x", "y");
    d.union("y", "z");
    d.rollback(0);
    expect(d.memberCount("x")).toBe(1);
    expect(d.find("x")).not.toBe(d.find("y"));
  });

  test("members + clusters", () => {
    const d = new RollbackDSU();
    d.union("a", "b");
    d.union("c", "d");
    d.union("e", "f");
    d.rollback(d.mark()); // no-op
    expect(new Set(d.members("a"))).toEqual(new Set(["a", "b"]));
    const clusters = d.clusters();
    expect(clusters.size).toBe(3); // {a,b}, {c,d}, {e,f}
  });

  test("membersFor groups only requested roots in one pass", () => {
    const d = new RollbackDSU();
    d.union("a", "b");
    d.union("c", "d");
    d.union("e", "f");
    const want = new Set([d.find("a"), d.find("e")]);
    const groups = d.membersFor(want);
    expect(groups.size).toBe(2);
    expect(new Set(groups.get(d.find("a"))!)).toEqual(new Set(["a", "b"]));
    expect(new Set(groups.get(d.find("e"))!)).toEqual(new Set(["e", "f"]));
    expect(groups.has(d.find("c"))).toBe(false);
    // singletons not in requested set are skipped
    const solo = new Set([d.find("a")]);
    const one = d.membersFor(solo);
    expect(new Set(one.get(d.find("a"))!)).toEqual(new Set(["a", "b"]));
  });

  test("membersFor with rollback stays consistent", () => {
    const d = new RollbackDSU();
    d.union("a", "b");
    const mark = d.mark();
    d.union("b", "c");
    const before = d.membersFor(new Set([d.find("a")])).get(d.find("a"))!;
    expect(before).toHaveLength(3);
    d.rollback(mark);
    expect(new Set(d.membersFor(new Set([d.find("a")])).get(d.find("a"))!)).toEqual(new Set(["a", "b"]));
  });

  test("snapshot roundtrip preserves structure", () => {
    const d = new RollbackDSU();
    d.union("a", "b");
    d.union("b", "c");
    const restored = RollbackDSU.fromJSON(d.toJSON());
    expect(restored.memberCount("a")).toBe(3);
    expect(new Set(restored.members("c"))).toEqual(new Set(["a", "b", "c"]));
    restored.rollback(1); // undo union(b,c)
    expect(restored.memberCount("a")).toBe(2);
  });
});
