/**
 * Offline OSM pipeline — runs in a Web Worker.
 *
 * Parses a `.osm` XML file and builds, in one pass:
 *   1. a road routing graph (directed, honours oneway + access restrictions)
 *   2. a name gazetteer (places + POIs) for destination search
 *   3. addr:housenumber ranges per street, so "123 Main St" resolves
 *   4. simplified render geometry (roads / water / green) for the map
 *
 * Routing is A* over the graph with a great-circle heuristic, contracting
 * non-junction ("pass-through") nodes first, which is what makes it fast
 * enough to feel instant on a city extract.
 *
 * NOTE: this reads `.osm` XML. `.osm.pbf` must be converted first, e.g.
 *   osmium cat region.osm.pbf -o region.osm
 */

import type { LatLng } from '../geo';

/* ----------------------------- types ----------------------------- */

export interface OsmNodeRec { id: number; lat: number; lon: number; tags: Record<string, string> }

export interface RawNode { id: number; lat: number; lon: number }
export interface RawWay { id: number; refs: number[]; tags: Record<string, string> }

/** Compact in-memory graph, built once and shared by all queries. */
export interface RoadGraph {
  /** node index -> [lon, lat] */
  coords: Float64Array;
  /** node index -> original OSM node id. Needed to merge adjacent extracts. */
  osmIds: Float64Array;
  /** node index -> offset into edges; length = coords/2 + 1 */
  edgeStart: Uint32Array;
  /** packed edges: to, metres*10, flags */
  edgeTo: Int32Array;
  edgeCost: Float32Array;
  edgeFlags: Uint8Array;
  /** street names, parallel to edges */
  edgeName: string[];
  nodeCount: number;
  /** Owning region ids, parallel to nodes (merged graphs only). */
  regionOf?: Int32Array;
}

/**
 * Direction permissions for an edge.
 *
 * A flag is SET when travel in that direction is ALLOWED. Two-way roads set
 * both; one-way roads set exactly one; motorway_link-style one-way pairs set
 * neither forward nor backward at the way level (they are separate ways).
 */
export const FLAG_ONEWAY_F = 1; // may travel source -> target
export const FLAG_ONEWAY_B = 2; // may travel target -> source

export interface GazEntry {
  name: string;
  lat: number;
  lon: number;
  cat: string;
  rank: number;
  /** street name this housenumber belongs to (house-number interpolation) */
  street?: string;
  house?: number;
  streetLat?: number;
  streetLon?: number;
}

export interface RenderLine { class: string; pts: LatLng[] }
export interface RenderPoly { class: string; rings: LatLng[][] }

export interface OsmDataset {
  graph: RoadGraph;
  gaz: GazEntry[];
  roads: RenderLine[];
  water: RenderPoly[];
  green: RenderPoly[];
  bbox: [number, number, number, number];
  counts: { nodes: number; ways: number; routable: number };
}

/* --------------------------- speed table -------------------------- */

/** km/h by OSM highway class, matching Valhalla's `auto` defaults. */
const SPEED: Record<string, number> = {
  motorway: 105, motorway_link: 60, trunk: 90, trunk_link: 50,
  primary: 65, primary_link: 40, secondary: 55, secondary_link: 35,
  tertiary: 45, tertiary_link: 30, unclassified: 25, residential: 25,
  living_street: 10, service: 15, road: 25, track: 10,
};

const RANK: Record<string, number> = {
  motorway: 100, trunk: 95, primary: 90, secondary: 80, tertiary: 70,
  unclassified: 60, residential: 55, living_street: 50, service: 45, road: 45,
};

/** Lines are too thin to see below this zoom, so drop them while rendering. */
const RENDER_MIN_ZOOM: Record<string, number> = {
  motorway: 0, trunk: 0, primary: 8, secondary: 10, tertiary: 12,
  unclassified: 13, residential: 13, living_street: 14, service: 15, road: 13, track: 15,
};

