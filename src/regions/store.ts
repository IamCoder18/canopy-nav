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
import { RegionLibrary, type Region } from '../osm/regions';

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
}

/**
 * Parse a `.osm` XML file and register it in the library under `id`.
 * Returns the parsed dataset on success, `null` on failure (the error is
 * reported through `onError`, so callers only need to check for `null`).
 */
export async function importRegionFile(req: ImportRequest): Promise<OsmDataset | null> {
  const { onProgress, onError } = req;
  onError?.(null);
  onProgress?.({ stage: 'Reading file', pct: 0 });

  // An engine can only be built once, so replacing a region needs a new worker.
  const prev = engines.get(req.id);
  const engine = new OsmEngine();
  engines.set(req.id, engine);
  engine.setProgressHandler(onProgress ?? null);

  try {
    if (/\.pbf$/i.test(req.file.name)) {
      throw new Error(
        '.osm.pbf is protobuf, and this build parses .osm XML only. Convert it on a desktop first: osmium cat region.osm.pbf -o region.osm',
      );
    }
    onProgress?.({ stage: 'Parsing extract', pct: 0 });
    const text = await req.file.text();
    const dataset = await engine.build(text);

    regionLib.add(
      {
        id: req.id,
        name: req.name,
        code: req.code,
        bbox: dataset.bbox,
        loadedAt: Date.now(),
        bytes: req.file.size,
        counts: dataset.counts,
        gazetteerSize: dataset.gaz.length,
      },
      dataset,
    );

    prev?.dispose();
    onProgress?.(null);
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

/** Drop a region and release its worker. */
export function removeRegion(id: string) {
  regionLib.remove(id);
  engines.get(id)?.dispose();
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