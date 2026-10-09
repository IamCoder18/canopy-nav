/**
 * What `importRegionFile` does with what the reader reports.
 *
 * ## Why this file exists
 *
 * §15.1 item 4's real half. The reader reports `cropStats` and `cropIgnored`, and
 * `importRegionFile` uses them for two things: a warning when the cropped parse actually cost
 * more than the device's budget, and a warning when a crop was asked for on a format that
 * cannot honour one.
 *
 * **The reader half is well covered and the consumer half was not covered at all.** An
 * adversarial review deleted both blocks from `store.ts` and the suite did not move — same
 * four failures before and after, same count. `§14.20.1` says "importRegionFile uses them for
 * two things it could not do before", and the "uses" was a claim.
 *
 * ## How it is driven
 *
 * Through the real `importRegionFile`, with the parse stubbed at the engine boundary. Node
 * has no `Worker`, which is the same seam `test/import.spec.ts` already uses, so this adds no
 * new machinery: what is under test is `store.ts`'s reaction to a dataset, not the dataset.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PbfCrop } from '../src/osm/pbf';

const REAL_PBF = join(__dirname, 'fixture.osm.pbf');

/** What `store.ts` reads off the dataset, and nothing else. */
interface StubDataset {
  counts: { nodes: number; ways: number; routable: number };
  cropApplied?: boolean;
  cropStats?: { seenNodes: number; keptNodes: number; ways: number; cropped: boolean } | null;
  cropIgnored?: boolean;
  [k: string]: unknown;
}

const built: StubDataset[] = [];
/**
 * The minimum `store.ts` reads off a dataset.
 *
 * `counts`, `cropStats` and `cropIgnored` are the subject; the rest exist because
 * `store.ts` records a few more fields on the way past and a stub missing one fails with
 * `Cannot read properties of undefined (reading 'length')` — which names neither the missing
 * field nor the file, and cost the first run of this spec a debugging round.
 */
let nextDataset: StubDataset = {
  counts: { nodes: 103, ways: 21, routable: 19 },
  gaz: [],
  bbox: [-3.2, 55.9, -3.1, 56.0],
  graph: {},
  roads: [],
  water: [],
  green: [],
} as unknown as StubDataset;

vi.mock('../src/osm/engine', async (orig) => {
  // Partial: `store.ts` also imports `importPreflight` and the region helpers from this
  // module, and a full replacement with none of them makes every import fail with a vitest
  // error rather than a product one — which is how the first version of this file reported.
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    OsmEngine: class {
    setProgressHandler() {}
    async build() {
      built.push(nextDataset);
      return nextDataset as never;
    }
    register() {}
    dispose() {}
    setEngine() {}
    route() { return null; }
    },
  };
});

/** A crop small enough that `keptNodes * 229` lands well under any device's budget. */
const TINY: PbfCrop = { west: -1.45, south: 51.45, east: -1.3, north: 51.65 };

/** A crop whose kept count blows past any plausible budget, by construction. */
const HUGE_NODES = 40_000_000;

async function importWith(
  dataset: Partial<StubDataset>,
  req: Record<string, unknown> = {},
): Promise<{ warns: string[]; errors: string[]; result: unknown }> {
  built.length = 0;
  nextDataset = { ...nextDataset, ...dataset } as StubDataset;
  const { importRegionFile } = await import('../src/regions/store');
  const warns: string[] = [];
  const errors: string[] = [];
  const file = new File([readFileSync(REAL_PBF)], 'fixture.osm.pbf');
  const result = await importRegionFile({
    id: 'test-region',
    name: 'Test',
    code: 'test',
    file,
    onWarn: (m: string | null) => { if (m) warns.push(m); },
    onError: (m: string | null) => { if (m) errors.push(m); },
    ...req,
  } as never);
  return { warns, errors, result };
}

describe('an uncropped import says nothing about crops', () => {
  beforeEach(() => { built.length = 0; });

  it('is silent, because there was no crop to report on', async () => {
    const { warns } = await importWith({
      cropApplied: false,
      cropStats: { seenNodes: 103, keptNodes: 103, ways: 21, cropped: false },
      cropIgnored: false,
    });
    expect(warns).toEqual([]);
  });

  it('does not warn about an ignored crop it was never asked for', async () => {
    // The false case matters: a warning that fires when nothing went wrong is how a
    // diagnostic panel becomes noise nobody reads.
    const { warns } = await importWith({ cropIgnored: false });
    expect(warns.filter((w) => /crop/i.test(w))).toEqual([]);
  });
});

