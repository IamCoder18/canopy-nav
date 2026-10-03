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
import { FLAG_ONEWAY_B } from './engine.worker';
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

/** Unordered-pair key, safe for node counts up to ~2^31. */
function pairKey(a: number, b: number): number {
  return a < b ? a * 4294967296 + b : b * 4294967296 + a;
}

export function mergeRegions(regions: Region[]): MergeReport {
  if (regions.length === 0) throw new Error('mergeRegions: no regions');
  if (regions.length === 1) {
    const g = regions[0].dataset.graph;
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

  // A directed edge (from -> to). Dedup per unordered pair + direction, since
  // the two directions of a road are genuinely separate edges.
  const seen = new Map<number, number>(); // packed pair -> index in the flat lists
  const flatFrom: number[] = [];
  const flatTo: number[] = [];
  const flatCost: number[] = [];
  const flatFlags: number[] = [];
  const flatName: string[] = [];
  let sharedEdges = 0;

  const pairSlot = new Map<number, number>(); // unordered pair -> first edge index

  for (let ri = 0; ri < regions.length; ri++) {
    const g = regions[ri].dataset.graph;
    const base = offsets[ri];
    for (let i = 0; i < g.nodeCount; i++) {
      const from = slotOf[base + i];
      for (let e = g.edgeStart[i]; e < g.edgeStart[i + 1]; e++) {
        const to = slotOf[base + g.edgeTo[e]];
        if (from === to) continue; // self-loop once shared nodes collapse

        const pk = pairKey(from, to);
        const directedKey = pk * 2 + (from < to ? 0 : 1);
        if (seen.has(directedKey)) continue;
        seen.set(directedKey, flatFrom.length);

        // Keep track of duplicate undirected pairs across extracts.
        const prior = pairSlot.get(pk);
        if (prior !== undefined) {
          sharedEdges++;
          // If this extract says the road is bidirectional but the stored copy
          // was one-way, relax the restriction rather than lose connectivity.
          if (!(g.edgeFlags[e] & FLAG_ONEWAY_B)) {
            const storedIdx = prior;
            // clear one-way on the stored forward edge
            flatFlags[storedIdx] &= FLAG_ONEWAY_B;
            const storedTo = flatTo[storedIdx];
            const reverseIdx = seen.get(pairKey(from, to) * 2 + 1);
            if (reverseIdx !== undefined) {
              flatFlags[reverseIdx] &= FLAG_ONEWAY_B;
            } else {
              // add the missing reverse direction
              flatFrom.push(storedTo);
              flatTo.push(from);
              flatCost.push(g.edgeCost[e]);
              flatFlags.push(FLAG_ONEWAY_B);
              flatName.push(g.edgeName[e]);
              seen.set(pairKey(from, to) * 2 + 1, flatFrom.length - 1);
            }
          }
          continue;
        }
        pairSlot.set(pk, flatFrom.length);

        flatFrom.push(from);
        flatTo.push(to);
        flatCost.push(g.edgeCost[e]);
        flatFlags.push(g.edgeFlags[e]);
        flatName.push(g.edgeName[e]);
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
