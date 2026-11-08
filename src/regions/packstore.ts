/**
 * Offline persistence for routing packs.
 *
 * A pack is the offline Valhalla engine's data: the tar of `.gph` tiles
 * `tools/build-pack.mjs` produces. Separate from `persist.ts` (which stores
 * parsed OSM datasets) because the two have different life cycles — a pack can
 * exist with or without an imported map, and a map with or without a pack — and
 * because a pack is one opaque blob rather than a graph to rehydrate.
 *
 * Separate *database* rather than a new store in `canopy-regions`: bumping that
 * database's version to add a store would run a migration over records holding
 * provinces, and this feature has no reason to put those bytes at risk.
 *
 * The failure policy is `persist.ts`'s, verbatim in spirit: storage problems
 * never take navigation down, and every rejection says something a human can
 * act on.
 */

export interface SavedPack {
  id: string;
  info: PackInfo;
  data: ArrayBuffer;
}

/**
 * What a pack is. Re-exported from `osm/regions` (where `RegionMeta.pack`
 * lives) so the store and the screen agree on one shape.
 */
export type { PackInfo } from '../osm/regions';
import type { PackInfo } from '../osm/regions';

const DB_NAME = 'canopy-packs';
const DB_VERSION = 1;
const STORE = 'packs';

interface PackRow {
  id: string;
  info: PackInfo;
  savedAt: number;
  data: ArrayBuffer;
}

function hasIndexedDb(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null &&
      typeof indexedDB.open === 'function';
  } catch {
    return false;
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!hasIndexedDb()) {
      reject(new Error('This device cannot store routing packs (no IndexedDB). The pack works for this session only.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(storageError(req.error));
    req.onblocked = () => reject(new Error('Another tab is holding the pack storage. Close other tabs of this app and try again.'));
  });
}

/** A sentence, never a raw DOMException. */
function storageError(e: unknown): Error {
  const name = e instanceof DOMException ? e.name : '';
  if (name === 'QuotaExceededError') {
    return new Error('This device is out of storage for routing packs. Remove a region or a pack and try again.');
  }
  return new Error(
    e instanceof Error && e.message ? `Could not use pack storage: ${e.message}` : 'Could not use pack storage.',
  );
}

export async function savePack(id: string, data: ArrayBuffer, info: PackInfo): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const row: PackRow = { id, info, savedAt: Date.now(), data };
      tx.objectStore(STORE).put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(storageError(tx.error));
      tx.onabort = () => reject(storageError(tx.error));
    });
  } finally {
    db.close();
  }
}

export async function loadPack(id: string): Promise<SavedPack | null> {
  if (!hasIndexedDb()) return null;
  const db = await openDb();
  try {
    const row = await new Promise<PackRow | undefined>((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result as PackRow | undefined);
      req.onerror = () => reject(storageError(req.error));
    });
    return row ? { id: row.id, info: row.info, data: row.data } : null;
  } catch {
    // Unreadable record: reported as absent rather than as a startup failure.
    return null;
  } finally {
    db.close();
  }
}

/** Ids + sizes only — listing never pulls pack bytes. */
export async function listPacks(): Promise<{ id: string; info: PackInfo }[]> {
  if (!hasIndexedDb()) return [];
  const db = await openDb();
  try {
    const rows = await new Promise<PackRow[]>((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      req.onsuccess = () => resolve((req.result as PackRow[]) ?? []);
      req.onerror = () => reject(storageError(req.error));
    });
    return rows.map((r) => ({ id: r.id, info: r.info }));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export async function deletePack(id: string): Promise<void> {
  if (!hasIndexedDb()) return;
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(storageError(tx.error));
    });
  } finally {
    db.close();
  }
}
