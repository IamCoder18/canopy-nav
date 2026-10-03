/**
 * Region-library tests — bbox helpers, RegionLibrary, cross-region plans,
 * catalog lookups and the merged gazetteer search.
 *
 * Datasets are either hand-built stubs (for bbox/gazetteer logic) or parsed
 * from small inline OSM XML so that routing runs through the real engine.
 *
 * Run with `npx vitest run test/regions.spec.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  RegionLibrary,
  CATALOG,
  COUNTRY_NAMES,
  catalogByCountry,
  bboxContains,
  bboxOverlapFrac,
  boundaryPoint,
  searchAll,
  type CatalogEntry,
  type Region,
} from '../src/osm/regions';
import { parseOsmXml, buildDataset, type GazEntry, type OsmDataset, type RoadGraph } from '../src/osm/engine.worker';

const EMPTY_GRAPH: RoadGraph = {
  coords: new Float64Array(0),
  osmIds: new Float64Array(0),
  edgeStart: new Uint32Array(1),
  edgeTo: new Int32Array(0),
  edgeCost: new Float32Array(0),
  edgeFlags: new Uint8Array(0),
  edgeName: [],
  nodeCount: 0,
};

/** An OsmDataset stub carrying only what the library needs. */
function stubDataset(
  bbox: [number, number, number, number],
  gaz: GazEntry[] = [],
): OsmDataset {
  return {
    graph: EMPTY_GRAPH,
    gaz,
    roads: [],
    water: [],
    green: [],
    bbox,
    counts: { nodes: 0, ways: 0, routable: 0 },
  };
}

function stubRegion(
  id: string,
  bbox: [number, number, number, number],
  gaz: GazEntry[] = [],
): Region {
  const dataset = stubDataset(bbox, gaz);
  return {
    id, name: `Region ${id}`, code: id, bbox, loadedAt: 0, bytes: 0,
    counts: dataset.counts, gazetteerSize: gaz.length, dataset,
  };
}

/** Register an existing Region (keeping its dataset) in a library. */
function addRegion(lib: RegionLibrary, r: Region) {
  lib.add(
    {
      id: r.id, name: r.name, code: r.code, bbox: r.bbox, loadedAt: r.loadedAt,
      bytes: r.bytes, counts: r.counts, gazetteerSize: r.gazetteerSize,
    },
    r.dataset,
  );
  return r;
}

/** A library pre-loaded with the given regions. */
function libWith(...regions: Region[]): RegionLibrary {
  const lib = new RegionLibrary();
  for (const r of regions) addRegion(lib, r);
  return lib;
}

/** Parse a tiny OSM XML snippet into a real dataset. */
function datasetFromXml(xml: string): OsmDataset {
  const { nodes, ways } = parseOsmXml(xml);
  return buildDataset(nodes, ways, () => {});
}

/** West extract: nodes 1-2 (lon 0 .. 0.01). East extract: nodes 2-3. */
const WEST_XML = `<osm>
  <node id="1" lat="0" lon="0"/>
  <node id="2" lat="0" lon="0.01"/>
  <way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/><tag k="name" v="Main"/></way>
</osm>`;
const EAST_XML = `<osm>
  <node id="2" lat="0" lon="0.01"/>
  <node id="3" lat="0" lon="0.02"/>
  <way id="11"><nd ref="2"/><nd ref="3"/><tag k="highway" v="residential"/><tag k="name" v="Main"/></way>
</osm>`;

describe('bboxContains', () => {
  const b: [number, number, number, number] = [-10, 40, 10, 50]; // [w, s, e, n]

  it('accepts interior points', () => {
    expect(bboxContains(b, [0, 45])).toBe(true);
  });

  it('is inclusive on every edge', () => {
    expect(bboxContains(b, [-10, 40])).toBe(true);
    expect(bboxContains(b, [10, 50])).toBe(true);
    expect(bboxContains(b, [0, 40])).toBe(true);
    expect(bboxContains(b, [0, 50])).toBe(true);
  });

  it('rejects points just outside each edge', () => {
    expect(bboxContains(b, [-10.0001, 45])).toBe(false);
    expect(bboxContains(b, [10.0001, 45])).toBe(false);
    expect(bboxContains(b, [0, 39.9999])).toBe(false);
    expect(bboxContains(b, [0, 50.0001])).toBe(false);
  });

  it('interprets the tuple as [west, south, east, north]', () => {
    // A [south, north, west, east] box would match this point; [w,s,e,n] must not.
    expect(bboxContains(b, [45, 0])).toBe(false);
  });
});

