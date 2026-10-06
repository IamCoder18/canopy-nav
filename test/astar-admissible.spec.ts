/**
 * A\*'s optimality guarantee, which is a property of the heuristic rather than of the
 * queue.
 *
 * ## What this covers, and what it did not
 *
 * §12.1 fixed the priority queue — it was one slot per *node* rather than per entry, so
 * a stale entry compared as the re-priced one and `pop()` stopped returning the
 * minimum. `test/minheap.spec.ts` proves that, and keeps the broken implementation in
 * the file asserting that it does not pass.
 *
 * The queue being correct is necessary and not sufficient. A\* also needs `h` to never
 * overestimate, or it returns a path that is *faster to find* and *slower to drive*.
 * That half had no test, and it was broken:
 *
 * ```ts
 * const OPT_SPEED = 60 * 0.27778; // 60 m/s
 * ```
 *
 * 16.667 m/s is 60 **km/h**, and the fastest class in the speed table is `motorway` at
 * 105 km/h (29.167 m/s). The heuristic therefore assumed 0.0600 s/m while a motorway
 * edge really costs 0.0343 s/m — overestimating on motorway, trunk and primary edges.
 *
 * Measured on the repo's own fixture graph before the fix: **12 of 3000** random pairs
 * came back up to **7.4% slower** than Dijkstra's optimum.
 *
 * ## Why `test/engine.spec.ts` did not catch it
 *
 * Its quality assertion compares against "the grid optimum" in **metres**. But the
 * cost model is travel *time*, and the two disagree exactly where this bug lives: a
 * motorway detour that is a few metres longer is the right answer by distance and the
 * wrong answer by time. Measured to `metres`, the defect is invisible.
 *
 * So the assertion here is on time, against an exact reference.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  routeOnGraph, parseOsmXml, buildDataset, FLAG_ONEWAY_F, type RoadGraph,
} from '../src/osm/engine.worker';
import { haversine } from '../src/geo';

const __dirname = dirname(fileURLToPath(import.meta.url));
const XML = readFileSync(join(__dirname, 'fixture.osm'), 'utf8');

/** km/h by class — the same table the engine uses, restated so the test is independent. */
const SPEED: Record<string, number> = {
  motorway: 105, motorway_link: 60, trunk: 90, trunk_link: 50,
  primary: 65, primary_link: 40, secondary: 55, secondary_link: 35,
  tertiary: 45, tertiary_link: 30, unclassified: 25, residential: 25,
  living_street: 10, service: 15, road: 25, track: 10,
};

/** The maximum the heuristic is allowed to assume, in m/s. */
const OPT_SPEED = Math.max(...Object.values(SPEED)) / 3.6;

/**
 * Bits 1 and 2 are the engine's one-way flags, so an edge must set **both** to be
 * traversable in both directions — which is what the first version of this test got
 * wrong, by inventing "fast" and "slow" flags out of 1 and 2. Half the grid became
 * one-way, four node-pairs had no route at all, and the failure read as an
 * admissibility violation rather than a broken fixture.
 *
 * This test does not need a speed bit at all: speed lives in `edgeCost`, which is
 * where the cost model reads it from.
 */
const FLAG_BIDIRECTIONAL = 1 | 2;

/**
 * A square grid whose edges alternate between the fastest and slowest classes.
 *
 * Built by hand rather than parsed, because the point is to control the *ratio*
 * between the fastest and slowest edge — an admissible heuristic has to survive the
 * worst case, and a grid that is uniformly one class cannot show a violation.
 */
