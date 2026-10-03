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

/** Where should we cut a route so it can be handed between two regions? */
export function boundaryPoint(
  a: Region, b: Region,
): LatLng | null {
  const ax = (a.bbox[0] + a.bbox[2]) / 2;
  const ay = (a.bbox[1] + a.bbox[3]) / 2;
  const bx = (b.bbox[0] + b.bbox[2]) / 2;
  const by = (b.bbox[1] + b.bbox[3]) / 2;
  // Ray/rect intersection between the two centroids.
  const dx = bx - ax, dy = by - ay;
  const minX = Math.min(a.bbox[0], b.bbox[0]), maxX = Math.max(a.bbox[2], b.bbox[2]);
  const minY = Math.min(a.bbox[1], b.bbox[1]), maxY = Math.max(a.bbox[3], b.bbox[3]);
  let tMin = 0, tMax = 1;
  for (const [p, d, lo, hi] of [[ax, dx, minX, maxX], [ay, dy, minY, maxY]] as const) {
    if (Math.abs(d) < 1e-12) {
      if (p < lo || p > hi) return null;
      continue;
    }
    let t1 = (lo - p) / d;
    let t2 = (hi - p) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  if (tMax <= 0 || tMin >= 1) return null;
  const t = (tMin + tMax) / 2;
  return [ax + dx * t, ay + dy * t];
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
    this.emit();
    return region;
  }

  remove(id: string) {
    this.regions.delete(id);
    this.emit();
  }

  get(id: string) { return this.regions.get(id); }

  /** Which loaded regions could contain this point? */
  regionsFor(p: LatLng): Region[] {
    return this.all.filter((r) => bboxContains(r.bbox, p));
  }

  /** Best single region for a point, preferring the tightest bbox. */
  bestFor(p: LatLng): Region | null {
    const hits = this.regionsFor(p);
    if (!hits.length) return null;
    return hits.sort((x, y) => area(y.bbox) - area(x.bbox))[0];
  }

  /** Which catalog entry would cover this point, if downloaded? */
  catalogFor(p: LatLng): CatalogEntry | null {
    const inside = (b: [number, number, number, number]) =>
      p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];

    // Coarse boxes so we can match without hardcoding every province outline.
    const rough: Record<string, [number, number, number, number]> = {
      'ca-ab': [-120, 49, -110, 60], 'ca-bc': [-139, 48.3, -114, 60],
      'ca-on': [-95.8, 41.7, -74.3, 56.9], 'ca-qc': [-79.6, 44.9, -57, 62.6],
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
   * Route across the library, stitching region legs together.
   * Off-road gaps between regions are flagged so the UI can warn the driver.
   */
  route(from: LatLng, to: LatLng): { result: RouteResult; regions: string[]; stitched: boolean } | null {
    const plan = this.plan(from, to);

    if (plan.kind === 'single') {
      const r = this.routeIn(plan.region, from, to);
      return r ? { result: r, regions: [plan.region.id], stitched: false } : null;
    }

    const legs: RouteResult[] = [];
    const regions: string[] = [];
    for (const leg of plan.legs) {
      const r = this.routeIn(leg.region, leg.from, leg.to);
      if (!r) return null;
      legs.push(r);
      regions.push(leg.region.id);
    }

    const geometry: LatLng[] = [];
    for (const [i, l] of legs.entries()) {
      const seg = i === 0 ? l.geometry : l.geometry.slice(1);
      geometry.push(...seg);
    }
    const metres = legs.reduce((s, l) => s + l.metres, 0);
    const time = legs.reduce((s, l) => s + l.time, 0);
    const steps = legs.flatMap((l) => l.steps);

    return { result: { geometry, metres, time, steps, engine: 'osm-local' }, regions, stitched: true };
  }
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
      if (hits.length > 6000) break;
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