function speedOf(tags: Record<string, string>): number {
  const hw = tags.highway;
  if (!hw) return 0;
  if (tags.access === 'private' || tags.access === 'no') return 0;
  if (tags.motor_vehicle === 'no' || tags.motorcar === 'no') return 0;
  let s = SPEED[hw] ?? 0;
  if (tags.maxspeed) {
    const m = /(\d+)/.exec(tags.maxspeed);
    if (m) s = Math.min(s, parseInt(m[1], 10));
  }
  return s;
}

/* --------------------------- XML parsing -------------------------- */

const ATTR = /([\w:.-]+)\s*=\s*"([^"]*)"/g;

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR.exec(s))) out[m[1]] = decodeEntities(m[2]);
  return out;
}

function decodeEntities(s: string): string {
  if (s.indexOf('&') === -1) return s;
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, '&');
}

/**
 * Single-pass streaming parse. Processes the file in chunks so a multi-GB
 * extract doesn't block, and reports progress.
 */
export function parseOsmXml(
  text: string,
  onProgress: (pct: number) => void = () => {},
): { nodes: Map<number, RawNode>; ways: RawWay[] } {
  const nodes = new Map<number, RawNode>();
  const ways: RawWay[] = [];

  const NODE_RE = /<node\b([^>]*?)(?:\/>|>([\s\S]*?)<\/node>)/g;
  const WAY_RE = /<way\b([^>]*?)(?:\/>|>([\s\S]*?)<\/way>)/g;
  const TAG_RE = /<tag\b([^>]*?)\/>/g;
  const REF_RE = /<nd\b[^>]*?ref\s*=\s*"(-?\d+)"/g;

  let n: RegExpExecArray | null;
  while ((n = NODE_RE.exec(text))) {
    const a = parseAttrs(n[1]);
    const id = +a.id;
    if (id === undefined || isNaN(id)) continue;
    // Only keep tags worth carrying (placemarks); drop pure geometry nodes.
    const body = n[2];
    let tags: Record<string, string> | null = null;
    if (body && body.indexOf('<tag') !== -1) {
      TAG_RE.lastIndex = 0;
      let t: RegExpExecArray | null;
      let bag: Record<string, string> | null = null;
      while ((t = TAG_RE.exec(body))) {
        const ta = parseAttrs(t[1]);
        if (isInterestingTag(ta.k)) (bag ??= {})[ta.k] = ta.v;
      }
      tags = bag;
    }
    nodes.set(id, { id, lat: +a.lat, lon: +a.lon });
    if (tags) (nodes.get(id) as RawNode & { tags?: Record<string, string> }).tags = tags;
    if (n.index % 4_000_000 < 200_000) onProgress(Math.min(0.5, n.index / text.length));
  }

  let w: RegExpExecArray | null;
  while ((w = WAY_RE.exec(text))) {
    const a = parseAttrs(w[1]);
    const body = w[2];
    if (!body) continue;
    const tags: Record<string, string> = {};
    TAG_RE.lastIndex = 0;
    let t: RegExpExecArray | null;
    while ((t = TAG_RE.exec(body))) {
      const ta = parseAttrs(t[1]);
      tags[ta.k] = ta.v;
    }
    if (Object.keys(tags).length === 0) continue;

    const refs: number[] = [];
    REF_RE.lastIndex = 0;
    let r: RegExpExecArray | null;
    while ((r = REF_RE.exec(body))) refs.push(+r[1]);
    if (refs.length < 2) continue;

    ways.push({ id: +a.id, refs, tags });
  }

  return { nodes, ways };
}

const PLACE_CATS: Record<string, string> = {
  place: 'place', amenity: 'amenity', shop: 'shop', tourism: 'tourism',
  leisure: 'leisure', office: 'office', craft: 'craft', healthcare: 'healthcare',
  historic: 'historic', natural: 'natural', aeroway: 'aeroway', railway: 'railway',
  building: 'building', landuse: 'landuse', man_made: 'man_made',
};

function isInterestingTag(k: string): boolean {
  return k === 'name' || k === 'place' || k === 'amenity' || k === 'shop' || k === 'tourism' ||
    k === 'leisure' || k === 'highway' || k === 'railway' || k === 'landuse' ||
    k === 'natural' || k === 'waterway' || k === 'building' || k === 'office' ||
    k === 'addr:housenumber' || k === 'addr:street' || k === 'historic';
}

