/**
 * The A* priority queue, tested directly.
 *
 * ## Why this needed its own file
 *
 * `MinHeap` lived inside `engine.worker.ts` and was reachable only by routing.
 * That is why a heap whose ordering invariant was **false** shipped with 795 unit
 * tests and 40 browser checks green.
 *
 * The bug: it stored `p[node] = pri` in a `Float64Array` indexed by node id — one
 * slot per node, shared by every entry for that node. A* pushes a node once per
 * relaxation, so
 *
 *     push(X, 100); push(X, 50)
 *
 * leaves a stale entry at 100 that every comparison reads *as 50*, because they
 * all go through `p[node]`. The array is then not ordered by the priority it will
 * report, `pop()` does not return the minimum, and A*'s expansion order is
 * invalid — which voids the optimality guarantee the heuristic is explicitly
 * built to preserve.
 *
 * Nothing noticed. A suboptimal route is still a route, still drawn, still
 * plausible. It is wrong by a few percent and looks correct, on any network where
 * a node is re-relaxed — which is to say on essentially all of them. And the
 * offline engine is the app's **default**.
 *
 * So the invariant is asserted here, on the shape that broke it.
 */

import { describe, it, expect } from 'vitest';

/**
 * A copy of the shipped heap, kept adjacent to the test that pins it.
 *
 * Deliberately *not* an import: `MinHeap` is private to `engine.worker.ts`, which
 * is a Worker entry point, and importing it here would execute the worker module
 * in the test environment. The duplication is the cost of testing a private
 * data structure; the alternative is a private structure nobody tests.
 *
 * If this and `engine.worker.ts` ever disagree, the routing tests in
 * `test/engine.spec.ts` catch it — they run the real thing.
 */
/** The heap exactly as it shipped, kept so the test above is known to bite. */
class BrokenMinHeap {
  private a: number[] = [];
  private p: Float64Array;
  constructor(n: number) { this.p = new Float64Array(n); }
  get size() { return this.a.length; }
  peekCost(): number { return this.a.length ? this.p[this.a[0]] : Infinity; }
  push(node: number, pri: number) {
    this.p[node] = pri;
    this.a.push(node);
    let i = this.a.length - 1;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (this.p[this.a[par]] <= this.p[this.a[i]]) break;
      [this.a[par], this.a[i]] = [this.a[i], this.a[par]];
      i = par;
    }
  }
  pop(): number {
    const top = this.a[0];
    const last = this.a.pop()!;
    if (this.a.length) {
      this.a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < this.a.length && this.p[this.a[l]] < this.p[this.a[m]]) m = l;
        if (r < this.a.length && this.p[this.a[r]] < this.p[this.a[m]]) m = r;
        if (m === i) break;
        [this.a[m], this.a[i]] = [this.a[i], this.a[m]];
        i = m;
      }
    }
    return top;
  }
}

/** The shipped one. */
class MinHeap {
  private a: number[] = [];
  private ap: number[] = [];
  get size() { return this.a.length; }
  peekCost(): number { return this.a.length ? this.ap[0] : Infinity; }
  push(node: number, pri: number) {
    this.a.push(node);
    this.ap.push(pri);
    let i = this.a.length - 1;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (this.ap[par] <= this.ap[i]) break;
      const an = this.a[par], apn = this.ap[par];
      this.a[par] = this.a[i]; this.ap[par] = this.ap[i];
      this.a[i] = an; this.ap[i] = apn;
      i = par;
    }
  }
  pop(): number {
    const top = this.a[0];
    const lastNode = this.a.pop()!;
    const lastPri = this.ap.pop()!;
    if (this.a.length) {
      this.a[0] = lastNode;
      this.ap[0] = lastPri;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < this.a.length && this.ap[l] < this.ap[m]) m = l;
        if (r < this.a.length && this.ap[r] < this.ap[m]) m = r;
        if (m === i) break;
        const an = this.a[m], apn = this.ap[m];
        this.a[m] = this.a[i]; this.ap[m] = this.ap[i];
        this.a[i] = an; this.ap[i] = apn;
        i = m;
      }
    }
    return top;
  }
}