describe('bboxOverlapFrac', () => {
  const box = (w: number, s: number, e: number, n: number) =>
    [w, s, e, n] as [number, number, number, number];

  it('is 1 when the inner box is entirely inside', () => {
    expect(bboxOverlapFrac(box(0, 0, 1, 1), box(-1, -1, 2, 2))).toBe(1);
  });

  it('is the overlap/inner area ratio when the inner box is bigger', () => {
    // inner 2x2 = 4, overlap 0.5x0.5 = 0.25 => 1/16
    expect(bboxOverlapFrac(box(-1, -1, 1, 1), box(0, 0, 0.5, 0.5))).toBe(0.0625);
  });

  it('is 0.5 for a half overlap', () => {
    expect(bboxOverlapFrac(box(0, 0, 2, 1), box(1, 0, 3, 1))).toBe(0.5);
  });

  it('is 0 for disjoint boxes', () => {
    expect(bboxOverlapFrac(box(0, 0, 1, 1), box(5, 5, 6, 6))).toBe(0);
  });

  it('is 0 for boxes that only touch along an edge', () => {
    expect(bboxOverlapFrac(box(0, 0, 1, 1), box(1, 0, 2, 1))).toBe(0);
  });

  it('is 0 for a zero-area inner box (no division by zero)', () => {
    expect(bboxOverlapFrac(box(0, 0, 0, 1), box(0, 0, 1, 1))).toBe(0);
    expect(bboxOverlapFrac(box(0, 0, 1, 0), box(0, 0, 1, 1))).toBe(0);
    expect(bboxOverlapFrac(box(1, 1, 1, 1), box(0, 0, 1, 1))).toBe(0);
  });

  it('is 0 when the inner box is inverted', () => {
    expect(bboxOverlapFrac(box(1, 1, 0, 0), box(0, 0, 2, 2))).toBe(0);
  });

  it('is 0 when the boxes only overlap in one dimension', () => {
    // x overlaps by 1, y by 0.
    expect(bboxOverlapFrac(box(0, 0, 2, 1), box(1, 1, 3, 2))).toBe(0);
  });

  it('measures the fraction of `inner`, not of `outer`', () => {
    // outer is half covered, inner is fully covered: the two directions differ.
    expect(bboxOverlapFrac(box(0, 0, 1, 1), box(0, 0, 2, 1))).toBe(1);
    expect(bboxOverlapFrac(box(0, 0, 2, 1), box(0, 0, 1, 1))).toBe(0.5);
  });
});

describe('boundaryPoint', () => {
  const a = stubRegion('a', [-120, 49, -110, 60]);
  const b = stubRegion('b', [-110, 49, -100, 60]);

  it('returns the midpoint of the two centroids for adjacent regions', () => {
    const p = boundaryPoint(a, b);
    expect(p).not.toBeNull();
    // centroids (-115, 54.5) and (-105, 54.5) => midpoint (-110, 54.5),
    // which is exactly the shared edge.
    expect(p![0]).toBeCloseTo(-110, 9);
    expect(p![1]).toBeCloseTo(54.5, 9);
  });

  it('is symmetric in its arguments', () => {
    expect(boundaryPoint(a, b)).toEqual(boundaryPoint(b, a));
  });

  it('works for diagonal neighbours', () => {
    const c = stubRegion('c', [-120, 60, -110, 70]);
    // centroids (-115, 54.5) and (-115, 65) => midpoint (-115, 59.75)
    const p = boundaryPoint(a, c)!;
    expect(p[0]).toBeCloseTo(-115, 9);
    expect(p[1]).toBeCloseTo(59.75, 9);
  });

  it('returns the shared centroid for identical boxes', () => {
    const same = stubRegion('same', [-120, 49, -110, 60]);
    expect(boundaryPoint(a, same)).toEqual([-115, 54.5]);
  });

  it('BUG: never returns null, even for regions on opposite sides of the world', () => {
    // The slab clip always contains both centroids (each is inside its own box
    // and the clip rect is the union of the two boxes), so t stays inside
    // [0, 1] and the `return null` paths are unreachable. Regions thousands of
    // km apart still get a "boundary" point between them.
    const far = stubRegion('far', [130, -40, 150, -20]);
    const p = boundaryPoint(a, far);
    expect(p).not.toBeNull();
    expect(p![0]).toBeCloseTo(12.5, 9); // (-115 + 140) / 2
    expect(p![1]).toBeCloseTo(12.25, 9); // (54.5 + -30) / 2
  });

  it.fails('returns null for non-adjacent regions', () => {
    const far = stubRegion('far', [130, -40, 150, -20]);
    expect(boundaryPoint(a, far)).toBeNull();
  });
});

