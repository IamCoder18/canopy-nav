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
import { mergeRegions, countComponents, diagnoseMerge } from '../src/osm/merge';
import { FLAG_ONEWAY_F, FLAG_ONEWAY_B, routeOnGraph, type RoadGraph } from '../src/osm/engine.worker';
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

  it('passes a single region through unchanged (same graph object)', () => {
    const g = makeGraph([{ id: 1, lon: 0, lat: 0 }, { id: 2, lon: 1, lat: 0 }], [{ from: 1, to: 2 }]);
    const report = mergeRegions([makeRegion('solo', g)]);
    expect(report.graph).toBe(g);
    expect(report.nodes).toBe(2);
    expect(report.sharedNodes).toBe(0);
    expect(report.sharedEdges).toBe(0);
    expect(report.components).toBe(1);
    expect(report.regionIds).toEqual(['solo']);
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

  it('BUG: drops the second direction of every two-way road', () => {
    // `pairSlot` is keyed on the unordered node pair, so the reverse record of
    // the same road collides with the forward record and hits the
    // `prior !== undefined -> continue` branch. A merged graph keeps at most
    // ONE directed edge per node pair, so every two-way road becomes one-way.
    const report = mergeRegions([
      makeRegion('a', makeGraph(nodes, twoWay)),
      makeRegion('b', makeGraph(nodes, twoWay)),
    ]);
    expect(edgeSet(report.graph)).toEqual(['0->1 flags=3']);
    expect(traversable(report.graph)).toEqual(['0->1']);
  });

  it.fails('keeps both directions of a two-way road', () => {
    const report = mergeRegions([
      makeRegion('a', makeGraph(nodes, twoWay)),
      makeRegion('b', makeGraph(nodes, twoWay)),
    ]);
    expect(traversable(report.graph)).toEqual(['0->1', '1->0']);
  });

  it('BUG: a merged two-way road is no longer routable in reverse', () => {
    const chain: [NodeSpec, NodeSpec, NodeSpec] = [
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
    expect(routeOnGraph(single, [0.02, 0], [0, 0])).not.toBeNull(); // works before merging

    const report = mergeRegions([makeRegion('a', single), makeRegion('b', single)]);
    expect(report.graph.edgeTo.length).toBe(2); // was 4 before the merge
    expect(routeOnGraph(report.graph, [0, 0], [0.02, 0])).not.toBeNull();
    expect(routeOnGraph(report.graph, [0.02, 0], [0, 0])).toBeNull(); // reverse is impossible
  });

  it.fails('a merged two-way road stays routable in both directions', () => {
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
    const report = mergeRegions([makeRegion('a', single), makeRegion('b', single)]);
    expect(report.graph.edgeTo.length).toBe(4);
    expect(routeOnGraph(report.graph, [0.02, 0], [0, 0])).not.toBeNull();
  });

  it('BUG: reports sharedEdges for two extracts that share nothing', () => {
    const a = makeGraph([{ id: 1, lon: 0, lat: 0 }, { id: 2, lon: 1, lat: 0 }], twoWay);
    const b = makeGraph([{ id: 90, lon: 40, lat: 40 }, { id: 91, lon: 41, lat: 40 }], [
      { from: 90, to: 91, flags: TWO_WAY },
      { from: 91, to: 90, flags: TWO_WAY },
    ]);
    const report = mergeRegions([makeRegion('a', a), makeRegion('b', b)]);
    expect(report.sharedNodes).toBe(0);
    // The counter is bumped by the two direction records inside each extract.
    expect(report.sharedEdges).toBe(2);
  });
});

describe('mergeRegions — one-way relaxation', () => {
  const nodes = [{ id: 1, lon: 0, lat: 0 }, { id: 2, lon: 1, lat: 0 }];

  it('does not make the road MORE restrictive than a two-way extract (BUG)', () => {
    // Extract A says one-way forward; extract B says two-way. The union of the
    // two descriptions is two-way, so merging must not lose 2->1.
    const report = mergeRegions([
      makeRegion('a', makeGraph(nodes, [{ from: 1, to: 2, flags: FLAG_ONEWAY_F }])),
      makeRegion('b', makeGraph(nodes, [
        { from: 1, to: 2, flags: TWO_WAY },
        { from: 2, to: 1, flags: TWO_WAY },
      ])),
    ]);
    expect(traversable(report.graph)).toEqual(['0->1']);
  });

  it.fails('keeps the two-way direction when merging a two-way and a one-way extract', () => {
    const report = mergeRegions([
      makeRegion('a', makeGraph(nodes, [{ from: 1, to: 2, flags: FLAG_ONEWAY_F }])),
      makeRegion('b', makeGraph(nodes, [
        { from: 1, to: 2, flags: TWO_WAY },
        { from: 2, to: 1, flags: TWO_WAY },
      ])),
    ]);
    expect(traversable(report.graph)).toEqual(['0->1', '1->0']);
  });

  it('turns a conflicting pair of one-ways into a road that is impassable', () => {
    // A: one-way 1->2 (record (0->1) flags=F). B: the same way listed
    // back-to-front as one-way 2->1 (record (1->0) flags=F). This is the only
    // input that reaches the "relax the restriction" branch, and it does the
    // exact opposite of relaxing:
    //   flatFlags[storedIdx] &= FLAG_ONEWAY_B   // F(1) & 2 === 0
    //   reverseIdx = seen.get(pk*2+1)          // the entry inserted 2 lines
    //                                              above, i.e. past the end
    //   flatFlags[reverseIdx] &= FLAG_ONEWAY_B  // undefined & 2 === 0
    // Net: one edge with flags 0, which the engine cannot traverse either way.
    const report = mergeRegions([
      makeRegion('a', makeGraph(nodes, [{ from: 1, to: 2, flags: FLAG_ONEWAY_F }])),
      makeRegion('b', makeGraph(nodes, [{ from: 2, to: 1, flags: FLAG_ONEWAY_F }])),
    ]);
    expect(report.sharedEdges).toBe(1);
    expect(edgeSet(report.graph)).toEqual(['0->1 flags=0']);
    expect(traversable(report.graph)).toEqual([]);
    // Both inputs were routable in one direction; the merge is routable in none.
    expect(routeOnGraph(report.graph, [0, 0], [1, 0])).toBeNull();
  });

  it.fails('relaxes two conflicting one-ways into a two-way road', () => {
    const report = mergeRegions([
      makeRegion('a', makeGraph(nodes, [{ from: 1, to: 2, flags: FLAG_ONEWAY_F }])),
      makeRegion('b', makeGraph(nodes, [{ from: 2, to: 1, flags: FLAG_ONEWAY_F }])),
    ]);
    expect(traversable(report.graph)).toEqual(['0->1', '1->0']);
  });

  it.fails('never leaves an edge that permits travel in no direction', () => {
    const report = mergeRegions([
      makeRegion('a', makeGraph(nodes, [{ from: 1, to: 2, flags: FLAG_ONEWAY_F }])),
      makeRegion('b', makeGraph(nodes, [{ from: 2, to: 1, flags: FLAG_ONEWAY_F }])),
    ]);
    for (let e = 0; e < report.graph.edgeFlags.length; e++) {
      expect(report.graph.edgeFlags[e]).toBeGreaterThan(0);
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