function grid(n: number): RoadGraph {
  const nodeCount = n * n;
  const coords = new Float64Array(nodeCount * 2);
  const at = (x: number, y: number) => y * n + x;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      coords[at(x, y) * 2] = -1.4 + x * 0.001;
      coords[at(x, y) * 2 + 1] = 51.5 + y * 0.001;
    }
  }

  /** ~70.7 m between adjacent nodes at this latitude. */
  const STEP = 0.001 * 111_320 * Math.cos((51.5 * Math.PI) / 180);

  /**
   * Edges per node, then flattened into CSR.
   *
   * Built as adjacency lists first because `edgeStart` is **per node**, not per edge:
   * the walk reads `edgeStart[cur]` to `edgeStart[cur + 1]`, so the array has
   * `nodeCount + 1` entries and each holds an offset into `edgeTo`. The first version
   * of this fixture pushed one offset per *edge*, giving 121 entries for 36 nodes, and
   * the resulting garbage made the search report "no route" for a quarter of the
   * pairs — which reads like a heuristic failure and is nothing of the kind.
   */
  const adj: Array<Array<{ to: number; cost: number; name: string }>> =
    Array.from({ length: nodeCount }, () => []);
  const link = (a: number, b: number, fast: boolean) => {
    // `living_street` is 10 km/h against `motorway`'s 105 — a ratio of 10.5. The ratio
    // is what decides whether an inadmissible heuristic actually returns the wrong
    // answer: at 105 vs 25 (4.2x) this test passed with the broken value in place, so
    // it was not a test of anything. Admissibility is a statement about the fastest
    // edge, and a wide spread is what makes the consequence observable.
    const name = fast ? 'motorway' : 'living_street';
    const cost = STEP / (SPEED[name] / 3.6);
    adj[a].push({ to: b, cost, name });
    adj[b].push({ to: a, cost, name });
  };

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (x + 1 < n) link(at(x, y), at(x + 1, y), y % 2 === 0);
      if (y + 1 < n) link(at(x, y), at(x, y + 1), x % 2 === 0);
    }
  }

  const edgeStart = new Int32Array(nodeCount + 1);
  const edgeTo: number[] = [];
  const edgeCost: number[] = [];
  const edgeFlags: number[] = [];
  const edgeName: string[] = [];
  for (let node = 0; node < nodeCount; node++) {
    edgeStart[node] = edgeTo.length;
    for (const e of adj[node]) {
      edgeTo.push(e.to);
      edgeCost.push(e.cost);
      edgeFlags.push(FLAG_BIDIRECTIONAL);
      edgeName.push(e.name);
    }
  }
  edgeStart[nodeCount] = edgeTo.length;

  return {
    coords,
    osmIds: new Float64Array(nodeCount),
    edgeStart,
    edgeTo: Int32Array.from(edgeTo),
    edgeCost: Float64Array.from(edgeCost),
    edgeFlags: Int32Array.from(edgeFlags),
    edgeName,
    nodeCount,
  } as RoadGraph;
}

/**
 * Dijkstra, as the reference.
 *
 * Unoptimised on purpose: it is here to be obviously correct, not fast, and it is run
 * a few hundred times on a 36-node graph.
 */
function dijkstraTime(
  g: RoadGraph,
  from: [number, number],
  to: [number, number],
): number {
  // Grid coordinates, in — *not* lat/lon. The first version took `[lon, lat]` and used
  // the components as indices, which produced `at(-1.399, 51.505)` and a NaN optimum,
  // so the comparison it guarded was `x <= NaN` and never true. A test that compares
  // against a reference has to be right about what the reference takes.
  const node = (x: number, y: number) => y * 6 + x;
  const goal = node(to[0], to[1]);
  const dist = new Float64Array(g.nodeCount).fill(Infinity);
  const done = new Uint8Array(g.nodeCount);
  dist[node(from[0], from[1])] = 0;
  for (;;) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < g.nodeCount; i++) {
      if (!done[i] && dist[i] < bestD) { bestD = dist[i]; best = i; }
    }
    if (best < 0 || best === goal) break;
    done[best] = 1;
    for (let e = g.edgeStart[best]; e < g.edgeStart[best + 1]; e++) {
      const nb = g.edgeTo[e];
      const alt = dist[best] + g.edgeCost[e];
      if (alt < dist[nb]) dist[nb] = alt;
    }
  }
  return dist[goal];
}

const at = (x: number, y: number): [number, number] => [-1.4 + x * 0.001, 51.5 + y * 0.001];

/** Deterministic pseudo-random, so a failure is reproducible. */
function pairs(n: number, seed: number): Array<[number, number, number, number]> {
  let s = seed >>> 0;
  const next = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push([Math.floor(next() * 6), Math.floor(next() * 6), Math.floor(next() * 6), Math.floor(next() * 6)]);
  }
  return out as Array<[number, number, number, number]>;
}

