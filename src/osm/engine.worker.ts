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

/**
 * Minimum zoom at which each class is worth drawing.
 *
 * Lines thinner than a pixel are noise, and on a provincial extract every one of
 * them is still a GeoJSON feature to build and serialise. `roadsToGeoJSON` in
 * `osm/engine.ts` filters on this table, which is why it is exported.
 */
export const RENDER_MIN_ZOOM: Record<string, number> = {
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
    // Numeric references are *code points*, not code units, so this has to be
    // `fromCodePoint`: `fromCharCode(128512)` wraps to 62976 and turns an emoji
    // into a private-use glyph. `fromCodePoint` throws a RangeError above
    // 0x10FFFF, and OSM in the wild does contain such values, so the range is
    // checked rather than trusted.
    .replace(/&#(\d+);/g, (_, d) => {
      const cp = +d;
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '�';
    })
    // Last, so `&amp;lt;` decodes to the literal text `&lt;` and not to `<`.
    // A single pass in the other order re-expands its own output and corrupts
    // every name containing an ampersand.
    .replace(/&amp;/g, '&');
}

const NODE_RE = /<node\b([^>]*?)(?:\/>|>([\s\S]*?)<\/node>)/g;
const WAY_RE = /<way\b([^>]*?)(?:\/>|>([\s\S]*?)<\/way>)/g;
const TAG_RE = /<tag\b([^>]*?)\/>/g;
const REF_RE = /<nd\b[^>]*?ref\s*=\s*"(-?\d+)"/g;

/**
 * Scan one segment of OSM XML into the accumulators.
 *
 * Shared by the whole-string and streaming entry points on purpose. Two
 * implementations of the same parser would eventually disagree about a
 * malformed element, and the streaming path is the one that runs on a 900 MB
 * province where a silent divergence is very hard to notice. One code path
 * means equivalence is a testable property rather than an aspiration.
 *
 * The segment must end on an element boundary; see `elementBoundary`.
 */
function scanSegment(
  segment: string,
  nodes: Map<number, RawNode>,
  ways: RawWay[],
): void {
  let n: RegExpExecArray | null;
  NODE_RE.lastIndex = 0;
  while ((n = NODE_RE.exec(segment))) {
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
    const lat = +a.lat;
    const lon = +a.lon;
    // Reject coordinates that are not on Earth.
    //
    // `+a.lat` is `NaN` for a missing attribute, and the old code stored it
    // regardless. A hand-edited or malformed extract carrying `lat="-200"` then
    // produced 74,756 gazetteer entries and invented street addresses
    // ("Neg 1200", "Neg 12300"), labelled `address / Offline` in search results —
    // confidently wrong data presented as fact, which is worse than no data.
    //
    // Longitude is bounded at 180 and latitude at 90, and both must be finite.
    // Anything else is a malformed element, so it is skipped like a node with no
    // id rather than poisoning the graph, the bounding box and the gazetteer.
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;

    nodes.set(id, { id, lat, lon });
    if (tags) (nodes.get(id) as RawNode & { tags?: Record<string, string> }).tags = tags;
  }

  let w: RegExpExecArray | null;
  WAY_RE.lastIndex = 0;
  while ((w = WAY_RE.exec(segment))) {
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
}

/**
 * A complete `<node>` or `<way>` element, in either XML form.
 *
 * This is the grammar the scanner actually consumes, so it is also the right
 * unit for deciding where it is safe to cut a buffer. Using a looser rule --
 * "after any `>`" -- splits a tagged node across two segments: the opening
 * `<node id=...>` ends one, the `<tag>` children and `</node>` the next, and
 * neither half matches, so the node and its way are silently dropped.
 */
const ELEMENT_RE = /<(node|way)\b[^>]*?(?:\/>|>[\s\S]*?<\/\1>)/g;

/**
 * Index just past the last complete top-level element in `buf`, or -1.
 *
 * Only a complete `<node>`/`<way>` counts, because those are the only
 * constructs `scanSegment` matches on. Anything finer-grained would cut an
 * element in half; anything coarser would stall on a long buffered tail.
 */
function elementBoundary(buf: string): number {
  let end = -1;
  ELEMENT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ELEMENT_RE.exec(buf))) end = m.index + m[0].length;
  return end;
}

