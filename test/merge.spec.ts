/**
 * Graph-merge tests — mergeRegions, countComponents, diagnoseMerge.
 *
 * Hand-built RoadGraphs are used rather than parsed extracts so that node ids
 * and direction flags can be controlled exactly: the interesting cases live in
 * how the merge reconciles the *same* OSM edge described differently by two
 * adjacent extracts.
 *
 * Flag semantics (from src/osm/engine.worker.ts): FLAG_ONEWAY_F on the record
 * (from -> to) permits travel from -> to; FLAG_ONEWAY_B permits to -> from.
 * A two-way road therefore appears as TWO records, one per direction.
 *
 * Run with `npx vitest run test/merge.spec.ts`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeRegions, countComponents, diagnoseMerge } from '../src/osm/merge';
import {
  FLAG_ONEWAY_F,
  FLAG_ONEWAY_B,
  parseOsmXml,
  buildDataset,
  routeOnGraph,
  type RoadGraph,
} from '../src/osm/engine.worker';
import type { Region } from '../src/osm/regions';
import type { OsmDataset } from '../src/osm/engine.worker';

const TWO_WAY = FLAG_ONEWAY_F | FLAG_ONEWAY_B;

interface NodeSpec {
  id: number;
  lon: number;
  lat: number;
}
interface EdgeSpec {
  from: number;
  to: number;
  /** Direction permissions: F = may travel from->to, B = may travel to->from. */
  flags?: number;
  name?: string;
  cost?: number;
}

/** Build a CSR RoadGraph from a compact spec, indexed by OSM node id. */
function makeGraph(nodes: NodeSpec[], edges: EdgeSpec[]): RoadGraph {
  const n = nodes.length;
  const coords = new Float64Array(n * 2);
  const osmIds = new Float64Array(n);
  nodes.forEach((nd, i) => {
    coords[i * 2] = nd.lon;
    coords[i * 2 + 1] = nd.lat;
    osmIds[i] = nd.id;
  });

  const edgeStart = new Uint32Array(n + 1);
  for (const e of edges) edgeStart[idx(e.from) + 1]++;
  for (let i = 0; i < n; i++) edgeStart[i + 1] += edgeStart[i];

  const total = edges.length;
  const edgeTo = new Int32Array(total);
  const edgeCost = new Float32Array(total);
  const edgeFlags = new Uint8Array(total);
  const edgeName = new Array<string>(total);
  const cursor = Uint32Array.from(edgeStart.subarray(0, n));
  edges.forEach((e, k) => {
    const w = cursor[idx(e.from)]++;
    edgeTo[w] = idx(e.to);
    edgeCost[w] = e.cost ?? 10;
    edgeFlags[w] = e.flags ?? TWO_WAY;
    edgeName[w] = e.name ?? 'Road';
  });

  return { coords, osmIds, edgeStart, edgeTo, edgeCost, edgeFlags, edgeName, nodeCount: n };

  function idx(id: number): number {
    const i = nodes.findIndex((x) => x.id === id);
    if (i < 0) throw new Error(`unknown node id ${id}`);
    return i;
  }
}

function makeRegion(
  id: string,
  graph: RoadGraph,
  bbox: [number, number, number, number] = [0, 0, 1, 1],
): Region {
  const dataset: OsmDataset = {
    graph,
    gaz: [],
    roads: [],
    water: [],
    green: [],
    bbox,
    counts: { nodes: graph.nodeCount, ways: 0, routable: 0 },
  };
  return {
    id, name: id, code: id, bbox, loadedAt: 0, bytes: 0,
    counts: dataset.counts, gazetteerSize: 0, dataset,
  };
}

/** Dump the merged graph as a sorted, readable list of directed edges. */
function edgeSet(g: RoadGraph): string[] {
  const out: string[] = [];
  for (let i = 0; i < g.nodeCount; i++) {
    for (let e = g.edgeStart[i]; e < g.edgeStart[i + 1]; e++) {
      out.push(`${i}->${g.edgeTo[e]} flags=${g.edgeFlags[e]}`);
    }
  }
  return out.sort();
}

