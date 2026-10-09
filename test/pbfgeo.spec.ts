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
import { readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOsmPbf } from '../src/osm/pbf';
import { parseOsmXml, buildDataset, type OsmDataset } from '../src/osm/engine.worker';

/** The spec's unit, in degrees. */
const NANO = 1e-7;
/**
 * Resolve a fixture against this file's own directory.
 *
 * The rest of the suite opens fixtures with relative paths, which works because
 * vitest runs from the repo root. This spec also shells out to a child process,
 * and CI does not guarantee that working directory -- it failed there with
 * ENOENT on a path that plainly exists. Anchoring to `import.meta.url` makes it
 * independent of where the runner started.
 */
const fixture = (name: string): string =>
  resolve(dirname(fileURLToPath(import.meta.url)), name);

/**
 * Re-encode the fixture's first node through the real encoder, so the nanodegree
 * value the parser sees is the one a real writer produces.
 *
 * The alternative was a hand-rolled PBF writer in this file, which turned out to
 * be a second thing to get wrong — and one that tests the writer rather than the
 * parser. Going through `tools/osm2pbf.mjs` means the constant under test is the
 * spec's, applied by the code a developer actually runs.
 */
async function parseViaEncoder(xmlName: string): Promise<OsmDataset> {
  const xmlFile = fixture(xmlName);
  // A unique path per run so parallel workers cannot collide, and inside the OS
  // temp dir rather than a hardcoded one -- `/tmp/opencode/...` exists only on
  // the machine that wrote it, which is why CI failed with ENOENT.
  const out = join(
    tmpdir(),
    `pbfgeo-${process.pid}-${Date.now()}.osm.pbf`,
  );
  try {
    // cwd and absolute paths: the encoder is run as a child process, so it
    // inherits the runner's working directory, which is not guaranteed to be the
    // repo root.
    const encoder = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'osm2pbf.mjs');
    const pbf = execFileSync('node', [encoder, xmlFile, out], { cwd: process.cwd() });
    expect(pbf.toString()).toMatch(/nodes/);
    const { nodes, ways } = await parseOsmPbf(new Uint8Array(readFileSync(out)));
    return buildDataset(nodes, ways, () => {});
  } finally {
    rmSync(out, { force: true });
  }
}

describe('a spec-conformant nanodegree is decoded as degrees', () => {
  it('round-trips the fixture through the real encoder to the right place', async () => {
    const ds = await parseViaEncoder('fixture.osm');
    const [west, south, east, north] = ds.bbox;
    // The fixture sits near Edinburgh: ~-1.4 lon, ~51.5 lat.
    expect(south).toBeGreaterThan(51.4);
    expect(north).toBeGreaterThan(51.5);
    expect(west).toBeLessThan(-1.3);
    expect(east).toBeGreaterThan(-1.4);
  });

  it('does not decode it a hundred times too small', async () => {
    const ds = await parseViaEncoder('fixture.osm');
    // The bug in one assertion: dividing by 1e9 put 51.5 at ~0.515.
    expect(ds.bbox[1]).not.toBeLessThan(1);
    expect(ds.bbox[1]).toBeGreaterThan(51);
  });

  it('keeps the two parsers in agreement on every node', async () => {
    const xml = parseOsmXml(readFileSync(fixture('fixture.osm'), 'utf8'));
    const pbf = await parseOsmPbf(
      new Uint8Array(readFileSync(fixture('fixture.osm.pbf'))),
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
    const pbf = await parseOsmPbf(new Uint8Array(readFileSync(fixture('fixture.osm.pbf'))));
    const { nodes, ways } = pbf;
    const xml = parseOsmXml(readFileSync(fixture('fixture.osm'), 'utf8'));

    // Snapshot the coordinates *before* building.
    //
    // `buildDataset` consumes its inputs — it clears the node map, because the
    // boxed `RawNode` map is the largest object in a parse and nothing needs it
    // once the graph exists. Comparing afterwards iterated an empty map, so every
    // assertion below passed without executing once. A test that cannot fail is
    // worse than no test because it is counted, which is the defect class this
    // project has now hit three times.
    const want = [...xml.nodes.values()].map((n) => [n.id, n.lat, n.lon] as const);
    const got = new Map(pbf.nodes);
    expect(want.length, 'the fixture actually has nodes to compare').toBeGreaterThan(10);

    const pbfDs = buildDataset(nodes, ways, () => {});
    const xmlDs = buildDataset(xml.nodes, xml.ways, () => {});

    // Raw parse output, before the graph builder compacts pure-geometry nodes
    // away. This is the pair that must agree: two readers, one format.
    expect(pbfDs.counts.routable).toBe(xmlDs.counts.routable);
    for (const [id, lat, lon] of want) {
      const y = got.get(id);
      expect(y, `node ${id} missing from the PBF`).toBeDefined();
      // Within one nanodegree: the finest the format can express.
      expect(Math.abs(lat - y!.lat), `node ${id} lat`).toBeLessThan(NANO);
      expect(Math.abs(lon - y!.lon), `node ${id} lon`).toBeLessThan(NANO);
    }
    // And the built datasets agree outright.
    expect(pbfDs.bbox.map((v) => Number(v.toFixed(6))))
      .toEqual(xmlDs.bbox.map((v) => Number(v.toFixed(6))));
  });

  it('puts the fixture in the northern hemisphere at a plausible latitude', async () => {
    const ds = buildDataset(
      parseOsmXml(readFileSync(fixture('fixture.osm'), 'utf8')).nodes,
      parseOsmXml(readFileSync(fixture('fixture.osm'), 'utf8')).ways,
      () => {},
    );
    const [, south, , north] = ds.bbox;
    // The fixture sits near Edinburgh. Anything divided by 1e9 lands near 0.0005.
    expect(south).toBeGreaterThan(50);
    expect(north).toBeLessThan(53);
  });

  it('produces a bounding box the app can actually fit to', async () => {
    const { nodes, ways } = await parseOsmPbf(
      new Uint8Array(readFileSync(fixture('fixture.osm.pbf'))),
    );
    // bbox is [west, south, east, north].
    const [west, south, east, north] = buildDataset(nodes, ways, () => {}).bbox;
    expect(south).toBeGreaterThan(51);
    expect(north).toBeGreaterThan(south);
    expect(west).toBeLessThan(-1.3);
    expect(east).toBeGreaterThan(west);
  });
});