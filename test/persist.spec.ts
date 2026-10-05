/**
 * Persistence tests for downloaded OSM regions.
 *
 * IndexedDB doesn't exist in plain Node, so `fake-indexeddb` stands in: a pure
 * in-memory implementation of the real API, including structured clone. That
 * matters here — the whole point of the module under test is what survives the
 * clone, and a hand-written shim would happily agree with a broken
 * implementation.
 *
 * The datasets under test come from the real parser (`test/fixture.osm`), so
 * the round-trip assertions cover the shapes the app actually produces: a CSR
 * graph, a gazetteer with optional fields, render geometry, and a merged graph
 * carrying the optional `regionOf` array.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';

import { parseOsmXml, buildDataset, FLAG_ONEWAY_F, FLAG_ONEWAY_B } from '../src/osm/engine.worker';
import type { OsmDataset } from '../src/osm/engine.worker';
import { mergeRegions } from '../src/osm/merge';
import type { Region, RegionMeta } from '../src/osm/regions';
import {
  isPersistenceAvailable, probePersistence, saveRegion, loadRegion,
  listSavedRegions, deleteRegion, loadAllRegions, estimateDatasetBytes,
} from '../src/regions/persist';

/* ------------------------------ environment ----------------------------- */

const factory = new IDBFactory();
const realIndexedDb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');

function installIndexedDb() {
  Object.defineProperty(globalThis, 'indexedDB', {
    value: factory, configurable: true, writable: true,
  });
}
function uninstallIndexedDb() {
  Object.defineProperty(globalThis, 'indexedDB', {
    value: undefined, configurable: true, writable: true,
  });
}
installIndexedDb();

afterEach(() => {
  // Whatever a test did to the global, the next test gets a working store.
  if (realIndexedDb) Object.defineProperty(globalThis, 'indexedDB', realIndexedDb);
  else installIndexedDb();
});

/* -------------------------------- fixtures ------------------------------ */

const XML = readFileSync(join(__dirname, 'fixture.osm'), 'utf8');

function parsed(): OsmDataset {
  const { nodes, ways } = parseOsmXml(XML);
  return buildDataset(nodes, ways, () => {});
}

/**
 * Reach past the module's API and rewrite a stored record in place.
 *
 * Needed because the defect under test is a *record* that is missing a field, and
 * every public writer here writes a complete one. The stores are opened directly
 * rather than through `persist.ts`, which is the point: a test that goes through
 * the same code it is testing cannot produce malformed input for it.
 */
async function corruptRecord(id: string, mutate: (rec: unknown) => void) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('canopy-regions', 1);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  try {
    const existing = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction('regions', 'readwrite');
      const get = tx.objectStore('regions').get(id);
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(get.error);
    });
    mutate(existing);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('regions', 'readwrite');
      tx.objectStore('regions').put(existing);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

function metaFor(id: string, name: string, ds: OsmDataset): RegionMeta {
  return {
    id,
    name,
    code: id.toUpperCase(),
    bbox: ds.bbox,
    loadedAt: 1_700_000_000_000,
    bytes: 12_345_678,
    counts: ds.counts,
    gazetteerSize: ds.gaz.length,
  };
}

/** Ids used by the suite; cleared before every test. */
const IDS = ['ca-ab', 'ca-on', 'ca-bc', 'ca-ns', 'local-edmonton', 'ca-damaged'];

beforeEach(async () => {
  for (const id of IDS) await deleteRegion(id);
});

/* -------------------------------- raw idb ------------------------------- */

// persist.ts keeps these private; the tests reach for them only to stage damage
// that a well-behaved save can never produce.
const DB = 'canopy-regions';
const STORE_DATA = 'regions';

/** Read/modify/write one raw record, bypassing the module under test. */
async function patchStoredRecord(id: string, mutate: (rec: Record<string, any>) => void) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory.open(DB);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const rec = await new Promise<Record<string, any>>((resolve, reject) => {
    const tx = db.transaction(STORE_DATA, 'readwrite');
    const rq = tx.objectStore(STORE_DATA).get(id);
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
  mutate(rec);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_DATA, 'readwrite');
    tx.objectStore(STORE_DATA).put(rec);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
  db.close();
}

/**
 * Make `put` of `id` fail — as a full disk does. Pass a store name to fail only
 * the second write of a save, which is what proves the transaction as a whole
 * is rejected rather than "one of the two writes worked".
 */
