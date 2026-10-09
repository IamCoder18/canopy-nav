/**
 * A memory gate — §15.3 item 10.
 *
 * ## Why this exists
 *
 * `tools/` has gates for offline boot, focus, reflow and text scale, all cheap. Nothing
 * asserted **how much memory the parse takes**, and that is the regression this area is prone
 * to: the peak is dominated by a `Map<number, RawNode>` of *boxed* objects, and §15.1.1
 * measured 229 B per kept node against the 112 the guard had assumed. Every change that keeps
 * more of them alive longer — a cache, a second index, a crop that dilates too far, a
 * `buildDataset` that stops consuming its inputs — moves the peak while **every behavioural
 * test stays green**. `test/pbf.spec.ts` asserts what comes out; nothing asserted what it
 * took.
 *
 * ## What it measures, and what it cannot
 *
 * The dominant term, measured directly: 200,000 boxed nodes inserted into a `Map`, compared
 * against the same 229 B/node the guard uses. That is a *real* V8 heap measurement, and it is
 * the figure a regression in this area moves first.
 *
 * Two limits, stated because they are the difference between this being evidence and this
 * being a comfort blanket:
 *
 * 1. **Node's heap is not a phone's heap.** Android caps a low-end WebView in the hundreds of
 *    MB; Node here has far more. So this cannot prove a province import fits. What it catches
 *    is a *regression* — a 2× rise is invisible on a large heap and fatal on a small one,
 *    and this is the only place that would notice.
 * 2. **No `global.gc()`.** vitest does not run Node with `--expose-gc`, so the measurement is
 *    a `heapUsed` *delta* across an allocation rather than a settled total. Deltas over-read
 *    slightly, which is the safe direction for a ceiling — and the budget has 1.6× slack for
 *    exactly that reason.
 *
 * The other half is **structural**, deliberately: the properties that keep the file out of
 * memory are visible in the source, and asserting them there is stronger than inferring them
 * from a number measured on a machine that is not the target.
 *
 * ## What this is not
 *
 * It does not replace `importguard`. That guard runs on a device that will not reliably
 * report its heap and refuses *before* starting; this one runs where the heap is measurable and
 * would notice *afterwards*. Both exist precisely because neither can do the other's job.
 *
 * ## Why a spec and not a `tools/` script
 *
 * Because it has to import `src/osm/pbf.ts`, which is TypeScript — and because a gate nobody
 * runs is worth nothing, so this runs inside `npm test` as well as on its own via
 * `npm run memory`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/**
 * Bytes per kept node at the parse peak.
 *
 * §15.1.1's measured 229, on four nested crops of a real 20 MiB Bremen extract:
 * `peak MiB = 36.4 + 229 × kept nodes`, r ≈ 0.999. It replaced 112, which was reasoned rather
 * than measured and was 2× low in the permissive direction.
 *
 * Written here as well as in `importguard` deliberately: a gate that imported the constant it
 * is a gate on would pass by construction if the constant were wrong. This one has to be
 * *edited* to agree, and `test/importguard.spec.ts` independently pins the module's value, so
 * the two disagreeing is a failure rather than a coincidence.
 */
const BYTES_PER_NODE = 229;

/** 1.6× of a measured figure: slack for GC timing, not for real growth. */
const BUDGET_FACTOR = 1.6;