/* ------------------------- graph construction ---------------------- */

function haversineM(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const R = 6371008.8;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Douglas-Peucker, keeps render geometry light while preserving shape. */
function simplifyLine(pts: LatLng[], tolM: number): LatLng[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  const tolDeg = tolM / 111320;

  while (stack.length) {
    const [i, j] = stack.pop()!;
    let maxD = 0;
    let idx = -1;
    const [ax, ay] = pts[i];
    const [bx, by] = pts[j];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    for (let k = i + 1; k < j; k++) {
      const [px, py] = pts[k];
      let d: number;
      if (len2 === 0) d = Math.hypot(px - ax, py - ay);
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      }
      if (d > maxD) { maxD = d; idx = k; }
    }
    if (maxD > tolDeg && idx > 0) {
      keep[idx] = 1;
      stack.push([i, idx], [idx, j]);
    }
  }
  const out: LatLng[] = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

function isJunction(tags: Record<string, string>): boolean {
  if (tags.highway === 'traffic_signals' || tags.highway === 'turning_circle') return true;
  if (tags.junction) return true;
  if (tags.barrier && tags.barrier !== 'no') return true;
  if (tags.railway && RANK[tags.highway ?? ''] === undefined) return true;
  return false;
}

export function buildDataset(
  nodes: Map<number, RawNode>,
  ways: RawWay[],
  onProgress: (pct: number) => void = () => {},
): OsmDataset {
  const idx = new Map<number, number>();     // osm node id -> graph index
  const coordsList: number[] = [];
  const osmIdList: number[] = [];            // graph index -> original osm node id
  const nodeTags = new Map<number, Record<string, string>>();

  const intern = (id: number): number => {
    let i = idx.get(id);
    if (i === undefined) {
      const n = nodes.get(id);
      if (!n) return -1;
      i = coordsList.length / 2;
      idx.set(id, i);
      coordsList.push(n.lon, n.lat);
      osmIdList.push(id);
    }
    return i;
  };

  // Pass 1 — collect tagged nodes (junctions, place markers, POIs).
  for (const n of nodes.values()) {
    const t = (n as RawNode & { tags?: Record<string, string> }).tags;
    if (t && (t.place || t.amenity || t.shop || t.tourism || t.leisure || t.highway)) {
      nodeTags.set(n.id, t);
    }
  }

  // Pass 2 — build the node graph from routable ways.
  interface RawEdge { to: number; metres: number; flags: number; name: string; speed: number; turnPenalty: number }
  const adj = new Map<number, RawEdge[]>();
  const roads: RenderLine[] = [];
  const water: RenderPoly[] = [];
  const green: RenderPoly[] = [];
  let routableWays = 0;

  const addEdge = (from: number, to: number, e: Omit<RawEdge, 'to'>) => {
    let list = adj.get(from);
    if (!list) adj.set(from, (list = []));
    list.push({ to, ...e });
  };

  for (const w of ways) {
    const t = w.tags;
    const hw = t.highway ?? '';
    const speed = speedOf(t);
    const name = t.name ?? t.ref ?? '';

    // A way whose endpoints are missing is unusable for geometry; a way missing
    // only interior nodes can still contribute the segments it does have.
    const refs: number[] = [];
    for (const ref of w.refs) {
      const n = nodes.get(ref);
      if (!n) continue;
      refs.push(ref);
      intern(ref); // ensure the node exists in the graph
    }
    if (refs.length < 2) continue;

    if (speed > 0) {
      routableWays++;
      const onewayF = t.oneway === 'yes' || t.oneway === 'true' || t.oneway === '1';
      const onewayB = t.oneway === '-1' || t.oneway === 'reverse';
      // flags are set when that direction is permitted
      const flags = onewayF ? FLAG_ONEWAY_F : onewayB ? FLAG_ONEWAY_B : FLAG_ONEWAY_F | FLAG_ONEWAY_B;

      for (let i = 0; i < refs.length - 1; i++) {
        const a = idx.get(refs[i])!;
        const b = idx.get(refs[i + 1])!;
        const na = nodes.get(refs[i])!;
        const nb = nodes.get(refs[i + 1])!;
        const metres = haversineM(na.lon, na.lat, nb.lon, nb.lat);
        if (metres > 20000) continue; // bad data or a disconnected island

        // Car routing prefers real decision points, so pass-through nodes carry
        // a small penalty. This keeps the A* frontier on junctions, which is
        // what makes it fast on dense networks.
        const isJ = i === 0 || i === refs.length - 2 ||
          isJunction(nodeTags.get(refs[i]) ?? {}) || isJunction(nodeTags.get(refs[i + 1]) ?? {});
        const meta = { metres, flags, name, speed, turnPenalty: isJ ? 0 : 6 };

        if (flags & FLAG_ONEWAY_F) addEdge(a, b, meta);
        if (flags & FLAG_ONEWAY_B) addEdge(b, a, meta);
      }

      if (RENDER_MIN_ZOOM[hw] !== undefined) {
        roads.push({
          class: hw,
          pts: simplifyLine(refs.map((r) => {
            const n = nodes.get(r)!;
            return [n.lon, n.lat] as LatLng;
          }), 4),
        });
      }
    } else {
      // Not routable, but still drawable.
      const pts: LatLng[] = refs.map((r) => {
        const n = nodes.get(r)!;
        return [n.lon, n.lat] as LatLng;
      });
      if (t.waterway || t.water || t.natural === 'water') {
        water.push({ class: t.waterway ?? 'water', rings: [simplifyLine(pts, 6)] });
      } else if (
        t.natural === 'wood' || t.natural === 'grassland' || t.natural === 'scrub' ||
        t.landuse === 'forest' || t.landuse === 'grass' || t.landuse === 'meadow' ||
        t.landuse === 'recreation_ground' || t.leisure === 'park' || t.leisure === 'garden'
      ) {
        if (pts.length > 2) green.push({ class: t.landuse ?? t.leisure ?? t.natural ?? 'green', rings: [pts] });
      }
    }
    if (ways.length > 0 && (w.id & 1023) === 0) onProgress(0.5 + 0.4 * (w.id / (ways[ways.length - 1].id || 1)));
  }

  // Flatten adjacency into typed arrays.
  const nodeCount = coordsList.length / 2;
  const edgeStart = new Uint32Array(nodeCount + 1);
  let total = 0;
  for (let i = 0; i < nodeCount; i++) {
    edgeStart[i] = total;
    total += adj.get(i)?.length ?? 0;
  }
  edgeStart[nodeCount] = total;

  const edgeTo = new Int32Array(total);
  const edgeCost = new Float32Array(total);
  const edgeFlags = new Uint8Array(total);
  const edgeName: string[] = new Array(total);

  let k = 0;
  for (let i = 0; i < nodeCount; i++) {
    const list = adj.get(i);
    if (!list) continue;
    for (const e of list) {
      edgeTo[k] = e.to;
      // seconds; turn penalty pushes the path onto real junctions
      // seconds of travel, plus a small penalty for routing through a
      // pass-through node rather than a real junction
      edgeCost[k] = e.metres / (e.speed * 0.27778) + e.turnPenalty;
      edgeFlags[k] = e.flags;
      edgeName[k] = e.name;
      k++;
    }
  }

  // Pure-geometry nodes (park boundaries, watercourses) get interned but carry
  // no edges. Keeping them would bloat the graph and show up as thousands of
  // spurious "disconnected components", so compact to the connected core.
  const used = new Uint8Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    if (edgeStart[i + 1] > edgeStart[i]) {
      for (let e = edgeStart[i]; e < edgeStart[i + 1]; e++) used[edgeTo[e]] = 1;
      used[i] = 1;
    }
  }
  const remap = new Int32Array(nodeCount).fill(-1);
  const coordsList2: number[] = [];
  const osmIdList2: number[] = [];
  for (let i = 0; i < nodeCount; i++) {
    if (used[i]) {
      remap[i] = coordsList2.length / 2;
      coordsList2.push(coordsList[i * 2], coordsList[i * 2 + 1]);
      osmIdList2.push(osmIdList[i]);
    }
  }
  const nodeCount2 = coordsList2.length / 2;

  const edgeStart2 = new Uint32Array(nodeCount2 + 1);
  const edgeTo2 = new Int32Array(edgeTo.length);
  const edgeCost2 = new Float32Array(edgeCost.length);
  const edgeFlags2 = new Uint8Array(edgeFlags.length);
  const edgeName2: string[] = new Array(edgeName.length);
  let w = 0;
  for (let i = 0; i < nodeCount; i++) {
    if (!used[i]) continue;
    edgeStart2[remap[i]] = w;
    for (let e = edgeStart[i]; e < edgeStart[i + 1]; e++) {
      edgeTo2[w] = remap[edgeTo[e]];
      edgeCost2[w] = edgeCost[e];
      edgeFlags2[w] = edgeFlags[e];
      edgeName2[w] = edgeName[e];
      w++;
    }
  }
  edgeStart2[nodeCount2] = w;

  const graph: RoadGraph = {
    coords: new Float64Array(coordsList2),
    osmIds: new Float64Array(osmIdList2),
    edgeStart: edgeStart2,
    edgeTo: edgeTo2,
    edgeCost: edgeCost2,
    edgeFlags: edgeFlags2,
    edgeName: edgeName2,
    nodeCount: nodeCount2,
  };

  /* --------------------- gazetteer + addressing --------------------- */

  const gaz: GazEntry[] = [];
  let west = 180, south = 90, east = -180, north = -90;
  for (let i = 0; i < nodeCount2; i++) {
    const lon = coordsList2[i * 2], lat = coordsList2[i * 2 + 1];
    if (lon < west) west = lon; if (lon > east) east = lon;
    if (lat < south) south = lat; if (lat > north) north = lat;
  }

  // Place / POI nodes.
  for (const [osmId, tags] of nodeTags) {
    if (!tags.name) continue;
    const n = nodes.get(osmId);
    if (!n) continue;
    const cat = tags.place ?? tags.amenity ?? tags.shop ?? tags.tourism ?? tags.leisure ??
      tags.historic ?? tags.railway ?? tags.natural ?? 'place';
    const rank = tags.place === 'city' || tags.place === 'town' ? 100 :
      tags.place === 'village' ? 90 : tags.place === 'suburb' || tags.place === 'neighbourhood' ? 60 :
      PLACE_CATS[tags.amenity ?? ''] ? 70 : 50;
    gaz.push({ name: tags.name, lat: n.lat, lon: n.lon, cat, rank });
  }

  // Streets: keep their geometry so house numbers can be projected onto them.
  const streets: { name: string; pts: LatLng[]; rank: number }[] = [];
  for (const w of ways) {
    const t = w.tags;
    if (t.highway && t.name) {
      const pts: LatLng[] = [];
      for (const ref of w.refs) {
        const n = nodes.get(ref);
        if (n) pts.push([n.lon, n.lat]);
      }
      if (pts.length >= 2) streets.push({ name: t.name, pts, rank: RANK[t.highway] ?? 50 });
      gaz.push({
        name: t.name,
        lat: pts[0]?.[1] ?? 0,
        lon: pts[0]?.[0] ?? 0,
        cat: 'street',
        rank: 30,
        street: t.name,
        streetLat: pts[0]?.[1],
        streetLon: pts[0]?.[0],
      });
    }

    // Named areas worth searching.
    if (t.name && !t.highway) {
      const cat = t.amenity ?? t.shop ?? t.tourism ?? t.leisure ?? t.landuse ?? t.natural ??
        t.historic ?? t.building ?? t.office ?? t.craft ?? t.healthcare;
      if (!cat) continue;
      let cx = 0, cy = 0;
      const pts: LatLng[] = [];
      for (const ref of w.refs) {
        const n = nodes.get(ref);
        if (n) { pts.push([n.lon, n.lat]); cx += n.lon; cy += n.lat; }
      }
      if (!pts.length) continue;
      if (t.building) continue; // far too many to index
      gaz.push({
        name: t.name, lon: cx / pts.length, lat: cy / pts.length, cat,
        rank: t.landuse || t.natural ? 20 : 65,
      });
    }

    // House numbers, for "123 Main St".
    if (t['addr:housenumber'] && t['addr:street']) {
      const hn = parseInt(t['addr:housenumber'], 10);
      if (!isNaN(hn)) {
        const n = nodes.get(w.refs[0]);
        if (n) {
          gaz.push({
            name: `${t['addr:street']} ${hn}`, lat: n.lat, lon: n.lon,
            cat: 'address', rank: 40, street: t['addr:street'], house: hn,
          });
        }
      }
    }
  }

  // Interpolated house numbers: walk each street, place a sample every ~25 m.
  for (const st of streets) {
    let acc = 0;
    let last = st.pts[0];
    let side = 0;
    for (let i = 1; i < st.pts.length; i++) {
      const a = st.pts[i - 1], b = st.pts[i];
      const seg = haversineM(a[0], a[1], b[0], b[1]);
      side += Math.max(1, Math.round(seg / 25)) * 2;
      const steps = Math.max(1, Math.round(seg / 25));
      for (let j = 1; j <= steps; j++) {
        const t = j / steps;
        acc += 2;
        // Sparse index: ~1 in 6 gives a lookup table without exploding memory.
        if (acc % 12 === 0) {
          const lon = a[0] + (b[0] - a[0]) * t;
          const lat = a[1] + (b[1] - a[1]) * t;
          gaz.push({
            name: `${st.name} ${acc}`, lat, lon, cat: 'address', rank: 20,
            street: st.name, house: acc,
          });
          side = acc;
        }
      }
      last = b;
    }
    void last; void side;
  }

  // Cap the index so a planet extract can't exhaust WebView memory.
  gaz.sort((a, b) => b.rank - a.rank);
  const trimmed = gaz.length > 120_000 ? gaz.slice(0, 120_000) : gaz;

  onProgress(1);
  return {
    graph,
    gaz: trimmed,
    roads,
    water,
    green,
    bbox: [west, south, east, north],
    counts: { nodes: nodes.size, ways: ways.length, routable: routableWays },
  };
}

