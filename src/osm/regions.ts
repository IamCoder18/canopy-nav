/**
 * Region library — multiple named .osm extracts, each independently loaded.
 *
 * The app must support "download Alberta", "download British Columbia", etc. and
 * route *between* regions, so datasets can't be a single global. Each region
 * owns its own graph and bbox; the library resolves which region(s) a query
 * touches and stitches cross-region routes at the boundary.
 */

import type { LatLng } from '../geo';
import type { OsmDataset, RouteResult } from './engine.worker';
import { routeOnGraph } from './engine.worker';
import { mergeRegions, type MergeReport } from './merge';
import { canMerge } from './mergeguard';

export interface RegionMeta {
  /** Stable id, e.g. 'ca-ab'. */
  id: string;
  name: string;
  /** Admin level / ISO code as downloaded. */
  code: string;
  bbox: [number, number, number, number];
  loadedAt: number;
  bytes: number;
  counts: OsmDataset['counts'];
  /** Index size, useful for the settings screen. */
  gazetteerSize: number;
}

export interface Region extends RegionMeta {
  dataset: OsmDataset;
}

/** Catalogue of downloadable extracts. */
export interface CatalogEntry {
  id: string;
  name: string;
  country: string;
  /** Geofabrik-style URL for the .osm.pbf. */
  pbfUrl: string;
  /** Approximate download size in MB, for the UI. */
  approxMb: number;
  parentId?: string;
}

/**
 * Subset of Geofabrik's catalogue covering Canadian provinces plus a few
 * common US states, so "download by province/state" works out of the box.
 * Anything not listed can still be imported manually from a file.
 */
export const CATALOG: readonly CatalogEntry[] = [
  { id: 'ca-ab', name: 'Alberta', country: 'Canada', pbfUrl: 'https://download.geofabrik.de/north-america/canada/alberta-latest.osm.pbf', approxMb: 380, parentId: 'ca' },
  { id: 'ca-bc', name: 'British Columbia', country: 'Canada', pbfUrl: 'https://download.geofabrik.de/north-america/canada/british-columbia-latest.osm.pbf', approxMb: 620, parentId: 'ca' },
  { id: 'ca-on', name: 'Ontario', country: 'Canada', pbfUrl: 'https://download.geofabrik.de/north-america/canada/ontario-latest.osm.pbf', approxMb: 900, parentId: 'ca' },
  { id: 'ca-qc', name: 'Quebec', country: 'Canada', pbfUrl: 'https://download.geofabrik.de/north-america/canada/quebec-latest.osm.pbf', approxMb: 780, parentId: 'ca' },
  { id: 'ca-mb', name: 'Manitoba', country: 'Canada', pbfUrl: 'https://download.geofabrik.de/north-america/canada/manitoba-latest.osm.pbf', approxMb: 340, parentId: 'ca' },
  { id: 'ca-sk', name: 'Saskatchewan', country: 'Canada', pbfUrl: 'https://download.geofabrik.de/north-america/canada/saskatchewan-latest.osm.pbf', approxMb: 330, parentId: 'ca' },
  { id: 'ca-ns', name: 'Nova Scotia', country: 'Canada', pbfUrl: 'https://download.geofabrik.de/north-america/canada/nova-scotia-latest.osm.pbf', approxMb: 130, parentId: 'ca' },
  { id: 'ca-nb', name: 'New Brunswick', country: 'Canada', pbfUrl: 'https://download.geofabrik.de/north-america/canada/new-brunswick-latest.osm.pbf', approxMb: 140, parentId: 'ca' },
  { id: 'ca-nl', name: 'Newfoundland and Labrador', country: 'Canada', pbfUrl: 'https://download.geofabrik.de/north-america/canada/newfoundland-latest.osm.pbf', approxMb: 180, parentId: 'ca' },
  { id: 'ca-pe', name: 'Prince Edward Island', country: 'Canada', pbfUrl: 'https://download.geofabrik.de/north-america/canada/prince-edward-island-latest.osm.pbf', approxMb: 30, parentId: 'ca' },
  { id: 'ca-mb-north', name: 'Manitoba (north)', country: 'Canada', pbfUrl: 'https://download.geofabrik.de/north-america/canada/manitoba-north-latest.osm.pbf', approxMb: 90, parentId: 'ca-mb' },

  { id: 'us-ca', name: 'California', country: 'United States', pbfUrl: 'https://download.geofabrik.de/north-america/us/california-latest.osm.pbf', approxMb: 950 },
  { id: 'us-wa', name: 'Washington', country: 'United States', pbfUrl: 'https://download.geofabrik.de/north-america/us/washington-latest.osm.pbf', approxMb: 520 },
  { id: 'us-ny', name: 'New York', country: 'United States', pbfUrl: 'https://download.geofabrik.de/north-america/us/new-york-latest.osm.pbf', approxMb: 480 },
  { id: 'us-tx', name: 'Texas', country: 'United States', pbfUrl: 'https://download.geofabrik.de/north-america/us/texas-latest.osm.pbf', approxMb: 1400 },
  { id: 'us-fl', name: 'Florida', country: 'United States', pbfUrl: 'https://download.geofabrik.de/north-america/us/florida-latest.osm.pbf', approxMb: 620 },
];