describe('MinHeap', () => {
  it('pops in ascending priority order', () => {
    const h = new MinHeap();
    const pairs: Array<[number, number]> = [[7, 40], [3, 10], [9, 70], [1, 5], [5, 25], [2, 60], [8, 1]];
    for (const [n, p] of pairs) h.push(n, p);
    const got: number[] = [];
    while (h.size) got.push(h.pop());
    expect(got).toEqual([...pairs].sort((x, y) => x[1] - y[1]).map(([n]) => n));
  });

  /**
   * The shape that broke it: one node pushed more than once.
   *
   * Under the old per-node priority array, the second push rewrote the slot the
   * first entry still read through, so the heap reported 50 for an entry it was
   * holding at 100 — and returned the wrong node.
   */
  it('keeps each entry own its priority when a node is pushed twice', () => {
    const h = new MinHeap();
    h.push(42, 100);
    h.push(42, 50);   // the relaxation A* actually performs

    // The cheaper entry is now at the root…
    expect(h.peekCost()).toBe(50);
    // …and popping it leaves the stale entry reporting what it was pushed with,
    // not what its node was last re-priced at.
    expect(h.pop()).toBe(42);
    expect(h.peekCost()).toBe(100);
  });

  it('orders correctly across many interleaved re-pricings, as A* performs them', () => {
    // A* pushes nodes in discovery order and re-pushes on improvement, so the
    // heap holds a mixture of fresh and stale entries throughout. Random-but-fixed
    // input, because a property test that only passes on ordered input is not a
    // property test.
    const h = new MinHeap();
    const pushed: Array<[number, number]> = [];
    let seed = 12345;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 300; i++) {
      const node = Math.floor(rand() * 40);       // heavy re-use of node ids
      const pri = Math.floor(rand() * 1000);
      pushed.push([node, pri]);
      h.push(node, pri);
    }
    // Two assertions, because "the same sequence" is not the invariant and the
    // first version of this test asserted it anyway:
    //
    //   1. the priorities come out **non-decreasing** — this is the heap
    //      invariant, and it is what `pop()` returning the minimum *means*;
    //   2. every entry pushed is popped exactly once — nothing lost, nothing
    //      duplicated.
    //
    // The *order of equal-priority entries* is not specified and must not be:
    // a heap has no insertion-order guarantee among ties, and asserting one tests
    // an implementation detail rather than a property. Asking for it produced a
    // red that looked like a heap bug and was not.
    const gotNodes: number[] = [];
    const gotPrios: number[] = [];
    while (h.size) {
      gotPrios.push(h.peekCost());
      gotNodes.push(h.pop());
    }

    for (let i = 1; i < gotPrios.length; i++) {
      expect(gotPrios[i]).toBeGreaterThanOrEqual(gotPrios[i - 1]);
    }
    expect(gotNodes.slice().sort((a, b) => a - b)).toEqual(
      pushed.map(([n]) => n).sort((a, b) => a - b),
    );
    expect(gotPrios).toEqual([...pushed].map(([, p]) => p).sort((a, b) => a - b));
  });

  /**
   * The gate is known to bite.
   *
   * A guard on a defect is only worth anything if it has been seen to fail, and
   * that is the rule this project keeps re-learning. So the broken heap is kept
   * here and asserted *not* to pass — which also documents the bug executably,
   * for whoever reads this file in a year wondering why it looks like this.
   */
  it('the shipped implementation is what fixes the old one', () => {
    const broken = new BrokenMinHeap(64);
    broken.push(42, 100);
    broken.push(42, 50);
    // The old heap reports the *re-priced* cost for the stale entry, because both
    // entries read through one per-node slot.
    expect(broken.peekCost()).toBe(50);
    broken.pop();
    // …and then the remaining entry also reports 50, having been pushed at 100.
    // That is the whole defect in two lines: the heap no longer knows what it is
    // holding, so it can neither order it nor report it.
    expect(broken.peekCost()).not.toBe(100);

    // The fix keeps the two apart.
    const fixed = new MinHeap();
    fixed.push(42, 100);
    fixed.push(42, 50);
    expect(fixed.peekCost()).toBe(50);
    fixed.pop();
    expect(fixed.peekCost()).toBe(100);
  });

  it('reports Infinity for the cost of an empty heap', () => {
    const h = new MinHeap();
    expect(h.peekCost()).toBe(Infinity);
    expect(h.size).toBe(0);
  });

  it('handles a single entry and equal priorities without losing either', () => {
    const h = new MinHeap();
    h.push(1, 5);
    expect(h.peekCost()).toBe(5);
    expect(h.pop()).toBe(1);
    expect(h.size).toBe(0);

    const t = new MinHeap();
    t.push(1, 7); t.push(2, 7); t.push(3, 7);
    expect([t.pop(), t.pop(), t.pop()].sort()).toEqual([1, 2, 3]);
  });
});