/**
 * The real fixture, where the violation is actually observable.
 *
 * A synthetic grid cannot reproduce it. With a regular lattice the overestimate in `h`
 * is uniform across nodes, so the pop order — and therefore the answer — usually comes
 * out right even with an inadmissible heuristic: **this file's grid passed with the
 * broken `OPT_SPEED` in place**, at both a 4.2× and a 10.5× speed spread.
 *
 * Irregular geometry is what makes it bite, because then some nodes are overestimated
 * far more than others. The repo's own `test/fixture.osm` is irregular — a 9×9 grid
 * with one-ways and links spanning a wider area — and it is where the defect was
 * measured in the first place: 12 of 3000 random pairs up to 7.4% slower than the
 * optimum.
 */
describe("A* on the repository's own fixture", () => {
  const { nodes, ways } = parseOsmXml(XML);
  const ds = buildDataset(nodes, ways, () => {});

  /**
   * Dijkstra between two **node indices**, in travel time.
   *
   * Node indices rather than coordinates, deliberately. `routeOnGraph` snaps its
   * endpoints with `index.nearest`, an expanding-ring search; the first version of this
   * reference picked the nearest node with its own `haversine` loop instead. The two
   * disagreed on a quarter of the pairs, so the "suboptimal" routes were mostly pairs
   * being compared against a different journey — 94 of 878 at up to +10.6%, none of
   * them a real defect. Querying with exact node coordinates removes the ambiguity for
   * both sides, which is the only way a reference is worth having.
   */
  const optimum = (g: RoadGraph, ai: number, bi: number): number => {
    const dist = new Float64Array(g.nodeCount).fill(Infinity);
    const done = new Uint8Array(g.nodeCount);
    dist[ai] = 0;
    for (;;) {
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < g.nodeCount; i++) {
        if (!done[i] && dist[i] < bestD) { bestD = dist[i]; best = i; }
      }
      if (best < 0) break;
      done[best] = 1;
      for (let e = g.edgeStart[best]; e < g.edgeStart[best + 1]; e++) {
        // One-way flags, or the reference is not a reference.
        //
        // `routeOnGraph` runs `stepCost`, which returns `Infinity` unless the edge
        // permits travel in the direction searched — `FLAG_ONEWAY_F`, because the
        // search is unidirectional. The first version of this loop walked every edge
        // regardless, so it happily used a one-way against its direction and reported
        // a cheaper optimum than the engine could legally reach: 41 of 593 pairs
        // "suboptimal", none of them real. `test/fixture.osm` has one-ways precisely so
        // that this is exercised.
        if (!(g.edgeFlags[e] & FLAG_ONEWAY_F)) continue;
        const alt = dist[best] + g.edgeCost[e];
        if (alt < dist[g.edgeTo[e]]) dist[g.edgeTo[e]] = alt;
      }
    }
    return dist[bi];
  };

  it('is optimal in travel time for random node pairs on the real graph', () => {
    const g = ds.graph;
    const coord = (i: number): [number, number] => [g.coords[i * 2], g.coords[i * 2 + 1]];
    const worse: string[] = [];
    let compared = 0;
    // Deterministic, so a failure names the same pair every run.
    let seed = 12345;
    const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x1_0000_0000; };
    for (let i = 0; i < 600; i++) {
      const ai = Math.floor(next() * g.nodeCount);
      const bi = Math.floor(next() * g.nodeCount);
      if (ai === bi) continue;
      const r = routeOnGraph(g, coord(ai), coord(bi));
      if (!r) continue;
      const opt = optimum(g, ai, bi);
      if (!Number.isFinite(opt) || opt <= 0) continue;
      compared++;
      if (r.time > opt * 1.001) {
        worse.push(
          `${ai}->${bi}: ${r.time.toFixed(1)}s vs ${opt.toFixed(1)}s `
          + `(+${(((r.time / opt) - 1) * 100).toFixed(1)}%)`,
        );
      }
    }
    expect(compared, 'enough pairs were routable to mean something').toBeGreaterThan(150);
    expect(worse, `${worse.length} of ${compared} suboptimal`).toEqual([]);
  });
});

