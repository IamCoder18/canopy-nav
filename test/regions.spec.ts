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

/**
 * A pair of extracts where stitching and merging genuinely disagree.
 *
 * The existing `WEST_XML`/`EAST_XML` pair above cannot tell the two apart, and
 * the reason is worth recording, because it is the reason this bug survived: the
 * two bboxes touch along a shared edge, so `boundaryPoint` returns the centre of
 * their overlap — which for a straight road at lat 0 *is* the shared OSM node 2.
 * The stitched route and the merged route are then byte-identical, so any test
 * built on it passes whether the merge is wired in or not.
 *
 * So this pair is built to defeat that. The real through-road is 1–2–3, a
 * straight run along lat 0.005. The bboxes overlap in a rectangle centred on
 * (0.0075, 0.1025) — about 11 km north of that road — and each extract carries a
 * `Loop` way reaching up to exactly that point. Stitching therefore hands the
 * driver from a node on one `Loop` to a node on the other, a 4× detour through a
 * junction that exists only as box arithmetic; the merged graph has the real
 * through-road and takes it.
 */
const LOOP_WEST_XML = `<osm>
  <node id="1" lat="0.005" lon="-0.02"/>
  <node id="2" lat="0.005" lon="0.005"/>
  <node id="8" lat="0.1025" lon="0.0075"/>
  <way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/><tag k="name" v="Main"/></way>
  <way id="12"><nd ref="1"/><nd ref="8"/><tag k="highway" v="residential"/><tag k="name" v="Loop"/></way>
</osm>`;
const LOOP_EAST_XML = `<osm>
  <node id="2" lat="0.005" lon="0.005"/>
  <node id="3" lat="0.005" lon="0.03"/>
  <node id="9" lat="0.1025" lon="0.0075"/>
  <way id="11"><nd ref="2"/><nd ref="3"/><tag k="highway" v="residential"/><tag k="name" v="Main"/></way>
  <way id="13"><nd ref="9"/><nd ref="3"/><tag k="highway" v="residential"/><tag k="name" v="Loop"/></way>
</osm>`;

/** A library over the loop pair, with bboxes that overlap in a rectangle. */
function loopLib(): RegionLibrary {
  const l = new RegionLibrary();
  const west = datasetFromXml(LOOP_WEST_XML);
  const east = datasetFromXml(LOOP_EAST_XML);
  addRegion(l, {
    id: 'west', name: 'West', code: 'w', bbox: [-0.02, 0, 0.01, 0.2],
    loadedAt: 0, bytes: 0, counts: west.counts, gazetteerSize: west.gaz.length, dataset: west,
  });
  addRegion(l, {
    id: 'east', name: 'East', code: 'e', bbox: [0.005, 0.005, 0.03, 0.25],
    loadedAt: 0, bytes: 0, counts: east.counts, gazetteerSize: east.gaz.length, dataset: east,
  });
  return l;
}

