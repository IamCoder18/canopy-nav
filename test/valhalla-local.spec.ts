/**
 * The offline Valhalla engine — the real one, over the committed fixture pack.
 *
 * This is the integration test for `src/nav/valhalla-local/`: the WASM engine
 * (`ecc521/valhalla-wasm`'s Valhalla 3.x build) reading `test/fixture.valhalla.tar`
 * (built by `tools/build-pack.mjs` from the same `fixture.osm` the in-app graph
 * engine tests use). Everything here runs the code the app ships — the runtime,
 * the mount, the request builder, the response parser — with only the *host*
 * differing (in-process instead of a Worker, which the browser e2e covers).
 *
 * The parity test against `routeOnGraph` is the point of the fixture choice:
 * two independent engines over one map must drive the same streets, and a
 * disagreement here is exactly the kind of "plausible but wrong" this app has
 * been burned by before (STATUS §3.18).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { InProcessClient } from '../src/nav/valhalla-local/client';
import { loadNodeFactory } from '../src/nav/valhalla-local/node';
import { describeLocalFailure } from '../src/nav/valhalla-local/runtime';
import { arrayBufferSource, type PackSource } from '../src/nav/valhalla-local/tilesource';
import { parseTarIndex } from '../src/nav/valhalla-local/tar';
import { RoutingError, type Route, type LatLng } from '../src/nav/valhalla';
import { parseOsmXml, buildDataset, routeOnGraph } from '../src/osm/engine.worker';
import { partition } from './tarfixture';

const FIXTURE_PACK = join(__dirname, 'fixture.valhalla.tar');
const FIXTURE_OSM = join(__dirname, 'fixture.osm');

// [lon, lat] — the fixture grid's SW and NE corners.
const SW: LatLng = [-1.4, 51.5];
const NE: LatLng = [-1.3232, 51.506];
const OUTSIDE: LatLng = [0, 0];

const packBytes = () => new Uint8Array(readFileSync(FIXTURE_PACK));

/** A source that records how many reads reach storage, and of how many bytes. */
function counting(bytes: Uint8Array): PackSource & { reads: number } {
  const inner = arrayBufferSource(bytes);
  const stats = { reads: 0 };
  return {
    get entries() { return inner.entries; },
    read: (into, at) => {
      const n = inner.read(into, at);
      if (n > 0) stats.reads += 1;
      return n;
    },
    get reads() { return stats.reads; },
  };
}

let client: InProcessClient;

beforeAll(async () => {
  client = new InProcessClient({ loadFactory: loadNodeFactory });
  await client.mount('fixture', packBytes());
}, 60_000);

afterAll(() => {
  client?.dispose();
});

describe('offline Valhalla — routing over a pack', () => {
  it('mounts the fixture pack and reports itself ready', () => {
    expect(client.ready()).toBe(true);
    expect(client.regions()).toEqual(['fixture']);
  });

  it('routes the fixture grid corner to corner', async () => {
    const route = await client.route({ from: SW, to: NE, units: 'km' });
    expect(route.engine).toBe('valhalla-local');
    // The grid is 8 steps x ~800 m east and 6 x ~660 m north; the road distance
    // is around 6 km (measured 6.0) and nowhere near either extreme. Summary
    // lengths are metres whatever the request asked for (valhalla.ts converts
    // once, for every engine).
    expect(route.summary.length).toBeGreaterThan(4000);
    expect(route.summary.length).toBeLessThan(9000);
    expect(route.summary.time).toBeGreaterThan(60);
    expect(route.geometry.length).toBeGreaterThan(5);
    // The line starts at the start.
    expect(Math.abs(route.geometry[0][0] - SW[0])).toBeLessThan(0.01);
    expect(Math.abs(route.geometry[0][1] - SW[1])).toBeLessThan(0.01);
  });

  it('carries real maneuvers, arrival included', async () => {
    const route = await client.route({ from: SW, to: NE, units: 'km' });
    expect(route.maneuvers.length).toBeGreaterThanOrEqual(2);
    for (const m of route.maneuvers) {
      expect(typeof m.instruction).toBe('string');
      expect(m.instruction.length).toBeGreaterThan(0);
      expect(m.begin_shape_index).toBeGreaterThanOrEqual(0);
      expect(m.end_shape_index).toBeLessThan(route.geometry.length);
    }
    // The last maneuver ends where the geometry ends — the arrival, not a turn.
    const last = route.maneuvers[route.maneuvers.length - 1];
    expect(last.end_shape_index).toBe(route.geometry.length - 1);
    // Legs carry the same maneuvers the top level does.
    expect(route.legs[0].maneuvers.length).toBe(route.maneuvers.length);
  });

  it('reports units on the route but keeps lengths in metres', async () => {
    const km = await client.route({ from: SW, to: NE, units: 'km' });
    const miles = await client.route({ from: SW, to: NE, units: 'miles' });
    expect(km.units).toBe('km');
    expect(miles.units).toBe('miles');
    // Valhalla reports lengths in the requested units; `valhalla.ts` converts
    // to metres once, for every engine, so consumers never do the arithmetic.
    // Same trip, same metres, both times.
    expect(Math.abs(miles.summary.length - km.summary.length)).toBeLessThan(1);
    expect(km.summary.length).toBeGreaterThan(4000);
  });

  it('agrees with the in-app graph engine on the same map', async () => {
    const { nodes, ways } = parseOsmXml(readFileSync(FIXTURE_OSM, 'utf8'));
    const ds = buildDataset(nodes, ways, () => {});
    const local = routeOnGraph(ds.graph, SW, NE);
    expect(local).not.toBeNull();
    const valhalla = await client.route({ from: SW, to: NE, units: 'km' });
    // Two engines, two cost models; the *path* must still be the same drive.
    const drift = Math.abs(valhalla.summary.length - local!.metres) / local!.metres;
    expect(drift).toBeLessThan(0.25);
  });

  it('refuses a point outside the map with a sentence about the map', async () => {
    const err = await client.route({ from: OUTSIDE, to: [0.01, 0], units: 'km' })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RoutingError);
    expect((err as RoutingError).message).toMatch(/no road near|offline map/i);
    // The raw engine text rides along for the trace, never for the driver.
    expect((err as RoutingError).detail).toBeTruthy();
    expect((err as RoutingError).message).not.toMatch(/server/i);
  });

  it('is done with a region after unmount', async () => {
    const temp = new InProcessClient({ loadFactory: loadNodeFactory });
    await temp.mount('fixture', packBytes());
    expect(temp.ready()).toBe(true);
    temp.unmount('fixture');
    expect(temp.ready()).toBe(false);
    // Not ready means the providers layer never asks; when asked anyway, the
    // answer is an honest failure, not a crash or an empty route.
    const err = await temp.route({ from: SW, to: NE, units: 'km' }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RoutingError);
    temp.dispose();
  }, 60_000);
});