describe('RegionLibrary bookkeeping', () => {
  const meta = (id: string) => ({
    id, name: id.toUpperCase(), code: id, bbox: [0, 0, 1, 1] as [number, number, number, number],
    loadedAt: 1, bytes: 2, counts: stubDataset([0, 0, 1, 1]).counts, gazetteerSize: 0,
  });

  it('adds, gets, counts and lists regions', () => {
    const lib = new RegionLibrary();
    const ds = stubDataset([0, 0, 1, 1]);
    const r = lib.add(meta('x'), ds);
    expect(lib.count).toBe(1);
    expect(lib.get('x')).toBe(r);
    expect(lib.ids).toEqual(['x']);
    expect(lib.all).toEqual([r]);
    expect(lib.get('nope')).toBeUndefined();
  });

  it('notifies subscribers on add and remove, and stops after unsubscribe', () => {
    const lib = new RegionLibrary();
    let calls = 0;
    const off = lib.subscribe(() => calls++);
    lib.add(meta('x'), stubDataset([0, 0, 1, 1]));
    expect(calls).toBe(1);
    lib.remove('x');
    expect(calls).toBe(2);
    expect(lib.count).toBe(0);
    off();
    lib.add(meta('y'), stubDataset([0, 0, 1, 1]));
    expect(calls).toBe(2);
  });

  it('notifies every subscriber', () => {
    const lib = new RegionLibrary();
    let a = 0;
    let b = 0;
    lib.subscribe(() => a++);
    lib.subscribe(() => b++);
    lib.add(meta('x'), stubDataset([0, 0, 1, 1]));
    expect([a, b]).toEqual([1, 1]);
  });

  it('replaces a region with the same id instead of duplicating it', () => {
    const lib = new RegionLibrary();
    lib.add(meta('x'), stubDataset([0, 0, 1, 1]));
    lib.add(meta('x'), stubDataset([0, 0, 1, 1]));
    expect(lib.count).toBe(1);
  });

  it('emits even when removing an id that was never added', () => {
    // remove() is unconditional, so subscribers wake up for a no-op delete.
    const lib = new RegionLibrary();
    let calls = 0;
    lib.subscribe(() => calls++);
    lib.remove('ghost');
    expect(lib.count).toBe(0);
    expect(calls).toBe(1);
  });
});

describe('regionsFor / bestFor', () => {
  const big = () => stubRegion('big', [-10, 40, 10, 60]);
  const small = () => stubRegion('small', [0, 45, 5, 50]);

  it('returns every region whose bbox contains the point', () => {
    const lib = libWith(big(), small());
    expect(lib.regionsFor([1, 46]).map((r) => r.id).sort()).toEqual(['big', 'small']);
    expect(lib.regionsFor([-5, 42]).map((r) => r.id)).toEqual(['big']);
    expect(lib.regionsFor([100, 0])).toEqual([]);
  });

  it('BUG: picks the LOOSEST bbox, not the tightest', () => {
    const lib = libWith(big(), small());
    // `hits.sort((x, y) => area(y.bbox) - area(x.bbox))` orders descending by
    // area, so `hits[0]` is the biggest box even though the docstring says
    // "preferring the tightest bbox".
    expect(lib.bestFor([1, 46])!.id).toBe('big');
    expect(lib.bestFor([-5, 42])!.id).toBe('big');
  });

  it.fails('prefers the tightest bbox', () => {
    const lib = libWith(big(), small());
    expect(lib.bestFor([1, 46])!.id).toBe('small');
    expect(lib.bestFor([-5, 42])!.id).toBe('big');
  });

  it('returns null when no region covers the point', () => {
    expect(libWith(big()).bestFor([100, 0])).toBeNull();
  });

  it('returns null for an empty library', () => {
    expect(new RegionLibrary().bestFor([0, 0])).toBeNull();
  });
});

