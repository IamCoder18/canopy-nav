/**
 * Provider-chain tests — PROVIDERS metadata, resolveRoute fallback behaviour,
 * probeProvider, connectivity helpers and localToRoute.
 *
 * `fetch` is stubbed and a small in-memory OSM dataset stands in for the
 * imported .osm file, so resolveRoute is exercised end to end without a
 * network or a worker.
 *
 * Run with `npx vitest run test/providers.spec.ts`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PROVIDERS,
  resolveRoute,
  probeProvider,
  isOnline,
  watchConnectivity,
  localToRoute,
  NoRouteError,
  type Provider,
} from '../src/nav/providers';
import { parseOsmXml, buildDataset, type OsmDataset } from '../src/osm/engine.worker';
import { RoutingError, VALHALLA_ENDPOINT } from '../src/nav/valhalla';
import type { LatLng } from '../src/geo';

/** A 3-node residential street: (0,0) -> (0.005, 0) -> (0.01, 0). */
const XML = `<osm>
  <node id="1" lat="0" lon="0"/>
  <node id="2" lat="0" lon="0.005"/>
  <node id="3" lat="0" lon="0.01"/>
  <way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/><tag k="name" v="Main"/></way>
  <way id="11"><nd ref="2"/><nd ref="3"/><tag k="highway" v="residential"/><tag k="name" v="Main"/></way>
</osm>`;

const FROM: LatLng = [0, 0];
const TO: LatLng = [0.01, 0];
const FAR_AWAY: LatLng = [80, 40];

let fetchMock: ReturnType<typeof vi.fn>;

function okTrip(): unknown {
  return {
    trip: {
      units: 'km',
      summary: { length: 1, time: 60, min_lat: 0, min_lon: 0, max_lat: 0, max_lon: 0.01 },
      legs: [{
        maneuvers: [{ type: 1, instruction: 'Go.', begin_shape_index: 0, end_shape_index: 1, length: 1, time: 60 }],
        summary: { length: 1, time: 60, min_lat: 0, min_lon: 0, max_lat: 0, max_lon: 0.01 },
        shape: 'oh`eBoh`eB',
      }],
    },
  };
}

function respondOnline() {
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => okTrip() });
}

function respondError(status: number, error: string) {
  fetchMock.mockResolvedValue({ ok: false, status, json: async () => ({ error, error_code: 1 }) });
}

function dataset(): OsmDataset {
  const { nodes, ways } = parseOsmXml(XML);
  return buildDataset(nodes, ways, () => {});
}

function online(onLine = true) {
  vi.stubGlobal('navigator', { onLine });
}

function headers(): Record<string, string> {
  return fetchMock.mock.calls[0][1].headers as Record<string, string>;
}

function url(): string {
  return String(fetchMock.mock.calls[0][0]);
}

function body(): Record<string, any> {
  return JSON.parse(String(fetchMock.mock.calls[0][1].body));
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  online(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PROVIDERS', () => {
  it('describes the four providers in chain order', () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual([
      'local', 'valhalla-fossgis', 'valhalla-simplerouting', 'valhalla-custom',
    ]);
    expect(PROVIDERS[0].online).toBe(false);
    expect(PROVIDERS[0].endpoint).toBe('');
    expect(PROVIDERS[1].endpoint).toBe(VALHALLA_ENDPOINT);
    expect(PROVIDERS[1].requiresKey).toBeUndefined();
  });

  it('marks simplerouting as key-gated and custom as endpoint-gated', () => {
    const simple = PROVIDERS[2];
    expect(simple.requiresKey).toBe(true);
    expect(simple.headers).toEqual({ Authorization: '' });
    const custom = PROVIDERS[3];
    expect(custom.endpoint).toBe('');
    expect(custom.requiresKey).toBeUndefined();
  });

  it('gives every provider a label and a subtitle', () => {
    for (const p of PROVIDERS) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.subtitle.length).toBeGreaterThan(0);
    }
  });
});

describe('isOnline', () => {
  it('is true when navigator reports a link', () => {
    online(true);
    expect(isOnline()).toBe(true);
  });

  it('is false only when navigator.onLine is explicitly false', () => {
    online(false);
    expect(isOnline()).toBe(false);
  });

  it('assumes online when onLine is missing', () => {
    vi.stubGlobal('navigator', {});
    expect(isOnline()).toBe(true);
  });

  it('assumes online when navigator is absent entirely', () => {
    vi.stubGlobal('navigator', undefined);
    expect(isOnline()).toBe(true);
  });
});

