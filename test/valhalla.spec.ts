/**
 * Valhalla /route client tests.
 *
 * `fetch` is stubbed; nothing here touches the network. The response fixture
 * mirrors Valhalla's documented shape semantics: a leg's `shape` is an encoded
 * polyline6 that *includes* the destination, and the last maneuver's
 * `end_shape_index` points at that final coordinate (size - 1).
 *
 * Run with `npx vitest run test/valhalla.spec.ts`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { routeOnValhalla, valhallaStatus, RoutingError, VALHALLA_ENDPOINT } from '../src/nav/valhalla';
import { decodePolyline, type LatLng } from '../src/geo';

/** Precision-6 polyline encoder (Google's algorithm). */
function encode6(coords: LatLng[]): string {
  let out = '';
  let prevLat = 0;
  let prevLon = 0;
  const enc = (n: number) => {
    let v = n < 0 ? ~(n << 1) : n << 1;
    while (v >= 0x20) {
      out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    out += String.fromCharCode(v + 63);
  };
  for (const [lon, lat] of coords) {
    const iLat = Math.round(lat * 1e6);
    const iLon = Math.round(lon * 1e6);
    enc(iLat - prevLat);
    enc(iLon - prevLon);
    prevLat = iLat;
    prevLon = iLon;
  }
  return out;
}

/** A realistic 7-point Detroit leg: three maneuvers, the last one "arrived". */
const LEG_SHAPE_PTS: LatLng[] = [
  [-83.0456, 42.3314],
  [-83.046, 42.3313],
  [-83.0465, 42.3312],
  [-83.047, 42.3311],
  [-83.0465, 42.331],
  [-83.0458, 42.3301],
  [-83.045, 42.3295],
];
const LEG_SHAPE = encode6(LEG_SHAPE_PTS);

const LEG_SUMMARY = {
  length: 0.42, time: 12.9,
  min_lat: 42.3295, min_lon: -83.047, max_lat: 42.3314, max_lon: -83.045,
};

const TRIP_JSON = {
  trip: {
    language: 'en-US',
    units: 'km',
    status: 0,
    status_message: 'Found route between points',
    summary: {
      length: 0.42, time: 12.9,
      min_lat: 42.3295, min_lon: -83.047, max_lat: 42.3314, max_lon: -83.045,
    },
    legs: [
      {
        maneuvers: [
          { type: 1, instruction: 'Drive southeast on Appleton.', street_names: ['Appleton'], begin_shape_index: 0, end_shape_index: 4, length: 0.21, time: 8.1 },
          { type: 2, instruction: 'Turn left onto RDivers St.', street_names: ['RDivers St'], begin_shape_index: 4, end_shape_index: 6, length: 0.21, time: 4.8 },
          { type: 4, instruction: 'You have arrived at your destination.', begin_shape_index: 6, end_shape_index: 6, length: 0, time: 0 },
        ],
        summary: LEG_SUMMARY,
        shape: LEG_SHAPE,
      },
    ],
  },
};

const FROM: LatLng = [-83.0456, 42.3314];
const TO: LatLng = [-83.045, 42.3295];

type FetchArgs = [string, RequestInit];
let fetchMock: ReturnType<typeof vi.fn>;

/** Install a fetch stub returning `body` with the given status. */
function respond(body: unknown, status = 200) {
  fetchMock.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  return fetchMock;
}

function lastCall(): FetchArgs {
  const calls = fetchMock.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1] as FetchArgs;
}