/** Single-pass parse of a complete XML document already in memory. */
export function parseOsmXml(
  text: string,
  onProgress: (pct: number) => void = () => {},
): { nodes: Map<number, RawNode>; ways: RawWay[] } {
  const nodes = new Map<number, RawNode>();
  const ways: RawWay[] = [];

  // Same segment-at-a-time discipline as the streaming path, so the two cannot
  // drift: a regex applied to one boundary-aligned segment behaves identically
  // to a regex applied to the whole document.
  let cut = elementBoundary(text);
  let at = 0;
  while (cut > at) {
    scanSegment(text.slice(at, cut), nodes, ways);
    at = cut;
    onProgress(Math.min(0.5, at / text.length));
    cut = elementBoundary(text.slice(at)) + at;
  }
  if (at < text.length) scanSegment(text.slice(at), nodes, ways);

  return { nodes, ways };
}

/**
 * Parse OSM XML from a stream of chunks, never holding the whole document.
 *
 * A province extract is 100-900 MB and `arrayBuffer()` on that OOMs a phone, so
 * the buffer is kept to a working window: everything up to the last safe element
 * boundary is scanned and dropped, and only the incomplete tail is carried.
 *
 * @param totalChars Optional size hint. Progress is a fraction of it.
 *
 * ## Without a size hint, progress is a single terminal report
 *
 * This used to say progress "is reported against the high-water mark rather than a
 * total". There is no such reporting. A variable named `high` was accumulated on every
 * window cut and **never read anywhere in the repo** — the fingerprint of reporting
 * that was removed and not re-wired — so a caller passing no hint received exactly one
 * value: `onProgress(0.5)`, after the last chunk.
 *
 * That is the honest answer rather than a missing feature, and it took a wrong fix to
 * see why. The tempting repair is to report `high / seen`, which rises toward 0.5 — but
 * `high / seen` is **1.0** the moment the first boundary is cut, and stays there, so it
 * is not a fraction of anything. Any other rising value without a denominator is
 * **invented**: it would claim the parse is 40% done when nothing knows that, which is
 * the same defect as §13.14's steps list, where a screen reported a cause nothing had
 * established.
 *
 * So: no hint means one terminal report, and `high` is gone rather than left as dead
 * state that invites exactly that invention. Production is unaffected either way —
 * `engine.ts` always passes `file.size`, so this is the branch the app never takes, and
 * the worker's `post(label, p * 0.5)` halves whatever arrives.
 */
export async function parseOsmXmlStream(
  chunks: AsyncIterable<string> | Iterable<string>,
  onProgress: (pct: number) => void = () => {},
  totalChars?: number,
): Promise<{ nodes: Map<number, RawNode>; ways: RawWay[] }> {
  const nodes = new Map<number, RawNode>();
  const ways: RawWay[] = [];

  let carry = '';
  let seen = 0;

  const flush = (segment: string, done: boolean) => {
    scanSegment(segment, nodes, ways);
    if (totalChars) onProgress(Math.min(0.5, seen / totalChars));
    else if (done) onProgress(0.5);
  };

  for await (const chunk of chunks as AsyncIterable<string>) {
    carry += chunk;
    seen += chunk.length;
    const cut = elementBoundary(carry);
    if (cut > 0) {
      flush(carry.slice(0, cut), false);
      carry = carry.slice(cut);
    }
  }

  // Whatever never reached a boundary is still scanned: a truncated final
  // element should not silently cost a node.
  if (carry) flush(carry, true);
  else onProgress(0.5);

  return { nodes, ways };
}

const PLACE_CATS: Record<string, string> = {
  place: 'place', amenity: 'amenity', shop: 'shop', tourism: 'tourism',
  leisure: 'leisure', office: 'office', craft: 'craft', healthcare: 'healthcare',
  historic: 'historic', natural: 'natural', aeroway: 'aeroway', railway: 'railway',
  building: 'building', landuse: 'landuse', man_made: 'man_made',
};


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