describe('a crop that was ignored', () => {
  /**
   * The self-contradicting message, first version:
   *
   *   "Only the area inside the chosen box was read from this file — the format it is in
   *    does not support cropping, so the whole of it was parsed."
   *
   * Two opposite sentences in one string, in a warning whose whole purpose is to tell the
   * driver that asking for a metro area got them the province.
   */
  it('says the crop did NOT happen, and does not also say it did', async () => {
    const { warns } = await importWith({ cropIgnored: true, cropApplied: false }, { crop: TINY });
    const cropWarn = warns.find((w) => /crop/i.test(w));
    expect(cropWarn, 'no warning about the ignored crop').toBeDefined();
    // It must not tell the driver a partial read happened.
    expect(cropWarn).not.toMatch(/only the part|inside the chosen box was read/i);
    // It must say the whole file was read, and say it once.
    expect(cropWarn).toMatch(/read in full/i);
    expect(cropWarn!.match(/read in full/gi)).toHaveLength(1);
    // And it names the file, because "the extract" is ambiguous when two are being imported.
    expect(cropWarn).toContain('fixture.osm.pbf');
    // And it should be actionable: XML cannot be cropped, so the fix is a format change.
    expect(cropWarn).toMatch(/\.osm\.pbf/);
  });

  it('does not fire when nothing asked for a crop', async () => {
    const { warns } = await importWith({ cropIgnored: false });
    expect(warns.filter((w) => /does not support cropping/i.test(w))).toEqual([]);
  });
});

describe('a cropped import that cost more than the device had', () => {
  /**
   * §15.1 item 4's substitution of a measurement for an estimate: `keptNodes × 229 B`
   * against the budget, rather than a number derived from a file size that no longer
   * describes what is being read.
   */
  it('reports the real cost, in nodes and megabytes, with the budget it exceeded', async () => {
    const { warns } = await importWith({
      cropApplied: true,
      cropStats: { seenNodes: HUGE_NODES + 100, keptNodes: HUGE_NODES, ways: 1, cropped: true },
    }, { crop: TINY });

    const warn = warns.find((w) => /held about/.test(w));
    expect(warn, 'no cost warning').toBeDefined();
    // The two numbers are the point: what it kept, and what that needed.
    expect(warn).toContain(HUGE_NODES.toLocaleString());
    expect(warn).toMatch(/against this device's \d+ MB/);
    // And it is phrased as "it parsed, but there was little room" rather than as a
    // refusal: the memory is already spent, and throwing here would discard a working map.
    expect(warn).toMatch(/it parsed/i);
    expect(warn).toMatch(/smaller area/i);
  });

  it('is quiet when the crop fitted', async () => {
    const { warns } = await importWith({
      cropApplied: true,
      cropStats: { seenNodes: 103, keptNodes: 12, ways: 3, cropped: true },
    }, { crop: TINY });
    expect(warns.filter((w) => /held about/.test(w))).toEqual([]);
  });

  it('is quiet when the crop was not cropped', async () => {
    // `cropStats` present but `cropped: false` is a real shape — the reader reports it on
    // every parse — and treating it as a crop would warn on every ordinary import.
    const { warns } = await importWith({
      cropApplied: false,
      cropStats: { seenNodes: HUGE_NODES, keptNodes: HUGE_NODES, ways: 1, cropped: false },
    }, { crop: TINY });
    expect(warns.filter((w) => /held about/.test(w))).toEqual([]);
  });
});

describe('the import still succeeds in every one of those cases', () => {
  /**
   * A warning that arrives with a thrown import is a different product. §14.20.1 says the
   * cost report is deliberately a warning and not a post-hoc refusal, because the memory has
   * already been spent.
   */
  it('a warning never replaces the import', async () => {
    for (const ds of [
      { cropIgnored: true, cropApplied: false },
      { cropApplied: true, cropStats: { seenNodes: HUGE_NODES, keptNodes: HUGE_NODES, ways: 1, cropped: true } },
    ]) {
      const { errors, result } = await importWith(ds as Partial<StubDataset>, { crop: TINY });
      expect(errors, `errors for ${JSON.stringify(Object.keys(ds))}`).toEqual([]);
      expect(result).not.toBeNull();
    }
  });
});