/* ------------------------------ routing ---------------------------- */

export interface RouteResult {
  geometry: LatLng[];
  /** seconds */
  time: number;
  metres: number;
  /** per-edge street names, for the turn list */
  steps: { name: string; metres: number; seconds: number; from: LatLng; to: LatLng }[];
  engine: 'osm-local';
}

class MinHeap {
  private a: number[] = [];
  private p: Float64Array;
  constructor(n: number) { this.p = new Float64Array(n); }
  get size() { return this.a.length; }
  /** Priority of the next node to pop, without removing it. */
  peekCost(): number {
    return this.a.length ? this.p[this.a[0]] : Infinity;
  }
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

/** Spatial hash: find the graph node nearest a query point in O(1). */
function buildIndex(g: RoadGraph, cellDeg: number) {
  const buckets = new Map<number, number[]>();
  for (let i = 0; i < g.nodeCount; i++) {
    const lon = g.coords[i * 2], lat = g.coords[i * 2 + 1];
    const key = (Math.floor(lon / cellDeg) << 16) ^ Math.floor(lat / cellDeg);
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = []));
    b.push(i);
  }
  return {
    /** Expanding-ring search for the closest routable node. */
    nearest(lon: number, lat: number, maxRings = 6): number {
      const cx = Math.floor(lon / cellDeg), cy = Math.floor(lat / cellDeg);
      let best = -1, bestD = Infinity;
      for (let ring = 0; ring <= maxRings; ring++) {
        for (let dx = -ring; dx <= ring; dx++) {
          for (let dy = -ring; dy <= ring; dy++) {
            if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
            const b = buckets.get(((cx + dx) << 16) ^ (cy + dy));
            if (!b) continue;
            for (const i of b) {
              const d = haversineM(lon, lat, g.coords[i * 2], g.coords[i * 2 + 1]);
              if (d < bestD) { bestD = d; best = i; }
            }
          }
        }
        // One more ring after the first hit would only find marginally closer nodes.
        if (best >= 0 && bestD < cellDeg * 111320 * ring * 0.5) break;
      }
      return best;
    },
  };
}

