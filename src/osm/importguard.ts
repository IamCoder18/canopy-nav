/**
 * Whether a given extract is worth parsing on this device.
 *
 * ## Why this exists
 *
 * `download.ts` checks free **disk** before fetching, via
 * `navigator.storage.estimate()`. That is the right check for the download and
 * the wrong one for the parse: a 334 MB file fits on a phone with room to spare,
 * and expanding it into a boxed object per node does not.
 *
 * The failure this prevents has no catch. When a WebView runs out of heap the
 * tab is killed — no exception, no `onerror` the app can read, no recovery card.
 * `OsmEngine`'s `worker.onerror` handler, which converts a *throw* into a
 * message the user sees, never fires for it, because an OOM is not a throw. The
 * app's only visible symptom is a silent return to the launcher with the region
 * gone. So the decision has to be made from a static estimate **before** the
 * worker is asked to do the work, which is the same discipline
 * `mergeguard.ts` applies to merging and for the same reason.
 *
 * ## Why this is separate from `mergeguard.ts`
 *
 * `mergeguard.ts` estimates from a **declared** structure: a `RoadGraph` it is
 * holding, whose arrays it can measure exactly. `BYTES_PER_NODE` there is
 * arithmetic on the real thing.
 *
 * This guard runs *earlier* — before any parse — so it has only a file size, and
 * a size is not a node count. That makes it an estimate from a constant, not a
 * measurement, and it is documented as one everywhere below. The constants are
 * the honest part of the trade: they are stated, testable, and wrong in the
 * safe direction. A guard built on a guess that occasionally under-estimates is
 * worth having; one that reads a missing value as unlimited is not.
 *
 * ## The estimate
 *
 * A Geofabrik `.osm.pbf` is roughly **6–17 compressed bytes per node**, measured rather
 * than guessed: 6.1 for Iceland, 16.6 for Monaco, 7.0 for Andorra, 8.8 for New York, 11.3
 * for Malta, 12.7 for Bremen (§15.1.1). `PBF_BYTES_PER_NODE` below takes the low end, so
 * `estimatedNodes = bytes / 6` over-counts rather than under-counts.
 *
 * Each node then costs, at peak, more than its slot in the graph. `buildDataset` holds
 * them in a `Map<number, RawNode>` of boxed `{id, lat, lon, tags?}` objects while the
 * typed arrays are built alongside. `BYTES_PER_NODE` below is **229**, and that is measured
 * rather than reasoned: four nested crops of a real 20 MB extract fit
 * `peak MiB = 36.4 + 229 × nodes` at r ≈ 0.999. It was 112, which under-estimated by 2.0×
 * in the permissive direction.
 *
 * **And this estimate is now known to be the wrong shape**, which is worth stating at the
 * top rather than leaving to be discovered. Once the §15.1 crop exists, the number of nodes
 * that *survive* is not knowable before the node phase has been read — it depends on the
 * box, not on the file. A size-derived estimate can only ever bound the worst case, which
 * is what this does. The crop therefore reports its kept-node count as it goes, so a real
 * measurement can be compared against this one rather than trusted in its place.
 *
 * The consequence is stated plainly because it decides what this guard does in practice:
 * **a province-sized extract does not pass.** Not on a low-end phone, not on a good one.
 * `estimatedNodes` for Alberta is ~58 M, which at 229 B/node is ~13 GB against a budget of
 * a few hundred MB. Alberta has no Geofabrik sub-regions (verified: its extract page
 * reports "No sub regions are defined for this region"), so there is no smaller Alberta to
 * download either.
 *
 * That is a real limitation of on-device whole-province parsing, not a tuning
 * problem, and the guard's job is to say so with a number rather than to let a
 * phone be killed. The alternative that *does* fit is an extract cut to the
 * driver's actual needs — `osmium extract -b <bbox>`, which the Regions screen
 * already documents and which turns 334 MB into a few MB.
 *
 * ## What this does not change
 *
 * `canMerge` is untouched. Merging two parsed datasets is a different question
 * from parsing one, and its estimate is computed from declared structure rather
 * than from a file size, so it remains exact.
 */