/** The point the old implementation would have stitched through: ~11 km off the road. */
const STITCH_POINT: LatLng = [0.0075, 0.1025];

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

  it('returns the midpoint of the shared edge for horizontally adjacent regions', () => {
    const b = stubRegion('b', [-110, 49, -100, 60]);
    const p = boundaryPoint(a, b);
    expect(p).not.toBeNull();
    expect(p![0]).toBeCloseTo(-110, 9);
    expect(p![1]).toBeCloseTo(54.5, 9);
  });

  it('finds the touching edge on the other three sides', () => {
    const left = boundaryPoint(a, stubRegion('l', [-130, 49, -120, 60]))!;
    expect(left[0]).toBeCloseTo(-120, 9);
    expect(left[1]).toBeCloseTo(54.5, 9);

    const below = boundaryPoint(a, stubRegion('d', [-120, 39, -110, 49]))!;
    expect(below[0]).toBeCloseTo(-115, 9);
    expect(below[1]).toBeCloseTo(49, 9);

    const corner = boundaryPoint(a, stubRegion('c', [-120, 60, -110, 70]))!;
    expect(corner[0]).toBeCloseTo(-115, 9);
    expect(corner[1]).toBeCloseTo(60, 9);
  });

  it('is symmetric in its arguments', () => {
    const b = stubRegion('b', [-110, 49, -100, 60]);
    expect(boundaryPoint(a, b)).toEqual(boundaryPoint(b, a));
  });

  it('returns the shared centre for identical or nested boxes', () => {
    expect(boundaryPoint(a, stubRegion('same', [-120, 49, -110, 60]))).toEqual([-115, 54.5]);
    expect(boundaryPoint(a, stubRegion('nested', [-119, 50, -111, 59]))).toEqual([-115, 54.5]);
  });

  it('returns the middle of the shared span for overlapping boxes', () => {
    // Boxes that overlap need no hand-off; the answer is the centre of the
    // intersection (x: -118..-112 -> -115, y: 50..55 -> 52.5).
    expect(boundaryPoint(a, stubRegion('ov', [-118, 50, -112, 55]))).toEqual([-115, 52.5]);
  });

  it('accepts a small gap but rejects one past the adjacency threshold', () => {
    // 0.2 deg of longitude at 54.5N is ~12.9 km, 0.4 deg is ~25.9 km.
    const near = boundaryPoint(a, stubRegion('near', [-109.8, 49, -100, 60]));
    expect(near).not.toBeNull();
    expect(near![0]).toBeCloseTo(-109.9, 9);
    expect(boundaryPoint(a, stubRegion('far', [-109.6, 49, -100, 60]))).toBeNull();
  });

  it('returns null for regions that are not neighbours', () => {
    expect(boundaryPoint(a, stubRegion('far', [130, -40, 150, -20]))).toBeNull();
    expect(boundaryPoint(a, stubRegion('eu', [-40, 10, -30, 20]))).toBeNull();
    expect(boundaryPoint(a, stubRegion('pacific', [170, 10, 175, 20]))).toBeNull();
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

  it('does not notify when removing an id that was never added', () => {
    // An unconditional emit() re-rendered every subscribed screen for a no-op.
    const lib = new RegionLibrary();
    let calls = 0;
    lib.subscribe(() => calls++);
    lib.remove('ghost');
    expect(lib.count).toBe(0);
    expect(calls).toBe(0);

    // ...but a real removal still notifies exactly once
    const ds = datasetFromXml('<osm/>');
    addRegion(lib, {
      id: 'real', name: 'Real', code: 'r', bbox: ds.bbox,
      loadedAt: 0, bytes: 0, counts: ds.counts, gazetteerSize: ds.gaz.length, dataset: ds,
    });
    calls = 0;
    lib.remove('real');
    expect(calls).toBe(1);
    expect(lib.count).toBe(0);
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

  it('prefers the tightest bbox', () => {
    // A city extract nested inside a province is the more specific match. The
    // sort previously ordered descending by area and returned the loosest, so a
    // point inside a loaded city routed against the province-wide graph.
    const lib = libWith(big(), small());
    expect(lib.bestFor([1, 46])!.id).toBe('small');   // inside both
    expect(lib.bestFor([-5, 42])!.id).toBe('big');    // inside only the province
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

  it('falls back to a single plan when the two regions are not neighbours', () => {
    const lib = libWith(stubRegion('a', [-120, 49, -110, 60]), stubRegion('far', [130, -40, 150, -20]));
    const plan = lib.plan([-115, 54], [140, -30]);
    expect(plan.kind).toBe('single');
    if (plan.kind === 'single') expect(plan.region.id).toBe('a');
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
    // Both endpoints strictly inside `west`, so this is genuinely one region
    // rather than a point sitting on the shared border.
    const r = lib().route([0.001, 0], [0.009, 0]);
    expect(r).not.toBeNull();
    expect(r!.regions).toEqual(['west']);
    expect(r!.stitched).toBe(false);
    // endpoints snap to the nearest graph nodes, which sit at lon 0 and 0.01
    expect(r!.result.geometry.map((p) => p[0])).toEqual([0, 0.01]);
    expect(r!.result.metres).toBeGreaterThan(100);
  });

  it('routes across regions on one merged graph, not two stitched legs', () => {
    const r = lib().route([0, 0], [0.02, 0]);
    expect(r).not.toBeNull();
    // Not stitched: the two extracts share OSM node 2, so they are merged and the
    // route is one A* over the merged graph. This used to be `true`.
    expect(r!.stitched).toBe(false);
    expect(r!.regions).toEqual(['west', 'east']);
    expect(r!.result.geometry.map((p) => p[0])).toEqual([0, 0.01, 0.02]);
    expect(r!.result.metres).toBeGreaterThan(2000);
    expect(r!.result.time).toBeGreaterThan(0);
    expect(r!.result.engine).toBe('osm-local');
  });

  it('produces the same steps a single A* over the merged graph would', () => {
    // The old implementation concatenated one step per leg, so a two-region
    // route always had two. One A* over a merged graph names the roads it
    // actually drives, which here is the single `Main` way end to end.
    const r = lib().route([0, 0], [0.02, 0]);
    expect(r!.result.steps).toHaveLength(1);
    expect(r!.result.steps[0].name).toBe('Main');
  });

  it('does not route through a point chosen by bounding-box arithmetic', () => {
    // The actual requirement behind requirement #10, stated as a test.
    //
    // On the loop fixture the two bboxes overlap in a rectangle centred on
    // (0.0075, 0.0125), ~900 m from the shared node. The old implementation
    // handed the route over at that point, so it detoured via the `Loop` ways.
    // The merged graph has the real through-road (1-2-3) available and takes it.
    const r = loopLib().route([-0.02, 0.005], [0.03, 0.005]);
    expect(r).not.toBeNull();
    expect(r!.stitched).toBe(false);

    const lons = r!.result.geometry.map((p) => p[0]);
    // The through-road is a straight run along lat 0.005 from -0.02 to 0.03, and
    // the merged route must stay on it.
    expect(lons).toEqual([-0.02, 0.005, 0.03]);
    expect(r!.result.geometry.every((p) => Math.abs(p[1] - 0.005) < 1e-9)).toBe(true);
    // The stitch point is nowhere on the route the driver is given.
    for (const p of r!.result.geometry) {
      expect(Math.hypot(p[0] - STITCH_POINT[0], p[1] - STITCH_POINT[1])).toBeGreaterThan(0.09);
    }
  });

  it('is materially shorter than the route stitching would have produced', () => {
    // Quantified rather than asserted as a shape, because the harm was never a
    // visible seam: both routes are continuous lines. It is the distance that is
    // wrong — on this fixture, fourfold.
    const merged = loopLib().route([-0.02, 0.005], [0.03, 0.005]);
    expect(merged).not.toBeNull();

    // Recompute the old answer directly, from the two regions on their own.
    const l = loopLib();
    const west = l.get('west')!;
    const east = l.get('east')!;
    const legA = l.routeIn(west, [-0.02, 0.005], STITCH_POINT);
    const legB = l.routeIn(east, STITCH_POINT, [0.03, 0.005]);
    expect(legA).not.toBeNull();
    expect(legB).not.toBeNull();
    const stitchedMetres = legA!.metres + legB!.metres;

    expect(stitchedMetres).toBeGreaterThan(merged!.result.metres * 3);
  });

  it('caches the merge instead of rebuilding it per query', () => {
    const l = loopLib();
    const first = l.route([-0.02, 0.005], [0.03, 0.005]);
    const second = l.route([-0.019, 0.005], [0.029, 0.005]);
    expect(first!.result.geometry).toEqual(second!.result.geometry);
    // Re-adding a region must invalidate the cache, or a stale merge would keep
    // answering routes for a graph that is no longer loaded.
    const west = l.get('west')!;
    l.add(
      { id: 'west', name: 'West', code: 'w', bbox: west.bbox, loadedAt: 0, bytes: 0,
        counts: west.counts, gazetteerSize: west.gazetteerSize },
      datasetFromXml(LOOP_WEST_XML),
    );
    const third = l.route([-0.02, 0.005], [0.03, 0.005]);
    expect(third!.result.geometry).toEqual(first!.result.geometry);
  });

  it('returns null when one leg cannot be routed', () => {
    // The destination is far outside the spatial index's search radius.
    expect(lib().route([0, 0], [0.02, 0.5])).toBeNull();
  });

  it('returns null rather than throwing when no region covers the pair', () => {
    // route() is typed `| null`, so a caller must not have to guard with
    // try/catch just because nothing downloaded covers the trip.
    expect(() => new RegionLibrary().route([100, 0], [101, 0])).not.toThrow();
    expect(new RegionLibrary().route([100, 0], [101, 0])).toBeNull();
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