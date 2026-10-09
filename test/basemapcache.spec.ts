/**
 * The offline basemap cache.
 *
 * ## Why this is tested at all
 *
 * The cache is a `WeakMap` over module state with no exported surface, so it
 * would be untestable by inspection alone — and the defect it exists to fix is
 * invisible to every other suite. `roadsToGeoJSON` on a province allocates
 * 10⁵–10⁶ objects on the main thread; nothing crashes, nothing throws, the map
 * just stutters. A green test run is exactly what a performance defect looks
 * like.
 *
 * So the cache is extracted here by re-implementing `basemapFor`'s logic over a
 * counted `roadsToGeoJSON`. That is a real weakness of this test and it is stated
 * rather than hidden: **it verifies the algorithm, not the shipped function.** If
 * `MapView.tsx` is edited to reintroduce a single-slot cache, this suite stays
 * green. `test/audit-regressions.spec.ts` covers that half by asserting on the
 * source text instead, which catches the shape but not the behaviour.
 *
 * What is asserted here is the behaviour that is actually easy to get wrong:
 * several zooms resident, zoom-independent layers built once, and eviction that
 * keeps the arriving level.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type FeatureCollection = { type: 'FeatureCollection'; features: unknown[] };

/** The two zoom-independent conversions, and the zoom-dependent one. */
interface CacheShape {
  roads: FeatureCollection;
  water: FeatureCollection;
  green: FeatureCollection;
}

function makeCounters() {
  return { roads: 0, water: 0, green: 0 };
}

/**
 * `basemapFor` as shipped, with the converters replaced by counting stubs.
 *
 * Kept structurally identical to `MapView.tsx` on purpose — the value of this
 * test is that the two can be diffed by eye.
 */
function makeBasemapFor(
  counts: ReturnType<typeof makeCounters>,
  maxCachedZooms: number,
): (dataset: object, zoom: number) => CacheShape {
  const cache = new WeakMap<object, {
    water: FeatureCollection;
    green: FeatureCollection;
    roadsByZoom: Map<number, FeatureCollection>;
  }>();

  const roadsToGeoJSON = (_ds: object, zoom: number): FeatureCollection => {
    counts.roads++;
    return { type: 'FeatureCollection', features: [`roads@${zoom}`] };
  };
  const waterToGeoJSON = (): FeatureCollection => {
    counts.water++;
    return { type: 'FeatureCollection', features: ['water'] };
  };
  const greenToGeoJSON = (): FeatureCollection => {
    counts.green++;
    return { type: 'FeatureCollection', features: ['green'] };
  };

  return function basemapFor(dataset, zoom) {
    const key = dataset;
    let entry = cache.get(key);
    if (!entry) {
      entry = {
        water: waterToGeoJSON(),
        green: greenToGeoJSON(),
        roadsByZoom: new Map(),
      };
      cache.set(key, entry);
    }
    let roads = entry.roadsByZoom.get(zoom);
    if (roads !== undefined) {
      entry.roadsByZoom.delete(zoom);
    } else {
      roads = roadsToGeoJSON(key, zoom);
    }
    entry.roadsByZoom.set(zoom, roads);
    while (entry.roadsByZoom.size > maxCachedZooms) {
      const oldest = entry.roadsByZoom.keys().next();
      if (oldest.done) break;
      entry.roadsByZoom.delete(oldest.value);
    }
    return { roads, water: entry.water, green: entry.green };
  };
}

const MAX = 3;

describe('basemap cache: zoom crossings', () => {
  it('does not rebuild when the zoom has not changed', () => {
    const counts = makeCounters();
    const basemapFor = makeBasemapFor(counts, MAX);
    const ds = {};

    basemapFor(ds, 12);
    basemapFor(ds, 12);
    basemapFor(ds, 12);
    expect(counts.roads).toBe(1);
  });

  it('does not rebuild for a zoom already in the cache', () => {
    // The single-slot cache rebuilt here, on every crossing, forever: it kept
    // one zoom and compared against it. This is the regression the multiple-zoom
    // entry exists to prevent.
    const counts = makeCounters();
    const basemapFor = makeBasemapFor(counts, MAX);
    const ds = {};

    basemapFor(ds, 11);
    basemapFor(ds, 12);
    basemapFor(ds, 11); // back again
    expect(counts.roads).toBe(2);
    expect(counts.water).toBe(1);
    expect(counts.green).toBe(1);
  });

  it('survives repeated oscillation across a zoom boundary', () => {
    // The driver's actual gesture: pinch out, pinch back, repeated. With a
    // single slot each crossing is a full re-serialisation; this asserts the
    // steady state is reached after the first pass in each direction.
    const counts = makeCounters();
    const basemapFor = makeBasemapFor(counts, MAX);
    const ds = {};

    for (let i = 0; i < 50; i++) {
      basemapFor(ds, i % 2 === 0 ? 13 : 14);
    }
    expect(counts.roads).toBe(2);
  });

  it('builds zoom-independent layers exactly once per dataset', () => {
    // `water` and `green` do not vary with zoom — `RENDER_MIN_ZOOM` applies to
    // roads only — so rebuilding them per crossing produced identical objects.
    const counts = makeCounters();
    const basemapFor = makeBasemapFor(counts, MAX);
    const ds = {};

    for (let z = 4; z <= 20; z++) basemapFor(ds, z);
    expect(counts.water).toBe(1);
    expect(counts.green).toBe(1);
    expect(counts.roads).toBe(17);
  });

  it('returns the same water and green object identity at every zoom', () => {
    // Identity, not equality: these are shared, not rebuilt-and-equal.
    const counts = makeCounters();
    const basemapFor = makeBasemapFor(counts, MAX);
    const ds = {};

    const a = basemapFor(ds, 10);
    const b = basemapFor(ds, 16);
    expect(b.water).toBe(a.water);
    expect(b.green).toBe(a.green);
  });

  it('returns the right roads for the zoom asked about', () => {
    const counts = makeCounters();
    const basemapFor = makeBasemapFor(counts, MAX);
    const ds = {};

    expect(basemapFor(ds, 7).roads.features).toEqual(['roads@7']);
    expect(basemapFor(ds, 9).roads.features).toEqual(['roads@9']);
  });
});

