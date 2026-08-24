/**
 * Rollback-capable disjoint-set union (union-find) — PLAN.md §6.
 *
 * - union by size, NO path compression (compression destroys undoability)
 * - explicit operation-history stack: unions can be popped back to any mark
 * - find is O(depth) ~ O(log n) with union by size
 *
 * Used for wallet clustering where merges must be undoable (reorgs,
 * post-hoc label invalidation).
 */
export class RollbackDSU {
  private parent = new Map<string, string>();
  private size = new Map<string, number>();
  private children = new Map<string, Set<string>>();
  private keys = new Set<string>();
  /** Each entry: [childRoot, parentRoot] — before the union, childRoot was its own root. */
  private ops: Array<[string, string, string[]]> = [];
  private opsBase = 0;
  private _components = 0;

  private ensure(x: string): void {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.size.set(x, 1);
      this.keys.add(x);
      this._components++;
    }
  }

  has(x: string): boolean {
    return this.parent.has(x);
  }

  find(x: string): string {
    this.ensure(x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root) as string;
    return root;
  }

  /** Union two elements. Returns true if they were in different sets. */
  union(a: string, b: string): boolean {
    const created: string[] = [];
    if (!this.parent.has(a)) created.push(a);
    if (!this.parent.has(b)) created.push(b);
    let ra = this.find(a);
    let rb = this.find(b);
    if (ra === rb) {
      for (const key of new Set(created)) {
        this.parent.delete(key);
        this.size.delete(key);
        this.keys.delete(key);
        this.children.delete(key);
        this._components--;
      }
      return false;
    }
    let sa = this.size.get(ra) as number;
    let sb = this.size.get(rb) as number;
    if (sa < sb) {
      [ra, rb] = [rb, ra];
      [sa, sb] = [sb, sa];
    }
    this.parent.set(rb, ra);
    this.size.set(ra, sa + sb);
    
    let rChildren = this.children.get(ra);
    if (!rChildren) {
      rChildren = new Set();
      this.children.set(ra, rChildren);
    }
    rChildren.add(rb);
    
    this.ops.push([rb, ra, created]);
    this._components--;
    return true;
  }

  /** Current operation-stack depth — a restore point for rollback(). */
  mark(): number {
    return this.opsBase + this.ops.length;
  }

  /** Undo all unions applied since `m`. */
  rollback(m: number): void {
    while (this.opsBase + this.ops.length > m) {
      const op = this.ops.pop();
      if (!op) break;
      const [childRoot, parentRoot, created] = op;
      const ps = this.size.get(parentRoot) as number;
      const cs = this.size.get(childRoot) as number;
      this.parent.set(childRoot, childRoot);
      this.children.get(parentRoot)?.delete(childRoot);
      this.size.set(parentRoot, ps - cs);
      this._components++;
      for (const key of created) {
        this.parent.delete(key);
        this.size.delete(key);
        this.keys.delete(key);
        this.children.delete(key);
        this._components--;
      }
    }
  }

  /** Permanently discard undo history prior to mark `m`. */
  finalize(m: number): void {
    const keep = this.opsBase + this.ops.length - m;
    if (keep < this.ops.length && keep >= 0) {
      const drop = this.ops.length - keep;
      this.ops = this.ops.slice(drop);
      this.opsBase += drop;
    }
  }

  /** Garbage collect unreferenced leaf wallets to stop unbounded memory growth. */
  prune(activeKeys: Set<string>): void {
    const lockedKeys = new Set<string>();
    for (const op of this.ops) {
      lockedKeys.add(op[0]);
      lockedKeys.add(op[1]);
      for (const c of op[2]) lockedKeys.add(c);
    }
    
    let pruned = true;
    while (pruned) {
      pruned = false;
      for (const k of this.keys) {
        if (!activeKeys.has(k) && !lockedKeys.has(k)) {
          const ch = this.children.get(k);
          if (!ch || ch.size === 0) {
            const p = this.parent.get(k);
            if (p && p !== k) {
              this.children.get(p)?.delete(k);
              
              let curr = k;
              while (true) {
                const parentNode = this.parent.get(curr);
                if (parentNode && parentNode !== curr) {
                  this.size.set(parentNode, (this.size.get(parentNode) ?? 1) - 1);
                  curr = parentNode;
                } else {
                  break;
                }
              }
            } else {
              this._components--;
            }
            this.parent.delete(k);
            this.size.delete(k);
            this.children.delete(k);
            this.keys.delete(k);
            pruned = true;
          }
        }
      }
    }
  }

  get componentCount(): number {
    return this._components;
  }

  memberCount(x: string): number {
    return this.size.get(this.find(x)) as number;
  }

  /** All members of x's set. O(cluster size) using children DFS. */
  members(x: string): string[] {
    const root = this.find(x);
    const out: string[] = [];
    const stack = [root];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      out.push(cur);
      const ch = this.children.get(cur);
      if (ch) {
        for (const child of ch) stack.push(child);
      }
    }
    return out;
  }

  /** Members of each requested root, grouped in ONE pass. */
  membersFor(roots: ReadonlySet<string>): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const r of roots) {
      out.set(r, this.members(r));
    }
    return out;
  }

  /** All sets with >1 member, keyed by root. */
  clusters(): Map<string, string[]> {
    const byRoot = new Map<string, string[]>();
    for (const k of this.keys) {
      const r = this.find(k);
      const arr = byRoot.get(r);
      if (arr) arr.push(k);
      else byRoot.set(r, [k]);
    }
    for (const [r, members] of byRoot) if (members.length <= 1) byRoot.delete(r);
    return byRoot;
  }

  /** Export raw state for snapshots. */
  toJSON(): { parent: Record<string, string>; size: Record<string, number>; children: Record<string, string[]>; opsBase: number; ops: [string, string, string[]][] } {
    const serializedChildren: Record<string, string[]> = {};
    for (const [k, v] of this.children) serializedChildren[k] = [...v];
    return { parent: Object.fromEntries(this.parent), size: Object.fromEntries(this.size), children: serializedChildren, opsBase: this.opsBase, ops: [...this.ops] };
  }

  static fromJSON(j: { parent: Record<string, string>; size: Record<string, number>; children?: Record<string, string[]>; opsBase?: number; ops: [string, string, string[]][] }): RollbackDSU {
    const d = new RollbackDSU();
    d.parent = new Map(Object.entries(j.parent));
    d.size = new Map(Object.entries(j.size));
    d.keys = new Set(d.parent.keys());
    if (j.children) {
      for (const [k, v] of Object.entries(j.children)) {
        d.children.set(k, new Set(v));
      }
    } else {
      // Reconstruct children from parent mapping for legacy snapshots
      for (const [k, p] of d.parent) {
        if (k !== p) {
          let ch = d.children.get(p);
          if (!ch) { ch = new Set(); d.children.set(p, ch); }
          ch.add(k);
        }
      }
    }
    d.opsBase = j.opsBase ?? 0;
    d.ops = j.ops.map(([a, b, created]) => [a, b, created ?? []] as [string, string, string[]]);
    let comps = 0;
    for (const [k, v] of d.parent) if (k === v) comps++;
    d._components = comps;
    return d;
  }
}
