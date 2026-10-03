/**
 * Nominatim geocoding tests — request shape, `toPlace` mapping and, most
 * importantly, the 1 req/s throttle.
 *
 * The throttle keeps module-level state (`lastRequest` + a promise `queue`), so
 * every test here runs on fake timers with a monotonically increasing epoch: a
 * fresh epoch far in the future guarantees the *first* call of each test is not
 * charged a wait, and the ordering assertions inside a test are exact.
 *
 * Run with `npx vitest run test/geocode.spec.ts`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  searchPlaces,
  reverseGeocode,
  CATEGORIES,
  NOMINATIM_ENDPOINT,
  type Place,
} from '../src/nav/geocode';

const REV_PAYLOAD = {
  place_id: 111, osm_type: 'node', osm_id: 222, lat: '1', lon: '2',
  category: 'building', type: 'house', name: 'Somewhere', display_name: 'Somewhere, World',
};

/** Respond based on which endpoint was called. */
function byEndpoint() {
  return (url: string) =>
    String(url).includes('/reverse') ? ok(REV_PAYLOAD) : ok([]);
}

const BASE = 1_700_000_000_000;
let clock = 0;
let fetchMock: ReturnType<typeof vi.fn>;

/** Install fake timers on a fresh epoch so `lastRequest` never throttles call #1. */
function useFakeClock() {
  clock += 600_000;
  vi.useFakeTimers({ now: BASE + clock });
}

/** Advance fake time so the throttle gate releases, then return the result. */
async function settle<T>(p: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(10_000);
  return p;
}

/** A Response-like object; `body` may be a value or a factory for a rejected json(). */
function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