describe('the boxed node map, which dominates the parse peak', () => {
  it('costs less per node than the guard assumes', () => {
    const N = 200_000;
    // The exact shape `buildDataset` holds: numeric keys, boxed values, four fields. Not a
    // stand-in for it -- `RawNode` is `{id, lat, lon, tags?}`, and a Map entry with a boxed
    // value is the term §15.1.1 identified.
    const before = process.memoryUsage().heapUsed;
    const m = new Map<number, { id: number; lat: number; lon: number }>();
    for (let i = 0; i < N; i++) m.set(i, { id: i, lat: 51.5, lon: -1.4 });
    const after = process.memoryUsage().heapUsed;
    // Touch every entry so the JIT cannot prove it was unused and V8 cannot drop it.
    let acc = 0;
    for (const v of m.values()) acc += v.lat;
    expect(acc).toBeGreaterThan(0);
    expect(m.size).toBe(N);

    const perNode = (after - before) / N;
    // Reported either way, because a figure nobody sees cannot be argued with.
    console.log(
      `  measured ${perNode.toFixed(0)} B per boxed node `
      + `(budget ${Math.round(BYTES_PER_NODE * BUDGET_FACTOR)} B)`,
    );
    expect(perNode).toBeGreaterThan(0);
    expect(perNode).toBeLessThan(BYTES_PER_NODE * BUDGET_FACTOR);
    // Held so the allocation is not collected between the reading and the assertion.
    expect(m.get(N - 1)?.id).toBe(N - 1);
  });

  it('is the same shape the builder actually uses', () => {
    // If `RawNode` ever grows a field, or the map is keyed differently, this measurement
    // stops describing the thing and becomes a number about a stand-in. Asserted against the
    // real type rather than a copy of it.
    const worker = src('src/osm/engine.worker.ts');
    expect(worker).toMatch(/nodes: Map<number, RawNode>/);
    expect(worker).toMatch(/interface RawNode \{[\s\S]*?lat: number;[\s\S]*?lon: number;/);
    // And the builder clears the map, which is what keeps the peak from being the steady
    // state for the life of the region. §14.17.
    expect(worker).toMatch(/nodes\.clear\(\)/);
  });
});

describe('the file is never resident whole', () => {
  it('the PBF reader takes bytes by contract and the worker does not feed it the file', () => {
    const pbf = src('src/osm/pbf.ts');
    const worker = src('src/osm/engine.worker.ts');
    // `parseOsmPbf` is the whole-buffer reader and exists for tests and Blob-shaped
    // callers. What must not happen is the *production* path reaching for it with the whole
    // extract, which is what §14.16 found and what doubled the peak for the format
    // Geofabrik actually publishes.
    const callSites = [...worker.matchAll(/parseOsmPbf\(([^)]*)\)/g)].map((m) => m[1]);
    for (const call of callSites) {
      expect(call).not.toMatch(/file\.arrayBuffer\(\)/);
    }
    // And the streaming reader is preferred whenever the file can stream.
    expect(worker).toMatch(/parseOsmPbfStream\(/);
    expect(pbf).toMatch(/MAX_BLOB_SIZE/);
  });

  it('the reader copies blob payloads rather than viewing them', () => {
    // A view into a queued chunk is one `await` from being overwritten by the next
    // `ensure`, and `readBlobPayload` is async — so an uncompressed blob would be parsed from
    // recycled memory. Silent: wrong coordinates, a plausible extract, a wrong route.
    //
    // Asserted on the *implementation*, not a comment. An earlier version of this test
    // anchored on a docstring, which is this project's own standing rule: a comment is a claim
    // about code and needs the same treatment as a number. `take` must allocate.
    const pbf = src('src/osm/pbf.ts');
    const open = pbf.indexOf('  take(n: number)');
    const take = pbf.slice(open, pbf.indexOf('\n  }\n', open));
    expect(take).toMatch(/new Uint8Array\(n\)/);
    expect(take).not.toMatch(/return this\.buf\.subarray/);
    // And the payload is fetched through `take`, which copies, rather than by reaching
    // into the queue's buffer. `queue.take(` is the only sanctioned way out.
    expect(pbf).toMatch(/const body = queue\.take\(datasize\)/);
    expect(pbf).not.toMatch(/queue\.buf\.subarray/);
  });
});

describe('the crop bounds what is kept', () => {
  it('every write into the node map goes through the crop filter', () => {
    const pbf = src('src/osm/pbf.ts');
    // The one property that makes §15.1's crop bound memory: an out-of-box node is never
    // stored. Asserted by *absence* of any other write path, so a new code path that writes
    // straight into the map cannot be added without this failing.
    const directWrites = [...pbf.matchAll(/out\.nodes\.set\(/g)];
    const helperWrites = [...pbf.matchAll(/keepNode\(out, node\)/g)];
    // One write, inside `keepNode` itself — which is the filter.
    expect(directWrites.length).toBeLessThanOrEqual(1);
    expect(helperWrites.length).toBeGreaterThanOrEqual(2); // both node decoders
    expect(pbf).toMatch(/if \(out\.crop && !inBox\(out\.crop, node\.lat, node\.lon\)\) return false;/);
  });

  it('both PBF entry points accept a crop', () => {
    // A crop wired into the streaming path only would leave the whole-buffer path uncropped,
    // and which of the two a caller gets depends on whether its `File` has a `stream()`.
    const pbf = src('src/osm/pbf.ts');
    const signatures = [...pbf.matchAll(/export async function parseOsmPbf(?:Stream)?\(/g)];
    expect(signatures.length).toBe(2);
    for (const fn of ['parseOsmPbfStream', 'parseOsmPbf']) {
      const body = pbf.slice(pbf.indexOf(`export async function ${fn}(`));
      const end = body.indexOf('\n}\n');
      expect(body.slice(0, end), `${fn} must accept a crop`).toMatch(/crop\?: PbfCrop \| null/);
      expect(body.slice(0, end)).toMatch(/dilate\(crop\)|crop \? dilate/);
    }
  });
});

describe('the constants this gate is a gate on', () => {
  it('agrees with importguard, and says so if it stops agreeing', () => {
    // Deliberately a literal here rather than an import: a gate that read the constant it
    // checks would pass by construction if the constant were wrong. This is the one place
    // the two are meant to be written down twice, and `test/importguard.spec.ts` pins the
    // module's own value, so drift fails twice rather than once.
    const guard = src('src/osm/importguard.ts');
    expect(guard).toMatch(/export const PBF_BYTES_PER_NODE = 6;/);
    // `PARSE_BYTES_PER_NODE` lives in mergeguard and is re-exported.
    expect(src('src/osm/mergeguard.ts')).toMatch(/export const PARSE_BYTES_PER_NODE = 229;/);
    expect(BYTES_PER_NODE).toBe(229);
  });

  it('refuses rather than assuming a device has unlimited memory', () => {
    // The one bug a memory guard cannot have, and the reason a missing value is an assumed
    // 512 MB and never "no limit".
    const guard = src('src/osm/importguard.ts');
    expect(guard).toMatch(/ASSUMED_HEAP_MB/);
    expect(guard).not.toMatch(/Infinity as a budget|budget: Infinity/);
  });
});