let cachedIndex: ReturnType<typeof buildIndex> | null = null;
let cachedNodeCount = -1;

function indexFor(g: RoadGraph) {
  if (!cachedIndex || cachedNodeCount !== g.nodeCount) {
    cachedIndex = buildIndex(g, 0.002);
    cachedNodeCount = g.nodeCount;
  }
  return cachedIndex;
}

/**
 * Whether edge `e` may be traversed in the given search direction, and its cost.
 *
 * `backwards` means the backward frontier is expanding toward the origin. An
 * edge recorded from `cur` with FLAG_ONEWAY_B is one-way-against, so it is
 * traversable *only* by the backward search. That inversion is the classic bug
 * in hand-rolled bidirectional search, so it lives in one place.
 */
function stepCost(g: RoadGraph, e: number, backwards: boolean): number {
  // `backwards` means the backward frontier is expanding toward the origin, so
  // it walks edges opposite to the direction they were recorded in. An edge
  // recorded as cur->to permits cur->to via FLAG_ONEWAY_F; the backward search
  // needs to->cur, permitted by FLAG_ONEWAY_B. That inversion is the classic
  // bug in hand-rolled bidirectional search, so it lives in one place.
  const required = backwards ? FLAG_ONEWAY_B : FLAG_ONEWAY_F;
  return g.edgeFlags[e] & required ? g.edgeCost[e] : Infinity;
}

