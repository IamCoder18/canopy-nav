/**
 * Whether a merge is worth attempting at all.
 *
 * Merging two extracts is correct, and it is the only way to get a right answer
 * for a route that crosses a regional boundary. It is also the most expensive
 * thing this app does: `mergeRegions` holds every source graph, a full
 * JavaScript `Map`/`Array` copy of the nodes and edges, *and* the typed-array
 * result at the same time. That is **7.5× the source bytes**, not the "two to three
 * times" this paragraph used to claim — `TRANSIENT_MULTIPLIER` (2.5, the boxed copy) and
 * `PEAK_MULTIPLIER` (3, sources plus the result) are composed *multiplicatively*, so the
 * sources and the boxed copy are each counted once on top of the other's basis.
 *
 * The over-count is deliberate and conservative — it refuses a merge that would fit,
 * rather than starting one that would not — and `test/mergeguard.spec.ts` pins the 7.5
 * directly. So the number the driver is shown is 2.5× the requirement the prose used to
 * justify, and the prose is what was wrong.
 *
 * So the decision is made from static size, before any of it runs, and it has
 * three outcomes rather than two:
 *
 *  - **proceed** — the result fits;
 *  - **proceed-with-a-warning** — it fits, but the headroom is thin enough that
 *    the app should say so rather than hope;
 *  - **refuse** — it does not fit, and the app says so instead of returning a
 *    route it cannot compute.
 *
 * The middle outcome is the point. A guard with only yes/no either lets a phone
 * run out of memory mid-merge — which on a WebView is a silent tab kill, not an
 * error — or it refuses outright on hardware that would have coped. The size
 * figures are per-node and per-edge constants derived from the actual typed
 * arrays in `RoadGraph`, not guesses, and `test/mergeguard.spec.ts` asserts them
 * against the real interface.
 */

import type { RoadGraph } from './engine.worker';

/**
 * Bytes per node in a *merged* graph, and the multiplier on top of the sources.
 *
 * A `RoadGraph` is CSR: `coords` (Float64 ×2) + `osmIds` (Float64) +
 * `edgeStart` (Uint32) + `regionOf` (Int32) = 8+8+8+4+4 = 32 B/node, plus a
 * `MinHeap` and four A* scratch arrays of ~25 B/node, plus the spatial index,
 * which is a nested `Map` of JS arrays and is comfortably larger per node than
 * the graph itself. The sources are counted at this same rate, because they
 * stay resident — `mergeRegions` never mutates them, and the map, the search
 * index and single-region routing all still need them.
 */
export const BYTES_PER_NODE = 96;

/**
 * The same measure, for the *parse* peak rather than a resident graph.
 *
 * Exported here so `importguard.ts` can be compared against it directly, and
 * deliberately set **higher** than `BYTES_PER_NODE`. A `RoadGraph` is compact typed
 * arrays; the peak of parsing an extract is a `Map<number, RawNode>` of boxed
 * `{id, lat, lon, tags?}` objects coexisting with the arrays being built. The steady
 * state is survivable and the peak is what kills a WebView, so a guard sized for the
 * steady state under-estimates and passes the cases it exists to refuse.
 *
 * **112 was a guess and measured 229** (§15.1.1). Four nested Bremen crops fit
 * `peak MiB = 36.4 + 229 × kept nodes` with r ≈ 0.999, so 112 under-estimated the parse
 * peak by 2.0× — in the permissive direction, which is the one direction a memory guard
 * cannot afford. A `Map<number, RawNode>` costs far more per entry than a typed-array
 * slot because both the key and the value are heap objects and V8's inline caches for
 * neither apply; that was the reasoning that produced 112 and it was simply low.
 *
 * The fixed term (36.4 MiB) is the reader's own footprint — chunk queue, decompressor,
 * graph arrays built alongside — and is not modelled per node, which is why this stays a
 * linear figure. `importguard` does not use it: its budget is derived from the device,
 * not from this module, and `test/importguard.spec.ts` pins the relationship instead.
 */
export const PARSE_BYTES_PER_NODE = 229;

/** Bytes per directed edge: `edgeTo` + `edgeCost` + `edgeFlags` + a name slot. */
export const BYTES_PER_EDGE = 24;

/**
 * Multiplier on the total for the JS-side copy `mergeRegions` builds alongside
 * the typed arrays (the `Map`s in the union-find pass and the plain `number[]`
 * node/edge lists in the compaction pass). Those are boxed, so they cost far
 * more per element than the arrays they become.
 */
export const TRANSIENT_MULTIPLIER = 2.5;

