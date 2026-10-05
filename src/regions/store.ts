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
import { OsmEngine, importPreflight, type BuildProgress } from '../osm/engine';
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
  /**
   * Non-fatal complaint about a file that *did* import — a valid extract with
   * nothing routable in it, say. Distinct from `onError`, which means the import
   * failed and nothing changed.
   */
  onWarn?: (message: string | null) => void;
}

/** Best-effort guess that a file is a saved web page rather than map data. */
function isProbablyHtml(file: File): boolean {
  return /\.(html?|htm|txt|json)$/i.test(file.name ?? '');
}

/**
 * Parse a `.osm` XML file and register it in the library under `id`.
 * Returns the parsed dataset on success, `null` on failure (the error is
 * reported through `onError`, so callers only need to check for `null`).
 */
export async function importRegionFile(req: ImportRequest): Promise<OsmDataset | null> {
  const { onProgress, onError, onPersistError, onWarn } = req;
  onError?.(null);
  onWarn?.(null);
  onProgress?.({ stage: 'Reading file', pct: 0 });

  // An engine can only be built once, so replacing a region needs a new worker.
  const prev = engines.get(req.id);
  // Declared outside the try so the catch can release a worker that was created
  // but then failed. It is `let` rather than `const` because construction can
  // itself throw -- `new Worker(...)` does in any environment without one -- and
  // when it did, that rejection escaped `importRegionFile` entirely instead of
  // being reported through `onError`, so the UI was left with whatever it had
  // before and no explanation.
  let engine: OsmEngine | null = null;
  let registered = false;

  try {
    // Reject an obviously-wrong file *before* constructing the engine, so a
    // bad import costs no worker and the diagnosis is the file's, not the
    // environment's.
    const problem = await importPreflight(req.file);
    if (problem) throw new Error(problem);

    engine = new OsmEngine();
    engines.set(req.id, engine);
    registered = true;
    engine.setProgressHandler(onProgress ?? null);

    // Both .osm (XML) and .osm.pbf (protobuf) are accepted; OsmEngine sniffs
    // which it actually got, so a mislabelled extension still works.
    onProgress?.({ stage: 'Reading extract', pct: 0 });
    const dataset = await engine.build(req.file);

    /**
     * Refuse a parse that produced nothing usable, *before* it touches the
     * library.
     *
     * This is the check whose absence was the worst defect in the import path.
     * A corrupt, truncated, empty or road-free file used to parse "successfully"
     * into an empty dataset, replace the region the user had working, report no
     * error at all, and leave the home screen reading "0 routable ways · 2
     * regions" — the previous map gone with nothing said and nothing to undo it.
     */
    const { nodes, ways, routable } = dataset.counts;
    if (nodes === 0 && ways === 0) {
      throw new Error(
        `${req.file.name} contains no OpenStreetMap data. ` +
        (isProbablyHtml(req.file)
          ? 'It looks like a saved web page, not map data — the download probably returned an error page. '
          : 'The file may be truncated, or the wrong file was chosen. ') +
        'Nothing was changed.',
      );
    }
    if (routable === 0) {
      /**
       * Refused, not merely warned about.
       *
       * It was originally accepted with a warning, which read as the polite
       * choice — and still displaced the region the user had working, because
       * the new dataset becomes the active one. So a file containing a single
       * building could silently replace a province, leaving the home screen
       * reading "0 routable ways" and leaving the user with no way to route and
       * no way back.
       *
       * For this app an extract with no roads has no use at all: offline
       * routing *is* the feature. Refusing costs the user a specific message
       * instead of their map.
       */
      throw new Error(
        `${req.file.name} has no routable roads — ${ways} way${ways === 1 ? '' : 's'} but ` +
        'none of them are highways this app can drive on. It may be a building-only or ' +
        'pedestrian-only extract. Nothing was changed.',
      );
    }

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
    // Guarded because the engine may never have been constructed.
    engine?.dispose();
    if (registered) {
      if (prev) engines.set(req.id, prev);
      else engines.delete(req.id);
    }
    onProgress?.(null);
    // `(e as Error).message` is `undefined` for a thrown string, a rejected
    // non-Error, or a `null` — which reaches the user as an empty card. Coerce,
    // so every failure carries words.
    const message = e instanceof Error ? e.message
      : typeof e === 'string' ? e
      : e == null ? 'The import failed for an unknown reason.'
      : (() => { try { return JSON.stringify(e); } catch { return 'The import failed for an unknown reason.'; } })();
    onError?.(message);
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