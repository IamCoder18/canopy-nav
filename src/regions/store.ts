/**
 * App-wide region store.
 *
 * The library in `osm/regions.ts` is pure data + geometry; this module owns
 * the *runtime* half of multi-region support:
 *
 *  - one `RegionLibrary` for the whole app (regions outlive any single screen,
 *    so a module singleton is simpler than threading it through props),
 *  - one `OsmEngine` per region id. An engine caches its build promise, so it
 *    is single-use; a re-import has to spin up a fresh worker,
 *  - a `useRegions()` hook so screens re-render when the library changes.
 *
 * Parser reality check: `engine.worker.ts` reads **XML** only. A Geofabrik
 * `.osm.pbf` is protobuf and cannot be parsed here, so those files are rejected
 * up front with a message pointing at `osmium cat`.
 */

import { useSyncExternalStore } from 'react';
import { OsmEngine, type BuildProgress } from '../osm/engine';
import type { OsmDataset } from '../osm/engine.worker';
import { RegionLibrary, type Region, type RegionMeta } from '../osm/regions';
import { saveRegion, deleteRegion, loadAllRegions, probePersistence } from './persist';

/** The one library. Downloaded regions live here for the life of the session. */
export const regionLib = new RegionLibrary();

/** Parser workers, keyed by region id. */
const engines = new Map<string, OsmEngine>();

export interface ImportRequest {
  /** Library id to store the extract under, e.g. 'ca-ab'. */
  id: string;
  /** Display name, e.g. 'Alberta'. */
  name: string;
  /** Admin code as downloaded, shown in the manage list. */
  code: string;
  file: File;
  onProgress?: (p: BuildProgress | null) => void;
  onError?: (message: string | null) => void;
  /**
   * Non-fatal persistence problem, e.g. the device is out of room.
   *
   * Deliberately separate from `onError`: failing to cache a region must never
   * make a perfectly good import look broken. Quota is the one case the driver
   * genuinely needs to see, so it is reported without failing the import.
   */
  onPersistError?: (message: string | null) => void;
}

/**
 * Parse a `.osm` XML file and register it in the library under `id`.
 * Returns the parsed dataset on success, `null` on failure (the error is
 * reported through `onError`, so callers only need to check for `null`).
 */
export async function importRegionFile(req: ImportRequest): Promise<OsmDataset | null> {
  const { onProgress, onError, onPersistError } = req;
  onError?.(null);
  onProgress?.({ stage: 'Reading file', pct: 0 });

  // An engine can only be built once, so replacing a region needs a new worker.
  const prev = engines.get(req.id);
  const engine = new OsmEngine();
  engines.set(req.id, engine);
  engine.setProgressHandler(onProgress ?? null);

  try {
    // Both .osm (XML) and .osm.pbf (protobuf) are accepted; OsmEngine sniffs
    // which it actually got, so a mislabelled extension still works.
    onProgress?.({ stage: 'Reading extract', pct: 0 });
    const dataset = await engine.build(req.file);

    const meta: RegionMeta = {
      id: req.id,
      name: req.name,
      code: req.code,
      bbox: dataset.bbox,
      loadedAt: Date.now(),
      bytes: req.file.size,
      counts: dataset.counts,
      gazetteerSize: dataset.gaz.length,
    };
    regionLib.add(meta, dataset);

    prev?.dispose();
    onProgress?.(null);

    // Cache the parsed dataset so it survives a restart. Re-parsing a province
    // takes tens of seconds, so this is worth doing even though it is not
    // required for the import to be usable.
    void saveRegion(meta, dataset)
      .then(() => onPersistError?.(null))
      .catch((err: Error) => onPersistError?.(err.message));

    return dataset;
  } catch (e) {
    // A failed replace must not take the working region down with it: the
    // parsed data lives on the library's Region, not on the worker.
    engine.dispose();
    if (prev) engines.set(req.id, prev);
    else engines.delete(req.id);
    onProgress?.(null);
    onError?.((e as Error).message);
    return null;
  }
}

/**
 * Rehydrate regions saved by a previous session.
 *
 * Returns the restored regions so the caller can pick an active dataset; a
 * restored region has no worker (routing and search run off the parsed dataset
 * on the main thread), so it is immediately usable.
 */
export async function restoreRegions(): Promise<Region[]> {
  try {
    if (!(await probePersistence())) return [];
    const saved = await loadAllRegions();
    const out: Region[] = [];
    for (const { meta, dataset } of saved) {
      out.push(regionLib.add(meta, dataset));
    }
    return out;
  } catch {
    // Never block startup on a storage problem.
    return [];
  }
}

/** Drop a region, release its worker, and forget the cached copy. */
export function removeRegion(id: string) {
  regionLib.remove(id);
  engines.get(id)?.dispose();
  void deleteRegion(id).catch(() => { /* nothing to do if it is already gone */ });
  engines.delete(id);
}

/** Total bytes held by loaded extracts, for the manage screen. */
export function regionBytes(): number {
  return regionLib.all.reduce((s, r) => s + r.bytes, 0);
}

/* ------------------------- React bindings ------------------------- */

// `RegionLibrary.all` builds a fresh array each call, so the snapshot is
// cached here; useSyncExternalStore would loop on an unstable getSnapshot.
let snapshot: readonly Region[] = Object.freeze(regionLib.all);

function onLibraryChange() {
  snapshot = Object.freeze(regionLib.all);
  for (const fn of libListeners) fn();
}

const libListeners = new Set<() => void>();
regionLib.subscribe(onLibraryChange);

/** Re-render whenever regions are added or removed. */
export function useRegions(): readonly Region[] {
  return useSyncExternalStore(
    (fn) => {
      libListeners.add(fn);
      return () => { libListeners.delete(fn); };
    },
    () => snapshot,
    () => snapshot,
  );
}

/* --------------------------- file naming --------------------------- */

/** `Alberta-latest.osm` -> `alberta-latest`. */
function stem(name: string): string {
  return name.replace(/\.(osm|xml|pbf)$/i, '');
}

/** Library id for an ad-hoc import that isn't tied to a catalogue entry. */
export function localRegionId(file: File): string {
  const slug = stem(file.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug ? `local-${slug}` : 'local-extract';
}

/** Human label for an ad-hoc import, e.g. `british-columbia.osm` -> 'British Columbia'. */
export function localRegionName(file: File): string {
  const words = stem(file.name).replace(/[-_]+/g, ' ').trim();
  if (!words) return 'Imported extract';
  return words.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}