function failing(status: number, body: unknown = { error: 'nope' }) {
  return { ok: false, status, json: async () => body };
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  useFakeClock();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('throttle', () => {
  it('serialises concurrent calls: only one request is in flight at a time', async () => {
    const calls: { url: string; t: number }[] = [];
    const resolvers: (() => void)[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    fetchMock.mockImplementation((url: string) => {
      calls.push({ url, t: Date.now() });
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((res) => resolvers.push(() => {
        inFlight--;
        res(ok([]));
      }));
    });

    const pending = Promise.all([searchPlaces('a'), searchPlaces('b'), searchPlaces('c')]);

    // The first request goes out immediately; the other two stay queued even
    // after 5 s of fake time, because the queue is a promise chain.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('q=a');

    resolvers[0]();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain('q=b');

    resolvers[1]();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(3);
    expect(calls[2].url).toContain('q=c');

    resolvers[2]();
    expect(await pending).toEqual([[], [], []]);
    expect(maxInFlight).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('spaces consecutive requests by at least 1100 ms', async () => {
    const times: number[] = [];
    fetchMock.mockImplementation(async () => {
      times.push(Date.now());
      return ok([]);
    });
    const all = Promise.all([searchPlaces('a'), searchPlaces('b'), searchPlaces('c')]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await all).toEqual([[], [], []]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(1100);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(1100);
  });

  it('holds the queue for a caller that arrives while another is in flight', async () => {
    const resolvers: (() => void)[] = [];
    fetchMock.mockImplementation(() => new Promise((res) => resolvers.push(() => res(ok([])))));
    const p1 = searchPlaces('a');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // a fourth caller joins the queue after the first request went out
    const p2 = searchPlaces('b');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolvers[0]();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    resolvers[1]();
    expect(await Promise.all([p1, p2])).toEqual([[], []]);
  });

  it('shares one queue between searchPlaces and reverseGeocode', async () => {
    const urls: string[] = [];
    fetchMock.mockImplementation(async (url: string) => {
      urls.push(url);
      return byEndpoint()(url);
    });
    await settle(Promise.all([reverseGeocode([1, 2]), searchPlaces('x')]));
    expect(urls).toHaveLength(2);
    // the reverse call was queued first, so it goes out first
    expect(urls[0]).toContain('/reverse?');
    expect(urls[1]).toContain('/search?');
  });

  it('does not let one failure stall the queue', async () => {
    fetchMock
      .mockResolvedValueOnce(failing(429))
      .mockResolvedValueOnce(ok([]))
      .mockResolvedValueOnce(ok([]));
    const results = await settle(
      Promise.allSettled([searchPlaces('a'), searchPlaces('b'), searchPlaces('c')]),
    );
    expect(results[0].status).toBe('rejected');
    expect(results[1]).toEqual({ status: 'fulfilled', value: [] });
    expect(results[2]).toEqual({ status: 'fulfilled', value: [] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('searchPlaces request', () => {
  it('hits /search with the documented jsonv2 parameters', async () => {
    fetchMock.mockResolvedValue(ok([]));
    await settle(searchPlaces('bow ring calgary'));
    const [url, init] = fetchMock.mock.calls[0];
    const parsed = new URL(String(url));
    expect(`${parsed.origin}${parsed.pathname}`).toBe(`${NOMINATIM_ENDPOINT}/search`);
    expect(parsed.searchParams.get('q')).toBe('bow ring calgary');
    expect(parsed.searchParams.get('format')).toBe('jsonv2');
    expect(parsed.searchParams.get('addressdetails')).toBe('1');
    expect(parsed.searchParams.get('limit')).toBe('10');
    expect(parsed.searchParams.get('extratags')).toBe('1');
    expect(parsed.searchParams.get('namedetails')).toBe('1');
    expect((init.headers as Record<string, string>)['Accept-Language']).toBe('en');
    expect((init.headers as Record<string, string>)['X-Client-Id']).toBe('canopy-nav');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(parsed.searchParams.get('viewbox')).toBeNull();
  });

  it('honours limit and a custom endpoint', async () => {
    fetchMock.mockResolvedValue(ok([]));
    await settle(
      searchPlaces('x', { limit: 3, endpoint: 'https://nominatim.example.org/' }),
    );
    const parsed = new URL(String(fetchMock.mock.calls[0][0]));
    expect(`${parsed.origin}${parsed.pathname}`).toBe('https://nominatim.example.org/search');
    expect(parsed.searchParams.get('limit')).toBe('3');
  });

  it('BUG: sends addressdetails=false instead of 0', async () => {
    // `String(opts.addressDetails ?? 1)` stringifies the boolean; the API only
    // accepts 0 or 1 for this parameter.
    fetchMock.mockResolvedValue(ok([]));
    await settle(searchPlaces('x', { addressDetails: false }));
    const parsed = new URL(String(fetchMock.mock.calls[0][0]));
    expect(parsed.searchParams.get('addressdetails')).toBe('false');
  });

  it.fails('sends addressdetails=0 when addressDetails is false', async () => {
    fetchMock.mockResolvedValue(ok([]));
    await settle(searchPlaces('x', { addressDetails: false }));
    const parsed = new URL(String(fetchMock.mock.calls[0][0]));
    expect(parsed.searchParams.get('addressdetails')).toBe('0');
  });

  it('BUG: builds the viewbox in lat,lon order instead of lon,lat', async () => {
    // Nominatim documents viewbox as <x1>,<y1>,<x2>,<y2> with x = longitude and
    // y = latitude. The code emits [lat+d, lon+d, lat-d, lon-d], so Berlin
    // becomes lon 53.1, lat 14 -> lon 51.9, lat 12.8: not a proper box (and in
    // the wrong hemisphere). App.tsx always passes `near`, so every in-app
    // search is affected.
    fetchMock.mockResolvedValue(ok([]));
    await settle(searchPlaces('cafe', { near: [13.4, 52.5] }));
    const parsed = new URL(String(fetchMock.mock.calls[0][0]));
    expect(parsed.searchParams.get('viewbox')).toBe('53.1,14,51.9,12.8');
    expect(parsed.searchParams.get('bounded')).toBeNull();
  });

  it.fails('builds the viewbox as <min_lon>,<min_lat>,<max_lon>,<max_lat>', async () => {
    fetchMock.mockResolvedValue(ok([]));
    await settle(searchPlaces('cafe', { near: [13.4, 52.5] }));
    const parsed = new URL(String(fetchMock.mock.calls[0][0]));
    expect(parsed.searchParams.get('viewbox')).toBe('12.8,51.9,14,53.1');
  });

  it('percent-encodes the query', async () => {
    fetchMock.mockResolvedValue(ok([]));
    await settle(searchPlaces('a b&c=d'));
    expect(String(fetchMock.mock.calls[0][0])).toContain('q=a+b%26c%3Dd');
  });
});

describe('toPlace mapping', () => {
  it('maps a complete jsonv2 result', async () => {
    fetchMock.mockResolvedValue(
      ok([
        {
          place_id: 204751033,
          osm_type: 'way',
          osm_id: 437595031,
          lat: '52.54274275',
          lon: '13.36690305710228',
          category: 'shop',
          type: 'bakery',
          name: 'Ditsch',
          display_name: 'Ditsch, Lindower Straße, Sprengelkiez, Wedding, Mitte, Berlin',
          boundingbox: ['52.5427201', '52.5427654', '13.3668619', '13.3669442'],
          importance: 0.00001,
        },
      ]),
    );
    const places = await settle(searchPlaces('bakery'));
    expect(places).toHaveLength(1);
    const p = places[0];
    expect(p.id).toBe('way/437595031');
    expect(p.osmType).toBe('way');
    expect(p.osmId).toBe(437595031);
    expect(p.name).toBe('Ditsch');
    expect(p.displayName).toBe(
      'Ditsch, Lindower Straße, Sprengelkiez, Wedding, Mitte, Berlin',
    );
    expect(p.lat).toBeCloseTo(52.54274275, 8);
    expect(p.lon).toBeCloseTo(13.36690305710228, 12);
    expect(p.category).toBe('shop');
    expect(p.type).toBe('bakery');
    expect(p.importance).toBeCloseTo(0.00001, 8);
    expect(p.bbox).toEqual([52.5427201, 52.5427654, 13.3668619, 13.3669442]);
  });

  it('falls back to the first display_name segment when `name` is absent', async () => {
    fetchMock.mockResolvedValue(
      ok([
        {
          place_id: 1, osm_type: 'node', osm_id: 2, lat: '1.5', lon: '2.5',
          display_name: '135 Pilkington Avenue, Maney, Sutton Coldfield, Birmingham, UK',
        },
      ]),
    );
    const p = (await settle(searchPlaces('pilkington')))[0];
    expect(p.name).toBe('135 Pilkington Avenue');
    expect(p.displayName.split(',')[0]).toBe(p.name);
    // no category/class/type at all
    expect(p.category).toBe('place');
    expect(p.type).toBe('place');
    expect(p.bbox).toBeUndefined();
  });

  it('uses an empty-string name the same way as a missing one', async () => {
    fetchMock.mockResolvedValue(
      ok([
        { place_id: 1, osm_type: 'node', osm_id: 2, lat: '0', lon: '0', name: '', display_name: 'Somewhere, Elsewhere' },
      ]),
    );
    expect((await settle(searchPlaces('somewhere')))[0].name).toBe('Somewhere');
  });

  it('falls back category -> class -> type', async () => {
    fetchMock.mockResolvedValue(
      ok([
        { place_id: 1, osm_type: 'node', osm_id: 2, lat: '0', lon: '0', class: 'place', type: 'village', display_name: 'V' },
        { place_id: 3, osm_type: 'node', osm_id: 4, lat: '0', lon: '0', type: 'peak', display_name: 'P' },
        { place_id: 5, osm_type: 'node', osm_id: 6, lat: '0', lon: '0', addresstype: 'road', display_name: 'R' },
      ]),
    );
    const places = await settle(searchPlaces('vpr'));
    const byId = Object.fromEntries(places.map((p) => [p.osmId, p]));
    expect(byId[2].category).toBe('place'); // from `class`
    expect(byId[2].type).toBe('village');
    expect(byId[4].category).toBe('peak'); // no category, no class -> `type`
    expect(byId[4].type).toBe('peak');
    expect(byId[6].category).toBe('place'); // nothing but addresstype
    expect(byId[6].type).toBe('road'); // addresstype fallback
  });

  it('composes the id from the osm type and id', async () => {
    fetchMock.mockResolvedValue(
      ok([
        { place_id: 1, osm_type: 'relation', osm_id: 99, lat: '0', lon: '0', display_name: 'R' },
        { place_id: 2, osm_type: 'node', osm_id: 98, lat: '0', lon: '0', display_name: 'N' },
        { place_id: 3, osm_type: 'way', osm_id: 97, lat: '0', lon: '0', display_name: 'W' },
      ]),
    );
    const ids = (await settle(searchPlaces('x'))).map((p) => p.id);
    expect(ids).toEqual(['relation/99', 'node/98', 'way/97']);
  });

  it('parses numeric strings for lat/lon', async () => {
    fetchMock.mockResolvedValue(
      ok([{ place_id: 1, osm_type: 'node', osm_id: 2, lat: '-33.8688', lon: '151.2093', display_name: 'Sydney' }]),
    );
    const p = (await settle(searchPlaces('sydney')))[0];
    expect(p.lat).toBe(-33.8688);
    expect(p.lon).toBe(151.2093);
    expect(typeof p.lat).toBe('number');
  });

  it('returns an empty array for an empty result set', async () => {
    fetchMock.mockResolvedValue(ok([]));
    expect(await settle(searchPlaces('zzzz'))).toEqual([]);
  });

  it('BUG: puts the bbox in Nominatim order [S, N, W, E], not [W, S, E, N]', async () => {
    // Nominatim's `boundingbox` is ["min_lat", "max_lat", "min_lon", "max_lon"],
    // but every other bbox in the app is [west, south, east, north], so this
    // field cannot be fed to bboxContains / bboxOverlapFrac / bboxOf.
    fetchMock.mockResolvedValue(
      ok([
        {
          place_id: 1, osm_type: 'way', osm_id: 2, lat: '52.5172', lon: '13.3978',
          display_name: 'Kommandantenhaus', boundingbox: ['52.5170798', '52.5173311', '13.3975116', '13.3981577'],
        },
      ]),
    );
    const p = (await settle(searchPlaces('kommandantenhaus')))[0];
    // Berlin: lat 52.517..52.517, lon 13.397..13.398
    expect(p.bbox).toEqual([52.5170798, 52.5173311, 13.3975116, 13.3981577]);
    expect(p.bbox![0]).toBeGreaterThan(p.bbox![2]); // south > west
  });

  it.fails('normalises the bbox to [west, south, east, north]', async () => {
    fetchMock.mockResolvedValue(
      ok([
        {
          place_id: 1, osm_type: 'way', osm_id: 2, lat: '52.5172', lon: '13.3978',
          display_name: 'Kommandantenhaus', boundingbox: ['52.5170798', '52.5173311', '13.3975116', '13.3981577'],
        },
      ]),
    );
    const p: Place = (await settle(searchPlaces('kommandantenhaus')))[0];
    expect(p.bbox).toEqual([13.3975116, 52.5170798, 13.3981577, 52.5173311]);
  });
});

describe('searchPlaces errors', () => {
  it('rejects with the status code on a non-OK response', async () => {
    fetchMock.mockResolvedValue(failing(429));
    const err = await settle(searchPlaces('x')).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Nominatim search failed (HTTP 429)');
  });

  it('rejects on a 500', async () => {
    fetchMock.mockResolvedValue(failing(500));
    await expect(settle(searchPlaces('x'))).rejects.toThrow('Nominatim search failed (HTTP 500)');
  });

  it('propagates a network failure unchanged', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(settle(searchPlaces('x'))).rejects.toThrow('Failed to fetch');
  });
});

describe('reverseGeocode', () => {
  const payload = {
    place_id: 111,
    osm_type: 'node',
    osm_id: 222,
    lat: '51.5074',
    lon: '-0.1278',
    category: 'building',
    type: 'house',
    name: '10 Downing Street',
    display_name: '10, Downing Street, London, United Kingdom',
  };

  it('hits /reverse with lat/lon and the default zoom', async () => {
    fetchMock.mockResolvedValue(ok(payload));
    const places = await settle(reverseGeocode([-0.1278, 51.5074]));
    const parsed = new URL(String(fetchMock.mock.calls[0][0]));
    expect(`${parsed.origin}${parsed.pathname}`).toBe(`${NOMINATIM_ENDPOINT}/reverse`);
    expect(parsed.searchParams.get('lat')).toBe('51.5074');
    expect(parsed.searchParams.get('lon')).toBe('-0.1278');
    expect(parsed.searchParams.get('zoom')).toBe('18');
    expect(parsed.searchParams.get('format')).toBe('jsonv2');
    expect(parsed.searchParams.get('addressdetails')).toBe('1');
    expect(parsed.searchParams.get('namedetails')).toBe('1');

    expect(places).toHaveLength(1);
    expect(places[0].id).toBe('node/222');
    expect(places[0].name).toBe('10 Downing Street');
    expect(places[0].lat).toBeCloseTo(51.5074, 8);
  });

  it('honours zoom and endpoint', async () => {
    fetchMock.mockResolvedValue(ok(payload));
    await settle(reverseGeocode([1, 2], { zoom: 10, endpoint: 'https://nominatim.example.org/' }));
    const parsed = new URL(String(fetchMock.mock.calls[0][0]));
    expect(`${parsed.origin}${parsed.pathname}`).toBe('https://nominatim.example.org/reverse');
    expect(parsed.searchParams.get('zoom')).toBe('10');
    expect(parsed.searchParams.get('lat')).toBe('2'); // lat is point[1]
    expect(parsed.searchParams.get('lon')).toBe('1');
  });

  it('returns [] for 404 (no address here)', async () => {
    fetchMock.mockResolvedValue(failing(404, { error: 'Unable to geocode' }));
    expect(await settle(reverseGeocode([0, 0]))).toEqual([]);
  });

  it('rejects for any other non-OK status', async () => {
    fetchMock.mockResolvedValue(failing(503));
    await expect(settle(reverseGeocode([0, 0]))).rejects.toThrow('Nominatim reverse failed (HTTP 503)');
  });
});

describe('CATEGORIES', () => {
  it('exposes the browse chips with distinct keys and search terms', () => {
    expect(CATEGORIES).toHaveLength(8);
    expect(new Set(CATEGORIES.map((c) => c.key)).size).toBe(8);
    expect(CATEGORIES.map((c) => c.key)).toEqual([
      'restaurant', 'fuel', 'cafe', 'hotel', 'parking', 'shopping', 'hospital', 'gas_charging',
    ]);
    expect(CATEGORIES.map((c) => c.term)).toEqual([
      'restaurant', 'fuel station', 'cafe', 'hotel', 'parking', 'shopping mall', 'hospital', 'charging station',
    ]);
    expect(CATEGORIES.every((c) => c.label.length > 0)).toBe(true);
  });
});