/** Which directions can actually be traversed, per the engine's flag rules. */
function traversable(g: RoadGraph): string[] {
  const out: string[] = [];
  for (let i = 0; i < g.nodeCount; i++) {
    for (let e = g.edgeStart[i]; e < g.edgeStart[i + 1]; e++) {
      if (g.edgeFlags[e] & FLAG_ONEWAY_F) out.push(`${i}->${g.edgeTo[e]}`);
    }
  }
  return out.sort();
}

/**
 * Every ordered (from, to) that the graph permits travelling along, keyed by OSM
 * id rather than slot so it can be compared across a merge (which renumbers
 * slots). This is the property a merge must never break: the union of the
 * extracts' travel permissions, no more and no less.
 */
function permissions(g: RoadGraph): string[] {
  const out = new Set<string>();
  for (let i = 0; i < g.nodeCount; i++) {
    for (let e = g.edgeStart[i]; e < g.edgeStart[i + 1]; e++) {
      const u = g.osmIds[i];
      const v = g.osmIds[g.edgeTo[e]];
      if (g.edgeFlags[e] & FLAG_ONEWAY_F) out.add(`${u}>${v}`);
      if (g.edgeFlags[e] & FLAG_ONEWAY_B) out.add(`${v}>${u}`);
    }
  }
  return [...out].sort();
}

/** Indices of edges that permit travel in neither direction — always empty. */
function deadEdges(g: RoadGraph): number[] {
  const out: number[] = [];
  for (let e = 0; e < g.edgeFlags.length; e++) {
    if ((g.edgeFlags[e] & (FLAG_ONEWAY_F | FLAG_ONEWAY_B)) === 0) out.push(e);
  }
  return out;
}

/** The dataset in test/fixture.osm, as the engine would load it. */
function fixtureDataset(): OsmDataset {
  const xml = readFileSync(join(__dirname, 'fixture.osm'), 'utf8');
  const { nodes, ways } = parseOsmXml(xml);
  return buildDataset(nodes, ways, () => {});
}

function regionOf(id: string, ds: OsmDataset): Region {
  return {
    id, name: id, code: id, bbox: ds.bbox, loadedAt: 0, bytes: 0,
    counts: ds.counts, gazetteerSize: ds.gaz.length, dataset: ds,
  };
}