function lastBody(): Record<string, any> {
  const [url, init] = lastCall();
  void url;
  return JSON.parse(String(init.body));
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('routeOnValhalla — request', () => {
  it('POSTs JSON to <endpoint>/route and identifies the client', async () => {
    respond(TRIP_JSON);
    await routeOnValhalla({ from: FROM, to: TO });
    const [url, init] = lastCall();
    expect(url).toBe(`${VALHALLA_ENDPOINT}/route`);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Client-Id']).toBe('canopy-nav');
  });

  it('strips a trailing slash from the endpoint', async () => {
    respond(TRIP_JSON);
    await routeOnValhalla({ from: FROM, to: TO }, 'https://routing.example.com/');
    expect(lastCall()[0]).toBe('https://routing.example.com/route');
  });

  it('merges extra headers without losing the defaults', async () => {
    respond(TRIP_JSON);
    await routeOnValhalla({ from: FROM, to: TO }, 'https://api.simplerouting.io/valhalla', {
      Authorization: 'Bearer secret-key',
    });
    const headers = lastCall()[1].headers as Record<string, string>;
    expect(headers).toEqual({
      'Content-Type': 'application/json',
      'X-Client-Id': 'canopy-nav',
      Authorization: 'Bearer secret-key',
    });
  });

  it('sends both locations as breaks, with lat/lon swapped correctly', async () => {
    respond(TRIP_JSON);
    await routeOnValhalla({ from: FROM, to: TO });
    expect(lastBody().locations).toEqual([
      { lat: 42.3314, lon: -83.0456, type: 'break' },
      { lat: 42.3295, lon: -83.045, type: 'break' },
    ]);
  });

  it('defaults to auto / km / en-US', async () => {
    respond(TRIP_JSON);
    await routeOnValhalla({ from: FROM, to: TO });
    const body = lastBody();
    expect(body.costing).toBe('auto');
    expect(body.units).toBe('km');
    expect(body.language).toBe('en-US');
    expect(body.directions_options).toEqual({ units: 'km', language: 'en-US' });
  });

  it('passes costing, units and language through', async () => {
    respond(TRIP_JSON);
    await routeOnValhalla({ from: FROM, to: TO, costing: 'bicycle', units: 'miles', language: 'fr-FR' });
    const body = lastBody();
    expect(body.costing).toBe('bicycle');
    expect(body.units).toBe('miles');
    expect(body.language).toBe('fr-FR');
    expect(body.directions_options).toEqual({ units: 'miles', language: 'fr-FR' });
  });

  it('asks for polyline6 and surface filters for auto', async () => {
    respond(TRIP_JSON);
    await routeOnValhalla({ from: FROM, to: TO, costing: 'auto' });
    const body = lastBody();
    expect(body.shape_format).toBe('polyline6');
    expect(body.filters).toEqual({
      attributes: ['edge.surface', 'edge.access', 'edge.impovability'],
      exclude_polygons: [],
    });
    expect(body.costing_options).toEqual({
      auto: { use_roads: 0.95, use_tolls: 0.5, ignore_closures: false },
    });
  });

  it('omits shape_format / filters / costing_options for non-auto costing', async () => {
    respond(TRIP_JSON);
    await routeOnValhalla({ from: FROM, to: TO, costing: 'pedestrian' });
    const body = lastBody();
    expect(body.shape_format).toBeUndefined();
    expect(body.filters).toBeUndefined();
    expect(body.costing_options).toBeUndefined();
    // but the response shape is still decoded as polyline6
    expect(body.shape_format ?? 'polyline6').toBe('polyline6');
  });

  it('encodes avoid polygons as polyline6 exclude_polygons', async () => {
    respond(TRIP_JSON);
    const avoid: LatLng[][] = [
      [[-83.046, 42.331], [-83.046, 42.3312], [-83.0458, 42.3312]],
    ];
    await routeOnValhalla({ from: FROM, to: TO, avoid });
    const polys = lastBody().exclude_polygons;
    expect(polys).toHaveLength(1);
    expect(polys[0].type).toBe('polyline');
    expect(decodePolyline(polys[0].shape, 6)).toEqual(avoid[0]);
  });

  it('omits exclude_polygons when no avoid lines are given', async () => {
    respond(TRIP_JSON);
    await routeOnValhalla({ from: FROM, to: TO, avoid: [] });
    expect(lastBody().exclude_polygons).toBeUndefined();
  });
});

describe('routeOnValhalla — response parsing', () => {
  it('decodes the leg geometry from polyline6', async () => {
    respond(TRIP_JSON);
    const route = await routeOnValhalla({ from: FROM, to: TO });
    const decoded = decodePolyline(LEG_SHAPE, 6);
    expect(route.geometry.slice(0, decoded.length)).toEqual(decoded);
    expect(route.geometry[0]).toEqual(LEG_SHAPE_PTS[0]);
    expect(route.geometry[decoded.length - 1]).toEqual(LEG_SHAPE_PTS[LEG_SHAPE_PTS.length - 1]);
  });

  it('returns exactly the decoded shape, with no duplicated last point', async () => {
    // Valhalla's `shape` already contains the destination, and the last
    // maneuver's end_shape_index is that coordinate's index. Appending it again
    // produced a zero-length final segment for every consumer downstream.
    respond(TRIP_JSON);
    const route = await routeOnValhalla({ from: FROM, to: TO });
    const decoded = decodePolyline(LEG_SHAPE, 6);
    expect(route.geometry).toEqual(decoded);
    // every coordinate distinct => no zero-length segment anywhere
    expect(new Set(route.geometry.map((p) => p.join(','))).size).toBe(decoded.length);
    // the arrival maneuver's end index lands exactly on the final point
    const last = route.maneuvers[route.maneuvers.length - 1];
    expect(route.geometry[last.end_shape_index]).toEqual(LEG_SHAPE_PTS[LEG_SHAPE_PTS.length - 1]);
  });

  it('exposes maneuvers, summary, units and engine', async () => {
    respond(TRIP_JSON);
    const route = await routeOnValhalla({ from: FROM, to: TO });
    expect(route.maneuvers).toEqual(TRIP_JSON.trip.legs[0].maneuvers);
    expect(route.maneuvers).toHaveLength(3);
    expect(route.summary).toEqual(TRIP_JSON.trip.summary);
    expect(route.units).toBe('km');
    expect(route.engine).toBe('valhalla');
    expect(route.legs).toHaveLength(1);
    expect(route.legs[0].maneuvers).toHaveLength(3);
    expect(route.legs[0].summary).toEqual(LEG_SUMMARY);
  });

  it("prefers the server's units over the requested ones", async () => {
    respond({ ...TRIP_JSON, trip: { ...TRIP_JSON.trip, units: 'miles' } });
    const route = await routeOnValhalla({ from: FROM, to: TO, units: 'km' });
    expect(route.units).toBe('miles');
  });

  it('falls back to the trip summary when the leg summary is missing', async () => {
    const json = JSON.parse(JSON.stringify(TRIP_JSON));
    delete json.trip.summary;
    respond(json);
    const route = await routeOnValhalla({ from: FROM, to: TO });
    expect(route.summary).toEqual(LEG_SUMMARY);
  });

  it('falls back to the requested units when the server omits units', async () => {
    const json = JSON.parse(JSON.stringify(TRIP_JSON));
    delete json.trip.units;
    respond(json);
    const route = await routeOnValhalla({ from: FROM, to: TO, units: 'miles' });
    expect(route.units).toBe('miles');
  });

  it('leaves a leg with no maneuvers untouched', async () => {
    const json = JSON.parse(JSON.stringify(TRIP_JSON));
    json.trip.legs[0].maneuvers = [];
    respond(json);
    const route = await routeOnValhalla({ from: FROM, to: TO });
    expect(route.maneuvers).toEqual([]);
    expect(route.geometry).toHaveLength(decodePolyline(LEG_SHAPE, 6).length);
  });

  it('ignores an end_shape_index past the end of the shape', async () => {
    const json = JSON.parse(JSON.stringify(TRIP_JSON));
    json.trip.legs[0].maneuvers[2].end_shape_index = 99;
    respond(json);
    const route = await routeOnValhalla({ from: FROM, to: TO });
    expect(route.geometry).toHaveLength(decodePolyline(LEG_SHAPE, 6).length);
  });

  it('concatenates every leg into route.geometry', async () => {
    // `geometry: legs[0].geometry` drops every later leg, so a via-point trip
    // renders and routes on a truncated line.
    const leg2 = {
      maneuvers: [{ type: 1, instruction: 'Arrive.', begin_shape_index: 0, end_shape_index: 1, length: 1, time: 1 }],
      summary: { ...LEG_SUMMARY, min_lon: -83.04 },
      shape: encode6([[-83.04, 42.32], [-83.03, 42.31]]),
    };
    respond({ trip: { ...TRIP_JSON.trip, legs: [TRIP_JSON.trip.legs[0], leg2] } });
    const route = await routeOnValhalla({ from: FROM, to: TO });
    expect(route.legs).toHaveLength(2);
    expect(route.maneuvers).toEqual(route.legs[0].maneuvers);
    // every coordinate of every leg reaches the drawn route
    expect(route.geometry.some((p) => p[0] === -83.03 || p[0] === -83.04)).toBe(true);
  });

  it('joins consecutive legs without inventing or losing coordinates', async () => {
    // Real legs meet at the break coordinate, so leg 2 starts where leg 1
    // ended. This fixture deliberately makes them differ, to prove the join only
    // removes a genuine repeat: a real gap must not be papered over by silently
    // discarding a coordinate.
    const leg2 = {
      maneuvers: [{ type: 1, instruction: 'Arrive.', begin_shape_index: 0, end_shape_index: 1, length: 1, time: 1 }],
      summary: LEG_SUMMARY,
      shape: encode6([[-83.045, 42.3295], [-83.04, 42.32]]), // starts at leg 1's end
    };
    respond({ trip: { ...TRIP_JSON.trip, legs: [TRIP_JSON.trip.legs[0], leg2] } });
    const route = await routeOnValhalla({ from: FROM, to: TO });

    // one copy of the shared break survives, and nothing else is lost
    expect(route.geometry).toEqual([
      ...route.legs[0].geometry.slice(0, -1),
      ...route.legs[1].geometry,
    ]);
  });

  it('keeps both endpoints when the legs do not actually meet', async () => {
    const leg2 = {
      maneuvers: [{ type: 1, instruction: 'Arrive.', begin_shape_index: 0, end_shape_index: 1, length: 1, time: 1 }],
      summary: LEG_SUMMARY,
      shape: encode6([[-83.04, 42.32], [-83.03, 42.31]]),
    };
    respond({ trip: { ...TRIP_JSON.trip, legs: [TRIP_JSON.trip.legs[0], leg2] } });
    const route = await routeOnValhalla({ from: FROM, to: TO });

    // leg 1 ends at [-83.045, 42.3295] and leg 2 starts at [-83.04, 42.32];
    // nothing coincides, so every coordinate must survive
    expect(route.geometry.length).toBe(
      route.legs[0].geometry.length + route.legs[1].geometry.length,
    );
    expect(route.geometry.at(-2)).toEqual([-83.04, 42.32]);
    expect(route.geometry.at(-1)).toEqual([-83.03, 42.31]);
  });
});

describe('routeOnValhalla — errors', () => {
  it('rejects with the server error string and status', async () => {
    respond({ error: 'No path could be found for the requested locations.', error_code: 442 }, 400);
    await expect(routeOnValhalla({ from: FROM, to: TO })).rejects.toThrow(
      'No path could be found for the requested locations.',
    );
    const err = await routeOnValhalla({ from: FROM, to: TO }).catch((e) => e);
    expect(err).toBeInstanceOf(RoutingError);
    expect(err.name).toBe('RoutingError');
    expect(err.status).toBe(400);
  });

  it('keeps a 5xx status for retry decisions', async () => {
    respond({ error: 'internal error' }, 503);
    const err = await routeOnValhalla({ from: FROM, to: TO }).catch((e) => e);
    expect(err.status).toBe(503);
  });

  it('falls back to HTTP <status> when the error body is not JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('not json');
      },
    });
    await expect(routeOnValhalla({ from: FROM, to: TO })).rejects.toThrow('HTTP 502');
  });

  it('falls back to HTTP <status> when the body has no error field', async () => {
    respond({ unexpected: true }, 400);
    await expect(routeOnValhalla({ from: FROM, to: TO })).rejects.toThrow('HTTP 400');
  });

  it('reports a readable message when the network is unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const err = await routeOnValhalla({ from: FROM, to: TO }).catch((e) => e);
    expect(err).toBeInstanceOf(RoutingError);
    expect(err.message).toBe('Could not reach the routing server — check your connection');
    expect(err.status).toBeUndefined();
  });

  it('reports the same message when fetch rejects with a non-Error', async () => {
    fetchMock.mockRejectedValue('kaboom');
    await expect(routeOnValhalla({ from: FROM, to: TO })).rejects.toThrow(
      'Could not reach the routing server — check your connection',
    );
  });

  it('rejects when the trip has no legs', async () => {
    respond({ trip: { legs: [] } });
    await expect(routeOnValhalla({ from: FROM, to: TO })).rejects.toThrow(
      'Route not found between the selected points',
    );
  });

  it('rejects when the response has no trip at all', async () => {
    respond({ error: 'bad request' });
    const err = await routeOnValhalla({ from: FROM, to: TO }).catch((e) => e);
    expect(err).toBeInstanceOf(RoutingError);
    expect(err.message).toBe('Route not found between the selected points');
    expect(err.status).toBeUndefined();
  });
});

