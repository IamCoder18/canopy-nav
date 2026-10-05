/**
 * `roadsToGeoJSON` class filtering.
 *
 * `roadsToGeoJSON` takes a `minClassZoom` that used to be declared, defaulted,
 * and then explicitly discarded with `void minClassZoom` — the parameter and the
 * `RENDER_MIN_ZOOM` table it was meant to consult both existed, and neither was
 * implemented. Both halves are now live, which is what these tests exist to keep
 * that way.
 *
 * The point of the filter is cost, not correctness: on a provincial extract every
 * road is still a GeoJSON feature to build and serialise, and a residential
 * street at zoom 6 is sub-pixel. So the behaviour worth pinning is *which classes
 * survive at a given zoom*.
 *
 * Run with `npx vitest run test/renderzoom.spec.ts`.
 */

import { describe, it, expect } from 'vitest';
import { roadsToGeoJSON, waterToGeoJSON, greenToGeoJSON } from '../src/osm/engine';
import { RENDER_MIN_ZOOM, parseOsmXml, buildDataset, type OsmDataset } from '../src/osm/engine.worker';

/**
 * One road of every class in `RENDER_MIN_ZOOM`, plus one it does not know.
 *
 * Built from the table's own keys rather than a hand-written list, so a class
 * added to the table is automatically covered. That matters because the table is
 * the thing under test: a hardcoded list here would pass while the table gained
 * a class nobody exercised.
 */
const ROADS = [
  ...Object.keys(RENDER_MIN_ZOOM).map((className) => ({
    class: className,
    pts: [[0, 0], [0, 1]] as [number, number][],
  })),
  { class: 'brand_new_osm_tag', pts: [[0, 0], [0, 1]] as [number, number][] },
];

function dataset(): OsmDataset {
  const ds = buildDataset(parseOsmXml('<osm/>').nodes, parseOsmXml('<osm/>').ways, () => {});
  return { ...ds, roads: ROADS };
}

function classesAt(zoom: number): string[] {
  return roadsToGeoJSON(dataset(), zoom).features
    .map((f) => String((f.properties as Record<string, unknown>).class))
    .sort();
}

describe('roadsToGeoJSON — no filtering by default', () => {
  it('keeps the classes with no lower bound at zoom 0', () => {
    // Not "every road": at zoom 0 a residential street is exactly the sub-pixel
    // noise the filter exists to drop. What must hold at zoom 0 is that only the
    // zero-threshold classes and the unknown class survive.
    expect(classesAt(0)).toEqual(['brand_new_osm_tag', 'motorway', 'trunk']);
  });

  it('a default-zoom caller gets the same as zoom 0', () => {
    const ds = dataset();
    expect(roadsToGeoJSON(ds).features.length).toBe(roadsToGeoJSON(ds, 0).features.length);
  });

  it('keeps every road when no threshold excludes it', () => {
    // A caller wanting the full dataset can pass a zoom above every threshold,
    // which is what the map layer effectively does once fully zoomed in.
    const max = Math.max(...Object.values(RENDER_MIN_ZOOM));
    expect(classesAt(max).length).toBe(ROADS.length);
  });
});

describe('roadsToGeoJSON — drops classes below their legibility zoom', () => {
  it('keeps only motorways and trunks at zoom 4', () => {
    expect(classesAt(4)).toEqual(['brand_new_osm_tag', 'motorway', 'trunk']);
  });

  it('adds primary roads at zoom 8', () => {
    expect(classesAt(8)).toContain('primary');
  });

  it('drops residential streets at zoom 10 but keeps them at 13', () => {
    expect(classesAt(10)).not.toContain('residential');
    expect(classesAt(13)).toContain('residential');
  });

  it('keeps the set monotonically non-decreasing as zoom rises', () => {
    let previous = classesAt(0).length;
    for (let z = 1; z <= 16; z++) {
      const n = classesAt(z).length;
      expect(n, `zoom ${z} lost roads`).toBeGreaterThanOrEqual(previous);
      previous = n;
    }
  });

  it('keeps everything the table lists once fully zoomed in', () => {
    const known = Object.keys(RENDER_MIN_ZOOM);
    const at16 = classesAt(16);
    for (const k of known) expect(at16, `${k} missing at zoom 16`).toContain(k);
  });
});

describe('roadsToGeoJSON — unknown classes are never dropped', () => {
  it('keeps a class the table has never heard of', () => {
    // New OSM tags appear, and dropping them silently makes roads vanish rather
    // than render untidily. A class absent from the table has no known
    // legibility threshold, so the only safe default is to draw it.
    expect(classesAt(0)).toContain('brand_new_osm_tag');
    expect(classesAt(16)).toContain('brand_new_osm_tag');
  });

  it('still applies the known thresholds alongside an unknown class', () => {
    expect(classesAt(4)).not.toContain('residential');
    expect(classesAt(4)).toContain('brand_new_osm_tag');
  });
});

describe('roadsToGeoJSON — the table is the single source of truth', () => {
  it('gives every listed class a numeric threshold', () => {
    for (const [cls, z] of Object.entries(RENDER_MIN_ZOOM)) {
      expect(typeof z, `${cls} has no numeric threshold`).toBe('number');
      expect(z).toBeGreaterThanOrEqual(0);
    }
  });

  it('draws motorways and trunks at every zoom', () => {
    expect(RENDER_MIN_ZOOM.motorway).toBe(0);
    expect(RENDER_MIN_ZOOM.trunk).toBe(0);
  });

  it('excludes a road exactly at its threshold and keeps it one zoom later', () => {
    // The comparison must be `min > zoom` to skip, i.e. inclusive at the
    // threshold. An off-by-one here would drop motorways at zoom 0.
    const z = RENDER_MIN_ZOOM.primary;
    expect(classesAt(z - 1)).not.toContain('primary');
    expect(classesAt(z)).toContain('primary');
  });
});

describe('the other GeoJSON mirrors are unaffected', () => {
  it('water and green take no zoom argument and always return a collection', () => {
    const ds = dataset();
    expect(waterToGeoJSON(ds).type).toBe('FeatureCollection');
    expect(greenToGeoJSON(ds).type).toBe('FeatureCollection');
  });
});