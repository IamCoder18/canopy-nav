/**
 * Offline persistence for downloaded OSM regions.
 *
 * The region library in `regions/store.ts` is a module singleton, so every
 * parsed extract is lost when the app restarts. Re-parsing is not an option
 * for a province — hundreds of megabytes of XML through a Web Worker — so
 * this module caches the **parsed dataset** itself and rehydrates it on the
 * next launch.
 *
 * Why the dataset and not the `.osm` file: the source file is bigger than the
 * dataset we actually use (the parser drops most tags, compacts the graph to
 * its connected core and caps the gazetteer), so keeping the dataset saves both
 * the parse time and the storage.
 *
 * Why IndexedDB and not localStorage: the road graph is a set of typed arrays
 * of tens of megabytes. localStorage is a synchronous string map and would
 * die on the first province.
 *
 * ## Typed arrays
 *
 * The graph is six typed arrays. `JSON.stringify(new Int32Array([1,2]))` is
 * `{"0":1,"1":2}`, which comes back as an object and silently breaks every
 * index, so typed arrays are stored as their raw `ArrayBuffer`s and rebuilt
 * with the right constructor on load. IndexedDB structured-clones those
 * buffers natively; the copy in `pack()` is what makes the stored record
 * independent of the live graph (a subarray view would otherwise drag in — or
 * be aliased to — a much larger buffer).
 *
 * ## Failure policy
 *
 * IndexedDB is missing in some WebViews, disabled in some private-browsing
 * modes, and full once a couple of provinces are stored. None of that may take
 * navigation down, so the contract is:
 *
 *  - **storage unavailable** (no `indexedDB` at all): `saveRegion` rejects with
 *    an explanation, and `loadRegion`/`listSavedRegions` report "nothing
 *    saved" (`null` / `[]`) while `deleteRegion` is a no-op. Callers can treat
 *    the region as a session-only region.
 *  - **storage present but failing**: the promise rejects with a message meant
 *    for a human, never a raw `DOMException`. A `QuotaExceededError` in
 *    particular names the region, its size and the region to delete instead.
 *  - **record unreadable** (truncated, or written by a different build):
 *    `loadRegion` rejects with a message telling the user to re-import, rather
 *    than pretending the region was never there. `loadAllRegions` skips such a
 *    record and carries on with the rest, which is what startup needs.
 *
 * Nothing here throws synchronously; every entry point returns a promise.
 */

import type { OsmDataset, RoadGraph, GazEntry, RenderLine, RenderPoly } from '../osm/engine.worker';
import type { RegionMeta } from '../osm/regions';

/** A region as it comes back out of storage. */
export interface SavedRegion {
  meta: RegionMeta;
  dataset: OsmDataset;
}

const DB_NAME = 'canopy-regions';
const DB_VERSION = 1;

/** Full record: meta + parsed dataset. Only ever read by id. */
const STORE_DATA = 'regions';
/** Meta-only mirror, so listing regions never pulls hundreds of MB. */
const STORE_META = 'meta';

/**
 * Layout version of a stored record. Bump it whenever `StoredDataset` changes
 * shape; older records are then reported as unreadable rather than loaded into
 * a half-understood graph.
 */
const RECORD_VERSION = 1;

/* ----------------------------- record layout ---------------------------- */

interface StoredMetaRow extends RegionMeta {
  savedAt: number;
  /** Approximate on-disk size, so the quota error can name a region to delete. */
  storedBytes: number;
}

interface StoredGraph {
  coords: ArrayBuffer;
  osmIds: ArrayBuffer;
  edgeStart: ArrayBuffer;
  edgeTo: ArrayBuffer;
  edgeCost: ArrayBuffer;
  edgeFlags: ArrayBuffer;
  edgeName: string[];
  nodeCount: number;
  regionOf: ArrayBuffer | null;
}

interface StoredDataset {
  graph: StoredGraph;
  gaz: GazEntry[];
  roads: RenderLine[];
  water: RenderPoly[];
  green: RenderPoly[];
  bbox: [number, number, number, number];
  counts: OsmDataset['counts'];
}