/**
 * Turn parsed nodes and ways into everything the app needs from an extract.
 *
 * ## The caller's `nodes` and `ways` are consumed
 *
 * Both are emptied before returning. Not as a micro-optimisation: `nodes` is a
 * `Map<number, RawNode>` of boxed objects, one per node in the extract, and it
 * is the single largest thing in the process. Holding it after the graph exists
 * means holding the parse *peak* for the life of the region, which is exactly
 * the cost `importguard.ts` estimates and refuses imports over.
 *
 * The worker relies on this — see its `postMessage` handler — and it relies on it
 * *not* relying on it, because both callers in `src/` pass structures they own
 * and would otherwise have to remember.
 *
 * ## Why it cannot be streamed away instead
 *
 * OSM PBF writes every node before every way, so when the ways arrive and name
 * the nodes they reference, the coordinates are already gone. A reader cannot
 * discard nodes as it goes; the map is required until the last way is seen.
 * Hence freeing it afterwards rather than never building it.
 */
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

    /**
     * The way's refs, as *runs* of consecutive present nodes.
     *
     * Previously this was one flat array with missing refs skipped, which silently joined
     * the survivors: a gap in the middle became a straight segment drawn across whatever
     * was missing. For corrupt data that is a few metres of error and the
     * `metres > 20000` guard below used to catch the worst of it.
     *
     * **It stops being a few metres the moment a crop exists.** Under §15.1's bbox filter
     * 2.4–7.4% of the refs of a way *touching* the box fall outside it, and those can be
     * kilometres apart — so the flat join would draw a road straight across country the
     * driver cannot see, and route along it. A road that leaves the cropped area has to
     * *end* at the edge, which is what a run boundary is.
     *
     * Behaviour is identical when nothing was dropped, because then there is one run: the
     * common case is untouched and only the previously-wrong case changes.
     */
    const runs: number[][] = [];
    let run: number[] = [];
    for (const ref of w.refs) {
      const n = nodes.get(ref);
      if (!n) {
        if (run.length) runs.push(run);
        run = [];
        continue;
      }
      run.push(ref);
      intern(ref); // ensure the node exists in the graph
    }
    if (run.length) runs.push(run);
    const usable = runs.filter((r) => r.length >= 2);
    if (usable.length === 0) continue;

    if (speed > 0) {
      routableWays++;
      const onewayF = t.oneway === 'yes' || t.oneway === 'true' || t.oneway === '1';
      const onewayB = t.oneway === '-1' || t.oneway === 'reverse';
      // flags are set when that direction is permitted
      const flags = onewayF ? FLAG_ONEWAY_F : onewayB ? FLAG_ONEWAY_B : FLAG_ONEWAY_F | FLAG_ONEWAY_B;

      for (const refs of usable) {
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
          // One polyline per run, so a road leaving the crop is drawn up to the edge and
          // stops, rather than being drawn as one line through the gap.
          roads.push({
            class: hw,
            pts: simplifyLine(refs.map((r) => {
              const n = nodes.get(r)!;
              return [n.lon, n.lat] as LatLng;
            }), 4),
          });
        }
      }
    } else {
      // Not routable, but still drawable.
      for (const refs of usable) {
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
  /**
 * Bounding box accumulator, starting *inside* the valid range.
 *
 * These were seeded at the inverted sentinels `west=180, east=-180,
 * south=90, north=-90`, which is fine as a "first value wins" trick — but if the
 * loop body never ran, the sentinel pair survived into the dataset and the
 * settings screen rendered `Bounds 180.000, 90.000, -180.000, -90.000` as though
 * it were a real location. Seeding inside the range makes "no nodes" produce
 * `west > east`, which is detectable, and the UI already has a real path for
 * "nothing was parsed".
 */
let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
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
  // `west > east` means no node ever updated the accumulator. Reporting the
  // inverted sentinels as a bounding box would show the user coordinates for
  // somewhere that does not exist; a zero box at the origin is a degenerate but
  // *true* statement, and the import validation rejects an empty parse before a
  // caller ever sees this.
  const bbox: [number, number, number, number] = west > east
    ? [0, 0, 0, 0]
    : [west, south, east, north];
  // Read *before* the structures are cleared below — `counts` is reported to the
  // launcher ("1.2 M routable ways") and the import screen's success card, so it
  // has to be a real figure rather than zero.
  const counts = { nodes: nodes.size, ways: ways.length, routable: routableWays };

  // Release the parse-time structures now that the graph exists. See the
  // docstring: the caller's map and array are consumed by this call.
  nodes.clear();
  ways.length = 0;

  return { graph, gaz: trimmed, roads, water, green, bbox, counts };
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

/**
 * A binary min-heap over `(node, priority)` **entries**.
 *
 * ## Why the priority is per-entry and not per-node
 *
 * This stored `p[node] = pri` in a `Float64Array` indexed by node id — one slot
 * per node, shared by every entry for that node. A\* pushes the same node
 * repeatedly: once with a tentative cost, again whenever a cheaper path is found.
 *
 *     push(X, 100)   // p[X] = 100, heap has (X, 100)
 *     push(X,  50)   // p[X] =  50, heap has (X, 100) and (X, 50)
 *
 * The stale entry at 100 now *compares* as 50, because every comparison in
 * sift-up and sift-down reads through `p[node]`. So the invariant "the array is
 * ordered by the priority it will report" is false, `pop()` does not return the
 * minimum, and A\*'s expansion order is no longer valid.
 *
 * That voided the optimality guarantee the heuristic above it is explicitly
 * built to preserve — and the offline engine is the app's **default**, so this
 * was the difference between a shortest path and a merely plausible one on any
 * network where a node gets re-relaxed, which is to say on essentially all of
 * them. Nothing detected it: a suboptimal route is still a route, still drawn,
 * still plausible. It is wrong by a few percent and looks correct.
 *
 * Two parallel arrays keep each entry's own priority, which is what a heap
 * actually needs.
 */
class MinHeap {
  private a: number[] = [];
  /** `ap[i]` is the priority of `a[i]`, and travels with it through every swap. */
  private ap: number[] = [];
  get size() { return this.a.length; }
  /** Priority of the next node to pop, without removing it. */
  peekCost(): number {
    return this.a.length ? this.ap[0] : Infinity;
  }
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

/**
 * Spatial hash: find the graph node nearest a query point.
 *
 * Bucket keys are a nested `Map` rather than a packed integer. The original
 * `(floor(lon/cell) << 16) ^ floor(lat/cell)` looks safe but is not: `<<`
 * coerces to int32, so the longitude cell index -- which spans about +-90000 at
 * cellDeg 0.002 -- exceeds the 16 bits the shift preserves. Cells exactly
 * 2^16 * cellDeg apart, i.e. **131 degrees of longitude**, hashed to the same
 * key and ended up in the same bucket 9000 km apart. A `nearest()` query near
 * the antimeridian therefore also searched nodes on the opposite side of the
 * planet, and could return one of them.
 *
 * A nested Map has no arithmetic to overflow, so distinctness holds for any
 * cell index a coordinate can produce.
 */
function buildIndex(g: RoadGraph, cellDeg: number) {
  /** cellDeg degrees, lon index -> (lat index -> node indices) */
  const buckets = new Map<number, Map<number, number[]>>();

  const bucket = (cx: number, cy: number): number[] | undefined => {
    const inner = buckets.get(cx);
    return inner?.get(cy);
  };

  for (let i = 0; i < g.nodeCount; i++) {
    const lon = g.coords[i * 2], lat = g.coords[i * 2 + 1];
    const cx = Math.floor(lon / cellDeg);
    const cy = Math.floor(lat / cellDeg);
    let inner = buckets.get(cx);
    if (!inner) buckets.set(cx, (inner = new Map()));
    let b = inner.get(cy);
    if (!b) inner.set(cy, (b = []));
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
            const b = bucket(cx + dx, cy + dy);
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

const indexCache = new WeakMap<RoadGraph, ReturnType<typeof buildIndex>>();

function indexFor(g: RoadGraph) {
  let ix = indexCache.get(g);
  if (!ix) {
    ix = buildIndex(g, 0.002);
    indexCache.set(g, ix);
  }
  return ix;
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
 * A* over the road graph.
 *
 * Unidirectional on purpose. A bidirectional variant (Ikeda et al., with `h/2`
 * on each front and a meeting-node termination test) was implemented and
 * removed: its search found the correct optimum but its path reconstruction
 * produced discontinuous geometry, because the two halves were stitched without
 * verifying they actually connect. A valid-but-broken path is far worse than a
 * slower correct one, and on road networks the great-circle heuristic is strong
 * enough that a single front stays fast.
 *
 * Edge costs are travel time in seconds, so the heuristic is a straight-line
 * distance divided by an optimistic speed — that keeps it admissible, so the
 * route returned is optimal for the cost model.
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

  // Optimistic speed for admissibility: the **fastest class in the network**, derived
  // from the table so it cannot drift from it.
  //
  // This used to read `60 * 0.27778` with the comment `// 60 m/s`. It is 16.667 m/s,
  // which is 60 **km/h** — and the fastest class here is `motorway` at 105 km/h
  // (29.167 m/s). So `h` assumed 0.0600 s/m while a motorway edge really costs
  // 0.0343 s/m: the heuristic **overestimated** on motorway, trunk and primary edges,
  // which is inadmissible, and A\* is only guaranteed optimal when `h` never
  // overestimates.
  //
  // Measured on the repo's own `test/fixture.osm` graph before the fix: 12 of 3000
  // random pairs returned a route up to **7.4% slower** than Dijkstra's optimum
  // (532.1 s against 495.5 s). On a 6x6 grid mixing 105 and 25 km/h edges, 5 of 4000
  // pairs were 19-32% slower. `test/minheap.spec.ts` proved the queue was a real heap,
  // so the optimality guarantee it restored was void for a different reason.
  //
  // `test/engine.spec.ts` asserted closeness to "the grid optimum" in **metres**, which
  // is why a time regression of this size passed: a faster road that is a few metres
  // longer is the *right* answer by distance and the *wrong* answer by time, and the
  // cost model is time.
  const OPT_SPEED = Math.max(...Object.values(SPEED)) / 3.6; // m/s, from the table above
  const gx = goalPt[0], gy = goalPt[1];
  const heur = (i: number) => haversineM(g.coords[i * 2], g.coords[i * 2 + 1], gx, gy) / OPT_SPEED;

  // The constructor took a node count and sized a per-node priority array.
  // Priorities are per-entry now, so it takes nothing.
  const open = new MinHeap();
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

// Static import: the parser is part of the same worker bundle.
import { parseOsmPbf, parseOsmPbfStream, type PbfCrop, type PbfCropStats } from './pbf';
import { isInterestingTag } from './tags';


/**
 * The parse/graph/route/search core is pure and testable under Node; only this
 * message handler is worker-specific, so it is installed only when `self` is a
 * real WorkerGlobalScope.
 */
/**
 * Decode a byte stream to text chunks without materialising the whole thing.
 *
 * `TextDecoder` with `{stream: true}` is what makes this safe across chunk
 * boundaries: a multi-byte UTF-8 sequence split between two reads is held in
 * the decoder's internal state instead of becoming two replacement characters.
 * Decoding each chunk independently would corrupt every non-ASCII place name at
 * exactly the chunk boundaries -- i.e. subtly, and only on large files.
 */
async function* decodeStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) yield decoder.decode(value, { stream: true });
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}

if (typeof self !== 'undefined' && typeof (self as any).postMessage === 'function' && typeof window === 'undefined') {
  self.onmessage = async (ev: MessageEvent) => {
    const { type, payload } = ev.data as { type: string; payload: any };
    try {
      if (type === 'build') {
        // Accepts either .osm XML text or raw .osm.pbf bytes. PBF is the format
        // Geofabrik actually publishes, so this is the normal path; XML stays
        // supported because it is trivially inspectable and useful for tests.
        //
        // A `stream` handle is preferred when present: it lets a multi-hundred-MB
        // extract be parsed in a bounded window instead of being held whole,
        // which is the difference between parsing a province and being OOM-killed
        // by one. The text/bytes form stays supported for callers that already
        // hold the file -- tests, and small imports.
        //
        // Both formats now take the streaming path in production. PBF used to be
        // read via `arrayBuffer()` on the client and joined into one contiguous
        // buffer here, so the format Geofabrik actually publishes was the one
        // format held whole -- see STATUS.md 14.16, which recorded that as the
        // largest single piece of engineering left in the app.
        const { text, bytes, format, stream, totalChars, totalBytes, crop } = payload as
          {
            text?: string;
            bytes?: ArrayBuffer;
            format?: 'xml' | 'pbf';
            stream?: ReadableStream<Uint8Array>;
            totalChars?: number;
            totalBytes?: number;
            crop?: PbfCrop | null;
          };
        const post = (stage: string, pct: number) =>
          (self as any).postMessage({ type: 'progress', stage, pct });

        const isPbf = format === 'pbf' || (!text && !!bytes);
        const label = isPbf ? 'Reading PBF' : 'Parsing XML';
        post(label, 0);

        let nodes: Map<number, RawNode>;
        let ways: RawWay[];
        /**
         * What the parse actually kept, when it could be cropped. §15.1 item 4: a
         * file-size estimate is the wrong shape once a crop exists, because the surviving
         * count depends on the box and not the file — so the reader reports it and the
         * guard can be compared against a measurement.
         */
        let cropStats: PbfCropStats | null = null;
        // `stats` is scoped to the PBF branch; declared here so the destructuring below
        // has something to bind to, and immediately folded into `cropStats`.
        let stats: PbfCropStats;
        // A crop asked for on a format that cannot honour one. Recorded rather than
        // ignored: the caller is trying to avoid being OOM-killed, and an ignored crop is
        // an OOM kill with extra steps.
        let cropIgnored = false;

        if (isPbf) {
          if (stream) {
            // PBF cannot be cut at an *element* boundary the way XML can -- a
            // protobuf field is a varint of unknown length -- but it is cut at a
            // *blob* boundary for free: BlobHeader carries `datasize`, so a
            // reader knows exactly where the current blob ends before reading
            // any of it. The parser therefore holds one blob at a time rather
            // than concatenating the whole file, which is what the loop here
            // used to do.
            ({ nodes, ways, stats } = await parseOsmPbfStream(
              stream,
              (p) => post(label, p * 0.5),
              totalBytes,
              crop,
            ));
            cropStats = stats;
          } else {
            ({ nodes, ways, stats } = await parseOsmPbf(
              new Uint8Array(bytes!), (p) => post(label, p * 0.5), crop,
            ));
            cropStats = stats;
          }
        } else {
          cropIgnored = !!crop;
          if (stream) {
            const decoded = decodeStream(stream);
            ({ nodes, ways } = await parseOsmXmlStream(decoded, (p) => post(label, p * 0.5), totalChars));
          } else {
            ({ nodes, ways } = parseOsmXml(text ?? '', (p) => post(label, p * 0.5)));
          }
        }

        post('Building graph', 0.5);
        // `buildDataset` consumes `nodes` and `ways` — it clears both before
        // returning, so the boxed `RawNode` map is released here rather than
        // staying reachable for the life of the worker. See its docstring.
        const ds = buildDataset(nodes, ways, (p) => post('Building graph', 0.5 + p * 0.5));
        // `cropApplied` / `cropStats` / `cropIgnored` travel with the dataset rather than
        // being logged: the caller's memory guard is estimated from a file size, and the
        // only thing that can correct it is what the parse actually kept.
        (self as any).postMessage({
          type: 'built',
          payload: { ...ds, cropApplied: !!cropStats?.cropped, cropStats, cropIgnored },
        });
      }
    } catch (err) {
      (self as any).postMessage({ type: 'error', message: (err as Error).message });
    }
  };
}
