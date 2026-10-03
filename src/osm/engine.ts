/**
 * Main-thread client for the offline OSM worker.
 *
 * Wraps the worker in a promise API, tracks build progress, and mirrors the
 * dataset onto the map as GeoJSON sources.
 */

import type { LatLng } from '../geo';
import type { OsmDataset, GazEntry, RouteResult } from './engine.worker';
import { searchGazetteer } from './engine.worker';

type Handler = (ev: MessageEvent) => void;

export interface BuildProgress {
  stage: string;
  pct: number;
}

export class OsmEngine {
  private worker: Worker;
  private dataset: OsmDataset | null = null;
  private buildPromise: Promise<OsmDataset> | null = null;
  private onProgress: ((p: BuildProgress) => void) | null = null;

  constructor() {
    this.worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = this.handle;
    this.worker.onerror = (e) => {
      console.error('OSM worker error', e);
    };
  }

  private handle: Handler = (ev) => {
    const msg = ev.data;
    if (msg.type === 'progress') {
      this.onProgress?.({ stage: msg.stage, pct: msg.pct });
    } else if (msg.type === 'built') {
      this.dataset = msg.payload as OsmDataset;
      this.resolveBuild?.(this.dataset);
      this.resolveBuild = null;
      this.rejectBuild = null;
    } else if (msg.type === 'error') {
      this.rejectBuild?.(new Error(msg.message));
      this.resolveBuild = null;
      this.rejectBuild = null;
    }
  };

  private resolveBuild: ((d: OsmDataset) => void) | null = null;
  private rejectBuild: ((e: Error) => void) | null = null;

  get ready() { return this.dataset !== null; }
  get data() { return this.dataset; }

  setProgressHandler(fn: ((p: BuildProgress) => void) | null) {
    this.onProgress = fn;
  }

  /** Parse an .osm XML string into a routing graph + gazetteer. */
  build(text: string): Promise<OsmDataset> {
    if (this.buildPromise) return this.buildPromise;
    this.buildPromise = new Promise<OsmDataset>((resolve, reject) => {
      this.resolveBuild = resolve;
      this.rejectBuild = reject;
      this.worker.postMessage({ type: 'build', payload: { text } });
    });
    return this.buildPromise;
  }

  route(from: LatLng, to: LatLng): RouteResult | null {
    if (!this.dataset) return null;
    // Routed on the main thread: the worker holds the data. For very large
    // extracts this should move back into the worker, but the typed arrays are
    // structured-cloneable so the dataset can be posted across if needed.
    return routeSync(this.dataset, from, to);
  }

  search(q: string, near?: LatLng, limit = 12): GazEntry[] {
    if (!this.dataset) return [];
    return searchGazetteer(this.dataset.gaz, q, near, limit);
  }

  dispose() {
    this.worker.terminate();
  }
}

// Imported lazily so the A* implementation stays in one module.
import { routeOnGraph } from './engine.worker';
function routeSync(ds: OsmDataset, from: LatLng, to: LatLng): RouteResult | null {
  return routeOnGraph(ds.graph, from, to);
}

/* ------------------------- GeoJSON for the map ------------------------- */

export function roadsToGeoJSON(ds: OsmDataset, minClassZoom = 0): GeoJSON.FeatureCollection {
  const feats: GeoJSON.Feature[] = [];
  for (const r of ds.roads) {
    feats.push({
      type: 'Feature',
      properties: { class: r.class },
      geometry: { type: 'LineString', coordinates: r.pts },
    });
  }
  void minClassZoom;
  return { type: 'FeatureCollection', features: feats };
}

export function waterToGeoJSON(ds: OsmDataset): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: ds.water.map((w) => ({
      type: 'Feature',
      properties: { class: w.class },
      geometry: { type: 'LineString', coordinates: w.rings[0] },
    })),
  };
}

export function greenToGeoJSON(ds: OsmDataset): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: ds.green.map((g) => ({
      type: 'Feature',
      properties: { class: g.class },
      geometry: { type: 'Polygon', coordinates: g.rings },
    })),
  };
}

export function lineToGeoJSON(pts: LatLng[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: pts.length ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pts } }] : [],
  };
}

export function pointsToGeoJSON(pts: LatLng[], props: Record<string, unknown> = {}): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: pts.map((p) => ({
      type: 'Feature',
      properties: props,
      geometry: { type: 'Point', coordinates: p },
    })),
  };
}
