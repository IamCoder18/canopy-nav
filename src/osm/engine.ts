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

/** A file's name for messages that quote it, or a neutral stand-in. */
function quoted(name: string | undefined): string {
  return name ? `"${name}"` : 'The file';
}

/**
 * Reject a file that cannot possibly be OSM data, before any work is done.
 *
 * Pure and async because it reads the first bytes of the file; returns `null`
 * when the file is worth parsing, or a message explaining why it is not.
 *
 * Called both by `build()` and by `importRegionFile` *before* it constructs an
 * `OsmEngine`. That ordering matters: the engine constructor spawns a Web Worker,
 * so validating afterwards meant every bad file still paid for a worker, and in
 * an environment without one the constructor's failure masked the real diagnosis
 * entirely — the user was told "Worker is not defined" for an empty file.
 */
export async function importPreflight(file: OsmFile): Promise<string | null> {
  const name = file.name;

  // A 0-byte file is the most common failed import — a cancelled download, a
  // truncated placeholder — and it used to reach the parser and produce a
  // valid-looking dataset with nothing in it.
  if (typeof file.size === 'number' && file.size === 0) {
    return `${quoted(name)} is empty (0 bytes). If this was a download, it did not complete — ` +
      'fetch the extract again before importing it.';
  }

  // Enough of the head to identify both formats. PBF identifies itself by the
  // type string following the 4-byte blob header, and "OSMHeader" is 9 bytes, so
  // 32 leaves room for that plus a length prefix.
  const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const ascii = Array.from(head, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ' ')).join('');

  const looksXml = ascii.includes('<');
  const looksPbf = ascii.includes('OSMHeader') || ascii.includes('OSMData');
  if (looksXml || looksPbf) return null;

  if (file.size !== undefined && file.size <= head.length) {
    // We just read every byte of it and it is neither. That is conclusive: a
    // short note or an HTML fragment cannot become `<osm>` further in, because
    // there is no further in. Only a *partial* sniff is inconclusive — a valid
    // extract may open with a comment or a licence block longer than 32 bytes.
    return `${quoted(name)} is not OpenStreetMap data — it starts with ` +
      `${JSON.stringify(ascii.slice(0, 16))}, which is neither XML (\`<osm\`) nor a PBF ` +
      'blob header (`OSMHeader`). A saved web page or a cancelled download looks like ' +
      'this. Convert a .pbf with `osmium cat region.osm.pbf -o region.osm`.';
  }

  // A long file whose first 32 bytes are unrecognised: possibly a licence
  // preamble, possibly not OSM at all. Let the parser decide rather than
  // guessing from a prefix.
  return null;
}

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
  /**
   * Nullable so `dispose()` is safe on a half-built engine.
   *
   * `new Worker(...)` throws outright in any environment without one — a
   * non-browser test runner, or a WebView that refused the blob URL. When that
   * happened, `importRegionFile`'s catch block called `engine.dispose()` on an
   * object whose `worker` had never been assigned, which threw a second time and
   * replaced the real error with "Cannot read properties of undefined". The user
   * saw a null message and the actual cause was lost.
   */
  private worker: Worker | null = null;
  private dataset: OsmDataset | null = null;
  private buildPromise: Promise<OsmDataset> | null = null;
  /**
   * `null` is a real value here, not just "no handler": `importRegionFile`
   * passes a handler whose parameter is `BuildProgress | null`, and `null` is how
   * the import screen learns to take its progress card down. So the type has to
   * admit it.
   */
  private onProgress: ((p: BuildProgress | null) => void) | null = null;

  constructor() {
    this.worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = this.handle;
    /*
     * A worker that dies must settle the build.
     *
     * This logged and returned. So every failure that arrives as a worker-level
     * error rather than as a `postMessage` left `buildPromise` pending forever:
     *
     *   - a throw during the worker's module initialisation,
     *   - an OOM on a 900 MB parse, which in a Worker is an `onerror` and not a
     *     catchable exception,
     *   - the worker's own chunk failing to load — the one that happens most often
     *     in practice, and the one a driver sees as a progress bar that sits at
     *     "Reading extract, 0%" forever.
     *
     * `importRegionFile` awaits `engine.build(file)`, so nothing returned, so
     * `onError` never fired, `onProgress(null)` never fired, the previous region
     * was never restored, and the only recourse was force-quitting. An error that
     * is caught and merely logged is not caught.
     *
     * `onmessageerror` is the same story for a message that cannot be
     * *deserialised* — which is also not a catchable throw in the worker.
     */
    this.worker.onerror = (e) => {
      console.error('OSM worker error', e);
      this.failBuild(
        e.message || 'The map parser stopped unexpectedly. Try importing again.',
      );
    };
    this.worker.onmessageerror = (e) => {
      console.error('OSM worker message could not be read', e);
      this.failBuild('The map parser sent a message this app could not read.');
    };
  }

  /**
   * Reject an in-flight build and clear its handlers, exactly once.
   *
   * Shared by `onerror`, `onmessageerror` and `dispose`, so all three leave the
   * object in the same state: nothing pending, and the next `build()` starts
   * clean rather than resolving into a caller that has long since given up.
   */
  private failBuild(message: string) {
    const reject = this.rejectBuild;
    this.resolveBuild = null;
    this.rejectBuild = null;
    this.onProgress?.(null);
    reject?.(new Error(message));
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

  setProgressHandler(fn: ((p: BuildProgress | null) => void) | null) {
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

    // A 0-byte file is the single most common failed import — a cancelled
    // download, a truncated placeholder, an empty picker — and it used to reach
    // the parser and produce a valid-looking dataset with nothing in it.
    if (typeof file.size === 'number' && file.size === 0) {
      throw new Error(
        `${quoted(name)} is empty (0 bytes). If this was a download, it did not complete — ` +
        'fetch the extract again before importing it.',
      );
    }

    // Enough of the head to identify both formats. PBF identifies itself by the
    // type string that follows the 4-byte blob header, and "OSMHeader" is 9
    // bytes, so 32 leaves room for that plus a length prefix.
    const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
    const ascii = Array.from(head, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ' ')).join('');

    // The bytes get to decide. It used to be `looksXml || /\.(osm|xml)$/`, which
    // let the *extension* override a definite byte-level answer: a real PBF
    // renamed to `.osm` was parsed as XML, matched nothing, and imported
    // "successfully" as an empty region that then displaced a working map.
    const isXml = ascii.includes('<')
      ? true
      : ascii.includes('OSMHeader') || ascii.includes('OSMData')
        ? false
        // Genuinely inconclusive (a very short file, or leading bytes we do not
        // recognise): fall back to the name.
        : !/\.pbf$/i.test(name);

    if (!isXml && !/\.pbf$/i.test(name) && !ascii.includes('OSMHeader') && !ascii.includes('OSMData')) {
      throw new Error(
        `${quoted(name)} is not OpenStreetMap data — its first bytes are neither XML ` +
        '(`<osm`) nor a PBF blob header (`OSMHeader`). A saved web page or a ' +
        'cancelled download looks like this. Convert with ' +
        '`osmium cat region.osm.pbf -o region.osm` if you have a .pbf.',
      );
    }

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
          const totalBytes = typeof file.size === 'number' && file.size > 0 ? file.size : undefined;
          // The XML parser counts *characters* and this counts *bytes*, so they
          // are not the same number for a non-ASCII document. Both name the file
          // size because each is the denominator its own parser divides by: the
          // XML scanner advances through decoded text, the PBF reader through
          // raw bytes. Passing one as the other would make the progress bar
          // wrong by the file's UTF-8 overhead — small, and wrong.
          const totalChars = totalBytes;
          // Captured once: `dispose()` can null the field from another tick.
          const worker = this.worker;
          if (!worker) throw new Error('The OSM worker is not available in this environment.');
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
              worker.postMessage(
                { type: 'build', payload: { stream, format: 'xml', totalChars } },
                [stream as unknown as Transferable],
              );
            } else {
              const text = await file.text();
              worker.postMessage({ type: 'build', payload: { text, format: 'xml' } });
            }
          } else if (typeof file.stream === 'function') {
            // PBF streams for the same reason XML does, and it is the format
            // Geofabrik actually publishes, so this is the production path.
            //
            // It used to take `arrayBuffer()` unconditionally here, which made
            // the *whole extract* resident on the client before a single byte
            // reached the worker -- on the main thread -- and then the worker
            // re-concatenated the chunks into a second full-size buffer. Two
            // copies of a province, when the BlobHeader framing is
            // self-delimiting and neither is necessary. See STATUS.md 14.16.
            //
            // `totalBytes` is what makes the progress bar truthful rather than
            // a guess: a stream has no `size`, so without it the parse reports
            // one terminal value.
            const stream = file.stream();
            worker.postMessage(
              { type: 'build', payload: { stream, format: 'pbf', totalBytes } },
              [stream as unknown as Transferable],
            );
          } else {
            // No `stream` (a plain Blob-shaped object, or a test fixture): fall
            // back to the whole-buffer form, which the worker still handles.
            const bytes = await file.arrayBuffer();
            worker.postMessage({ type: 'build', payload: { bytes, format: 'pbf' } }, [bytes]);
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
    // Terminating an already-terminated worker is harmless; calling it on one
    // that was never created is not.
    //
    // `terminate()` does not fire `onerror`, so without this a build in flight
    // when the engine is disposed — which is what `importRegionFile`'s catch does
    // on a failed import, and what replacing a region does — leaves the promise
    // pending forever and its `await` suspended. Same symptom as the `onerror`
    // case above, reached a different way.
    this.failBuild('The map parser was stopped before it finished.');
    this.worker?.terminate();
    this.worker = null;
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
 * The default is **not** "no filtering". `RENDER_MIN_ZOOM` gives each class the
 * lowest zoom at which it is worth drawing, and `min > minClassZoom` drops everything
 * above the supplied zoom — so the default of 0 keeps only what is drawable at zoom 0
 * and drops the other thirteen classes of the fifteen.
 *
 * Measured on a dataset of one `residential`, one `service` and one `motorway`:
 * `roadsToGeoJSON(ds)` returns the motorway alone, while `roadsToGeoJSON(ds, 16)`
 * returns all three.
 *
 * That is *correct* — a residential street at zoom 0 is the sub-pixel noise the filter
 * exists to drop, and `test/renderzoom.spec.ts` asserts it — so only this comment was
 * wrong, and it was wrong in the dangerous direction: a caller who read "no filtering"
 * would render a motorway-only map and believe it complete.
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