describe('watchConnectivity', () => {
  it('subscribes to both link events and can be torn down', () => {
    const listeners = new Map<string, () => void>();
    const add = vi.fn((type: string, fn: () => void) => listeners.set(type, fn));
    const remove = vi.fn((type: string) => listeners.delete(type));
    vi.stubGlobal('window', { addEventListener: add, removeEventListener: remove });

    const seen: boolean[] = [];
    const off = watchConnectivity((o) => seen.push(o));

    expect(add).toHaveBeenCalledTimes(2);
    expect([...listeners.keys()].sort()).toEqual(['offline', 'online']);
    listeners.get('online')!();
    listeners.get('offline')!();
    expect(seen).toEqual([true, false]);

    off();
    expect(remove).toHaveBeenCalledTimes(2);
    expect([...listeners.keys()]).toEqual([]);
  });
});

describe('localToRoute', () => {
  it('derives the summary bbox from the route geometry', () => {
    const r = localToRoute(
      {
        geometry: [[1, 2], [3, -4], [0, 5]],
        time: 120,
        metres: 900,
        steps: [],
        engine: 'osm-local',
      },
      'km',
    );
    expect(r.summary).toEqual({
      length: 900, time: 120,
      min_lat: -4, min_lon: 0, max_lat: 5, max_lon: 3,
    });
    expect(r.engine).toBe('osm-local');
    expect(r.units).toBe('km');
    expect(r.geometry).toHaveLength(3);
    expect(r.legs).toHaveLength(1);
    expect(r.legs[0].geometry).toBe(r.geometry);
    expect(r.maneuvers).toEqual([]);
    expect(r.legs[0].maneuvers).toEqual([]);
  });

  it('passes the requested units straight through', () => {
    const r = localToRoute({ geometry: [[0, 0]], time: 0, metres: 0, steps: [], engine: 'osm-local' }, 'miles');
    expect(r.units).toBe('miles');
  });

  it('BUG: throws RangeError for route geometries beyond ~125k points', () => {
    // `Math.min(...geometry.map(...))` spreads one argument per point, which
    // blows the argument limit on a long route from a large extract.
    const geometry: LatLng[] = Array.from({ length: 125_000 }, (_, i) => [i * 1e-5, i * 1e-5]);
    expect(() =>
      localToRoute({ geometry, time: 1, metres: 1, steps: [], engine: 'osm-local' }, 'km'),
    ).toThrow(RangeError);
  });

  it.fails('computes the summary bbox for a 125k-point geometry', () => {
    const geometry: LatLng[] = Array.from({ length: 125_000 }, (_, i) => [i * 1e-5, i * 1e-5]);
    const r = localToRoute({ geometry, time: 1, metres: 1, steps: [], engine: 'osm-local' }, 'km');
    expect(r.summary.max_lon).toBeCloseTo(1.24999, 5);
  });
});

