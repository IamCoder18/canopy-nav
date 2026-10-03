/**
 * Graph merging — combine adjacent .osm extracts into one routable network.
 *
 * Geofabrik (and any `osmium extract`) cuts province/state boundaries through
 * the OSM node topology: a road crossing the Alberta/BC border exists in both
 * extracts and references the *same* OSM node IDs on both sides. So merging is
 * a union-find over `osmIds`, and the border disappears completely — routing
 * across it is ordinary continuous road with no seam.
 *
 * This is why merging beats stitching two routes together at a boundary point.
 */

import type { RoadGraph } from './engine.worker';
import type { Region } from './regions';

/** Union-find with path halving. */
function makeDSU(n: number) {
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  return { find, union };
}

export interface MergeReport {
  graph: RoadGraph;
  nodes: number;
  /** duplicate OSM node ids collapsed across the boundary */
  sharedNodes: number;
  /** distinct roads present in more than one extract */
  sharedEdges: number;
  components: number;
  regionIds: string[];
}

/**
 * Unordered-pair key for two node slots, packed into one double.
 *
 * Exact only while `a * 2^32 + b` stays inside Number.MAX_SAFE_INTEGER, i.e.
 * below ~2^21 nodes; the direction bit doubles it again, halving that to
 * ~2^20. Comfortably beyond any extract this actually merges, but it is a hard
 * ceiling: a province-scale merge would need a non-numeric (nested-map or
 * string) key rather than a wider multiplier.
 */
function pairKey(a: number, b: number): number {
  return a < b ? a * 4294967296 + b : b * 4294967296 + a;
}

/**
 * Copy a graph so callers can never scribble on a region's dataset through the
 * merge result. Every multi-region merge already builds fresh arrays; making the
 * single-region case do the same keeps the "the report owns its graph" contract
 * uniform instead of handing back the caller's object by reference.
 */
function copyGraph(g: RoadGraph): RoadGraph {
  return {
    coords: g.coords.slice(),
    osmIds: g.osmIds.slice(),
    edgeStart: g.edgeStart.slice(),
    edgeTo: g.edgeTo.slice(),
    edgeCost: g.edgeCost.slice(),
    edgeFlags: g.edgeFlags.slice(),
    edgeName: g.edgeName.slice(),
    nodeCount: g.nodeCount,
    regionOf: g.regionOf ? g.regionOf.slice() : undefined,
  };
}