import {
  MEMORY_FRACTION, THIN_HEADROOM, PARSE_BYTES_PER_NODE, ASSUMED_HEAP_MB,
  type MemoryBudget,
} from './mergeguard';
import type { PbfCrop } from './pbf';

export { MEMORY_FRACTION, THIN_HEADROOM };

/**
 * Compressed bytes per node in a Geofabrik `.osm.pbf`.
 *
 * **Measured across six real files** (§15.1.1): 6.1 (iceland), 7.0 (andorra), 8.8
 * (new-york), 11.3 (malta), 12.7 (bremen), 16.6 (monaco). The previous value was 8,
 * chosen because it is what makes Alberta's 334 MB land on its real node count — which is
 * a single data point fitted, and it under-counts small extracts by up to 2×.
 *
 * **The low end is used deliberately.** This constant converts bytes into nodes, so
 * *under*-counting nodes makes the guard more permissive, which is the one error it
 * cannot afford: 6 rather than 8 refuses ~33% more files. The cost is that large rural
 * extracts are over-estimated and refused when they might have fitted — which §15.1's
 * crop is the answer to, and which is a far better failure than a killed WebView.
 *
 * Range matters here in a way it does not for `PARSE_BYTES_PER_NODE`: this figure
 * describes the *format*, and small extracts have proportionally more ways, tags and
 * shorter coordinate runs per node.
 */
export const PBF_BYTES_PER_NODE = 6;

/**
 * Bytes per node at peak — the boxed `RawNode` in the parse-time `Map` plus its
 * slot, which is what `buildDataset` holds before compaction discards the
 * pure-geometry nodes.
 *
 * Deliberately *not* `mergeguard.BYTES_PER_NODE` (96 B), which measures a
 * resident graph: a graph's arrays are compact, and the thing that actually
 * costs here is the pre-compaction map of boxed objects. Reusing 96 would
 * under-estimate by roughly half and hand back a guard that passes cases it
 * should refuse.
 */
export const BYTES_PER_NODE = PARSE_BYTES_PER_NODE;

/**
 * Fraction of the device heap a single parse may take.
 *
 * Lower than `mergeguard`'s share is not the intent — the two must not be
 * compared directly, since each budget is applied to a different operation.
 * This one is applied while the *only* thing running is the parse, but it is
 * still a WebView that has to hold the map, the React tree and the basemap
 * GeoJSON once the parse returns, so a parse that consumes nearly everything
 * leaves nothing for any of it.
 */
export const PARSE_MEMORY_FRACTION = 0.5;

/**
 * Largest extract this guard will even consider, in bytes.
 *
 * Above this the estimate is not refined — it is simply reported. Without a
 * ceiling a 4 GB planet file produces a `needed` figure large enough to look
 * authoritative, and a number nobody can act on is worse than a refusal.
 */
export const MAX_CONSIDERED_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * The estimate for one extract.
 *
 * `bytes` is the file size. `nodeCount` may be supplied by a caller that
 * already knows it (a caller holding a parsed dataset); when it is, the estimate
 * uses it instead of deriving one from size, which is strictly better.
 */
export function estimateParseBytes(bytes: number, nodeCount?: number): number {
  const nodes = nodeCount ?? Math.round(bytes / PBF_BYTES_PER_NODE);
  return nodes * BYTES_PER_NODE;
}

export type ImportVerdict =
  /** It fits, and with room to spare. */
  | { ok: true; memory: MemoryBudget; thin: false }
  /** It fits, but the headroom is thin enough to say so. */
  | { ok: true; memory: MemoryBudget; thin: true }
  /** It does not fit, and `reason` says so in words a driver can act on. */
  | { ok: false; memory: MemoryBudget; reason: string };

/**
 * What the device says it has, *before* this guard's own share is taken.
 *
 * The same sources `heapLimitBytes` reads, in the same order of preference, with
 * one deliberate difference: no fraction is applied here. See the note at the
 * call site.
 *
 * A missing value is an assumed 512 MB, never unlimited — a guard that reads
 * "I don't know" as "no limit" is the one bug a memory guard cannot have.
 */
