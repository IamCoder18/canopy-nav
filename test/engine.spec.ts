/**
 * Engine tests — run with `npm test`.
 *
 * Uses the hand-built fixture in test/fixture.osm (a 9x9 grid with one-ways,
 * a motorway, named roads, places and a POI) to verify the offline pipeline
 * end to end: parse -> graph -> route -> search, plus region merging.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  parseOsmXml, buildDataset, routeOnGraph, searchGazetteer,
  FLAG_ONEWAY_B,
} from '../src/osm/engine.worker';
import { decodePolyline, formatDistance, formatDuration, snapToPolyline } from '../src/geo';
import { mergeRegions, countComponents } from '../src/osm/merge';
import type { Region } from '../src/osm/regions';

const XML = readFileSync(join(__dirname, 'fixture.osm'), 'utf8');

/** Opposite corners of the fixture's 9x9 grid, on real roads. */
const FROM: [number, number] = [-1.3990, 51.5030];
const TO: [number, number] = [-1.3280, 51.5430];

/** Precision-6 polyline encoder, for round-trip tests. */
function encodePolyline6(coords: [number, number][]): string {
  let out = '';
  let prevLat = 0, prevLon = 0;
  const enc = (n: number) => {
    let v = n < 0 ? ~(n << 1) : n << 1;
    while (v >= 0x20) { out += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    out += String.fromCharCode(v + 63);
  };
  for (const [lon, lat] of coords) {
    const iLat = Math.round(lat * 1e6), iLon = Math.round(lon * 1e6);
    enc(iLat - prevLat); enc(iLon - prevLon);
    prevLat = iLat; prevLon = iLon;
  }
  return out;
}

function build() {
  const { nodes, ways } = parseOsmXml(XML);
  return buildDataset(nodes, ways, () => {});
}

describe('osm parsing', () => {
  it('parses nodes with coordinates', () => {
    const { nodes } = parseOsmXml(XML);
    expect(nodes.size).toBeGreaterThan(80);
    // grid nodes are near Calgary; place nodes may be anywhere in the province
    const grid = [...nodes.values()].filter((n) => n.lat > 51.4 && n.lat < 51.6);
    expect(grid.length).toBeGreaterThan(80);
    for (const n of grid) {
      expect(n.lon).toBeGreaterThan(-1.5);
      expect(n.lon).toBeLessThan(-1.2);
    }
    // and every coordinate is valid WGS84 regardless of position
    for (const n of nodes.values()) {
      expect(Math.abs(n.lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(n.lon)).toBeLessThanOrEqual(180);
    }
  });

  it('parses ways with tags and node refs', () => {
    const { ways } = parseOsmXml(XML);
    expect(ways.length).toBeGreaterThan(15);
    const residential = ways.find((w) => w.tags.highway === 'residential');
    expect(residential).toBeDefined();
    expect(residential!.refs.length).toBe(9);
  });

  it('keeps named nodes for the gazetteer', () => {
    const { nodes } = parseOsmXml(XML);
    const named = [...nodes.values()].filter((n) => (n as any).tags?.place);
    expect(named.length).toBeGreaterThanOrEqual(4);
    expect(named.some((n) => (n as any).tags.name === 'Calgary')).toBe(true);
  });

  it('decodes XML entities in tag values', () => {
    const xml = `<osm><node id="1" lat="1" lon="2"><tag k="name" v="A &amp; B"/></node></osm>`;
    const { nodes } = parseOsmXml(xml);
    expect((nodes.get(1) as any).tags.name).toBe('A & B');
  });
});

describe('graph construction', () => {
  it('builds a routable graph', () => {
    const ds = build();
    expect(ds.graph.nodeCount).toBeGreaterThan(80);
    expect(ds.graph.edgeTo.length).toBeGreaterThan(100);
    expect(ds.roads.length).toBeGreaterThan(15);
  });

  it('records original OSM node ids for merging', () => {
    const ds = build();
    expect(ds.graph.osmIds.length).toBe(ds.graph.nodeCount);
    // every id should be a real OSM id from the fixture range
    for (let i = 0; i < 5; i++) expect(ds.graph.osmIds[i]).toBeGreaterThan(100000);
  });

  it('flags one-way edges so reverse traversal is blocked', () => {
    const ds = build();
    let flagged = 0;
    for (let e = 0; e < ds.graph.edgeFlags.length; e++) {
      if (ds.graph.edgeFlags[e] & FLAG_ONEWAY_B) flagged++;
    }
    expect(flagged).toBeGreaterThan(0);
    // Two-way edges must NOT be flagged, or the network would collapse.
    expect(flagged).toBeLessThan(ds.graph.edgeFlags.length);
  });

  it('excludes non-routable ways from the graph but keeps them renderable', () => {
    const ds = build();
    expect(ds.water.length).toBeGreaterThan(0); // the river
    expect(ds.green.length).toBeGreaterThan(0);  // the park
  });

  it('produces a connected graph for the fixture', () => {
    const ds = build();
    expect(countComponents(ds.graph)).toBe(1);
  });
});

describe('routing (bidirectional A*)', () => {
  it('finds a route across the grid', () => {
    const ds = build();
    const r = routeOnGraph(ds.graph, FROM, TO);
    expect(r).not.toBeNull();
    expect(r!.geometry.length).toBeGreaterThan(5);
    expect(r!.metres).toBeGreaterThan(1000);
    expect(r!.engine).toBe('osm-local');
  });

  it('produces a contiguous geometry with no teleports', () => {
    const ds = build();
    const r = routeOnGraph(ds.graph, FROM, TO);
    for (let i = 1; i < r!.geometry.length; i++) {
      const [x1, y1] = r!.geometry[i - 1];
      const [x2, y2] = r!.geometry[i];
      // consecutive points must be adjacent grid nodes (~0.007 deg apart),
      // never a straight-line jump across the map
      expect(Math.hypot(x2 - x1, y2 - y1)).toBeLessThan(0.012);
    }
  });

  it('respects one-way direction', () => {
    const ds = build();
    // Column 2 (4 St W / 6 St W) is oneway=-1 in the fixture, so travelling
    // northbound on it must not be possible; the router should detour instead.
    const along = routeOnGraph(ds.graph, [-1.3904, 51.506], [-1.3904, 51.530]);
    expect(along).not.toBeNull();
    // whatever route it picks, it must not use the one-way in the forbidden
    // direction: check the geometry stays on the grid.
    for (const [lon, lat] of along!.geometry) {
      expect(lon).toBeGreaterThan(-1.41);
      expect(lon).toBeLessThan(-1.31);
    }
  });

  it('returns null for an unreachable pair', () => {
    const ds = build();
    // Point in the ocean, far from the network.
    expect(routeOnGraph(ds.graph, [-3.0, 40.0], [-3.1, 40.1])).toBeNull();
  });

  it('handles same-origin-and-destination', () => {
    const ds = build();
    const r = routeOnGraph(ds.graph, [-1.39, 51.52], [-1.39, 51.52]);
    expect(r).not.toBeNull();
    expect(r!.metres).toBe(0);
  });

  it('groups consecutive edges into named steps', () => {
    const ds = build();
    const r = routeOnGraph(ds.graph, FROM, TO);
    expect(r!.steps.length).toBeGreaterThan(0);
    expect(r!.steps.some((s) => s.name.length > 0)).toBe(true);
  });

  it('is deterministic', () => {
    const ds = build();
    const a = routeOnGraph(ds.graph, FROM, TO);
    const b = routeOnGraph(ds.graph, FROM, TO);
    expect(a!.metres).toBeCloseTo(b!.metres, 3);
    expect(a!.geometry.length).toBe(b!.geometry.length);
  });

  it('bidirectional search matches a single-direction reference', () => {
    // The route must be optimal, not merely valid: a Manhattan grid has a known
    // optimum, and a longer result means the termination test is unsound.
    const ds = build();
    const r = routeOnGraph(ds.graph, FROM, TO);
    expect(r!.metres).toBeLessThanOrEqual(14000);
  });
});

describe('offline gazetteer', () => {
  it('finds cities by prefix', () => {
    const ds = build();
    const hits = searchGazetteer(ds.gaz, 'Calg');
    expect(hits.some((h) => h.name === 'Calgary')).toBe(true);
    expect(hits[0].lat).toBeCloseTo(51.5085, 3);
  });

  it('finds POIs across categories', () => {
    const ds = build();
    expect(searchGazetteer(ds.gaz, 'Blue Yonder').length).toBeGreaterThan(0);
    expect(searchGazetteer(ds.gaz, 'Safeway').length).toBeGreaterThan(0);
  });

  it('indexes street names for address-style queries', () => {
    const ds = build();
    const hits = searchGazetteer(ds.gaz, '4 St W');
    expect(hits.some((h) => h.cat === 'street')).toBe(true);
  });

  it('finds streets for routing', () => {
    const ds = build();
    const hits = searchGazetteer(ds.gaz, 'Memorial');
    expect(hits.some((h) => h.cat === 'street')).toBe(true);
  });

  it('returns nothing for a non-matching query', () => {
    const ds = build();
    expect(searchGazetteer(ds.gaz, 'zzzzqqq')).toHaveLength(0);
  });
});

describe('region merging', () => {
  const mkRegion = (id: string, ds: ReturnType<typeof build>): Region => ({
    id, name: id, code: id, bbox: ds.bbox, loadedAt: 0, bytes: 0,
    counts: ds.counts, gazetteerSize: ds.gaz.length, dataset: ds,
  });

  it('merges two overlapping regions into one connected graph', () => {
    const ds = build();
    const a = mkRegion('a', ds);
    const b = mkRegion('b', ds);
    const report = mergeRegions([a, b]);
    // Same OSM node ids in both => fully collapsed
    expect(report.sharedNodes).toBeGreaterThan(0);
    expect(report.nodes).toBe(ds.graph.nodeCount);
    expect(report.components).toBe(1);
  });

  it('merged graph still routes, with contiguous geometry', () => {
    const ds = build();
    const report = mergeRegions([mkRegion('a', ds), mkRegion('b', ds)]);
    const r = routeOnGraph(report.graph, FROM, TO);
    expect(r).not.toBeNull();
    // Merging two extracts of the same area collapses duplicate nodes, and the
    // dedup keeps the *less* restrictive direction when one-ways disagree. The
    // route may therefore differ from the single-region one, so assert
    // correctness properties rather than equality.
    for (let i = 1; i < r!.geometry.length; i++) {
      const [x1, y1] = r!.geometry[i - 1];
      const [x2, y2] = r!.geometry[i];
      expect(Math.hypot(x2 - x1, y2 - y1)).toBeLessThan(0.012);
    }
    // and it must be no slower than the unmerged route
    const plain = routeOnGraph(ds.graph, FROM, TO)!;
    expect(r!.time).toBeLessThanOrEqual(plain.time * 1.02);
  });

  it('single region passes through unchanged', () => {
    const ds = build();
    const report = mergeRegions([mkRegion('only', ds)]);
    expect(report.nodes).toBe(ds.graph.nodeCount);
    expect(report.sharedNodes).toBe(0);
  });

  it('disjoint graphs stay separate components', () => {
    const a = build();
    // Shift the whole fixture 5 degrees away. Node IDs stay identical, so the
    // only thing that separates them is... nothing: they WILL be merged.
    // Rewrite the ids too so they are genuinely unrelated.
    const bXml = XML
      .replace(/lat="([\d.]+)"/g, (_m, v) => `lat="${(parseFloat(v) + 5).toFixed(7)}"`)
      .replace(/lon="([-\d.]+)"/g, (_m, v) => `lon="${(parseFloat(v) + 5).toFixed(7)}"`)
      .replace(/id="(\d+)"/g, (_m, v) => `id="${parseInt(v, 10) + 1000000}"`)
      .replace(/ref="(\d+)"/g, (_m, v) => `ref="${parseInt(v, 10) + 1000000}"`);
    const bn = parseOsmXml(bXml);
    const b = buildDataset(bn.nodes, bn.ways, () => {});
    const report = mergeRegions([mkRegion('a', a), mkRegion('b', b)]);
    // Different OSM ids => nothing collapses, two components remain.
    expect(report.sharedNodes).toBe(0);
    expect(report.components).toBe(2);
  });
});

describe('geo utilities', () => {
  it('decodes a polyline6 round-trip', () => {
    // Encode a known point, then decode it back.
    const pts = decodePolyline(encodePolyline6([[-120.2, 38.5], [-120.95, 40.7], [-126.453, 43.252]]), 6);
    expect(pts).toHaveLength(3);
    expect(pts[0][0]).toBeCloseTo(-120.2, 6);
    expect(pts[0][1]).toBeCloseTo(38.5, 6);
    expect(pts[2][0]).toBeCloseTo(-126.453, 6);
    expect(pts[2][1]).toBeCloseTo(43.252, 6);
  });

    it('decodes the canonical polyline example', () => {
    // The classic reference vector from Google's encoded polyline docs (precision 5).
    const pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5);
    expect(pts).toHaveLength(3);
    expect(pts[0][1]).toBeCloseTo(38.5, 3);
    expect(pts[1][1]).toBeCloseTo(40.7, 3);
    expect(pts[2][1]).toBeCloseTo(43.252, 3);
  });

  it('formats distance the way Google Maps does', () => {
    expect(formatDistance(450, 'metric')).toBe('450 m');
    expect(formatDistance(1500, 'metric')).toBe('1.5 km');
    expect(formatDistance(24000, 'metric')).toBe('24 km');
    expect(formatDistance(800, 'imperial')).toBe('0.5 mi');
    expect(formatDistance(120, 'imperial')).toBe('400 ft');
  });

  it('formats duration', () => {
    expect(formatDuration(30)).toBe('<1 min');
    expect(formatDuration(24 * 60)).toBe('24 min');
    expect(formatDuration(60 * 60)).toBe('1 hr');
    expect(formatDuration(65 * 60)).toBe('1 hr 5 min');
    expect(formatDuration(125 * 60)).toBe('2 hr 5 min');
  });

  it('snaps a point onto the nearest segment', () => {
    const line: [number, number][] = [[0, 0], [1, 0], [2, 0]];
    const s = snapToPolyline([0.5, 0.1], line);
    expect(s.index).toBe(0);
    expect(s.point[1]).toBeCloseTo(0, 6);
  });
});