interface StoredRegion {
  id: string;
  recordVersion: number;
  savedAt: number;
  storedBytes: number;
  meta: RegionMeta;
  dataset: StoredDataset;
}

/* ------------------------------ availability ---------------------------- */

/** `false` in Node, in old WebViews, and wherever the namespace is stripped. */
function hasIndexedDb(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null &&
      typeof indexedDB.open === 'function';
  } catch {
    // Some embedded WebViews throw on merely touching the global.
    return false;
  }
}

/** Result of the last completed real probe, or `null` if none has run. */
let probed: boolean | null = null;

/**
 * Whether regions can be kept across restarts.
 *
 * Cheap to call and never throws, so a screen can ask before offering an
 * "offline maps" affordance. The first call in a session kicks off a real
 * database open (see `probePersistence`) and answers optimistically, because
 * every write still surfaces its own failure; later calls report what the
 * probe found. Await `probePersistence()` when a definitive answer is needed
 * before rendering.
 */
export function isPersistenceAvailable(): boolean {
  if (!hasIndexedDb()) return false;
  if (probed !== null) return probed;
  void probePersistence();
  return true;
}

/** Open the database for real and report whether it works. */
export async function probePersistence(): Promise<boolean> {
  if (!hasIndexedDb()) {
    probed = false;
    return false;
  }
  try {
    await openDb();
    probed = true;
  } catch {
    probed = false;
  }
  return probed;
}

/* ------------------------------ idb wrapper ----------------------------- */

let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * Promise wrapper around the few IndexedDB calls this module needs — no
 * dependency, no generics gymnastics, and every failure arrives as an `Error`.
 */
function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  const p = new Promise<IDBDatabase>((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(new Error(`This browser refused to open offline storage (${describe(e)}).`));
      return;
    }
    if (!req) {
      reject(new Error('This browser does not implement IndexedDB.'));
      return;
    }

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_DATA)) {
        db.createObjectStore(STORE_DATA, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab upgrading the schema: let go of the handle rather than
      // blocking it.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(wrap(req.error, 'open the offline map storage'));
    req.onblocked = () =>
      reject(new Error('Another Canopy window is using the offline map storage.'));
  });

  dbPromise = p;
  // Never cache a failed open: a later call may succeed (private-mode prompts,
  // storage pressure cleared, another tab closed).
  p.catch(() => {
    if (dbPromise === p) dbPromise = null;
  });
  return p;
}

/**
 * Run `work` in one transaction and resolve when the transaction *completes*,
 * not when the last request succeeds: a multi-record write where the first put
 * fails must not look successful because the second one answered.
 *
 * `work` gets a `track` callback for each request it issues, so a failing
 * request's own error (much more specific than `tx.error`) becomes the
 * rejection reason.
 */
async function transact(
  stores: string[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction, track: (rq: IDBRequest) => IDBRequest) => void,
): Promise<void> {
  const db = await openDb();

  await new Promise<void>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(stores, mode);
    } catch (e) {
      reject(wrap(e, 'start an offline storage transaction'));
      return;
    }

    let reqError: unknown = null;
    const track = (rq: IDBRequest): IDBRequest => {
      rq.onerror = () => {
        if (reqError === null) reqError = rq.error;
      };
      return rq;
    };

    tx.oncomplete = () => resolve();
    // A failed request aborts its transaction, so this covers both the request
    // failure and an explicit `abort()`.
    tx.onabort = () =>
      reject(reqError ?? tx.error ?? new Error('the storage transaction was aborted'));

    try {
      work(tx, track);
    } catch (e) {
      // e.g. a synchronous QuotaExceededError from a put.
      try { tx.abort(); } catch { /* already finished; nothing to undo */ }
      reject(e);
    }
  });
}

/** One record by key, or `undefined` if there isn't one. */
async function readOne<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  let value: T | undefined;
  await transact([store], 'readonly', (tx, track) => {
    const rq = track(tx.objectStore(store).get(key));
    rq.onsuccess = () => { value = rq.result as T | undefined; };
  });
  return value;
}