function failPutFor(id: string, error: unknown, store?: string): () => void {
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function patched(this: IDBObjectStore, value: any, key?: any) {
    if (value?.id === id && (!store || this.name === store)) throw error;
    return original.call(this, value, key);
  } as typeof IDBObjectStore.prototype.put;
  return () => { IDBObjectStore.prototype.put = original; };
}

/* --------------------------------- tests -------------------------------- */

describe('persistence availability', () => {
  it('probes IndexedDB rather than assuming it', async () => {
    expect(isPersistenceAvailable()).toBe(true);
    expect(await probePersistence()).toBe(true);
    // The probe is memoised, and the second call is still a yes.
    expect(isPersistenceAvailable()).toBe(true);
  });

  it('reports unavailable and fails safely with no storage', async () => {
    const ds = parsed();
    const meta = metaFor('ca-on', 'Ontario', ds);
    uninstallIndexedDb();

    expect(isPersistenceAvailable()).toBe(false);
    expect(await probePersistence()).toBe(false);
    expect(await loadRegion('ca-on')).toBeNull();
    expect(await listSavedRegions()).toEqual([]);
    expect(await loadAllRegions()).toEqual([]);
    await expect(deleteRegion('ca-on')).resolves.toBeUndefined();

    // Saving has to fail, but with a sentence a person can read.
    const err = await saveRegion(meta, ds).then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain('Ontario');
    expect(err!.message).toMatch(/offline storage/i);

    // And nothing about the failure looks like a raw DOM exception.
    expect(err!.name).toBe('Error');
  });

  it('works again once storage comes back', async () => {
    const ds = parsed();
    uninstallIndexedDb();
    expect(isPersistenceAvailable()).toBe(false);
    installIndexedDb();
    expect(await probePersistence()).toBe(true);
    await saveRegion(metaFor('ca-ab', 'Alberta', ds), ds);
    expect((await loadRegion('ca-ab'))!.dataset.gaz.length).toBe(ds.gaz.length);
  });
});

const ARRAYS = ['coords', 'osmIds', 'edgeStart', 'edgeTo', 'edgeCost', 'edgeFlags'] as const;

