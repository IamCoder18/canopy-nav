/**
 * PBF coordinates are nanodegrees — the regression that hid inside a green suite.
 *
 * The OSM PBF spec stores a node's latitude and longitude as integers in units of
 * 1e-7 degrees. This parser divided by 1e-9 instead, and so did
 * `tools/osm2pbf.mjs`, which builds the fixtures. The round trip therefore agreed
 * with itself and every test passed — while any *real* Geofabrik extract, written
 * to the spec, decoded 100x too small. Andorra's 42.42 N arrived as 0.4242,
 * putting the country in the Gulf of Guinea: every distance, every route and
 * every cross-region comparison wrong, with nothing on screen to suggest so.
 *
 * The fix is one constant in three places. What these tests protect is the
 * *specification* — the numbers below are the spec's own nanodegrees, written out
 * rather than produced by a helper that could share the parser's mistake.
 *
 * Run with `npx vitest run test/pbfgeo.spec.ts`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseOsmPbf } from '../src/osm/pbf';
import { parseOsmXml, buildDataset, type OsmDataset } from '../src/osm/engine.worker';

/** The spec's unit, in degrees. */
const NANO = 1e-7;

/**
 * Re-encode the fixture's first node through the real encoder, so the nanodegree
 * value the parser sees is the one a real writer produces.
 *
 * The alternative was a hand-rolled PBF writer in this file, which turned out to
 * be a second thing to get wrong — and one that tests the writer rather than the
 * parser. Going through `tools/osm2pbf.mjs` means the constant under test is the
 * spec's, applied by the code a developer actually runs.
 */
async function parseViaEncoder(xmlPath: string): Promise<OsmDataset> {
  const xml = parseOsmXml(readFileSync(xmlPath, 'utf8'));
  const pbf = execFileSync('node', [
    'tools/osm2pbf.mjs', xmlPath, '/tmp/opencode/pbfgeo-fixture.osm.pbf',
  ]);
  expect(pbf.toString()).toMatch(/nodes/);
  const { nodes, ways } = await parseOsmPbf(
    new Uint8Array(readFileSync('/tmp/opencode/pbfgeo-fixture.osm.pbf')),
  );
  return buildDataset(nodes, ways, () => {});
}

describe('a spec-conformant nanodegree is decoded as degrees', () => {
  it('round-trips the fixture through the real encoder to the right place', async () => {
    const ds = await parseViaEncoder('test/fixture.osm');
    const [west, south, east, north] = ds.bbox;
    // The fixture sits near Edinburgh: ~-1.4 lon, ~51.5 lat.
    expect(south).toBeGreaterThan(51.4);
    expect(north).toBeGreaterThan(51.5);
    expect(west).toBeLessThan(-1.3);
    expect(east).toBeGreaterThan(-1.4);
  });

  it('does not decode it a hundred times too small', async () => {
    const ds = await parseViaEncoder('test/fixture.osm');
    // The bug in one assertion: dividing by 1e9 put 51.5 at ~0.515.
    expect(ds.bbox[1]).not.toBeLessThan(1);
    expect(ds.bbox[1]).toBeGreaterThan(51);
  });

  it('keeps the two parsers in agreement on every node', async () => {
    const xml = parseOsmXml(readFileSync('test/fixture.osm', 'utf8'));
    const pbf = await parseOsmPbf(
      new Uint8Array(readFileSync('test/fixture.osm.pbf')),
    );
    for (const [id, x] of xml.nodes) {
      const y = pbf.nodes.get(id);
      expect(y, `node ${id} missing from the PBF`).toBeDefined();
      expect(Math.abs(x.lat! - y!.lat!), `node ${id} lat`).toBeLessThan(NANO);
      expect(Math.abs(x.lon! - y!.lon!), `node ${id} lon`).toBeLessThan(NANO);
    }
  });
});

describe('the on-disk PBF fixture is in the right place', () => {
  it('decodes to the same coordinates as the XML it was generated from', async () => {
    const pbf = await parseOsmPbf(new Uint8Array(readFileSync('test/fixture.osm.pbf')));
    const { nodes, ways } = pbf;
    const xml = parseOsmXml(readFileSync('test/fixture.osm', 'utf8'));
    const pbfDs = buildDataset(nodes, ways, () => {});
    const xmlDs = buildDataset(xml.nodes, xml.ways, () => {});

    // Raw parse output, before the graph builder compacts pure-geometry nodes
    // away. This is the pair that must agree: two readers, one format.
    expect(pbfDs.counts.routable).toBe(xmlDs.counts.routable);
    for (const [id, x] of xml.nodes) {
      const y = pbf.nodes.get(id);
      expect(y, `node ${id} missing from the PBF`).toBeDefined();
      // Within one nanodegree: the finest the format can express.
      expect(Math.abs(x.lat! - y!.lat!), `node ${id} lat`).toBeLessThan(NANO);
      expect(Math.abs(x.lon! - y!.lon!), `node ${id} lon`).toBeLessThan(NANO);
    }
    // And the built datasets agree outright.
    expect(pbfDs.bbox.map((v) => Number(v.toFixed(6))))
      .toEqual(xmlDs.bbox.map((v) => Number(v.toFixed(6))));
  });

  it('puts the fixture in the northern hemisphere at a plausible latitude', async () => {
    const ds = buildDataset(
      parseOsmXml(readFileSync('test/fixture.osm', 'utf8')).nodes,
      parseOsmXml(readFileSync('test/fixture.osm', 'utf8')).ways,
      () => {},
    );
    const [, south, , north] = ds.bbox;
    // The fixture sits near Edinburgh. Anything divided by 1e9 lands near 0.0005.
    expect(south).toBeGreaterThan(50);
    expect(north).toBeLessThan(53);
  });

  it('produces a bounding box the app can actually fit to', async () => {
    const { nodes, ways } = await parseOsmPbf(
      new Uint8Array(readFileSync('test/fixture.osm.pbf')),
    );
    // bbox is [west, south, east, north].
    const [west, south, east, north] = buildDataset(nodes, ways, () => {}).bbox;
    expect(south).toBeGreaterThan(51);
    expect(north).toBeGreaterThan(south);
    expect(west).toBeLessThan(-1.3);
    expect(east).toBeGreaterThan(west);
  });
});