/** Every record in a store. Used only on the meta mirror, which is tiny. */
async function readAll<T>(store: string): Promise<T[]> {
  const out: T[] = [];
  await transact([store], 'readonly', (tx, track) => {
    const rq = track(tx.objectStore(store).openCursor());
    rq.onsuccess = () => {
      const cursor = rq.result;
      if (!cursor) return;
      out.push(cursor.value as T);
      cursor.continue();
    };
  });
  return out;
}

/* ------------------------- (de)serialising a dataset -------------------- */

interface TypedArrayCtor<T> {
  new (buffer: ArrayBuffer): T;
  BYTES_PER_ELEMENT: number;
}

/** Copy a view's bytes into a standalone buffer. */
function pack(view: ArrayBufferView): ArrayBuffer {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice().buffer;
}

function unpack<T>(
  buffer: ArrayBuffer | null | undefined,
  ctor: TypedArrayCtor<T>,
  field: string,
  id: string,
): T {
  if (!(buffer instanceof ArrayBuffer)) {
    throw corrupt(id, `the "${field}" array is missing`);
  }
  if (buffer.byteLength % ctor.BYTES_PER_ELEMENT !== 0) {
    throw corrupt(
      id,
      `the "${field}" array is ${buffer.byteLength} bytes, which is not a whole ` +
      `number of ${ctor.BYTES_PER_ELEMENT}-byte elements`,
    );
  }
  return new ctor(buffer);
}

/**
 * `edgeName` is built with `new Array(n)`, so it can carry holes. A hole and
 * `''` are interchangeable for every reader (`edgeName[e] ?? ''`), and
 * normalising here guarantees the restored graph is really a `string[]`.
 */
function packNames(names: string[]): string[] {
  return Array.from(names, (n) => n ?? '');
}

function serializeDataset(ds: OsmDataset): StoredDataset {
  const g = ds.graph;
  return {
    graph: {
      coords: pack(g.coords),
      osmIds: pack(g.osmIds),
      edgeStart: pack(g.edgeStart),
      edgeTo: pack(g.edgeTo),
      edgeCost: pack(g.edgeCost),
      edgeFlags: pack(g.edgeFlags),
      edgeName: packNames(g.edgeName),
      nodeCount: g.nodeCount,
      regionOf: g.regionOf ? pack(g.regionOf) : null,
    },
    // Plain objects and number arrays: structured clone handles these as-is.
    gaz: ds.gaz,
    roads: ds.roads,
    water: ds.water,
    green: ds.green,
    bbox: ds.bbox,
    counts: ds.counts,
  };
}

function deserializeDataset(s: StoredDataset, id: string): OsmDataset {
  const g = s?.graph;
  if (!g) throw corrupt(id, 'the stored dataset has no road graph');

  const base = {
    coords: unpack(g.coords, Float64Array, 'coords', id),
    osmIds: unpack(g.osmIds, Float64Array, 'osmIds', id),
    edgeStart: unpack(g.edgeStart, Uint32Array, 'edgeStart', id),
    edgeTo: unpack(g.edgeTo, Int32Array, 'edgeTo', id),
    edgeCost: unpack(g.edgeCost, Float32Array, 'edgeCost', id),
    edgeFlags: unpack(g.edgeFlags, Uint8Array, 'edgeFlags', id),
    edgeName: packNames(Array.isArray(g.edgeName) ? g.edgeName : []),
    nodeCount: g.nodeCount,
  };
  // Only merged graphs carry `regionOf`; don't invent the key.
  const graph: RoadGraph = g.regionOf
    ? { ...base, regionOf: unpack(g.regionOf, Int32Array, 'regionOf', id) }
    : base;

  return {
    graph,
    gaz: Array.isArray(s.gaz) ? s.gaz : [],
    roads: Array.isArray(s.roads) ? s.roads : [],
    water: Array.isArray(s.water) ? s.water : [],
    green: Array.isArray(s.green) ? s.green : [],
    bbox: Array.isArray(s.bbox) && s.bbox.length === 4
      ? s.bbox
      : [180, 90, -180, -90],
    counts: s.counts,
  };
}

/**
 * Roughly how much storage a dataset needs. Not exact — it is only used to
 * write a quota error a user can act on ("this one is 320 MB") — but it is
 * cheap and it counts the parts that actually dominate.
 */