describe('dataset round trip', () => {
  /**
   * A record whose `counts` did not survive.
   *
   * `counts` was the one field in the stored record that was not validated, and
   * also the one field read without a guard: `counts.routable.toLocaleString()`
   * on the launcher, during render. A record from an older build, or one
   * truncated by a crash mid-`put`, deserialised with `counts === undefined` and
   * the app opened on the top-level crash card — on launch, with no Settings
   * screen to recover from.
   *
   * `toMeta` already defaulted it, which is the tell that the two paths disagreed
   * about whether the field was trustworthy.
   */
  it('substitutes usable counts for a record missing them, rather than crashing on launch', async () => {
    const ds = parsed();
    const meta = metaFor('ca-ab', 'Alberta', ds);
    await saveRegion(meta, ds);

    // Corrupt the stored record the way a partial write would: reach past the
    // module's own API and drop the field from the record on disk.
    // `counts` lives inside the record's `dataset`, not at its root.
    await corruptRecord('ca-ab', (rec) => {
      const ds = (rec as { dataset?: Record<string, unknown> }).dataset;
      if (ds) delete ds.counts;
    });

    const loaded = await loadRegion('ca-ab');
    expect(loaded).not.toBeNull();
    // The shape the render path depends on: three finite numbers.
    expect(loaded!.dataset.counts).toEqual({ nodes: 0, ways: 0, routable: 0 });
    // And the exact expression the launcher evaluates, which used to throw.
    expect(() => loaded!.dataset.counts.routable.toLocaleString()).not.toThrow();
  });

  it('restores a parsed dataset unchanged', async () => {
    const ds = parsed();
    const meta = metaFor('ca-ab', 'Alberta', ds);
    await saveRegion(meta, ds);

    const loaded = await loadRegion('ca-ab');
    expect(loaded).not.toBeNull();
    expect(loaded!.meta).toEqual(meta);
    expect(loaded!.dataset).toEqual(ds);

    // The graph is rebuilt as real typed arrays, not as {"0":1,...} objects.
    const g = loaded!.dataset.graph;
    expect(g.coords).toBeInstanceOf(Float64Array);
    expect(g.osmIds).toBeInstanceOf(Float64Array);
    expect(g.edgeStart).toBeInstanceOf(Uint32Array);
    expect(g.edgeTo).toBeInstanceOf(Int32Array);
    expect(g.edgeCost).toBeInstanceOf(Float32Array);
    expect(g.edgeFlags).toBeInstanceOf(Uint8Array);
    expect(Array.isArray(g.edgeName)).toBe(true);
    expect(g.nodeCount).toBe(ds.graph.nodeCount);

    for (const key of ARRAYS) {
      expect(loaded!.dataset.graph[key].length).toBe(ds.graph[key].length);
      expect(Array.from(loaded!.dataset.graph[key])).toEqual(Array.from(ds.graph[key]));
      expect(loaded!.dataset.graph[key].buffer.byteLength)
        .toBe(ds.graph[key].buffer.byteLength);
    }
    expect(loaded!.dataset.graph.edgeName).toEqual(ds.graph.edgeName);

    // Non-graph payload survives too.
    expect(loaded!.dataset.bbox).toEqual(ds.bbox);
    expect(loaded!.dataset.counts).toEqual(ds.counts);
    expect(loaded!.dataset.gaz).toEqual(ds.gaz);
    expect(loaded!.dataset.roads).toEqual(ds.roads);
    expect(loaded!.dataset.water).toEqual(ds.water);
    expect(loaded!.dataset.green).toEqual(ds.green);
  });

  it('restores the graph flags and one-way bits that routing depends on', async () => {
    const ds = parsed();
    await saveRegion(metaFor('ca-ab', 'Alberta', ds), ds);
    const g = (await loadRegion('ca-ab'))!.dataset.graph;

    let twoWay = 0;
    let oneWay = 0;
    for (let e = 0; e < g.edgeTo.length; e++) {
      const f = g.edgeFlags[e];
      if (f === (FLAG_ONEWAY_F | FLAG_ONEWAY_B)) twoWay++;
      else oneWay++;
    }
    // The fixture is full of one-ways; losing edgeFlags would break routing
    // silently, so assert the data still carries both kinds.
    expect(twoWay).toBeGreaterThan(0);
    expect(oneWay).toBeGreaterThan(0);
    expect(g.edgeFlags.some((f) => f === 0)).toBe(false);
  });

  it('restores a merged graph including the optional regionOf array', async () => {
    const ds = parsed();
    const region: Region = { ...metaFor('ca-ab', 'Alberta', ds), dataset: ds };
    const merged = mergeRegions([region, region]);
    expect(merged.graph.regionOf).toBeInstanceOf(Int32Array);

    const mergedDs: OsmDataset = { ...ds, graph: merged.graph };
    await saveRegion(metaFor('ca-ns', 'Nova Scotia', mergedDs), mergedDs);

    const g = (await loadRegion('ca-ns'))!.dataset.graph;
    expect(g.regionOf).toBeInstanceOf(Int32Array);
    expect(Array.from(g.regionOf!)).toEqual(Array.from(merged.graph.regionOf!));
    expect((await loadRegion('ca-ns'))!.dataset).toEqual(mergedDs);
  });

  it('keeps signed integers and empty street names intact', async () => {
    // A tiny hand-built graph: -1 is not a legal edge target, it is here to
    // prove the buffer is rebuilt as Int32Array rather than Uint32Array, and
    // the empty name proves edgeName lines up with the edges.
    const coords = new Float64Array([-114.07, 51.045, -114.06, 51.046, -114.05, 51.047]);
    const osmIds = new Float64Array([101, 102, 103]);
    const edgeStart = new Uint32Array([0, 2, 2, 3]);
    const edgeTo = new Int32Array([-1, 2, 0]);
    const edgeCost = new Float32Array([0.5, 12.25, 3.5]);
    const edgeFlags = new Uint8Array([0, FLAG_ONEWAY_F, FLAG_ONEWAY_B]);
    const ds: OsmDataset = {
      graph: {
        coords, osmIds, edgeStart, edgeTo, edgeCost, edgeFlags,
        edgeName: ['', 'Ave', ''], nodeCount: 3,
      },
      gaz: [
        { name: 'Edmonton', lat: 51.045, lon: -114.07, cat: 'place', rank: 100 },
        {
          name: '128 St', lat: 51.046, lon: -114.06, cat: 'street', rank: 30,
          street: '128 St', streetLat: 51.046, streetLon: -114.06,
        },
      ],
      roads: [{ class: 'residential', pts: [[-114.07, 51.045], [-114.05, 51.047]] }],
      water: [{ class: 'river', rings: [[[-114.07, 51.045], [-114.06, 51.046]]] }],
      green: [
        { class: 'park', rings: [[[-114.06, 51.046], [-114.05, 51.047], [-114.07, 51.045]]] },
      ],
      bbox: [-114.07, 51.045, -114.05, 51.047],
      counts: { nodes: 3, ways: 2, routable: 1 },
    };

    await saveRegion(metaFor('local-edmonton', 'Edmonton', ds), ds);
    const loaded = await loadRegion('local-edmonton');
    expect(loaded!.dataset).toEqual(ds);
    expect(loaded!.dataset.graph.edgeTo[0]).toBe(-1);
    expect(loaded!.dataset.graph.edgeFlags[0]).toBe(0);
    expect(loaded!.dataset.graph.edgeName).toEqual(['', 'Ave', '']);
    expect(loaded!.dataset.gaz[1].streetLat).toBe(51.046);
  });

  it('estimates a dataset at more than zero bytes', () => {
    expect(estimateDatasetBytes(parsed())).toBeGreaterThan(0);
  });
});