const COUNTRY_NAMES: Record<string, string> = { ca: 'Canada', us: 'United States' };
export { COUNTRY_NAMES };

export function catalogByCountry(): { country: string; entries: CatalogEntry[] }[] {
  const map = new Map<string, CatalogEntry[]>();
  for (const e of CATALOG) {
    const c = e.country || (COUNTRY_NAMES[e.id.slice(0, 2)] ?? 'Other');
    const list = map.get(c) ?? [];
    list.push(e);
    map.set(c, list);
  }
  return [...map.entries()].map(([country, entries]) => ({ country, entries }));
}

/* --------------------------- bbox helpers --------------------------- */

export function bboxContains(b: [number, number, number, number], p: LatLng): boolean {
  return p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
}

/** Fraction of a bbox's area that lies within another bbox. */
export function bboxOverlapFrac(
  inner: [number, number, number, number],
  outer: [number, number, number, number],
): number {
  const w = Math.max(0, Math.min(inner[2], outer[2]) - Math.max(inner[0], outer[0]));
  const h = Math.max(0, Math.min(inner[3], outer[3]) - Math.max(inner[1], outer[1]));
  const area = (inner[2] - inner[0]) * (inner[3] - inner[1]);
  return area <= 0 ? 0 : (w * h) / area;
}

/**
 * Closest pair of points between two axis-aligned boxes, plus the gap.
 *
 * For axis-aligned boxes the minimum separation is exactly
 * `hypot(gapX, gapY)` where each gap is zero when the boxes overlap on that
 * axis — no search needed.
 */
function closestPoints(
  a: [number, number, number, number],
  b: [number, number, number, number],
): { pa: [number, number]; pb: [number, number]; gapM: number } {
  // Positive only when the boxes are separated on that axis.
  const gapX = Math.max(a[0] - b[2], b[0] - a[2], 0);
  const gapY = Math.max(a[1] - b[3], b[1] - a[3], 0);

  // The facing coordinate pair. When separated, these are the two edges that
  // touch; when overlapping, any shared coordinate works, so take the middle of
  // the shared span.
  const xPair: [number, number] =
    gapX > 0 ? (b[0] > a[2] ? [a[2], b[0]] : [b[2], a[0]])
             : [(Math.max(a[0], b[0]) + Math.min(a[2], b[2])) / 2,
                (Math.max(a[0], b[0]) + Math.min(a[2], b[2])) / 2];
  const yPair: [number, number] =
    gapY > 0 ? (b[1] > a[3] ? [a[3], b[1]] : [b[3], a[1]])
             : [(Math.max(a[1], b[1]) + Math.min(a[3], b[3])) / 2,
                (Math.max(a[1], b[1]) + Math.min(a[3], b[3])) / 2];

  const pa: [number, number] = [xPair[0], yPair[0]];
  const pb: [number, number] = [xPair[1], yPair[1]];

  // Convert the angular gap to metres; longitude degrees shrink with latitude.
  const midLat = ((a[1] + a[3]) / 2 + (b[1] + b[3]) / 2) / 2;
  const gapM =
    Math.hypot(gapX * 111320 * Math.cos((midLat * Math.PI) / 180), gapY * 111320);

  return { pa, pb, gapM };
}

/**
 * Largest separation still considered "adjacent".
 *
 * Canadian provinces and US states share borders, so a real pair overlaps or
 * touches. A wider gap means the two extracts are simply not neighbours and
 * there is no shared boundary to hand a route across.
 */
const ADJACENCY_GAP_M = 25_000;

/**
 * Where to hand a route from one region to the other, or null if they are not
 * neighbours.
 *
 * This previously clipped a segment between the two centroids against the
 * *union* of the boxes. Both centroids are by definition inside that union, so
 * the clip could never fail and every `null` path was dead code: two extracts on
 * opposite sides of the planet still produced a plausible-looking boundary
 * point, and `plan()` happily built a cross-ocean two-leg route for them.
 */