export function estimateDatasetBytes(ds: OsmDataset): number {
  const g = ds.graph;
  let n =
    g.coords.byteLength + g.osmIds.byteLength + g.edgeStart.byteLength +
    g.edgeTo.byteLength + g.edgeCost.byteLength + g.edgeFlags.byteLength +
    (g.regionOf?.byteLength ?? 0);
  n += g.edgeName.length * 24;   // string headers
  n += ds.gaz.length * 160;      // object + strings + numbers
  n += linePoints(ds.roads) * 16 + polyPoints(ds.water) * 16 + polyPoints(ds.green) * 16;
  return Math.round(n);
}

function linePoints(lines: RenderLine[]): number {
  let n = 0;
  for (const l of lines) n += l.pts?.length ?? 0;
  return n;
}

function polyPoints(polys: RenderPoly[]): number {
  let n = 0;
  for (const p of polys) for (const ring of p.rings ?? []) n += ring.length;
  return n;
}

/* --------------------------------- errors ------------------------------- */

/** `"Ontario" (ca-on)`, for messages the user reads. */
function label(meta: RegionMeta): string {
  return `"${meta.name}" (${meta.id})`;
}

function describe(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === 'string' && e) return e;
  if (e && typeof e === 'object') {
    const err = e as { name?: string; message?: string };
    if (err.message) return `${err.name ? `${err.name}: ` : ''}${err.message}`;
    if (err.name) return err.name;
  }
  return 'unknown storage error';
}

function wrap(e: unknown, what: string): Error {
  const err = e instanceof Error ? e : new Error(describe(e));
  return new Error(`Could not ${what}: ${err.message}`);
}

function corrupt(id: string, why: string): Error {
  return new Error(
    `The saved copy of region "${id}" could not be read (${why}). ` +
    'Delete the region and import the .osm file again.',
  );
}

function isQuotaError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const err = e as { name?: string; code?: number; message?: string };
  return err.name === 'QuotaExceededError' ||
    err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||   // old Firefox
    (typeof err.code === 'number' && err.code === 22) ||
    /quota/i.test(err.message ?? '');
}

function mb(bytes: number): string {
  const m = bytes / (1024 * 1024);
  return `${m >= 100 ? Math.round(m) : m.toFixed(1)} MB`;
}

/* --------------------------------- public ------------------------------- */

/**
 * Cache a parsed dataset so it survives a restart. One record per region id,
 * overwriting any previous copy — re-importing the same province must not
 * accumulate duplicates.
 *
 * Rejects with an actionable `Error` on failure (no storage, or no room);
 * nothing is written on the error path.
 */
export async function saveRegion(meta: RegionMeta, dataset: OsmDataset): Promise<void> {
  if (!hasIndexedDb()) {
    throw new Error(
      `This browser has no offline storage, so ${label(meta)} cannot be kept for next time. ` +
      'It will stay available until the app is closed.',
    );
  }

  const storedBytes = estimateDatasetBytes(dataset);
  const savedAt = Date.now();
  const record: StoredRegion = {
    id: meta.id,
    recordVersion: RECORD_VERSION,
    savedAt,
    storedBytes,
    meta: { ...meta },
    dataset: serializeDataset(dataset),
  };
  const row: StoredMetaRow = { ...meta, savedAt, storedBytes };

  try {
    // Both stores in one transaction: a region is either listed *and* loadable,
    // or neither.
    await transact([STORE_DATA, STORE_META], 'readwrite', (tx, track) => {
      track(tx.objectStore(STORE_DATA).put(record));
      track(tx.objectStore(STORE_META).put(row));
    });
  } catch (e) {
    throw await saveFailure(meta, storedBytes, e);
  }
}