function rawHeapBytes(): { bytes: number; assumed: boolean } {
  const nav = globalThis.navigator as (Navigator & { deviceMemory?: number }) | undefined;
  if (nav && typeof nav.deviceMemory === 'number' && nav.deviceMemory > 0) {
    return {
      bytes: nav.deviceMemory * 1024 * 1024 * 1024 * PARSE_MEMORY_FRACTION,
      assumed: false,
    };
  }
  const perf = globalThis.performance as (Performance & { memory?: { jsHeapSizeLimit?: number } }) | undefined;
  const limit = perf?.memory?.jsHeapSizeLimit;
  if (typeof limit === 'number' && limit > 0) {
    return { bytes: limit * PARSE_MEMORY_FRACTION, assumed: false };
  }
  return { bytes: ASSUMED_HEAP_MB * 1024 * 1024 * PARSE_MEMORY_FRACTION, assumed: true };
}

function mb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function gigabytes(bytes: number): string {
  const g = bytes / (1024 * 1024 * 1024);
  return `${g >= 10 ? Math.round(g) : g.toFixed(1)} GB`;
}

/**
 * Should this extract be parsed here?
 *
 * @param bytes Size of the file about to be parsed.
 * @param nodeCount Known node count, when the caller has one.
 * @param limitBytes Override for the device's stated heap, in bytes. Tests only;
 *   production passes nothing and reads the device, exactly as `canMerge` does.
 */
export function canImport(bytes: number, nodeCount?: number, limitBytes?: number): ImportVerdict {
  /**
   * The budget is `device figure × PARSE_MEMORY_FRACTION`, and the device figure
   * is read *directly* rather than through `heapLimitBytes`.
   *
   * That is not duplication. `heapLimitBytes` applies `MEMORY_FRACTION`
   * internally on the paths where the device reports a figure — and does **not**
   * on the assumed path, where `ASSUMED_HEAP_MB` is already a share. So its
   * return value is a budget already, not a device figure, and there is no way to
   * undo a fraction that was applied to one branch and not the other.
   *
   * Undoing it anyway was the first attempt, and it made every assumed-heap
   * device's budget exactly 2× what `mergeguard` grants the same device — so this
   * guard passed cases its sibling refuses. Reading the device here keeps the two
   * guards comparable without either having to invert the other.
   */
  const heap = limitBytes !== undefined
    ? { bytes: limitBytes * PARSE_MEMORY_FRACTION, assumed: false }
    : rawHeapBytes();


  const needed = estimateParseBytes(bytes, nodeCount);
  const budget = Math.round(heap.bytes);
  const memory: MemoryBudget = {
    budget,
    needed,
    ratio: budget > 0 ? needed / budget : Infinity,
    assumed: heap.assumed,
  };

  if (!Number.isFinite(memory.ratio)) {
    return {
      ok: false,
      memory,
      reason:
        'This device will not say how much memory it has, so importing cannot be ' +
        'judged safe here. Use an online routing engine, or import a smaller extract.',
    };
  }

  if (memory.ratio > 1) {
    return { ok: false, memory, reason: refusal(bytes, memory) };
  }
  return { ok: true, memory, thin: memory.ratio > THIN_HEADROOM };
}

/**
 * The refusal sentence.
 *
 * Written to be acted on. It names the shortfall and the budget in the same
 * units, says what the file actually is (a whole province, not a broken
 * download), and gives the one instruction that actually reduces the problem:
 * cut the extract to the area the driver needs.
 */