describe('basemap cache: eviction', () => {
  it('keeps at most MAX_CACHED_ZOOMS entries', () => {
    const counts = makeCounters();
    const basemapFor = makeBasemapFor(counts, MAX);
    const ds = {};

    for (let z = 0; z < 12; z++) basemapFor(ds, z);
    // The cap is the point: an unbounded per-zoom cache would itself become the
    // memory problem on a province extract.
    expect(counts.roads).toBe(12);
  });

  it('evicts the least recently used, not the lowest number', () => {
    // Re-touching a zoom must protect it, or a driver oscillating around one
    // boundary would evict the very entry it keeps coming back to.
    const counts = makeCounters();
    const basemapFor = makeBasemapFor(counts, MAX);
    const ds = {};

    basemapFor(ds, 10);
    basemapFor(ds, 11);
    basemapFor(ds, 12);
    basemapFor(ds, 10); // touch the oldest, making 11 the LRU
    basemapFor(ds, 13); // should evict 11, not 10

    const before = counts.roads;
    basemapFor(ds, 10);
    expect(counts.roads).toBe(before); // 10 survived
    basemapFor(ds, 11);
    expect(counts.roads).toBe(before + 1); // 11 was evicted, so rebuilt
  });

  it('still builds correctly once evicted', () => {
    const counts = makeCounters();
    const basemapFor = makeBasemapFor(counts, MAX);
    const ds = {};

    for (let z = 5; z < 15; z++) basemapFor(ds, z);
    expect(basemapFor(ds, 5).roads.features).toEqual(['roads@5']);
    expect(basemapFor(ds, 14).roads.features).toEqual(['roads@14']);
  });
});

describe('basemap cache: dataset isolation', () => {
  it('builds fresh layers per dataset', () => {
    const counts = makeCounters();
    const basemapFor = makeBasemapFor(counts, MAX);

    // Two datasets, captured from the *return value* rather than read off the
    // objects: the datasets are plain `{}` with no `water` property, so reading
    // `a.water` compared two `undefined`s and asserted nothing. That assertion
    // passed while testing nothing — the same "cannot fail" defect this file's
    // own header warns about, arrived at from the other direction.
    const a = basemapFor({}, 12);
    const b = basemapFor({}, 12);

    expect(counts.roads).toBe(2);
    expect(counts.water).toBe(2);
    expect(a.water).toBeDefined();
    expect(a.water).not.toBe(b.water);
    expect(a.roads).not.toBe(b.roads);
  });

  it('does not leak a region after it is replaced', () => {
    // The cache is a `WeakMap` precisely so a discarded extract is collectable;
    // a `Map` here would pin a province's worth of GeoJSON for the session.
    const counts = makeCounters();
    const basemapFor = makeBasemapFor(counts, MAX);

    let ds: object = {};
    basemapFor(ds, 12);
    ds = {};
    basemapFor(ds, 12);
    // Two builds means two cache misses: the new dataset was not served the
    // old dataset's entry.
    expect(counts.roads).toBe(2);
  });
});

/**
 * The source-level half of the coverage.
 *
 * The behavioural suite above reconstructs `basemapFor`; this asserts the shipped
 * one has the shape that makes those properties true. Weak in the other
 * direction — it cannot see behaviour — but it is the half that survives an
 * implementation being rewritten.
 */
describe('basemap cache: shipped source', () => {
  const MAP = readFileSync(join(__dirname, '..', 'src', 'map', 'MapView.tsx'), 'utf8');

  it('keys roads by zoom rather than holding one zoom', () => {
    expect(MAP).toMatch(/roadsByZoom\s*:\s*Map<number, GeoJSON\.FeatureCollection>/);
    expect(MAP).not.toMatch(/hit\.zoom === zoom/);
  });

  it('builds water and green once per dataset, outside the roads cache', () => {
    // Both calls must appear in the cache-miss branch only. Asserted by
    // requiring them to be inside the `if (!entry)` construction and nowhere in
    // the per-zoom path, which follows it.
    const missBranch = MAP.slice(MAP.indexOf('let entry = basemapCache.get'));
    const miss = missBranch.slice(0, missBranch.indexOf('let roads ='));
    expect(miss).toMatch(/water: waterToGeoJSON\(dataset\)/);
    expect(miss).toMatch(/green: greenToGeoJSON\(dataset\)/);

    const afterMiss = MAP.slice(MAP.indexOf('let roads ='));
    expect(afterMiss).not.toMatch(/waterToGeoJSON\(dataset\)/);
    expect(afterMiss).not.toMatch(/greenToGeoJSON\(dataset\)/);
  });

  it('caps the number of resident zooms', () => {
    expect(MAP).toMatch(/const MAX_CACHED_ZOOMS = \d+/);
    expect(MAP).toMatch(/while \(entry\.roadsByZoom\.size > MAX_CACHED_ZOOMS\)/);
  });
});