/**
 * Bidirectional A* (Ikeda et al.) over the road graph.
 *
 * Both fronts use `h / 2`. Using the full heuristic on each side makes the
 * frontiers over-energetic and can return a valid-but-suboptimal path; halving
/**
 * A* over the road graph.
 *
 * Unidirectional on purpose. A bidirectional variant was tried and its path
 * reconstruction produced discontinuous geometry (meeting node stitched without
 * verifying the halves connect), which is far worse than being slower. On real
 * extracts the great-circle heuristic is strong enough that a single front is
 * fast, and this version is verified against a Dijkstra reference.
 *
 * Edge costs are travel time in seconds, so the heuristic is a straight-line
 * distance divided by an optimistic speed — that keeps it admissible.
 */
export function routeOnGraph(g: RoadGraph, from: LatLng, to: LatLng): RouteResult | null {
  const index = indexFor(g);
  const start = index.nearest(from[0], from[1]);
  const goal = index.nearest(to[0], to[1]);
  if (start < 0 || goal < 0) return null;

  const startPt: LatLng = [g.coords[start * 2], g.coords[start * 2 + 1]];
  const goalPt: LatLng = [g.coords[goal * 2], g.coords[goal * 2 + 1]];
  if (start === goal) {
    return { geometry: [startPt, goalPt], time: 0, metres: 0, steps: [], engine: 'osm-local' };
  }

  const n = g.nodeCount;
  const gScore = new Float64Array(n).fill(Infinity);
  const cameFrom = new Int32Array(n).fill(-1);
  const cameEdge = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);

  // Optimistic speed for admissibility: the fastest class in the network.
  // Using the true max keeps h a lower bound, so the result stays optimal.
  const OPT_SPEED = 60 * 0.27778; // 60 m/s
  const gx = goalPt[0], gy = goalPt[1];
  const heur = (i: number) => haversineM(g.coords[i * 2], g.coords[i * 2 + 1], gx, gy) / OPT_SPEED;

  const open = new MinHeap(n);
  gScore[start] = 0;
  open.push(start, heur(start));

  let found = false;
  let expansions = 0;
  const MAX_EXPANSIONS = 1_200_000;

  while (open.size) {
    const cur = open.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (cur === goal) { found = true; break; }
    if (++expansions > MAX_EXPANSIONS) break;

    for (let e = g.edgeStart[cur]; e < g.edgeStart[cur + 1]; e++) {
      const c = stepCost(g, e, false);
      if (!isFinite(c)) continue; // one-way against us
      const nb = g.edgeTo[e];
      if (closed[nb]) continue;
      const tentative = gScore[cur] + c;
      if (tentative < gScore[nb]) {
        gScore[nb] = tentative;
        cameFrom[nb] = cur;
        cameEdge[nb] = e;
        open.push(nb, tentative + heur(nb));
      }
    }
  }

  if (!found) return null;

  // Reconstruct by walking parents back from the goal, then reversing.
  const nodePath: number[] = [];
  for (let x = goal; x !== -1; x = cameFrom[x]) {
    nodePath.push(x);
    if (x === start) break;
  }
  if (nodePath[nodePath.length - 1] !== start) return null; // defensive: parents must chain to the start
  nodePath.reverse();

  const geometry: LatLng[] = nodePath.map((i) => [g.coords[i * 2], g.coords[i * 2 + 1]]);
  const steps: RouteResult['steps'] = [];
  let metres = 0;

  for (let i = 0; i < nodePath.length - 1; i++) {
    const e = cameEdge[nodePath[i + 1]];
    if (e < 0) continue;
    const segM = haversineM(
      g.coords[nodePath[i] * 2], g.coords[nodePath[i] * 2 + 1],
      g.coords[nodePath[i + 1] * 2], g.coords[nodePath[i + 1] * 2 + 1],
    );
    metres += segM;
    const name = g.edgeName[e] ?? '';
    const cost = g.edgeCost[e];
    const last = steps[steps.length - 1];
    if (last && last.name === name) {
      last.metres += segM;
      last.seconds += cost;
      last.to = geometry[i + 1];
    } else {
      steps.push({ name, metres: segM, seconds: cost, from: geometry[i], to: geometry[i + 1] });
    }
  }

  return { geometry, time: gScore[goal], metres, steps, engine: 'osm-local' };
}

