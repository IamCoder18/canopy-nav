/**
 * Main-thread client for the offline OSM worker.
 *
 * Wraps the worker in a promise API, tracks build progress, and mirrors the
 * dataset onto the map as GeoJSON sources.
 */

import type { LatLng } from '../geo';
import type { OsmDataset, GazEntry, RouteResult } from './engine.worker';
import { searchGazetteer, RENDER_MIN_ZOOM } from './engine.worker';

type Handler = (ev: MessageEvent) => void;

/** The slice of `File` the engine needs, so tests can pass a stub. */
export interface OsmFile {
  name?: string;
  /** Total size in bytes, when known. Used only to scale progress. */
  size?: number;
  slice(start: number, end?: number): { arrayBuffer(): Promise<ArrayBuffer> };
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  /**
   * Optional lazy reader.
   *
   * Present on a real `File`, absent on a stub — which is exactly why the
   * engine feature-detects it rather than requiring it: the whole-file path
   * stays available for tests and for callers holding a plain Blob.
   */
  stream?(): ReadableStream<Uint8Array>;
}

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

  /**
   * Parse a `.osm` file into a routing graph + gazetteer.
   *
   * The format is sniffed from the file's leading bytes rather than trusted
   * from the extension, because both `.pbf` and `.xml` arrive through the same
   * file picker and picking the wrong parser produces a baffling error deep
   * inside the decoder.
   */
  async build(file: OsmFile): Promise<OsmDataset> {
    if (this.buildPromise) return this.buildPromise;

    const name = file.name ?? '';
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    // XML begins with '<' after an optional BOM/whitespace; PBF never does.
    let looksXml = false;
    for (const b of head) {
      if (b === 0x3c) { looksXml = true; break; }
      if (b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0xef && b !== 0xbb && b !== 0xbf) break;
    }
    const isXml = looksXml || /\.(osm|xml)$/i.test(name);

    this.buildPromise = new Promise<OsmDataset>((resolve, reject) => {
      this.resolveBuild = resolve;
      this.rejectBuild = reject;
      void (async () => {
        try {
          // A `File` is already a lazy, disk-backed handle, so streaming it costs
          // nothing extra and is the difference between parsing a 900 MB
          // province in a bounded window and being OOM-killed by one. The
          // whole-file forms are kept for callers that pass a plain Blob-shaped
          // object without `stream`, and for the test fixtures.
          const totalChars = typeof file.size === 'number' && file.size > 0 ? file.size : undefined;
          if (isXml) {
            if (typeof file.stream === 'function') {
              // `stream()` is called exactly once: each call returns a *new*
              // stream, so listing a second call in the transfer list would hand
              // the worker an untouched handle while transferring a different
              // one.
              //
              // The stream goes in the *transfer* list. It is not
              // structured-cloneable in Chrome: posting it without transferring
              // throws "A ReadableStream could not be cloned because it was not
              // transferred". Transferring also moves the handle rather than
              // copying it, which is the point.
              const stream = file.stream();
              this.worker.postMessage(
                { type: 'build', payload: { stream, format: 'xml', totalChars } },
                [stream as unknown as Transferable],
              );
            } else {
              const text = await file.text();
              this.worker.postMessage({ type: 'build', payload: { text, format: 'xml' } });
            }
          } else {
            // Transfer the buffer instead of copying a province-sized file.
            const bytes = await file.arrayBuffer();
            this.worker.postMessage({ type: 'build', payload: { bytes, format: 'pbf' } }, [bytes]);
          }
        } catch (err) {
          reject(err as Error);
        }
      })();
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

/**
 * Mirror the dataset's roads into GeoJSON for the offline map.
 *
 * `minClassZoom` drops classes whose minimum legibility zoom is above the
 * current view, because a residential street drawn at zoom 6 is sub-pixel noise
 * and, on a provincial extract, costs a great deal of GeoJSON to build and
 * serialise. The thresholds live in `RENDER_MIN_ZOOM` in the worker, which is
 * where the graph is built; this re-reads that same table so the two cannot
 * disagree about which class is which.
 *
 * Default 0 means "no filtering" — the map layer supplies the current zoom.
 */
export function roadsToGeoJSON(ds: OsmDataset, minClassZoom = 0): GeoJSON.FeatureCollection {
  const feats: GeoJSON.Feature[] = [];
  for (const r of ds.roads) {
    const min = RENDER_MIN_ZOOM[r.class];
    // An unknown class is kept: new OSM tags appear, and dropping them silently
    // would make roads vanish rather than render untidily.
    if (min !== undefined && min > minClassZoom) continue;
    feats.push({
      type: 'Feature',
      properties: { class: r.class },
      geometry: { type: 'LineString', coordinates: r.pts },
    });
  }
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