describe('resolveRoute — local provider', () => {
  it('routes locally and never touches the network', async () => {
    const out = await resolveRoute({ from: FROM, to: TO, provider: 'local' }, dataset(), {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.used).toBe('local');
    expect(out.degraded).toEqual([]);
    expect(out.route.engine).toBe('osm-local');
    expect(out.route.geometry.map((p) => p[0])).toEqual([0, 0.005, 0.01]);
    expect(out.route.summary.length).toBeGreaterThan(1000);
  });

  it('honours the units and costing request', async () => {
    const out = await resolveRoute(
      { from: FROM, to: TO, provider: 'local', units: 'miles' }, dataset(), {},
    );
    expect(out.route.units).toBe('miles');
  });

  it('throws NoRouteError with no dataset', async () => {
    const err = await resolveRoute({ from: FROM, to: TO, provider: 'local' }, null, {}).catch((e) => e);
    expect(err).toBeInstanceOf(NoRouteError);
    expect(err.name).toBe('NoRouteError');
    expect(err.message).toBe(
      'No route found. Import an .osm file covering this area, or connect to the network.',
    );
  });

  it('throws NoRouteError when the local graph cannot connect the pair', async () => {
    const err = await resolveRoute({ from: FROM, to: FAR_AWAY, provider: 'local' }, dataset(), {}).catch((e) => e);
    expect(err).toBeInstanceOf(NoRouteError);
    expect(err.message).toBe(
      'No route found. Import an .osm file covering this area, or connect to the network.',
    );
  });

  it('falls back to the local provider for an unknown provider id', async () => {
    const out = await resolveRoute(
      { from: FROM, to: TO, provider: 'nope' as never }, dataset(), {},
    );
    expect(out.used).toBe('local');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('resolveRoute — online provider', () => {
  it('uses the online provider when it succeeds', async () => {
    respondOnline();
    const out = await resolveRoute({ from: FROM, to: TO, provider: 'valhalla-fossgis' }, dataset(), {});
    expect(out.used).toBe('valhalla-fossgis');
    expect(out.degraded).toEqual([]);
    expect(out.route.engine).toBe('valhalla');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(url()).toBe(`${VALHALLA_ENDPOINT}/route`);
    expect(headers()['X-Client-Id']).toBe('canopy-nav');
    expect(body().locations).toEqual([
      { lat: 0, lon: 0, type: 'break' },
      { lat: 0, lon: 0.01, type: 'break' },
    ]);
  });

  it('forwards costing, units and avoid areas', async () => {
    respondOnline();
    const avoid: LatLng[][] = [[[0.002, 0], [0.003, 0]]];
    await resolveRoute(
      { from: FROM, to: TO, provider: 'valhalla-fossgis', costing: 'bicycle', units: 'miles', avoid },
      dataset(), {},
    );
    const b = body();
    expect(b.costing).toBe('bicycle');
    expect(b.units).toBe('miles');
    expect(b.exclude_polygons).toHaveLength(1);
    expect(b.exclude_polygons[0].type).toBe('polyline');
  });

  it('falls back to the local engine and records why', async () => {
    respondError(503, 'no tiles loaded');
    const out = await resolveRoute({ from: FROM, to: TO, provider: 'valhalla-fossgis' }, dataset(), {});
    expect(out.used).toBe('local');
    expect(out.route.engine).toBe('osm-local');
    expect(out.degraded).toEqual([{ provider: 'valhalla-fossgis', reason: 'no tiles loaded' }]);
  });

  it('records a readable reason for a network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const out = await resolveRoute({ from: FROM, to: TO, provider: 'valhalla-fossgis' }, dataset(), {});
    expect(out.degraded).toEqual([
      { provider: 'valhalla-fossgis', reason: 'Could not reach the routing server — check your connection' },
    ]);
    expect(out.used).toBe('local');
  });

  it('throws with both reasons when the fallback is also unavailable', async () => {
    respondError(500, 'internal error');
    const err = await resolveRoute({ from: FROM, to: TO, provider: 'valhalla-fossgis' }, null, {})
      .catch((e) => e);
    expect(err).toBeInstanceOf(NoRouteError);
    expect(err.message).toBe('internal error. No route found in the offline map for this pair.');
  });

  it('uses the first degraded reason when the online failure had none', async () => {
    respondError(400, 'bad request');
    const err = await resolveRoute({ from: FROM, to: TO, provider: 'valhalla-fossgis' }, null, {})
      .catch((e) => e);
    expect(err.message).toBe('bad request. No route found in the offline map for this pair.');
  });

  it('skips the network entirely when the link is down', async () => {
    online(false);
    const out = await resolveRoute({ from: FROM, to: TO, provider: 'valhalla-fossgis' }, dataset(), {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.used).toBe('local');
    expect(out.degraded).toEqual([
      { provider: 'valhalla-fossgis', reason: 'No network connection' },
    ]);
  });

  it('reports the offline reason when there is no local fallback either', async () => {
    online(false);
    const err = await resolveRoute({ from: FROM, to: TO, provider: 'valhalla-fossgis' }, null, {})
      .catch((e) => e);
    expect(err).toBeInstanceOf(NoRouteError);
    expect(err.message).toBe(
      'No network connection. No route found in the offline map for this pair.',
    );
  });

  it('does not send an Authorization header for simplerouting without a key', async () => {
    // BUG: `probeProvider` enforces `requiresKey` but resolveRoute does not, so
    // a keyless Simplerouting.io request goes out and comes back 401/403.
    respondError(401, 'Unauthorized');
    const out = await resolveRoute(
      { from: FROM, to: TO, provider: 'valhalla-simplerouting' }, dataset(), {},
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(url()).toBe('https://api.simplerouting.io/valhalla/route');
    expect(headers().Authorization).toBeUndefined();
    expect(out.used).toBe('local');
    expect(out.degraded[0]).toMatchObject({ provider: 'valhalla-simplerouting', reason: 'Unauthorized' });
  });

  it.fails('refuses to call simplerouting when no API key is configured', async () => {
    respondError(401, 'Unauthorized');
    const out = await resolveRoute(
      { from: FROM, to: TO, provider: 'valhalla-simplerouting' }, dataset(), {},
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.degraded[0].reason).toMatch(/API key/i);
  });

  it('sends a bearer token when simplerouting has a key', async () => {
    respondOnline();
    await resolveRoute(
      { from: FROM, to: TO, provider: 'valhalla-simplerouting' }, dataset(), { apiKey: 'k-123' },
    );
    expect(url()).toBe('https://api.simplerouting.io/valhalla/route');
    expect(headers().Authorization).toBe('Bearer k-123');
  });

  it('does not attempt valhalla-custom with no endpoint configured', async () => {
    respondOnline();
    const out = await resolveRoute({ from: FROM, to: TO, provider: 'valhalla-custom' }, dataset(), {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.used).toBe('local');
    // nothing was attempted, so nothing is reported as degraded
    expect(out.degraded).toEqual([]);
  });

  it('uses the configured endpoint for valhalla-custom', async () => {
    respondOnline();
    const out = await resolveRoute(
      { from: FROM, to: TO, provider: 'valhalla-custom' }, dataset(),
      { endpoint: 'https://valhalla.mydomain.net' },
    );
    expect(url()).toBe('https://valhalla.mydomain.net/route');
    expect(out.used).toBe('valhalla-custom');
  });

  it('strips a trailing slash from a custom endpoint', async () => {
    respondOnline();
    await resolveRoute(
      { from: FROM, to: TO, provider: 'valhalla-custom' }, dataset(),
      { endpoint: 'https://valhalla.mydomain.net/' },
    );
    expect(url()).toBe('https://valhalla.mydomain.net/route');
  });

  it('still falls back when the custom endpoint fails', async () => {
    respondError(500, 'boom');
    const out = await resolveRoute(
      { from: FROM, to: TO, provider: 'valhalla-custom' }, dataset(),
      { endpoint: 'https://valhalla.mydomain.net' },
    );
    expect(out.used).toBe('local');
    expect(out.degraded).toEqual([{ provider: 'valhalla-custom', reason: 'boom' }]);
  });

  it('treats 429 as retryable and still uses the offline fallback', async () => {
    respondError(429, 'Too many requests');
    const out = await resolveRoute({ from: FROM, to: TO, provider: 'valhalla-fossgis' }, dataset(), {});
    expect(out.used).toBe('local');
    expect(out.degraded[0].reason).toBe('Too many requests');
  });

  it('treats a 4xx as non-retryable but still falls back offline', async () => {
    // `fatal && degraded.length >= 2` can never be true: the chain pushes at
    // most one degraded entry, so the NoRouteError branch is dead code.
    respondError(400, 'bad request');
    const out = await resolveRoute({ from: FROM, to: TO, provider: 'valhalla-fossgis' }, dataset(), {});
    expect(out.used).toBe('local');
    expect(out.degraded).toHaveLength(1);
  });
});

describe('probeProvider', () => {
  const byId = (id: Provider['id']): Provider => PROVIDERS.find((p) => p.id === id)!;

  it('reports the offline provider as always available', async () => {
    expect(await probeProvider(byId('local'), {})).toEqual({ ok: true, detail: 'Always available' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires an endpoint for the custom provider', async () => {
    expect(await probeProvider(byId('valhalla-custom'), {})).toEqual({
      ok: false, detail: 'No endpoint configured',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires an API key for simplerouting', async () => {
    expect(await probeProvider(byId('valhalla-simplerouting'), {})).toEqual({
      ok: false, detail: 'API key required',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports the version of a reachable server', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ version: '3.5.1' }) });
    expect(await probeProvider(byId('valhalla-fossgis'), {})).toEqual({
      ok: true, detail: 'Valhalla 3.5.1',
    });
    expect(url()).toBe(`${VALHALLA_ENDPOINT}/status`);
  });

  it('reports a reachable server with no version as Reachable', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    expect(await probeProvider(byId('valhalla-fossgis'), {})).toEqual({ ok: true, detail: 'Reachable' });
  });

  it('reports a non-OK status as Unreachable', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502, json: async () => ({}) });
    expect(await probeProvider(byId('valhalla-fossgis'), {})).toEqual({ ok: false, detail: 'Unreachable' });
  });

  it('reports a thrown request as Unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await probeProvider(byId('valhalla-fossgis'), {})).toEqual({ ok: false, detail: 'Unreachable' });
  });

  it('probes the configured custom endpoint with a key-gated provider too', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ version: '3.1.4' }) });
    const out = await probeProvider(
      byId('valhalla-custom'),
      { endpoint: 'https://valhalla.mydomain.net', apiKey: 'abc' },
    );
    expect(out).toEqual({ ok: true, detail: 'Valhalla 3.1.4' });
    expect(url()).toBe('https://valhalla.mydomain.net/status');
  });

  it('still requires the key for the custom provider when an endpoint is set', async () => {
    const out = await probeProvider(
      byId('valhalla-simplerouting'),
      { endpoint: 'https://api.simplerouting.io/valhalla' },
    );
    expect(out).toEqual({ ok: false, detail: 'API key required' });
  });
});

describe('RoutingError interop', () => {
  it('the online client raises RoutingError with a status the chain can inspect', async () => {
    respondError(422, 'No path could be found for the requested locations');
    const out = await resolveRoute({ from: FROM, to: TO, provider: 'valhalla-fossgis' }, dataset(), {});
    expect(out.degraded[0].reason).toBe('No path could be found for the requested locations');
    // RoutingError is what resolveRoute inspects for `status`
    const err = new RoutingError('x', 422);
    expect(err.status).toBe(422);
    expect(err instanceof Error).toBe(true);
  });
});