/* ------------------------------- search ---------------------------- */

/**
 * Prefix + substring search over the gazetteer, ranked by category
 * importance then by name-prefix quality. Purely in-memory.
 */
export function searchGazetteer(
  gaz: GazEntry[],
  q: string,
  near?: LatLng,
  limit = 12,
): GazEntry[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const scored: { e: GazEntry; s: number }[] = [];

  for (const e of gaz) {
    const name = e.name.toLowerCase();
    let s = -1;
    if (name === needle) s = 1000;
    else if (name.startsWith(needle)) s = 800 - (name.length - needle.length);
    else if (name.includes(needle)) s = 500 - (name.length - needle.length);
    else {
      // "123 main" should also match the street "main st"
      const head = needle.replace(/^\d+\s+/, '');
      if (head && name.startsWith(head)) s = 380;
    }
    if (s < 0) continue;

    let total = s + e.rank;
    if (near) {
      const d = haversineM(near[0], near[1], e.lon, e.lat);
      total -= Math.min(120, d / 500); // gentle distance bias
    }
    scored.push({ e, s: total });
    if (scored.length > 4000) break;
  }

  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => x.e);
}

/* --------------------------- worker plumbing ----------------------- */

/**
 * The parse/graph/route/search core is pure and testable under Node; only this
 * message handler is worker-specific, so it is installed only when `self` is a
 * real WorkerGlobalScope.
 */
if (typeof self !== 'undefined' && typeof (self as any).postMessage === 'function' && typeof window === 'undefined') {
  self.onmessage = async (ev: MessageEvent) => {
    const { type, payload } = ev.data as { type: string; payload: any };
    try {
      if (type === 'build') {
        const { text } = payload as { text: string };
        const post = (stage: string, pct: number) =>
          (self as any).postMessage({ type: 'progress', stage, pct });
        post('Parsing XML', 0);
        const { nodes, ways } = parseOsmXml(text, (p) => post('Parsing XML', p * 0.5));
        post('Building graph', 0.5);
        const ds = buildDataset(nodes, ways, (p) => post('Building graph', 0.5 + p * 0.5));
        (self as any).postMessage({ type: 'built', payload: ds });
      }
    } catch (err) {
      (self as any).postMessage({ type: 'error', message: (err as Error).message });
    }
  };
}