/**
 * Peak as a multiple of the total node+edge bytes, from the source accounting in
 * `mergeRegions`: every input graph, a boxed copy of everything, and the result.
 * 3 covers that with room for the A* scratch on top.
 */
export const PEAK_MULTIPLIER = 3;

/**
 * Fraction of the memory limit a merge may use.
 *
 * Not 1.0, because the app is not the only thing on the device: the WebView has
 * its own heap, the OS needs headroom to kill something other than us, and a
 * merge that fits exactly is a merge that fails on a slightly larger province.
 */
export const MEMORY_FRACTION = 0.5;

/**
 * Below this share of the limit, the merge proceeds but the caller is warned.
 *
 * Android Auto's own rule of thumb for a long-press target is a 48dp circle,
 * well past the 24dp minimum, and the reason is the same one: a control that
 * responds is not the same as a control that is *comfortable*. A merge that
 * leaves a thin margin is the same situation in a different medium — it works,
 * and the user should know it is close to the edge.
 */
export const THIN_HEADROOM = 0.75;

/** How much heap a device is treated as having, when it will not say. */
export const ASSUMED_HEAP_MB = 512;

export interface MemoryBudget {
  /** Bytes the merge may use. */
  budget: number;
  /** Bytes the merge is projected to need at its peak. */
  needed: number;
  /** `needed / budget`. */
  ratio: number;
  /** True when the source could not be determined, so the figure is a guess. */
  assumed: boolean;
}

export type MergeVerdict =
  | { ok: true; memory: MemoryBudget; thin: boolean }
  | { ok: false; memory: MemoryBudget; reason: string };

/** Bytes one graph occupies, by its own declared shape. */
export function graphBytes(g: RoadGraph): number {
  const nodes = g.nodeCount * BYTES_PER_NODE;
  const edges = g.edgeTo.length * BYTES_PER_EDGE;
  return nodes + edges;
}

/**
 * What the device says it has.
 *
 * `navigator.deviceMemory` is a coarse bucket in GiB and is Chromium-only, so
 * this is deliberately imprecise; `performance.memory` is non-standard and
 * counts only the JS heap. When neither answers the honest thing is to say so
 * and assume, rather than to read a missing value as unlimited.
 */
export function heapLimitBytes(): { bytes: number; assumed: boolean } {
  const nav = globalThis.navigator as (Navigator & { deviceMemory?: number }) | undefined;
  if (nav && typeof nav.deviceMemory === 'number' && nav.deviceMemory > 0) {
    return { bytes: nav.deviceMemory * 1024 * 1024 * 1024 * MEMORY_FRACTION, assumed: false };
  }
  const perf = globalThis.performance as (Performance & { memory?: { jsHeapSizeLimit?: number } }) | undefined;
  const limit = perf?.memory?.jsHeapSizeLimit;
  if (typeof limit === 'number' && limit > 0) {
    return { bytes: limit * MEMORY_FRACTION, assumed: false };
  }
  return { bytes: ASSUMED_HEAP_MB * 1024 * 1024, assumed: true };
}

/**
 * Should these graphs be merged, and if not, why not.
 *
 * @param graphs the participating extracts
 * @param limitBytes override for the device's stated heap limit, in **bytes**.
 *   Exists for tests; production passes nothing and reads the device.
 */
export function canMerge(graphs: RoadGraph[], limitBytes?: number): MergeVerdict {
  const heap = limitBytes !== undefined
    ? { bytes: limitBytes * MEMORY_FRACTION, assumed: false }
    : heapLimitBytes();
  const sources = graphs.reduce((sum, g) => sum + graphBytes(g), 0);
  // Sources stay resident *and* the merge needs a transient boxed copy of them
  // *and* it produces a new result.
  const needed = Math.round(sources * TRANSIENT_MULTIPLIER * PEAK_MULTIPLIER);
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
      reason: 'Cannot estimate available memory, so this route is not safe to compute.',
    };
  }
  if (memory.ratio > 1) {
    const mb = (n: number) => `${Math.round(n / (1024 * 1024))} MB`;
    return {
      ok: false,
      memory,
      reason:
        `Routing across these regions needs about ${mb(memory.needed)} of memory and this ` +
        `device reports ${mb(memory.budget)} available. A route that needs a merge cannot be ` +
        'computed here, so none is offered rather than one that would be wrong. ' +
        'Download a single extract covering the whole journey, or use an online engine.',
    };
  }
  return { ok: true, memory, thin: memory.ratio > THIN_HEADROOM };
}