export function boundaryPoint(a: Region, b: Region): LatLng | null {
  const { pa, pb, gapM } = closestPoints(a.bbox, b.bbox);
  if (gapM > ADJACENCY_GAP_M) return null;
  return [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
}

/* --------------------------- the library --------------------------- */

export interface SinglePlan {
  kind: 'single';
  region: Region;
  from: LatLng;
  to: LatLng;
}

export interface CrossPlan {
  kind: 'cross';
  legs: { region: Region; from: LatLng; to: LatLng }[];
  /** Regions traversed, in order. */
  order: string[];
}

export type CrossRegionPlan = SinglePlan | CrossPlan;

export class RegionLibrary {
  private regions = new Map<string, Region>();
  private listeners = new Set<() => void>();
  /**
   * Merged graphs, keyed by the participating region ids.
   *
   * A merge costs seconds and hundreds of megabytes for provinces, so it cannot
   * be redone per query. Held on the library rather than registered as a region
   * of its own: `add()` fires `emit()`, which would make a phantom entry appear
   * in the region list with a Remove button that deletes nothing.
   *
   * Invalidated in `add` and `remove`, because a merge is only valid for the
   * exact graphs it was built from — re-importing a region must not leave a
   * stale merge answering routes.
   */
  private merges = new Map<string, MergeReport>();

  get all(): Region[] { return [...this.regions.values()]; }
  get count() { return this.regions.size; }
  get ids() { return [...this.regions.keys()]; }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() { for (const l of this.listeners) l(); }

  add(meta: RegionMeta, dataset: OsmDataset): Region {
    const region: Region = { ...meta, dataset };
    this.regions.set(meta.id, region);
    // A merge holds a copy of the old graph's nodes and edges; replacing a
    // region invalidates every merge that included it.
    this.merges.clear();
    this.emit();
    return region;
  }

  remove(id: string) {
    // Only notify on a real change; a no-op delete would otherwise re-render
    // every subscribed screen for nothing.
    if (this.regions.delete(id)) {
      this.merges.clear();
      this.emit();
    }
  }

  get(id: string) { return this.regions.get(id); }

  /** Which loaded regions could contain this point? */
  regionsFor(p: LatLng): Region[] {
    return this.all.filter((r) => bboxContains(r.bbox, p));
  }

  /**
   * Best single region for a point, preferring the tightest bbox.
   *
   * A city extract nested inside a province is the more specific match, so
   * ascending area is what "tightest" means. This previously sorted descending
   * and returned the loosest, so a point inside a loaded city routed against
   * the province-wide graph.
   */
  bestFor(p: LatLng): Region | null {
    const hits = this.regionsFor(p);
    if (!hits.length) return null;
    return hits.slice().sort((x, y) => area(x.bbox) - area(y.bbox))[0];
  }

  /** Which catalog entry would cover this point, if downloaded? */
  catalogFor(p: LatLng): CatalogEntry | null {
    const inside = (b: [number, number, number, number]) =>
      p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];

    // Coarse boxes so we can match without hardcoding every province outline.
    const rough: Record<string, [number, number, number, number]> = {
      'ca-ab': [-120, 49, -110, 60], 'ca-bc': [-139, 48.3, -114, 60],
      'ca-on': [-95.8, 41.7, -74.3, 56.9], 'ca-qc': [-79.6, 44.9, -57, 62.6],
      // First match wins, so the more specific Manitoba-north box must be
      // tested before the province-wide ca-mb box or it is unreachable.
      'ca-mb-north': [-102, 58.5, -88.9, 60],
      'ca-mb': [-102, 48.9, -88.9, 60], 'ca-sk': [-110, 48.9, -101.4, 60],
      'ca-ns': [-66.5, 43.3, -59.6, 47.1], 'ca-nb': [-69.1, 44.6, -63.8, 48.1],
      'ca-nl': [-59.5, 46.6, -52.6, 51.7], 'ca-pe': [-64.5, 46.2, -62, 47.1],
      'us-ca': [-124.5, 32.5, -114.1, 42], 'us-wa': [-124.8, 45.5, -116.9, 49],
      'us-ny': [-79.8, 40.5, -71.8, 45], 'us-tx': [-106.7, 25.8, -93.5, 36.5],
      'us-fl': [-87.6, 24.5, -80, 31],
    };
    for (const e of CATALOG) {
      const b = rough[e.id];
      if (b && inside(b)) return e;
    }
    return null;
  }

  /** Regions needed to connect two points, in travel order. */
  plan(from: LatLng, to: LatLng): CrossRegionPlan {
    const a = this.bestFor(from);
    const b = this.bestFor(to);

    if (a && b && a.id === b.id) {
      return { kind: 'single', region: a, from, to };
    }

    if (a && b) {
      const mid = boundaryPoint(a, b);
      if (mid) {
        return {
          kind: 'cross',
          legs: [
            { region: a, from, to: mid },
            { region: b, from: mid, to },
          ],
          order: [a.id, b.id],
        };
      }
    }

    // Fall back to whichever single region covers the most of the span.
    if (a) return { kind: 'single', region: a, from, to };
    if (b) return { kind: 'single', region: b, from, to };
    throw new Error('No downloaded region covers this route. Download the relevant province or state.');
  }

  /** Route within one region. */
  routeIn(region: Region, from: LatLng, to: LatLng): RouteResult | null {
    return routeOnGraph(region.dataset.graph, from, to);
  }

  /**
   * The merged graph for a set of regions, or why there isn't one.
   *
   * This is the only place a merge is built, so the cache and the memory guard
   * live with it. `plan()` still decides *which* regions a query needs — that
   * part was never the bug — but from here on the route is computed on one
   * graph spanning all of them.
   */
  private merged(parts: Region[]): { report: MergeReport } | { refusal: string } {
    // Keyed on the sorted ids, so the same pair merges once regardless of the
    // order `plan()` happened to hand them over in.
    const key = parts.map((r) => r.id).sort().join(' ');
    const hit = this.merges.get(key);
    if (hit) return { report: hit };

    const verdict = canMerge(parts.map((p) => p.dataset.graph));
    if (!verdict.ok) return { refusal: verdict.reason };

    const report = mergeRegions(parts);
    this.merges.set(key, report);
    return { report };
  }

  /**
   * Route across the library.
   *
   * Cross-region routes used to be built by routing two legs and concatenating
   * them at a point derived from the two bounding *boxes*, each leg snapping that
   * point to the nearest node inside its own extract. The result was a
   * continuous line, so nothing looked broken — it was simply not the route a
   * driver would take, because a box midpoint has no relationship to the road
   * network. For Calgary to Vancouver it put the handover in the Rockies, at the
   * closest point between two rectangles.
   *
   * Geofabrik cuts extracts from one database, so a border road carries the same
   * OSM node ids on both sides. Merging on those ids is what makes the road
   * continuous, and A\\* over the merged graph finds the real crossing.
   */
  route(from: LatLng, to: LatLng): { result: RouteResult; regions: string[]; stitched: boolean } | null {
    // `plan` throws when no downloaded region covers the pair. Callers expect a
    // nullable result here, so surface it the same way rather than forcing
    // every caller into a try/catch.
    let plan: CrossRegionPlan;
    try {
      plan = this.plan(from, to);
    } catch {
      return null;
    }

    if (plan.kind === 'single') {
      const r = this.routeIn(plan.region, from, to);
      return r ? { result: r, regions: [plan.region.id], stitched: false } : null;
    }

    const parts = plan.legs.map((l) => l.region);
    const merge = this.merged(parts);
    // Refusing is the correct outcome here, not a degraded one. A route across a
    // boundary that we cannot afford to merge has no honest approximation: the
    // stitched line it would replace is wrong, and wrong-but-continuous is the
    // worst thing to hand a driver.
    if ('refusal' in merge) {
      this.lastRefusal = merge.refusal;
      return null;
    }
    this.lastRefusal = null;

    const r = routeOnGraph(merge.report.graph, from, to);
    if (!r) return null;
    return { result: r, regions: [...plan.order], stitched: false };
  }

  /**
   * Why the last cross-region route returned nothing, if it refused.
   *
   * `route()` is nullable for three unrelated reasons — no region covers the
   * pair, no path exists, or a merge did not fit — and the caller cannot tell
   * them apart from a null. Only the third is actionable, and a driver who is
   * told "no route" when the truth is "this device cannot compute this route"
   * will conclude the destination is unreachable.
   */
  lastRefusal: string | null = null;
}