describe('listing saved regions', () => {
  it('returns nothing when the store is empty', async () => {
    expect(await listSavedRegions()).toEqual([]);
  });

  it('lists metadata only, newest first, with no stored fields leaking', async () => {
    const ab = parsed();
    const ds = parsed();
    await saveRegion(metaFor('ca-ab', 'Alberta', ab), ab);
    await saveRegion(
      { ...metaFor('ca-bc', 'British Columbia', ds), loadedAt: 1_800_000_000_000 },
      ds,
    );

    const list = await listSavedRegions();
    expect(list.map((r) => r.id)).toEqual(['ca-bc', 'ca-ab']);
    expect(Object.keys(list[0]).sort()).toEqual(
      ['bbox', 'bytes', 'code', 'counts', 'gazetteerSize', 'id', 'loadedAt', 'name'],
    );
    expect(list[0].name).toBe('British Columbia');
  });
});

describe('deleting', () => {
  it('removes the dataset and the listing', async () => {
    const ds = parsed();
    await saveRegion(metaFor('ca-on', 'Ontario', ds), ds);
    expect(await loadRegion('ca-on')).not.toBeNull();

    await deleteRegion('ca-on');
    expect(await loadRegion('ca-on')).toBeNull();
    expect((await listSavedRegions()).map((r) => r.id)).toEqual([]);
    expect((await loadAllRegions())).toEqual([]);
  });

  it('ignores an id that was never saved', async () => {
    await expect(deleteRegion('ca-ns')).resolves.toBeUndefined();
    expect(await loadRegion('ca-ns')).toBeNull();
  });
});

describe('overwriting a region', () => {
  it('replaces the record instead of adding a second one', async () => {
    const first = parsed();
    const second = parsed();
    await saveRegion(metaFor('ca-ab', 'Alberta', first), first);
    await saveRegion(
      { ...metaFor('ca-ab', 'Alberta', first), loadedAt: 1_900_000_000_000, bytes: 999 },
      second,
    );

    const list = await listSavedRegions();
    expect(list).toHaveLength(1);
    expect(list[0].loadedAt).toBe(1_900_000_000_000);
    expect(list[0].bytes).toBe(999);

    const loaded = await loadRegion('ca-ab');
    expect(loaded!.dataset).toEqual(second);
  });

  it('does not leave stale bytes from the previous dataset', async () => {
    // The classic typed-array persistence bug: a shorter region saved over a
    // longer one, with the old buffer left attached.
    const big = parsed();
    const small: OsmDataset = { ...big, gaz: [], roads: [], water: [], green: [] };
    small.graph = {
      coords: new Float64Array([-114.07, 51.045]),
      osmIds: new Float64Array([1]),
      edgeStart: new Uint32Array([0, 0]),
      edgeTo: new Int32Array([]),
      edgeCost: new Float32Array([]),
      edgeFlags: new Uint8Array([]),
      edgeName: [],
      nodeCount: 1,
    };

    await saveRegion(metaFor('ca-ab', 'Alberta', big), big);
    await saveRegion(metaFor('ca-ab', 'Alberta', small), small);

    const loaded = (await loadRegion('ca-ab'))!.dataset;
    expect(loaded.graph.nodeCount).toBe(1);
    expect(loaded.graph.edgeTo.length).toBe(0);
    expect(loaded.graph.edgeName).toEqual([]);
    expect(loaded.gaz).toEqual([]);
    expect(loaded).toEqual(small);
  });
});