/** Largest gap between consecutive geometry points — a seam shows up as a jump. */
function maxGeometryJump(pts: [number, number][]): number {
  let max = 0;
  for (let i = 1; i < pts.length; i++) {
    max = Math.max(max, Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  return max;
}

describe('countComponents', () => {
  it('counts weakly-connected components', () => {
    const g = makeGraph(
      [
        { id: 1, lon: 0, lat: 0 },
        { id: 2, lon: 1, lat: 0 },
        { id: 3, lon: 5, lat: 5 },
        { id: 4, lon: 6, lat: 5 },
      ],
      [{ from: 1, to: 2 }, { from: 3, to: 4 }],
    );
    expect(countComponents(g)).toBe(2);
  });

  it('treats one-way edges as connections for connectivity purposes', () => {
    const g = makeGraph(
      [{ id: 1, lon: 0, lat: 0 }, { id: 2, lon: 1, lat: 0 }],
      [{ from: 1, to: 2, flags: FLAG_ONEWAY_F }],
    );
    expect(countComponents(g)).toBe(1);
  });

  it('counts isolated nodes as their own components', () => {
    const g = makeGraph([{ id: 1, lon: 0, lat: 0 }, { id: 2, lon: 1, lat: 0 }], []);
    expect(countComponents(g)).toBe(2);
  });

  it('is 1 for a fully connected chain', () => {
    const g = makeGraph(
      [{ id: 1, lon: 0, lat: 0 }, { id: 2, lon: 1, lat: 0 }, { id: 3, lon: 2, lat: 0 }],
      [{ from: 1, to: 2 }, { from: 2, to: 3 }],
    );
    expect(countComponents(g)).toBe(1);
  });
});

describe('mergeRegions — node identity', () => {
  it('throws on an empty region list', () => {
    expect(() => mergeRegions([])).toThrow('mergeRegions: no regions');
  });

  it('passes a single region through unchanged, as its own copy', () => {
    const g = makeGraph([{ id: 1, lon: 0, lat: 0 }, { id: 2, lon: 1, lat: 0 }], [{ from: 1, to: 2 }]);
    const report = mergeRegions([makeRegion('solo', g)]);
    // The report owns its graph: a multi-region merge builds fresh arrays, and
    // the single-region case used to hand back the caller's object by reference,
    // so mutating the "merged" graph corrupted the region's own dataset.
    expect(report.graph).not.toBe(g);
    expect(report.graph.edgeTo).not.toBe(g.edgeTo);
    expect(report.graph.edgeFlags).not.toBe(g.edgeFlags);
    // ...but it is the same network.
    expect(edgeSet(report.graph)).toEqual(edgeSet(g));
    expect(report.nodes).toBe(2);
    expect(report.sharedNodes).toBe(0);
    expect(report.sharedEdges).toBe(0);
    expect(report.components).toBe(1);
    expect(report.regionIds).toEqual(['solo']);
  });

  it('isolates the merged graph from the source datasets', () => {
    const g = makeGraph([{ id: 1, lon: 0, lat: 0 }, { id: 2, lon: 1, lat: 0 }], [{ from: 1, to: 2 }]);
    const original = g.edgeFlags[0];
    const report = mergeRegions([makeRegion('solo', g)]);
    report.graph.edgeFlags[0] = 0;
    report.graph.edgeTo[0] = 99;
    report.graph.coords[0] = 12345;
    expect(g.edgeFlags[0]).toBe(original);
    expect(g.edgeTo[0]).toBe(1);
    expect(g.coords[0]).toBe(0);
  });

  it('collapses border nodes that share OSM ids', () => {
    // Two extracts of the same street split at a shared OSM node 2.
    const a = makeGraph([{ id: 1, lon: 0, lat: 0 }, { id: 2, lon: 1, lat: 0 }], [{ from: 1, to: 2 }]);
    const b = makeGraph([{ id: 2, lon: 1, lat: 0 }, { id: 3, lon: 2, lat: 0 }], [{ from: 2, to: 3 }]);
    const report = mergeRegions([makeRegion('a', a), makeRegion('b', b)]);
    expect(report.nodes).toBe(3);
    expect(report.sharedNodes).toBe(1);
    expect(report.sharedEdges).toBe(0); // distinct node pairs
    expect(report.components).toBe(1);
    // the seam must be a continuous chain 0 -> 1 -> 2
    expect(edgeSet(report.graph)).toEqual(['0->1 flags=3', '1->2 flags=3']);
  });

  it('keeps the first extract’s coordinates for a shared node', () => {
    const a = makeGraph([{ id: 2, lon: 1.5, lat: 0 }], []);
    const b = makeGraph([{ id: 2, lon: 1.5, lat: 9 }], []);
    const report = mergeRegions([makeRegion('a', a), makeRegion('b', b)]);
    expect(report.nodes).toBe(1);
    expect(report.graph.coords[0]).toBe(1.5);
    expect(report.graph.coords[1]).toBe(0);
    expect(report.sharedNodes).toBe(1);
  });

  it('does not collapse disjoint extracts', () => {
    const a = makeGraph([{ id: 1, lon: 0, lat: 0 }, { id: 2, lon: 1, lat: 0 }], [{ from: 1, to: 2 }]);
    const b = makeGraph([{ id: 90, lon: 40, lat: 40 }, { id: 91, lon: 41, lat: 40 }], [{ from: 90, to: 91 }]);
    const report = mergeRegions([makeRegion('a', a), makeRegion('b', b)]);
    expect(report.nodes).toBe(4);
    expect(report.sharedNodes).toBe(0);
    expect(report.components).toBe(2);
    expect(report.regionIds).toEqual(['a', 'b']);
  });

  it('merges a chain of three extracts sharing two seams', () => {
    const mkChain = (ids: number[]) =>
      makeGraph(
        ids.map((id) => ({ id, lon: id, lat: 0 })),
        ids.slice(0, -1).map((id) => ({ from: id, to: id + 1 })),
      );
    const report = mergeRegions([
      makeRegion('a', mkChain([1, 2])),
      makeRegion('b', mkChain([2, 3])),
      makeRegion('c', mkChain([3, 4])),
    ]);
    expect(report.nodes).toBe(4);
    expect(report.sharedNodes).toBe(2);
    expect(report.components).toBe(1);
  });

  it('records which region each surviving node came from', () => {
    const a = makeGraph([{ id: 1, lon: 0, lat: 0 }, { id: 2, lon: 1, lat: 0 }], [{ from: 1, to: 2 }]);
    const b = makeGraph([{ id: 2, lon: 1, lat: 0 }, { id: 3, lon: 2, lat: 0 }], [{ from: 2, to: 3 }]);
    const report = mergeRegions([makeRegion('a', a), makeRegion('b', b)]);
    expect([...(report.graph.regionOf ?? [])]).toEqual([0, 0, 1]);
  });

  it('drops a self-loop left over once shared nodes collapse', () => {
    const loop = makeGraph([{ id: 1, lon: 0, lat: 0 }], [{ from: 1, to: 1 }]);
    const report = mergeRegions([makeRegion('a', loop), makeRegion('b', loop)]);
    expect(report.nodes).toBe(1);
    expect(report.graph.edgeTo.length).toBe(0);
  });
});

describe('mergeRegions — edge dedup', () => {
  const nodes = [{ id: 1, lon: 0, lat: 0 }, { id: 2, lon: 1, lat: 0 }];
  /** A two-way road: two records, one per direction (this is what buildDataset emits). */
  const twoWay: EdgeSpec[] = [
    { from: 1, to: 2, flags: TWO_WAY },
    { from: 2, to: 1, flags: TWO_WAY },
  ];

  it('keeps the first extract’s name and cost for a duplicated road', () => {
    const report = mergeRegions([
      makeRegion('a', makeGraph(nodes, [{ from: 1, to: 2, name: 'First', cost: 11 }])),
      makeRegion('b', makeGraph(nodes, [{ from: 1, to: 2, name: 'Second', cost: 99 }])),
    ]);
    expect(report.graph.edgeName).toEqual(['First']);
    expect(report.graph.edgeCost[0]).toBe(11);
  });

  it('deduplicates a road seen in the same direction twice', () => {
    const report = mergeRegions([
      makeRegion('a', makeGraph(nodes, [{ from: 1, to: 2 }])),
      makeRegion('b', makeGraph(nodes, [{ from: 1, to: 2 }])),
    ]);
    expect(report.graph.edgeTo.length).toBe(1);
    expect(report.sharedNodes).toBe(2);
  });

  it('counts a road described in opposite directions as a shared edge', () => {
    const report = mergeRegions([
      makeRegion('a', makeGraph(nodes, [{ from: 1, to: 2 }])),
      makeRegion('b', makeGraph(nodes, [{ from: 2, to: 1 }])),
    ]);
    expect(report.sharedEdges).toBe(1);
  });

  it('keeps both records of a two-way road', () => {
    // `pairSlot` was keyed on the unordered node pair, so the reverse record of
    // the same road collided with the forward record already stored and hit the
    // `prior !== undefined -> continue` branch. The merged graph kept at most
    // ONE directed edge per node pair, i.e. every two-way road became a one-way
    // in an arbitrary direction. Dedup is per DIRECTED pair, so both records
    // survive; only a record from another extract is folded away.
    const report = mergeRegions([
      makeRegion('a', makeGraph(nodes, twoWay)),
      makeRegion('b', makeGraph(nodes, twoWay)),
    ]);
    expect(edgeSet(report.graph)).toEqual(['0->1 flags=3', '1->0 flags=3']);
    expect(traversable(report.graph)).toEqual(['0->1', '1->0']);
    // still exactly one *road*, counted once, however many directions it has
    expect(report.sharedEdges).toBe(1);
  });

  it('folds away only cross-extract duplicates, not a second copy of a two-way road', () => {
    // Two extracts of the same road: 4 records in, 2 out — one per direction.
    const report = mergeRegions([
      makeRegion('a', makeGraph(nodes, twoWay)),
      makeRegion('b', makeGraph(nodes, twoWay)),
    ]);
    expect(report.graph.edgeTo.length).toBe(2);
    // Three extracts, still two edges: the third copy folds into the first.
    const three = mergeRegions([
      makeRegion('a', makeGraph(nodes, twoWay)),
      makeRegion('b', makeGraph(nodes, twoWay)),
      makeRegion('c', makeGraph(nodes, twoWay)),
    ]);
    expect(three.graph.edgeTo.length).toBe(2);
    expect(three.sharedEdges).toBe(1);
  });

  it('keeps parallel one-ways over the same pair, in both directions', () => {
    // A node pair can carry several distinct records and they are not duplicates
    // of each other: two one-way streets pointing opposite ways share the same
    // unordered pair but not the same directed pair.
    const opposing = makeGraph(nodes, [
      { from: 1, to: 2, flags: FLAG_ONEWAY_F },
      { from: 2, to: 1, flags: FLAG_ONEWAY_F },
    ]);
    const report = mergeRegions([makeRegion('a', opposing), makeRegion('b', opposing)]);
    expect(report.graph.edgeTo.length).toBe(2);
    expect(edgeSet(report.graph)).toEqual(['0->1 flags=1', '1->0 flags=1']);
    expect(traversable(report.graph)).toEqual(['0->1', '1->0']);
  });

  it('a merged two-way road stays routable in both directions', () => {
    // The bug's real consequence: cross-region routing silently died one way.
    // Merging a chain with itself must leave all four records intact, so the
    // route survives in the reverse direction too — with contiguous geometry.
    const chain: NodeSpec[] = [
      { id: 1, lon: 0, lat: 0 },
      { id: 2, lon: 0.01, lat: 0 },
      { id: 3, lon: 0.02, lat: 0 },
    ];
    const chainEdges: EdgeSpec[] = [
      { from: 1, to: 2, flags: TWO_WAY },
      { from: 2, to: 1, flags: TWO_WAY },
      { from: 2, to: 3, flags: TWO_WAY },
      { from: 3, to: 2, flags: TWO_WAY },
    ];
    const single = makeGraph(chain, chainEdges);
    const before = routeOnGraph(single, [0.02, 0], [0, 0]);
    expect(before).not.toBeNull(); // the unmerged extract routes in reverse

    const report = mergeRegions([makeRegion('a', single), makeRegion('b', single)]);
    expect(report.graph.edgeTo.length).toBe(4); // was 2: both reverse records were dropped
    const legs: [[number, number], [number, number]][] = [
      [[0, 0], [0.02, 0]],
      [[0.02, 0], [0, 0]],
    ];
    for (const [from, to] of legs) {
      const r = routeOnGraph(report.graph, from, to);
      expect(r).not.toBeNull(); // the reverse leg used to be unreachable
      expect(r!.geometry.length).toBe(3); // both ends plus the middle node
      expect(maxGeometryJump(r!.geometry as [number, number][])).toBeLessThan(0.012);
      expect(r!.steps.map((s) => s.name).join('|')).toBe(
        before!.steps.map((s) => s.name).join('|'),
      );
    }
  });

  it('reports no shared edges for two extracts that share nothing', () => {
    const a = makeGraph([{ id: 1, lon: 0, lat: 0 }, { id: 2, lon: 1, lat: 0 }], twoWay);
    const b = makeGraph([{ id: 90, lon: 40, lat: 40 }, { id: 91, lon: 41, lat: 40 }], [
      { from: 90, to: 91, flags: TWO_WAY },
      { from: 91, to: 90, flags: TWO_WAY },
    ]);
    const report = mergeRegions([makeRegion('a', a), makeRegion('b', b)]);
    expect(report.sharedNodes).toBe(0);
    expect(report.sharedEdges).toBe(0);
    // both roads keep both directions
    expect(report.graph.edgeTo.length).toBe(4);
    expect(traversable(report.graph)).toEqual(['0->1', '1->0', '2->3', '3->2']);
  });

  it('merging a real extract with itself loses no road and no direction', () => {
    // The concrete measurement of the "one direction per pair" bug: fixture.osm
    // has 288 directed records over 144 roads, and the merged graph used to keep
    // exactly 144 of them. Merging an extract with itself must be a no-op on the
    // edge set.
    const ds = fixtureDataset();
    const undirected = new Set<number>();
    for (let i = 0; i < ds.graph.nodeCount; i++) {
      for (let e = ds.graph.edgeStart[i]; e < ds.graph.edgeStart[i + 1]; e++) {
        undirected.add(Math.min(i, ds.graph.edgeTo[e]) * 1e6 + Math.max(i, ds.graph.edgeTo[e]));
      }
    }
    expect(ds.graph.edgeTo.length).toBe(288);
    expect(undirected.size).toBe(144);

    const report = mergeRegions([regionOf('a', ds), regionOf('b', ds)]);
    expect(report.nodes).toBe(ds.graph.nodeCount);
    expect(report.sharedNodes).toBe(81);
    expect(report.components).toBe(1);
    expect(report.graph.edgeTo.length).toBe(288);
    expect(report.sharedEdges).toBe(144); // all 144 roads are in both extracts
    expect(deadEdges(report.graph)).toEqual([]);
    // The invariant behind the edge count: every direction of travel the extract
    // permits still exists after the merge, keyed by OSM id.
    expect(permissions(report.graph)).toEqual(permissions(ds.graph));
  });

  it('routes across a merged real extract in both directions', () => {
    const ds = fixtureDataset();
    const report = mergeRegions([regionOf('a', ds), regionOf('b', ds)]);
    const g = report.graph;

    // the two ends of the network, by longitude
    let lo = 0, hi = 0;
    for (let i = 1; i < g.nodeCount; i++) {
      if (g.coords[i * 2] < g.coords[lo * 2]) lo = i;
      if (g.coords[i * 2] > g.coords[hi * 2]) hi = i;
    }
    const A: [number, number] = [g.coords[lo * 2], g.coords[lo * 2 + 1]];
    const B: [number, number] = [g.coords[hi * 2], g.coords[hi * 2 + 1]];

    const legs: [[number, number], [number, number]][] = [[A, B], [B, A]];
    for (const [from, to] of legs) {
      const r = routeOnGraph(g, from, to);
      expect(r).not.toBeNull(); // was null in the reverse direction before the fix
      // contiguous geometry: every consecutive pair is a real edge, no seam
      expect(maxGeometryJump(r!.geometry as [number, number][])).toBeLessThan(0.012);
      // and identical to routing the unmerged extract
      const plain = routeOnGraph(ds.graph, from, to)!;
      expect(r!.metres).toBeCloseTo(plain.metres, 6);
      expect(r!.time).toBeCloseTo(plain.time, 3);
      expect(r!.geometry.length).toBe(plain.geometry.length);
    }
  });
});

describe('mergeRegions — one-way relaxation', () => {
  const nodes = [{ id: 1, lon: 0, lat: 0 }, { id: 2, lon: 1, lat: 0 }];

  it('does not make the road MORE restrictive than a two-way extract', () => {
    // Extract A says one-way forward; extract B says two-way. The union of the
    // two descriptions is two-way, so merging must not lose 2->1. Relaxing a
    // restriction means GRANTING the missing permission (`|=`), never masking
    // flags away (`&=`, which with F(1) & B(2) yields 0 and strands the road).
    const report = mergeRegions([
      makeRegion('a', makeGraph(nodes, [{ from: 1, to: 2, flags: FLAG_ONEWAY_F }])),
      makeRegion('b', makeGraph(nodes, [
        { from: 1, to: 2, flags: TWO_WAY },
        { from: 2, to: 1, flags: TWO_WAY },
      ])),
    ]);
    expect(traversable(report.graph)).toEqual(['0->1', '1->0']);
    expect(edgeSet(report.graph)).toEqual(['0->1 flags=3', '1->0 flags=3']);
    expect(routeOnGraph(report.graph, [1, 0], [0, 0])).not.toBeNull();
    expect(routeOnGraph(report.graph, [0, 0], [1, 0])).not.toBeNull();
  });

  it('relaxes two conflicting one-ways into a two-way road', () => {
    // A: one-way 1->2, recorded (0->1) with F. B: the same way listed
    // back-to-front as one-way 2->1, recorded (1->0) with F. Neither record is a
    // duplicate of the other — they are the two directions of one road — and
    // together they permit travel both ways.
    const report = mergeRegions([
      makeRegion('a', makeGraph(nodes, [{ from: 1, to: 2, flags: FLAG_ONEWAY_F }])),
      makeRegion('b', makeGraph(nodes, [{ from: 2, to: 1, flags: FLAG_ONEWAY_F }])),
    ]);
    expect(report.sharedEdges).toBe(1);
    expect(edgeSet(report.graph)).toEqual(['0->1 flags=1', '1->0 flags=1']);
    expect(traversable(report.graph)).toEqual(['0->1', '1->0']);
    expect(deadEdges(report.graph)).toEqual([]);
    // Both inputs were routable in one direction; so is the merge, in both.
    expect(routeOnGraph(report.graph, [0, 0], [1, 0])).not.toBeNull();
    expect(routeOnGraph(report.graph, [1, 0], [0, 0])).not.toBeNull();
  });

  it('never leaves an edge that permits travel in no direction', () => {
    // stepCost() needs FLAG_ONEWAY_F to walk an edge forward and
    // FLAG_ONEWAY_B to walk it backward, so flags === 0 is a road that cannot be
    // used at all — exactly what `flatFlags[i] &= FLAG_ONEWAY_B` produced.
    const road = (flags: number[]): RoadGraph => makeGraph(
      [{ id: 1, lon: 0, lat: 0 }, { id: 2, lon: 1, lat: 0 }],
      flags.map((f, i) => ({ from: i % 2 ? 2 : 1, to: i % 2 ? 1 : 2, flags: f })),
    );
    const scenarios: [string, RoadGraph, RoadGraph][] = [
      ['conflicting one-ways', road([FLAG_ONEWAY_F]), road([FLAG_ONEWAY_F])],
      ['one-way vs two-way', road([FLAG_ONEWAY_F]), road([TWO_WAY, TWO_WAY])],
      ['repeated one-way records', road([FLAG_ONEWAY_F, FLAG_ONEWAY_F]), road([FLAG_ONEWAY_F])],
      ['reverse one-ways', road([FLAG_ONEWAY_B, FLAG_ONEWAY_B]), road([FLAG_ONEWAY_B])],
      ['mixed directions', road([FLAG_ONEWAY_F, FLAG_ONEWAY_B]), road([TWO_WAY, TWO_WAY])],
      ['two-way vs two-way', road([TWO_WAY, TWO_WAY]), road([TWO_WAY, TWO_WAY])],
    ];
    for (const [name, a, b] of scenarios) {
      for (const regions of [[a, b], [a, b, b]]) {
        const g = mergeRegions(regions.map((rg, i) => makeRegion(`${name}-${i}`, rg))).graph;
        expect(deadEdges(g), name).toEqual([]);
        // The merge may relax a restriction (grant the union of what the
        // extracts permit) but must neither drop nor invent a direction.
        const allowed = new Set(regions.flatMap(permissions));
        for (const p of permissions(g)) expect(allowed, name).toContain(p);
        for (const p of allowed) expect(permissions(g), name).toContain(p);
      }
    }
    // the same guarantee on a real extract
    const ds = fixtureDataset();
    for (const regions of [[regionOf('a', ds)], [regionOf('a', ds), regionOf('b', ds)]]) {
      expect(deadEdges(mergeRegions(regions).graph)).toEqual([]);
    }
  });

  it('leaves a one-way in a single extract alone', () => {
    const a = makeGraph(nodes, [{ from: 1, to: 2, flags: FLAG_ONEWAY_F }]);
    const report = mergeRegions([makeRegion('only', a)]);
    expect(edgeSet(report.graph)).toEqual(['0->1 flags=1']);
    expect(traversable(report.graph)).toEqual(['0->1']);
  });

  it('leaves a reverse one-way (FLAG_ONEWAY_B only) alone', () => {
    // OSM oneway=-1: buildDataset stores the reversed record with B only, so
    // the forward search cannot use it (it requires FLAG_ONEWAY_F) — it exists
    // for the backward direction only, per stepCost() in engine.worker.ts.
    const a = makeGraph(nodes, [{ from: 2, to: 1, flags: FLAG_ONEWAY_B }]);
    const report = mergeRegions([makeRegion('only', a)]);
    expect(edgeSet(report.graph)).toEqual(['1->0 flags=2']);
    expect(traversable(report.graph)).toEqual([]);
  });
});

describe('diagnoseMerge', () => {
  it('describes a fully connected merge', () => {
    const nodes = [{ id: 1, lon: 0, lat: 0 }, { id: 2, lon: 1, lat: 0 }];
    const report = mergeRegions([
      makeRegion('a', makeGraph(nodes, [{ from: 1, to: 2 }])),
      makeRegion('b', makeGraph(nodes, [{ from: 2, to: 1 }])),
    ]);
    expect(report.components).toBe(1);
    const d = diagnoseMerge(report);
    expect(d).toBe(
      `${report.nodes.toLocaleString()} nodes, 1 components · 2 border nodes merged · fully connected`,
    );
  });

  it('omits the border clause when nothing was shared', () => {
    const g = makeGraph([{ id: 1, lon: 0, lat: 0 }, { id: 2, lon: 1, lat: 0 }], [{ from: 1, to: 2 }]);
    const d = diagnoseMerge(mergeRegions([makeRegion('solo', g)]));
    expect(d).toBe('2 nodes, 1 components · fully connected');
    expect(d).not.toContain('border nodes');
  });

  it('says "mostly connected" for a handful of components', () => {
    const g = makeGraph(
      [{ id: 1, lon: 0, lat: 0 }, { id: 2, lon: 1, lat: 0 }, { id: 3, lon: 9, lat: 9 }],
      [{ from: 1, to: 2 }],
    );
    const d = diagnoseMerge(mergeRegions([makeRegion('a', g)]));
    expect(d).toBe('3 nodes, 2 components · mostly connected');
  });

  it('warns when there are many components', () => {
    const nodes = Array.from({ length: 60 }, (_, i) => ({ id: i + 1, lon: i, lat: 0 }));
    const d = diagnoseMerge(mergeRegions([makeRegion('a', makeGraph(nodes, [{ from: 1, to: 2 }]))]));
    expect(d).toBe(
      `60 nodes, 59 components · WARNING: many disconnected components — the extracts may not be adjacent`,
    );
  });

  it('formats counts with locale grouping', () => {
    const nodes = Array.from({ length: 1500 }, (_, i) => ({ id: i + 1, lon: 0, lat: 0 }));
    const edges = Array.from({ length: 1499 }, (_, i) => ({ from: i + 1, to: i + 2 }));
    const d = diagnoseMerge(mergeRegions([makeRegion('a', makeGraph(nodes, edges))]));
    expect(d.startsWith((1500).toLocaleString())).toBe(true);
    expect(d).toContain('nodes, 1 components · fully connected');
  });
});