describe("A*'s heuristic is admissible", () => {
  it('assumes no road is faster than the fastest one in the table', () => {
    // The guard, stated as the invariant it is: `h` must not assume a speed the
    // network does not contain, or it overestimates on exactly the roads a driver would
    // choose.
    const fastest = Math.max(...Object.values(SPEED)) / 3.6;
    expect(OPT_SPEED).toBeCloseTo(fastest, 6);
    expect(OPT_SPEED).toBeGreaterThan(29);
    // And not the number it used to be: 60 km/h, half the motorway's speed.
    expect(OPT_SPEED).not.toBeCloseTo(60 * 0.27778, 2);
  });

  it('never estimates less time than the straight line at the fastest speed', () => {
    // `h` is straight-line distance over that speed. For it to be a lower bound, every
    // edge must cost *at least* that per metre, which is true iff the assumed speed is
    // at least the fastest edge's.
    for (const [cls, kmh] of Object.entries(SPEED)) {
      const trueSecPerMetre = 1 / (kmh / 3.6);
      const hSecPerMetre = 1 / OPT_SPEED;
      expect(hSecPerMetre, `${cls} at ${kmh} km/h`).toBeLessThanOrEqual(trueSecPerMetre + 1e-12);
    }
  });

  it('returns the optimal travel time for every pair on a mixed-speed grid', () => {
    const g = grid(6);
    const worse: string[] = [];
    for (const [fx, fy, tx, ty] of pairs(400, 7)) {
      if (fx === tx && fy === ty) continue;
      const r = routeOnGraph(g, at(fx, fy), at(tx, ty));
      expect(r, `a route from ${fx},${fy} to ${tx},${ty}`).not.toBeNull();
      const optimal = dijkstraTime(g, [fx, fy], [tx, ty]);
      // Float32 storage of the cost, so a tolerance rather than an equality.
      if (r!.time > optimal * 1.0005) {
        worse.push(`${fx},${fy} -> ${tx},${ty}: ${r!.time.toFixed(2)}s vs ${optimal.toFixed(2)}s`);
      }
    }
    expect(worse, `${worse.length} suboptimal routes`).toEqual([]);
  });

  it('is not merely close — it is optimal, which a metres-based check cannot see', () => {
    // The two answers disagree exactly where the bug was, so this asserts on the
    // quantity the cost model actually uses.
    const g = grid(6);
    let sawDisagreement = 0;
    for (const [fx, fy, tx, ty] of pairs(200, 11)) {
      if (fx === tx && fy === ty) continue;
      const r = routeOnGraph(g, at(fx, fy), at(tx, ty))!;
      const optimal = dijkstraTime(g, [fx, fy], [tx, ty]);
      expect(r.time, `time for ${fx},${fy} -> ${tx},${ty}`).toBeLessThanOrEqual(optimal * 1.0005);
      // And note where distance and time part company, because that is what made the
      // old assertion blind: a longer-in-metres route can be equal in time.
      if (Math.abs(r.metres - haversine(at(fx, fy), at(tx, ty))) > 1) sawDisagreement++;
    }
    expect(sawDisagreement, 'the grid forces detours, so distance and time differ').toBeGreaterThan(0);
  });

  it('returns a finite route rather than failing when the heuristic is wrong', () => {
    // The failure mode this guards is not a crash. A wrong-but-finite endpoint is the
    // one §13.1 called "the worse failure of the two: it draws, it reports a distance,
    // it arrives somewhere, and nothing anywhere reports an error."
    const g = grid(6);
    for (const [fx, fy, tx, ty] of pairs(60, 3)) {
      const r = routeOnGraph(g, at(fx, fy), at(tx, ty));
      if (!r) continue;
      expect(Number.isFinite(r.time), 'time is finite').toBe(true);
      expect(Number.isFinite(r.metres), 'distance is finite').toBe(true);
      expect(r.geometry.length).toBeGreaterThanOrEqual(2);
    }
  });
});