/** Turn a failed save into something worth putting on screen. */
async function saveFailure(meta: RegionMeta, bytes: number, e: unknown): Promise<Error> {
  if (!isQuotaError(e)) {
    return new Error(
      `Could not keep ${label(meta)} for offline use (${describe(e)}). ` +
      'It still works until the app is closed.',
    );
  }

  // Out of room is the expected failure for a couple of provinces, so name a
  // victim instead of just saying "full".
  let victim: StoredMetaRow | null = null;
  try {
    const rows = (await readAll<StoredMetaRow>(STORE_META))
      .filter((r) => r && typeof r.id === 'string' && r.id !== meta.id)
      .sort((a, b) => (b.storedBytes ?? 0) - (a.storedBytes ?? 0));
    victim = rows[0] ?? null;
  } catch {
    // Best effort only: the advice is a bonus, not the message.
  }

  return new Error(
    `Not enough device storage to keep ${label(meta)} (${mb(bytes)}). ` +
    (victim
      ? `Remove ${label(victim)} (${mb(victim.storedBytes ?? 0)}) from Offline maps ` +
        `first, then import ${meta.name} again.`
      : 'Free up space on the device, then import it again.'),
  );
}

/** A saved region, or `null` if that id was never saved (or storage is absent). */
export async function loadRegion(id: string): Promise<SavedRegion | null> {
  if (!hasIndexedDb()) return null;

  const record = await readOne<StoredRegion>(STORE_DATA, id);
  if (!record) return null;
  if (record.recordVersion !== RECORD_VERSION) {
    throw new Error(
      `The saved copy of "${id}" was written by a different version of Canopy ` +
      'and cannot be read. Delete the region and import the .osm file again.',
    );
  }

  let dataset: OsmDataset;
  try {
    dataset = deserializeDataset(record.dataset, id);
  } catch (e) {
    throw e instanceof Error ? e : corrupt(id, describe(e));
  }
  return { meta: toMeta(record.meta, id), dataset };
}

/** Metadata for every saved region, newest first. Never reads the datasets. */
export async function listSavedRegions(): Promise<RegionMeta[]> {
  if (!hasIndexedDb()) return [];
  const rows = await readAll<StoredMetaRow>(STORE_META);
  return rows
    .filter((r): r is StoredMetaRow => !!r && typeof r.id === 'string')
    .map((r) => toMeta(r, r.id))
    .sort((a, b) => b.loadedAt - a.loadedAt || a.name.localeCompare(b.name));
}

/**
 * Forget a region on disk. Removing an id that isn't stored is not an error,
 * and neither is having no storage at all.
 */
export async function deleteRegion(id: string): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    await transact([STORE_DATA, STORE_META], 'readwrite', (tx, track) => {
      track(tx.objectStore(STORE_DATA).delete(id));
      track(tx.objectStore(STORE_META).delete(id));
    });
  } catch (e) {
    throw new Error(
      `Could not delete the saved copy of "${id}" (${describe(e)}). ` +
      'It will reappear the next time the app starts.',
    );
  }
}

/**
 * Every saved region, for startup. One unreadable record is skipped with a
 * warning rather than taking the whole library down with it — the user can
 * still route through the regions that did load.
 */
export async function loadAllRegions(): Promise<SavedRegion[]> {
  if (!hasIndexedDb()) return [];
  const out: SavedRegion[] = [];
  for (const meta of await listSavedRegions()) {
    try {
      const region = await loadRegion(meta.id);
      if (region) out.push(region);
    } catch (e) {
      console.warn(`Canopy: skipping saved region ${label(meta)}`, e);
    }
  }
  return out;
}

/** Exactly the `RegionMeta` fields, so callers get a clean object. */
function toMeta(row: RegionMeta | StoredMetaRow | undefined, id: string): RegionMeta {
  const r = (row ?? {}) as Partial<StoredMetaRow>;
  return {
    id: typeof r.id === 'string' ? r.id : id,
    name: r.name ?? id,
    code: r.code ?? '',
    bbox: Array.isArray(r.bbox) && r.bbox.length === 4 ? r.bbox : [180, 90, -180, -90],
    loadedAt: typeof r.loadedAt === 'number' ? r.loadedAt : 0,
    bytes: typeof r.bytes === 'number' ? r.bytes : 0,
    counts: r.counts ?? { nodes: 0, ways: 0, routable: 0 },
    gazetteerSize: typeof r.gazetteerSize === 'number' ? r.gazetteerSize : 0,
  };
}