describe('plan', () => {
  it('returns a single plan when both points are in one region', () => {
    const lib = libWith(stubRegion('a', [-10, 40, 10, 50]));
    const plan = lib.plan([0, 45], [5, 46]);
    expect(plan.kind).toBe('single');
    if (plan.kind === 'single') {
      expect(plan.region.id).toBe('a');
      expect(plan.from).toEqual([0, 45]);
      expect(plan.to).toEqual([5, 46]);
    }
  });

  it('returns a cross plan with a shared cut point when the points span regions', () => {
    const lib = libWith(stubRegion('a', [-10, 40, 0, 50]), stubRegion('b', [0, 40, 10, 50]));
    const plan = lib.plan([-5, 45], [5, 45]);
    expect(plan.kind).toBe('cross');
    if (plan.kind === 'cross') {
      expect(plan.order).toEqual(['a', 'b']);
      expect(plan.legs).toHaveLength(2);
      expect(plan.legs[0].region.id).toBe('a');
      expect(plan.legs[0].from).toEqual([-5, 45]);
      expect(plan.legs[0].to).toEqual([0, 45]);
      expect(plan.legs[1].region.id).toBe('b');
      expect(plan.legs[1].from).toEqual([0, 45]);
      expect(plan.legs[1].to).toEqual([5, 45]);
    }
  });

  it('falls back to the region covering the origin when the destination is elsewhere', () => {
    const lib = libWith(stubRegion('a', [-10, 40, 0, 50]));
    const plan = lib.plan([-5, 45], [100, 0]);
    expect(plan.kind).toBe('single');
    if (plan.kind === 'single') expect(plan.region.id).toBe('a');
  });

  it('falls back to the region covering the destination when the origin is elsewhere', () => {
    const lib = libWith(stubRegion('b', [0, 40, 10, 50]));
    const plan = lib.plan([100, 0], [5, 45]);
    expect(plan.kind).toBe('single');
    if (plan.kind === 'single') expect(plan.region.id).toBe('b');
  });

  it('throws when no region covers either point', () => {
    const lib = libWith(stubRegion('a', [-10, 40, 0, 50]));
    expect(() => lib.plan([100, 0], [120, 0])).toThrow(
      'No downloaded region covers this route. Download the relevant province or state.',
    );
  });
});

