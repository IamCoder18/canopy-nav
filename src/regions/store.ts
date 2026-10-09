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
 * ## The two guards that run before a worker exists
 *
 * `importPreflight` refuses a file that is not OSM data at all, and
 * `importguard.canImport` refuses one that is OSM data but too large for this
 * device's heap. Both run before `new OsmEngine()`, so a rejected import costs no
 * worker and no memory.
 *
 * The second is the one that cannot be caught. An out-of-heap WebView is killed
 * by the system: no throw, no `worker.onerror`, so `buildPromise` never settles
 * and the user sees the progress bar vanish. A refusal is the only version of
 * this the app gets to choose.
 */

import { useSyncExternalStore } from 'react';
import { OsmEngine, importPreflight, type BuildProgress } from '../osm/engine';
import { canImport, importWarning, importBudgetBytes, BYTES_PER_NODE } from '../osm/importguard';
import type { PbfCrop } from '../osm/pbf';

import type { OsmDataset } from '../osm/engine.worker';
import { describeError } from '../errors';
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
  /**
   * Parse anyway, even though the memory guard says it will not fit.
   *
   * The guard's estimate comes from a file size and a constant, not from a
   * measurement, so it is an estimate — and a user who has just watched a
   * progress bar say "this needs 4 GB" is entitled to disagree with it. This is
   * that disagreement, made explicit: the caller must have asked, so an import
   * that dies is a choice rather than a surprise.
   */
  forceMemory?: boolean;
  /**
   * Restrict the parse to a box — §15.1.2. Makes peak memory a function of area rather
   * than of province, which is the only reason a 334 MB extract is importable at all.
   *
   * Only `.osm.pbf` honours it; `.osm` XML is parsed whole and the result says so, so a
   * caller can tell a crop that happened from one that was asked for and ignored.
   */
  crop?: PbfCrop;
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

    /**
     * Refuse an extract this device cannot parse, before a worker exists.
     *
     * The check that had to come first, and does not. `download.ts` asks
     * `navigator.storage.estimate()` about free *disk*, which is the right
     * question for the download and the wrong one for the parse — a 334 MB
     * Alberta extract has room on disk and does not have room in the heap.
     *
     * What happens without this is worse than an exception. An out-of-heap
     * WebView is killed by the system: no `throw`, no `onerror`, so
     * `OsmEngine`'s handler never runs and the promise here never settles. The
     * user sees the app return to its launcher with the progress bar simply
     * gone. See `importguard.ts` for the estimate and its known limits.
     *
     * `forceMemory` is the escape hatch for a *wrong* estimate, and it is
     * deliberately not implicit: an import that dies should have been asked for.
     *
     * ## The crop makes this estimate inapplicable, and applying it anyway was a bug
     *
     * This ran `canImport(size)` unconditionally, so an import carrying a `crop` was
     * refused on the **whole file's** size before the crop was ever considered -- which
     * made the Regions screen's "Import just the area I'm in" button unreachable. The
     * file was 146 MB, the crop would have read a fraction of it, and the guard refused
     * anyway. §15.1.1's finding is precisely this: once a crop exists the surviving node
     * count is a function of the box, not of the file, so a size-derived estimate is the
     * wrong *shape*.
     *
     * Refusing for a reason that no longer applies is the same failure as returning a
     * wrong route: confidently, and about something other than the thing asked.
     *
     * So a cropped import is **warned** rather than refused, and the warning says the
     * honest thing -- the cost is unknown until the parse reports it. That weakens the
     * guard deliberately, and the mitigation is that `parseOsmPbfStream` reports
     * `keptNodes`, so the measurement arrives immediately after (§15.1 item 4) instead of
     * a second guess standing in for it.
     */
    const size = req.file.size ?? 0;
    if (size > 0) {
      const verdict = canImport(size);
      const cropped = !!req.crop;
      if (!verdict.ok && !req.forceMemory && !cropped) {
        throw new Error(verdict.reason);
      }
      if (cropped && !req.forceMemory) {
        onWarn?.(cropWarning(size, verdict));
      } else if (verdict.ok && verdict.thin && !req.forceMemory) {
        onWarn?.(importWarning(verdict.memory));
      }
    }

    engine = new OsmEngine();
    engines.set(req.id, engine);
    registered = true;
    engine.setProgressHandler(onProgress ?? null);

    // Both .osm (XML) and .osm.pbf (protobuf) are accepted; OsmEngine sniffs
    // which it actually got, so a mislabelled extension still works.
    onProgress?.({ stage: 'Reading extract', pct: 0 });
    const dataset = await engine.build(req.file, req.crop ?? null);

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

    /**
     * Compare what the parse *actually* cost against what the guard estimated.
     *
     * §15.1 item 4, and the reason the reader reports `cropStats`. A cropped import is
     * warned rather than refused above, because a whole-file estimate cannot judge it — so
     * the number that would have refused it arrives only after the node phase has been read.
     * This is that number being used, rather than left to sit on the dataset.
     *
     * Two things it does:
     *
     * - Says when the real cost exceeded the budget, which is the failure the whole file
     *   exists to prevent and the one a warning would otherwise have papered over.
     * - Records `cropApplied` in the message either way when a crop was asked for and did
     *   *not* happen, because a silent no-op is worse than a slow import.
     *
     * It is a warning and not a post-hoc refusal: the memory has already been spent, and
     * throwing here would discard a map that parsed. Saying so is the honest move; a
     * "successful" import on a device that was about to be killed teaches nothing.
     */
    if (dataset.cropIgnored) {
      onWarn?.(
        // One sentence, saying one thing.
        //
        // The first version read: "Only the area inside the chosen box was read from this
        // file -- the format it is in does not support cropping, so the whole of it was
        // parsed." Two opposite claims in one string, in the warning whose entire purpose is
        // to tell a driver that asking for a metro area got them the province. A message that
        // contradicts itself cannot be acted on, and the reader has no way to tell which half
        // is true.
        'This file was read in full: ' + (req.file.name || 'the extract')
        + ' is a format that cannot be cropped, so the chosen area was ignored. If the app '
        + 'closes while importing, convert it to .osm.pbf first and try again.',
      );
    }
    const cropStats = dataset.cropStats;
    if (cropStats?.cropped) {
      const actual = cropStats.keptNodes * BYTES_PER_NODE;
      const budget = importBudgetBytes();
      if (actual > budget) {
        onWarn?.(
          `That area held about ${Math.round(cropStats.keptNodes).toLocaleString()} nodes, `
          + `which needs roughly ${Math.round(actual / 1048576)} MB of memory against this `
          + `device's ${Math.round(budget / 1048576)} MB. It parsed, but there was little room, `
          + 'so remove another region or choose a smaller area.',
        );
      }
    }

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
    // `describeError` was written here first, and now lives in `src/errors.ts`
    // so every `catch` in the app can reach it. See that module for why
    // `(e as Error).message` is not a safe assertion.
    onError?.(describeError(e));
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
/**
 * Forget a region, in memory and on disk.
 *
 * ## Why this returns a promise now
 *
 * The storage delete was `void deleteRegion(id).catch(() => {})`, and
 * `deleteRegion` goes to real trouble to build the sentence "It will reappear
 * the next time the app starts." — which the catch discarded. So on a device
 * where IndexedDB refused (another tab holding the database, which
 * `persist.ts` explicitly detects), the region vanished from the UI, the byte
 * count fell, the bytes were **not** freed, and nothing was said. A few
 * hundred megabytes per province, gone silently.
 *
 * Both callers now await this and report a failure. The in-memory removal still
 * happens first and unconditionally: the region *is* gone from the running app
 * regardless of whether the file on disk could be deleted, so the failure to
 * report is about the bytes, not about the map.
 */