describe('failures are readable', () => {
  it('names the region and what to delete when the device is full', async () => {
    const bc = parsed();
    const on = parsed();
    await saveRegion(metaFor('ca-bc', 'British Columbia', bc), bc);

    const quota = new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    const restore = failPutFor('ca-on', quota);
    try {
      const err = await saveRegion(metaFor('ca-on', 'Ontario', on), on)
        .then(() => null, (e: Error) => e);

      expect(err).toBeInstanceOf(Error);
      // An Error the user can be shown, not a DOMException with a code.
      expect(err!.name).toBe('Error');
      expect(err!.message).toContain('Ontario');
      expect(err!.message).toMatch(/not enough device storage/i);
      expect(err!.message).toMatch(/remove/i);
      // Actionable: the biggest other region is named so they can act.
      expect(err!.message).toContain('British Columbia');
      expect(err!.message).not.toMatch(/\[object DOMException\]/);
    } finally {
      restore();
    }

    // The failed save left nothing behind, and the existing region is intact.
    expect(await loadRegion('ca-on')).toBeNull();
    expect((await listSavedRegions()).map((r) => r.id)).toEqual(['ca-bc']);
    expect((await loadRegion('ca-bc'))!.dataset).toEqual(bc);
  });

  it('still names the region when there is nothing else to remove', async () => {
    const on = parsed();
    const restore = failPutFor('ca-on', new DOMException('full', 'QuotaExceededError'));
    try {
      const err = await saveRegion(metaFor('ca-on', 'Ontario', on), on)
        .then(() => null, (e: Error) => e);
      expect(err!.message).toContain('Ontario');
      expect(err!.message).toMatch(/free up space|out of space/i);
      expect(err!.message).not.toMatch(/\[object/);
    } finally {
      restore();
    }
  });

  it('turns a write failure into a sentence, and writes nothing', async () => {
    const ds = parsed();
    const restore = failPutFor('ca-ns', new Error('the disk fell over'));
    try {
      const err = await saveRegion(metaFor('ca-ns', 'Nova Scotia', ds), ds)
        .then(() => null, (e: Error) => e);
      expect(err!.name).toBe('Error');
      expect(err!.message).toContain('Nova Scotia');
      expect(err!.message).toContain('the disk fell over');
      expect(err!.message).toMatch(/until the app is closed/i);
    } finally {
      restore();
    }

    // A rejected transaction must not leave a half-written listing behind.
    expect(await loadRegion('ca-ns')).toBeNull();
    expect((await listSavedRegions()).map((r) => r.id)).toEqual([]);
  });

  it('rolls the whole save back when the second write fails', async () => {
    // A region is written as two records in one transaction: the dataset and
    // the listing entry. If only the second fails, saving must still fail and
    // must not leave a loadable region that the manage screen can't see.
    const ds = parsed();
    const quota = new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    const restore = failPutFor('ca-bc', quota, 'meta');
    try {
      const err = await saveRegion(metaFor('ca-bc', 'British Columbia', ds), ds)
        .then(() => null, (e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toContain('British Columbia');
    } finally {
      restore();
    }

    expect(await loadRegion('ca-bc')).toBeNull();
    expect(await listSavedRegions()).toEqual([]);
  });

  it('rejects rather than silently dropping an unreadable record', async () => {
    const ds = parsed();
    await saveRegion(metaFor('ca-damaged', 'Damaged', ds), ds);
    await patchStoredRecord('ca-damaged', (rec) => { rec.recordVersion = 999; });

    const err = await loadRegion('ca-damaged').then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain('ca-damaged');
    expect(err!.message).toMatch(/different version of canopy/i);
    expect(err!.message).toMatch(/import .* again/i);
  });

  it('reports a truncated graph instead of loading half of it', async () => {
    const ds = parsed();
    await saveRegion(metaFor('ca-damaged', 'Damaged', ds), ds);
    // Two bytes is not a whole number of Int32 elements.
    await patchStoredRecord('ca-damaged', (rec) => {
      rec.dataset.graph.edgeTo = new ArrayBuffer(2);
    });

    const err = await loadRegion('ca-damaged').then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain('edgeTo');
    expect(err!.message).toMatch(/import .* again/i);
  });

  it('rehydration skips a damaged region and keeps the rest', async () => {
    const ab = parsed();
    const on = parsed();
    await saveRegion(metaFor('ca-ab', 'Alberta', ab), ab);
    await saveRegion(metaFor('ca-on', 'Ontario', on), on);
    await patchStoredRecord('ca-on', (rec) => { rec.recordVersion = 999; });

    const all = await loadAllRegions();
    expect(all.map((r) => r.meta.id)).toEqual(['ca-ab']);
    expect(all[0].dataset).toEqual(ab);
  });
});