export function mergeRegions(regions: Region[]): MergeReport {
  if (regions.length === 0) throw new Error('mergeRegions: no regions');
  if (regions.length === 1) {
    const g = copyGraph(regions[0].dataset.graph);
    return {
      graph: g, nodes: g.nodeCount, sharedNodes: 0, sharedEdges: 0,
      components: countComponents(g), regionIds: [regions[0].id],
    };
  }

  /* ---------- pass 1: union slots that share an OSM node id ---------- */

  const offsets: number[] = [];
  let slotTotal = 0;
  for (const r of regions) {
    offsets.push(slotTotal);
    slotTotal += r.dataset.graph.nodeCount;
  }

  const dsu = makeDSU(slotTotal);
  const firstSeen = new Map<number, number>();
  let sharedNodes = 0;

  for (let ri = 0; ri < regions.length; ri++) {
    const g = regions[ri].dataset.graph;
    const base = offsets[ri];
    for (let i = 0; i < g.nodeCount; i++) {
      const id = g.osmIds[i];
      const prev = firstSeen.get(id);
      if (prev === undefined) firstSeen.set(id, base + i);
      else { dsu.union(prev, base + i); sharedNodes++; }
    }
  }

  /* ---------- pass 2: compact slots ---------- */

  const rootToSlot = new Map<number, number>();
  const slotOf = new Int32Array(slotTotal);
  const coords: number[] = [];
  const osmIds: number[] = [];
  const regionOf: number[] = [];

  for (let ri = 0; ri < regions.length; ri++) {
    const g = regions[ri].dataset.graph;
    const base = offsets[ri];
    for (let i = 0; i < g.nodeCount; i++) {
      const root = dsu.find(base + i);
      let slot = rootToSlot.get(root);
      if (slot === undefined) {
        slot = coords.length / 2;
        rootToSlot.set(root, slot);
        coords.push(g.coords[i * 2], g.coords[i * 2 + 1]);
        osmIds.push(g.osmIds[i]);
        regionOf.push(ri);
      }
      slotOf[base + i] = slot;
    }
  }

  const nodeCount = coords.length / 2;

  /* ---------- pass 3: collect deduped edges with explicit sources ---------- */

  // Dedup is keyed on the DIRECTED pair (from -> to), because the two records
  // of a two-way road are two genuinely different edges and both must survive:
  // buildDataset emits `a->b` and `b->a` for one untagged way. Keying on the
  // *unordered* pair instead makes the reverse record of every two-way road
  // collide with the forward record that is already stored, so every two-way
  // road collapses into a single arbitrarily-oriented one-way.
  //
  // `seen` therefore points at the first record stored for a directed pair, and
  // `flatRegion` remembers which extract stored it. Only a record from a
  // *different* extract is a duplicate to be folded away; a repeat inside one
  // extract is kept, because a single extract may legitimately hold parallel
  // ways (two one-ways over the same node pair, or the same way listed twice).
  const seen = new Map<number, number>(); // directed pair key -> index in the flat lists
  const flatRegion: number[] = []; // index -> region that stored the record
  const flatFrom: number[] = [];
  const flatTo: number[] = [];
  const flatCost: number[] = [];
  const flatFlags: number[] = [];
  const flatName: string[] = [];

  // `sharedEdges` counts roads present in more than one extract, which is a
  // property of the unordered pair but must be counted once per pair and never
  // for the second direction record of a single extract.
  const pairRegion = new Map<number, number>(); // unordered pair -> region that first claimed it
  const sharedPairs = new Set<number>(); // unordered pairs already counted
  let sharedEdges = 0;

  for (let ri = 0; ri < regions.length; ri++) {
    const g = regions[ri].dataset.graph;
    const base = offsets[ri];
    for (let i = 0; i < g.nodeCount; i++) {
      const from = slotOf[base + i];
      for (let e = g.edgeStart[i]; e < g.edgeStart[i + 1]; e++) {
        const to = slotOf[base + g.edgeTo[e]];
        if (from === to) continue; // self-loop once shared nodes collapse

        const pk = pairKey(from, to);
        const dir = from < to ? 0 : 1;

        // Keep track of duplicate undirected pairs across extracts.
        const firstRegion = pairRegion.get(pk);
        if (firstRegion === undefined) pairRegion.set(pk, ri);
        else if (firstRegion !== ri && !sharedPairs.has(pk)) {
          sharedPairs.add(pk);
          sharedEdges++;
        }

        // NOTE: `seen` is written *after* the duplicate branch. Writing it first
        // (as this loop used to) left the stored index one past the end of the
        // flat lists, so every later lookup for the pair read a hole and the
        // flag fix-ups that depend on a valid index could never run.
        const key = pk * 2 + dir;
        const prior = seen.get(key);
        if (prior !== undefined && flatRegion[prior] !== ri) {
          // The same directed road in a different extract. The two descriptions
          // may disagree about which directions it allows (one clipped it into a
          // one-way, the other kept the two-way), and the union of the
          // permissions is what keeps it routable. So GRANT the missing bits:
          // masking (`&=`) would clear the direction instead of relaxing it,
          // and since stepCost() requires FLAG_ONEWAY_F forward and
          // FLAG_ONEWAY_B backward, clearing both leaves a road that cannot be
          // travelled in either direction at all.
          flatFlags[prior] |= g.edgeFlags[e];
          continue;
        }

        // No separate repair pass is needed for the opposite direction: whatever
        // permits `to -> from` is either this record (stored just below, flags and
        // all) or the reverse record of the same pair, which has its own directed
        // key and is therefore stored as its own edge instead of being dropped as
        // a duplicate of the forward record.
        if (prior === undefined) seen.set(key, flatFrom.length);

        flatFrom.push(from);
        flatTo.push(to);
        flatCost.push(g.edgeCost[e]);
        flatFlags.push(g.edgeFlags[e]);
        flatName.push(g.edgeName[e]);
        flatRegion.push(ri);
      }
    }
  }

  /* ---------- pass 4: CSR layout ---------- */

  const edgeStart = new Uint32Array(nodeCount + 1);
  for (const f of flatFrom) edgeStart[f + 1]++;
  for (let i = 0; i < nodeCount; i++) edgeStart[i + 1] += edgeStart[i];

  const total = flatFrom.length;
  const edgeTo = new Int32Array(total);
  const edgeCost = new Float32Array(total);
  const edgeFlags = new Uint8Array(total);
  const edgeName = new Array<string>(total);
  const cursor = Uint32Array.from(edgeStart.subarray(0, nodeCount));

  for (let k = 0; k < total; k++) {
    const f = flatFrom[k];
    const w = cursor[f]++;
    edgeTo[w] = flatTo[k];
    edgeCost[w] = flatCost[k];
    edgeFlags[w] = flatFlags[k];
    edgeName[w] = flatName[k];
  }

  const graph: RoadGraph = {
    coords: new Float64Array(coords),
    osmIds: new Float64Array(osmIds),
    edgeStart,
    edgeTo,
    edgeCost,
    edgeFlags,
    edgeName,
    nodeCount,
    regionOf: Int32Array.from(regionOf),
  };

  return {
    graph,
    nodes: nodeCount,
    sharedNodes,
    sharedEdges,
    components: countComponents(graph),
    regionIds: regions.map((r) => r.id),
  };
}

/** Count weakly-connected components via union-find over the CSR edges. */
export function countComponents(g: RoadGraph): number {
  const dsu = makeDSU(g.nodeCount);
  for (let i = 0; i < g.nodeCount; i++) {
    for (let e = g.edgeStart[i]; e < g.edgeStart[i + 1]; e++) dsu.union(i, g.edgeTo[e]);
  }
  const roots = new Set<number>();
  for (let i = 0; i < g.nodeCount; i++) roots.add(dsu.find(i));
  return roots.size;
}

/**
 * Sanity check after a merge: the graph should still be connected enough to
 * route. Returns a short human-readable diagnosis.
 */
export function diagnoseMerge(report: MergeReport): string {
  const parts: string[] = [];
  parts.push(`${report.nodes.toLocaleString()} nodes, ${report.components.toLocaleString()} components`);
  if (report.sharedNodes) parts.push(`${report.sharedNodes.toLocaleString()} border nodes merged`);
  if (report.components === 1) parts.push('fully connected');
  else if (report.components < 50) parts.push('mostly connected');
  else parts.push('WARNING: many disconnected components — the extracts may not be adjacent');
  return parts.join(' · ');
}