describe('route', () => {
  const lib = () => {
    const l = new RegionLibrary();
    const west = datasetFromXml(WEST_XML);
    const east = datasetFromXml(EAST_XML);
    addRegion(l, {
      id: 'west', name: 'West', code: 'w', bbox: [-0.001, -0.001, 0.01, 0.001],
      loadedAt: 0, bytes: 0, counts: west.counts, gazetteerSize: west.gaz.length, dataset: west,
    });
    addRegion(l, {
      id: 'east', name: 'East', code: 'e', bbox: [0.01, -0.001, 0.02, 0.001],
      loadedAt: 0, bytes: 0, counts: east.counts, gazetteerSize: east.gaz.length, dataset: east,
    });
    return l;
  };

  it('routes inside a single region without stitching', () => {
    const r = lib().route([0, 0], [0.01, 0]);
    expect(r).not.toBeNull();
    expect(r!.regions).toEqual(['west']);
    expect(r!.stitched).toBe(false);
    expect(r!.result.geometry.map((p) => p[0])).toEqual([0, 0.01]);
    expect(r!.result.metres).toBeGreaterThan(1000);
  });

  it('routes across regions and joins the legs without duplicating the seam node', () => {
    const r = lib().route([0, 0], [0.02, 0]);
    expect(r).not.toBeNull();
    expect(r!.stitched).toBe(true);
    expect(r!.regions).toEqual(['west', 'east']);
    expect(r!.result.geometry.map((p) => p[0])).toEqual([0, 0.01, 0.02]);
    expect(r!.result.metres).toBeGreaterThan(2000);
    expect(r!.result.time).toBeGreaterThan(0);
    expect(r!.result.engine).toBe('osm-local');
  });

  it('concatenates the per-leg steps', () => {
    const r = lib().route([0, 0], [0.02, 0]);
    expect(r!.result.steps).toHaveLength(2);
    expect(r!.result.steps.every((s) => s.name === 'Main')).toBe(true);
  });

  it('returns null when one leg cannot be routed', () => {
    // The destination is far outside the spatial index's search radius.
    expect(lib().route([0, 0], [0.02, 0.5])).toBeNull();
  });

  it('throws rather than returning null when no region covers the pair', () => {
    // plan() throws and route() does not catch it, so a caller expecting
    // `RouteResult | null` gets an exception instead.
    expect(() => new RegionLibrary().route([100, 0], [101, 0])).toThrow(
      /No downloaded region covers this route/,
    );
  });

  it('routeIn delegates to the single-region engine', () => {
    const l = lib();
    const west = l.get('west')!;
    expect(l.routeIn(west, [0, 0], [0.01, 0])).not.toBeNull();
    expect(l.routeIn(west, [50, 50], [51, 50])).toBeNull();
  });
});

describe('catalog', () => {
  const idAt = (p: [number, number]): CatalogEntry | null =>
    new RegionLibrary().catalogFor(p);

  it('finds the province for a point inside it', () => {
    expect(idAt([-114.5, 51.05])!.id).toBe('ca-ab'); // Calgary
    expect(idAt([-123.1, 49.3])!.id).toBe('ca-bc'); // Victoria
    expect(idAt([-79.4, 43.7])!.id).toBe('ca-on'); // Toronto
    expect(idAt([-73.6, 45.5])!.id).toBe('ca-qc');
    expect(idAt([-97.2, 49.9])!.id).toBe('ca-mb'); // Winnipeg
    expect(idAt([-105.7, 52.1])!.id).toBe('ca-sk');
    expect(idAt([-63.5, 44.7])!.id).toBe('ca-ns');
  });

  it('finds US states', () => {
    expect(idAt([-118.2, 34.05])!.id).toBe('us-ca');
    expect(idAt([-122.3, 47.6])!.id).toBe('us-wa');
    expect(idAt([-73.9, 40.7])!.id).toBe('us-ny');
    expect(idAt([-97.5, 30.3])!.id).toBe('us-tx');
    expect(idAt([-81.4, 28.5])!.id).toBe('us-fl');
  });

  it('returns the first catalogue entry in overlapping boxes, not the tightest', () => {
    // (-118, 55) is inside both ca-ab and ca-bc; ca-ab comes first in CATALOG.
    expect(idAt([-118, 55])!.id).toBe('ca-ab');
    // A point only inside Nova Scotia's rough box.
    expect(idAt([-65, 44])!.id).toBe('ca-ns');
    // Charlottetown is inside ca-pe, ca-ns AND ca-qc (whose rough box reaches
    // east to -57), and ca-qc is listed first of the three.
    expect(idAt([-63.3, 46.4])!.id).toBe('ca-qc');
  });

  it('rough boxes are crude: a point in Illinois matches Ontario', () => {
    // Chicago sits inside ca-on's rough box ([-95.8, 41.7] .. [-74.3, 56.9]).
    expect(idAt([-87.6, 41.9])!.id).toBe('ca-on');
  });

  it('returns null for a point in no catalogue region', () => {
    expect(idAt([-87.7, 41.0])).toBeNull();
    expect(idAt([0, 0])).toBeNull();
  });

  it('never returns the Manitoba (north) entry because it has no rough box', () => {
    expect(CATALOG.some((e) => e.id === 'ca-mb-north')).toBe(true);
    // A point in northern Manitoba resolves to the province, never to the
    // "Manitoba (north)" entry, because `rough` has no ca-mb-north key.
    expect(idAt([-97, 55])!.id).toBe('ca-mb');
  });

  it('groups the catalogue by country', () => {
    const groups = catalogByCountry();
    expect(groups.map((g) => g.country)).toEqual(['Canada', 'United States']);
    expect(groups[0].entries).toHaveLength(11);
    expect(groups[1].entries).toHaveLength(5);
    expect(groups[0].entries.every((e) => e.country === 'Canada')).toBe(true);
    expect(groups.flatMap((g) => g.entries).length).toBe(CATALOG.length);
  });

  it('gives every catalogue entry a geofabrik URL and a country code it can derive', () => {
    for (const e of CATALOG) {
      expect(e.pbfUrl).toMatch(/^https:\/\/download\.geofabrik\.de\/.+\.osm\.pbf$/);
      expect(e.approxMb).toBeGreaterThan(0);
      expect(COUNTRY_NAMES[e.id.slice(0, 2)]).toBe(e.country);
    }
    expect(COUNTRY_NAMES).toEqual({ ca: 'Canada', us: 'United States' });
  });
});