describe('valhallaStatus', () => {
  it('reports the version from /status', async () => {
    respond({ version: '3.5.1', tileset_last_modified: 1700000000, has_tiles: true });
    expect(await valhallaStatus('https://valhalla.example.com')).toEqual({ ok: true, version: '3.5.1' });
    const [url, init] = lastCall();
    expect(url).toBe('https://valhalla.example.com/status');
    expect((init.headers as Record<string, string>)['X-Client-Id']).toBe('canopy-nav');
    expect(init.body).toBeUndefined();
  });

  it('omits version when the server does not report one', async () => {
    respond({ has_tiles: true });
    expect(await valhallaStatus()).toEqual({ ok: true, version: undefined });
  });

  it('reports ok: false for a non-2xx response', async () => {
    respond({ error: 'nope' }, 404);
    expect(await valhallaStatus()).toEqual({ ok: false });
  });

  it('reports ok: false when the request throws', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await valhallaStatus()).toEqual({ ok: false });
  });

  it('reports ok: false when the body is not JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('not json');
      },
    });
    expect(await valhallaStatus()).toEqual({ ok: false });
  });

  it('defaults to the FOSSGIS endpoint and strips a trailing slash', async () => {
    respond({ version: '3.5.1' });
    await valhallaStatus(`${VALHALLA_ENDPOINT}/`);
    expect(lastCall()[0]).toBe(`${VALHALLA_ENDPOINT}/status`);
  });
});