describe('offline Valhalla — packs partitioned from one build', () => {
  it('routes across the seam of two packs holding one build\'s tiles', async () => {
    const bytes = packBytes();
    const entries = parseTarIndex(
      (into, at) => {
        const n = Math.min(into.length, bytes.length - at);
        into.set(bytes.subarray(at, at + n));
        return n;
      },
      bytes.length,
    );
    const [packA, packB] = partition(entries, bytes, 2);
    expect(packA.length).toBeGreaterThan(0);
    expect(packB.length).toBeGreaterThan(0);

    const whole = await client.route({ from: SW, to: NE, units: 'km' });

    const split = new InProcessClient({ loadFactory: loadNodeFactory });
    await split.mount('west', packA);
    await split.mount('east', packB);
    expect(split.ready()).toBe(true);
    const across = await split.route({ from: SW, to: NE, units: 'km' });
    // Same tiles, same build: the answer must be *identical*, not merely close.
    expect(across.summary.length).toBe(whole.summary.length);
    expect(across.summary.time).toBe(whole.summary.time);
    split.dispose();
  }, 60_000);
});

describe('offline Valhalla — storage reads', () => {
  it('reads every tile at most once per eviction window, however much the search asks', async () => {
    const source = counting(packBytes());
    const temp = new InProcessClient({ loadFactory: loadNodeFactory });
    await temp.mountSource('fixture', source);
    const before = source.reads;
    expect(before).toBe(0);

    await temp.route({ from: SW, to: NE, units: 'km' });
    const afterCold = source.reads;
    const tiles = source.entries.length;
    // The whole-tile cache: one storage read per touched tile, not per chunk.
    expect(afterCold).toBeLessThanOrEqual(tiles);

    await temp.route({ from: SW, to: NE, units: 'km' });
    await temp.route({ from: [-1.38, 51.51], to: [-1.35, 51.53], units: 'km' });
    // Warm routes over cached tiles reach storage for nothing new unless the
    // search wanders into a tile it has not touched.
    expect(source.reads).toBeLessThanOrEqual(tiles);
    temp.dispose();
  }, 60_000);
});

describe('describeLocalFailure', () => {
  it('knows the codes this engine actually produces', () => {
    expect(describeLocalFailure(171, '')).toMatch(/no route found/i);
    expect(describeLocalFailure(442, '')).toMatch(/no road near/i);
    expect(describeLocalFailure(154, '')).toMatch(/longer than/i);
    expect(describeLocalFailure(161, '')).toMatch(/no road connects/i);
  });

  it('reads the raw text when there is no code', () => {
    expect(describeLocalFailure(null, 'No suitable edges near location'))
      .toMatch(/no road near/i);
    expect(describeLocalFailure(null, 'Path distance exceeds the max distance limit'))
      .toMatch(/too long/i);
    expect(describeLocalFailure(null, 'No path could be found for the input locations'))
      .toMatch(/no route found/i);
  });

  it('says something honest for text it does not know', () => {
    const msg = describeLocalFailure(null, 'some completely novel failure');
    expect(msg).toMatch(/offline/i);
    expect(msg).not.toMatch(/server/i);
  });
});

describe('route shape', () => {
  it('tags every parse of the engine that produced it', async () => {
    const route: Route = await client.route({ from: SW, to: NE, units: 'km' });
    expect(route.engine).toBe('valhalla-local');
    expect(route.units).toBe('km');
    expect(route.summary.min_lat).toBeLessThan(route.summary.max_lat);
  });
});