describe('searchAll', () => {
  const NEAR: [number, number] = [-114.0719, 51.0447]; // Calgary

  const gaz = (name: string, rank: number, offDeg = 0): GazEntry => ({
    name, rank, cat: 'place',
    lat: NEAR[1] + offDeg, lon: NEAR[0] + offDeg,
  });

  it('returns nothing for an empty or whitespace query', () => {
    const lib = libWith(stubRegion('ab', [-1, -1, 1, 1], [gaz('Banff', 100)]));
    expect(searchAll(lib, '', NEAR)).toEqual([]);
    expect(searchAll(lib, '   ', NEAR)).toEqual([]);
  });

  it('ranks exact > prefix > substring', () => {
    const lib = libWith(
      stubRegion('ab', [-1, -1, 1, 1], [
        gaz('Banff', 100),
        gaz('Banff Springs', 100),
        gaz('Mount Banff Road', 100),
      ]),
    );
    const hits = searchAll(lib, 'banff', NEAR, 10);
    expect(hits.map((h) => h.entry.name)).toEqual([
      'Banff', 'Banff Springs', 'Mount Banff Road',
    ]);
    expect(hits.every((h) => h.regionId === 'ab' && h.regionName === 'Region ab')).toBe(true);
  });

  it('prefers a nearer exact match over a distant one even at the score cap', () => {
    const lib = libWith(
      stubRegion('ab', [-1, -1, 1, 1], [gaz('Banff', 100), gaz('Banff', 100, 0.09)]),
    );
    const hits = searchAll(lib, 'banff', NEAR, 10);
    expect(hits[0].entry.lat).toBeCloseTo(NEAR[1], 9);
    expect(hits[1].entry.lat).toBeCloseTo(NEAR[1] + 0.09, 9);
  });

  it('scores as match + rank - min(120, distance/500)', () => {
    const lib = libWith(
      stubRegion('ab', [-1, -1, 1, 1], [
        gaz('Banff', 100), // exact, 0 m       => 1100 - 0
        gaz('Banff', 40), // exact, 0 m        => 1040 - 0
        gaz('Banff', 100, 0.05), // exact, 6.6 km  => 1100 - 13.16
        gaz('Banff', 100, 0.6), // exact, 79 km   => 1100 - 120 (capped)
      ]),
    );
    const mPerDegLon = 111320 * Math.cos((NEAR[1] * Math.PI) / 180);
    // mirror the module's planar distance exactly (offsets applied to the
    // stored lat/lon before subtracting, so the float rounding matches)
    const dist = (off: number) =>
      Math.hypot((NEAR[1] + off - NEAR[1]) * 111320, (NEAR[0] + off - NEAR[0]) * mPerDegLon);
    expect(dist(0.05)).toBeCloseTo(6575, 0);
    expect(dist(0.05) / 500).toBeCloseTo(13.15, 1);
    expect(dist(0.6) / 500).toBeGreaterThan(120); // the cap bites past 60 km

    const hits = searchAll(lib, 'banff', NEAR, 10);
    expect(hits.map((h) => h.score)).toEqual([
      1000 + 100,
      1000 + 100 - dist(0.05) / 500,
      1000 + 40,
      1000 + 100 - Math.min(120, dist(0.6) / 500),
    ]);
  });

  it('breaks rank ties before distance ties', () => {
    const lib = libWith(
      stubRegion('ab', [-1, -1, 1, 1], [
        gaz('Calgary', 50, 0.01), // far, low rank
        gaz('Calgary', 90), // near, high rank
      ]),
    );
    const hits = searchAll(lib, 'calgary', NEAR, 10);
    expect(hits[0].entry.rank).toBe(90);
    expect(hits[1].entry.rank).toBe(50);
  });

  it('breaks distance ties for identical name and rank', () => {
    const lib = libWith(
      stubRegion('ab', [-1, -1, 1, 1], [
        gaz('Calgary', 90, 0.05), // ~5.5 km away
        gaz('Calgary', 90, 0.01), // ~1.1 km away
      ]),
    );
    const hits = searchAll(lib, 'calgary', NEAR, 10);
    expect(hits[0].entry.lat).toBeCloseTo(NEAR[1] + 0.01, 9);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    // penalty is the planar distance in metres / 500, both axes included
    const mPerDegLon = 111320 * Math.cos((NEAR[1] * Math.PI) / 180);
    const dist = (off: number) => Math.hypot(off * 111320, off * mPerDegLon);
    expect(hits[0].score - hits[1].score).toBeCloseTo((dist(0.05) - dist(0.01)) / 500, 9);
    expect(hits[0].score).toBeCloseTo(1090 - dist(0.01) / 500, 9);
  });

  it('searches every region and labels the hits', () => {
    const lib = libWith(
      stubRegion('ab', [-120, 49, -110, 60], [gaz('Calgary', 100)]),
      stubRegion('bc', [-139, 48.3, -114, 60], [gaz('Vancouver', 100), gaz('Calgary', 100)]),
    );
    const hits = searchAll(lib, 'calgary', NEAR, 10);
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.regionId).sort()).toEqual(['ab', 'bc']);
    // identical name and rank, so the nearer copy (ab) wins
    expect(hits[0].regionId).toBe('ab');
    expect(hits[1].regionName).toBe('Region bc');
  });

  it('honours the limit and drops non-matches', () => {
    const lib = libWith(
      stubRegion('ab', [-1, -1, 1, 1], [
        gaz('Calgary', 100), gaz('Calgary North', 90), gaz('Old Calgary', 80),
        gaz('Edmonton', 100),
      ]),
    );
    expect(searchAll(lib, 'calgary', NEAR, 2)).toHaveLength(2);
    expect(searchAll(lib, 'zzzz', NEAR)).toHaveLength(0);
  });

  it('is case- and whitespace-insensitive on the query', () => {
    const lib = libWith(stubRegion('ab', [-1, -1, 1, 1], [gaz('Calgary', 100)]));
    expect(searchAll(lib, '  CALGARY ', NEAR)).toHaveLength(1);
  });

  it('prefers an exact match over a longer name sharing the prefix', () => {
    const lib = libWith(
      stubRegion('ab', [-1, -1, 1, 1], [gaz('Calgary Trail North', 100), gaz('Calgary', 100)]),
    );
    expect(searchAll(lib, 'calgary', NEAR, 10)[0].entry.name).toBe('Calgary');
  });

  it('prefers the shorter name among two prefix matches', () => {
    const lib = libWith(
      stubRegion('ab', [-1, -1, 1, 1], [gaz('Calgary Trail', 100), gaz('Calgary Road', 100)]),
    );
    // Both are prefix matches: 800 - (name.length - needle.length) + rank.
    // 'Calgary Road' is 12 chars vs 'Calgary Trail' at 13, so it wins by 1.
    const hits = searchAll(lib, 'calgary', NEAR, 10);
    expect(hits.map((h) => h.entry.name)).toEqual(['Calgary Road', 'Calgary Trail']);
    expect(hits.map((h) => h.score)).toEqual([800 - (12 - 7) + 100, 800 - (13 - 7) + 100]);
  });
});