export async function removeRegion(id: string): Promise<string | null> {
  regionLib.remove(id);
  engines.get(id)?.dispose();
  engines.delete(id);
  try {
    await deleteRegion(id);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
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

/**
 * The sentence a *cropped* import shows instead of a refusal.
 *
 * §15.1 item 4, stated to the driver rather than to the file. A cropped parse's real cost
 * is the number of nodes inside the box, which is not knowable until the node phase has
 * been read — so this says so, and says what will happen next, instead of quoting a
 * whole-file figure that no longer describes what is about to run.
 *
 * It also keeps the desktop instruction, because the crop covers the driver's *current*
 * area: someone who needs a different part of the province is still better served by
 * `osmium`, and hiding that would be a cure for the complaint, not an answer.
 */
function cropWarning(bytes: number, verdict: ReturnType<typeof canImport>): string {
  const wholeMb = Math.round(bytes / 1024 / 1024);
  const neededMb = Math.round(verdict.memory.needed / 1024 / 1024);
  // Assembled from parts rather than one nested template: a `${}` inside a `${}` inside
  // a template is legal and unreadable, and the one place it appeared here also cost a
  // debugging round because the error pointed at the end of the file rather than at it.
  const comparison = verdict.ok
    ? 'and this is already more than the device has room for'
    : `and the whole of it would have needed about ${neededMb} MB`;
  return (
    `Only the part of this ${wholeMb} MB extract inside the chosen area will be read, ` +
    `which is far less than the whole file — ${comparison}.\n\n` +
    'If the app closes while importing, the area was denser than this device has room ' +
    'for: pick a smaller area, or cut the extract on a desktop with\n' +
    '  osmium extract -b <west,south,east,north> extract.osm.pbf -o area.osm.pbf'
  );
}