function refusal(bytes: number, memory: MemoryBudget): string {
  const head = bytes > MAX_CONSIDERED_BYTES
    ? `"${gigabytes(bytes)} is larger than this app can read on any phone` +
      ' — it is a whole-country or planet extract'
    : `Reading this ${mb(bytes)} extract needs about ${gigabytes(memory.needed)} of memory, ` +
      `and this device has ${mb(memory.budget)} available`;

  return (
    `${head}. Parsing it here would be killed by the system rather than fail with an ` +
    'error, so it was not started and nothing was changed.\n\n' +
    'Cut the extract down to the area you actually drive: with `osmium` on a desktop,\n' +
    '  osmium extract -b <west,south,east,north> province-latest.osm.pbf -o area.osm.pbf\n' +
    'A few hundred square kilometres is a few MB, imports in seconds, and routes ' +
    'offline exactly the same. Most drivers only need one metro area at a time.'
  );
}

/**
/**
 * Worst-case node density, in nodes per square kilometre.
 *
 * **12,400**, from the smallest New York box in §15.1.1: a 10.7 km box over Manhattan
 * kept 1,423,000 nodes, so 1,423,000 / 114.5 km² ~ 12,400. Manhattan is the densest place
 * measured, and a *lower* assumed density would size the box larger than the budget
 * allows -- so this is the conservative end of one data point rather than an average.
 *
 * Calgary, Edinburgh or a rural province are one to two orders of magnitude lighter, so a
 * box sized for Manhattan is comfortably generous for almost everywhere real.
 */
export const WORST_CASE_NODES_PER_KM2 = 12_400;

/** ~111 km per degree of latitude. Only the latitude axis is used, and only for sizing. */
const KM_PER_DEG = 111.32;

/**
 * A box, centred on a point, as large as this device's budget can afford.
 *
 * Derived rather than a constant, because the honest size of "the area I'm in" depends on
 * the device. The chain: budget / 229 B per kept node => how many nodes fit; that /
 * 12,400 nodes per km² => how many km² fit; square root => a half-width.
 *
 * A fixed 0.12° is wrong at both ends. On a 2 GB phone that is ~8.8 M nodes' worth of
 * Manhattan, which gets the WebView killed -- the exact failure this file exists to
 * prevent. On a 16 GB machine it is needlessly small.
 *
 * Returns `null` for a position that is not a real coordinate, so a caller with no fix
 * cannot be handed a box somewhere in the Gulf of Guinea. `NaN` from an uninitialised
 * GPS is the realistic case, and a box built from it silently covers half the planet.
 */
export function affordableBoxAround(
  pos: { lat: number; lon: number } | null | undefined,
  budgetBytes: number,
): PbfCrop | null {
  if (!pos) return null;
  const { lat, lon } = pos;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  const maxNodes = Math.max(0, budgetBytes) / PARSE_BYTES_PER_NODE;
  const halfDeg = Math.sqrt(maxNodes / WORST_CASE_NODES_PER_KM2) / KM_PER_DEG;

  return {
    west: lon - halfDeg,
    south: lat - halfDeg,
    east: lon + halfDeg,
    north: lat + halfDeg,
  };
}

/**
 * The warning shown when the estimate fits but the margin is thin.
 *
 * Not an error: the import proceeds and the region is added. The user is told
 * because a device one allocation away from eviction produces a better result
 * when it knows the risk than when it discovers it.
 */
export function importWarning(memory: MemoryBudget): string {
  return (
    `This extract needs about ${gigabytes(memory.needed)} and this device reports ` +
    `${mb(memory.budget)} available, so it fits with little to spare. If the app ` +
    'closes while importing, or the map goes blank, that is why — remove another ' +
    'region and try again, or cut the extract to a smaller area.'
  );
}

/**
 * The budget this device grants a single parse, in bytes.
 *
 * Exported because §15.1's default crop has to be sized against the *same* number the
 * refusal quotes. Two readers of the device heap that disagree by a fraction would size a
 * box the guard then refuses, which is the same class of bug as a guard with two
 * constants — and `mergeguard` already documents that `heapLimitBytes` cannot be inverted,
 * because it applies `MEMORY_FRACTION` on some branches and not others.
 */
export function importBudgetBytes(limitBytes?: number): number {
  return limitBytes !== undefined
    ? limitBytes * PARSE_MEMORY_FRACTION
    : rawHeapBytes().bytes;
}