function area(b: [number, number, number, number]) {
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
}

/* ---------------------- search across regions ---------------------- */

export interface RegionHit {
  regionId: string;
  regionName: string;
  score: number;
  entry: { name: string; lat: number; lon: number; cat: string; rank: number };
}

export function searchAll(
  lib: RegionLibrary,
  q: string,
  near: LatLng,
  limit = 20,
): RegionHit[] {
  const hits: RegionHit[] = [];
  const needle = q.trim().toLowerCase();
  if (!needle) return hits;

  const mPerDegLon = 111320 * Math.cos((near[1] * Math.PI) / 180);

  outer:
  for (const region of lib.all) {
    for (const g of region.dataset.gaz) {
      const name = g.name.toLowerCase();
      let score = -1;
      if (name === needle) score = 1000;
      else if (name.startsWith(needle)) score = 800 - (name.length - needle.length);
      else if (name.includes(needle)) score = 500 - (name.length - needle.length);
      if (score < 0) continue;

      const dLat = (g.lat - near[1]) * 111320;
      const dLon = (g.lon - near[0]) * mPerDegLon;
      const distM = Math.hypot(dLat, dLon);

      hits.push({
        regionId: region.id,
        regionName: region.name,
        score: score + g.rank - Math.min(120, distM / 500),
        entry: g,
      });
      // Cap total work, not per-region work: breaking only the inner loop let a
      // 20-region library push tens of thousands of hits before stopping.
      if (hits.length > 6000) break outer;
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
