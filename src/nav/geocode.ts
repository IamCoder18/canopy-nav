import type { LatLng } from '../geo';

/**
 * Nominatim (OpenStreetMap) geocoding — forward search + reverse lookup.
 * Docs: https://nominatim.org/release-docs/develop/api/
 *
 * The public demo service requires a valid HTTP Referer or User-Agent and caps
 * usage at 1 request/second. We serialise calls through `lastRequest`.
 */

/**
 * Canonical Nominatim host.
 *
 * This was `nominatim.openstreetmap.de`, which does not resolve at all — DNS
 * NXDOMAIN, `ERR_NAME_NOT_RESOLVED` on every request — so the entire online
 * search fallback had been dead, silently, for as long as it had been pointed
 * there. `.org` is the host the project publishes and it answers.
 *
 * Note that this is *not* the same mistake as the Valhalla endpoint, which
 * genuinely is `.de` and does resolve. Only the geocoder host moved.
 */
export const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org';

export interface Place {
  id: string;
  name: string;
  displayName: string;
  lat: number;
  lon: number;
  category: string;
  type: string;
  /** 'node' | 'way' | 'relation' */
  osmType: 'node' | 'way' | 'relation';
  osmId: number;
  /** Pre-computed bounding box, if the API returned one. */
  bbox?: [number, number, number, number];
  importance?: number;
}

let lastRequest = 0;
let queue: Promise<unknown> = Promise.resolve();

/** Nominatim asks for <= 1 req/s; chain every call through this gate. */
function throttle<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = Math.max(0, 1100 - (Date.now() - lastRequest));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastRequest = Date.now();
    return fn();
  });
  queue = run.catch(() => undefined);
  return run;
}

/**
 * No `Content-Type` here: every call this module makes is a bodyless GET, so a
 * content type is meaningless (and some proxies reject it outright).
 */
function headers(): HeadersInit {
  return {
    'Accept-Language': 'en',
    // FOSSGIS asks distributed clients to identify themselves.
    'X-Client-Id': 'canopy-nav',
  };
}

/**
 * How long a geocoder request may take.
 *
 * `fetch` has no deadline of its own — it waits indefinitely unless the socket
 * errors — and without one here a hanging geocoder left the search screen on
 * "Searching…" indefinitely, with no cancel and no way to tell a slow server from
 * a dead one. Measured: still spinning at 30 s.
 *
 * 12 s is comfortably longer than a real request (the live endpoint answers in
 * roughly 0.6 s) and short enough that the app reports failure while the user
 * still cares.
 *
 * The same reasoning as `VALHALLA_TIMEOUT_MS` in `valhalla.ts`, on a **smaller**
 * budget: routing is the request a driver waits on mid-turn, where 20 s is a long time
 * to stare at a banner that is not moving. This used to say "the same 20 s figure",
 * which was true when the constant was 20 s and stopped being true when it was lowered.
 */
export const GEOCODE_TIMEOUT_MS = 12_000;

/**
 * A `fetch` that gives up.
 *
 * On timeout it throws a message that says so, rather than the generic
 * "connection failed" — the two need different responses from the user: one is
 * worth retrying, the other usually is not.
 */
async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    GEOCODE_TIMEOUT_MS,
  );
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    if (controller.signal.aborted) {
      throw new Error(
        `The search service did not answer within ${Math.round(GEOCODE_TIMEOUT_MS / 1000)} seconds.`,
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

interface NominatimPlace {
  place_id: number;
  osm_type: 'node' | 'way' | 'relation';
  osm_id: number;
  lat: string;
  lon: string;
  category?: string;
  type?: string;
  class?: string;
  name?: string;
  display_name: string;
  boundingbox?: [string, string, string, string];
  importance?: number;
  addresstype?: string;
}

function toPlace(p: NominatimPlace): Place {
  return {
    id: `${p.osm_type}/${p.osm_id}`,
    // Nominatim's `name` is often blank for buildings; fall back to the tail of display_name.
    name: p.name || p.display_name.split(',')[0],
    displayName: p.display_name,
    lat: parseFloat(p.lat),
    lon: parseFloat(p.lon),
    category: p.category ?? p.class ?? p.type ?? 'place',
    type: p.type ?? p.addresstype ?? 'place',
    osmType: p.osm_type,
    osmId: p.osm_id,
    // Nominatim returns `boundingbox` as [min_lat, max_lat, min_lon, max_lon]
    // (= [S, N, W, E]). The rest of the app uses [west, south, east, north]
    // (see `bboxOf` in src/geo.ts and `bboxContains`/`bboxOverlapFrac` in
    // src/osm/regions.ts), so permute the two axis pairs rather than leaking a
    // second, incompatible box ordering into `Place`.
    bbox: p.boundingbox
      ? [
          parseFloat(p.boundingbox[2]), // W
          parseFloat(p.boundingbox[0]), // S
          parseFloat(p.boundingbox[3]), // E
          parseFloat(p.boundingbox[1]), // N
        ]
      : undefined,
    importance: p.importance,
  };
}

/** Free-text search, biased toward the current map centre. */
export function searchPlaces(
  q: string,
  opts: { near?: LatLng; limit?: number; addressDetails?: boolean; endpoint?: string } = {},
): Promise<Place[]> {
  const endpoint = (opts.endpoint ?? NOMINATIM_ENDPOINT).replace(/\/$/, '');
  const params = new URLSearchParams({
    q,
    format: 'jsonv2',
    // Nominatim only accepts 0 or 1 here — `String(false)` would send the
    // literal "false". Only an explicit `false` disables address details, so
    // the default stays on (App.tsx never passes the flag).
    addressdetails: opts.addressDetails === false ? '0' : '1',
    limit: String(opts.limit ?? 10),
    extratags: '1',
    namedetails: '1',
  });
  if (opts.near) {
    // Nominatim documents viewbox as <x1>,<y1>,<x2>,<y2> where x is LONGITUDE
    // and y is LATITUDE — i.e. [W, S, E, N], the same ordering as every other
    // bbox in the app. `near` is a LatLng ([lon, lat]), so emit
    // lon-d, lat-d, lon+d, lat+d: the south-west corner first, then the
    // north-east. (Nominatim accepts either corner as first, but keeping
    // min-before-max is self-documenting and matches how we build boxes
    // locally.) The two corners are +/-0.6 deg, ~65 km out at this latitude.
    // `bounded` is deliberately left unset (defaults to 0) so the box only
    // *biases* ranking towards the map centre without excluding distant hits.
    const d = 0.6;
    params.set('viewbox', [
      opts.near[0] - d, // W
      opts.near[1] - d, // S
      opts.near[0] + d, // E
      opts.near[1] + d, // N
    ].join(','));
  }

  return throttle(async () => {
    const res = await fetchWithTimeout(`${endpoint}/search?${params}`, { headers: headers() });
    if (!res.ok) throw new Error(`Nominatim search failed (HTTP ${res.status})`);
    const json = (await res.json()) as NominatimPlace[];
    return json.map(toPlace);
  });
}

/** Reverse-geocode a coordinate to the nearest address/place. */
export function reverseGeocode(
  point: LatLng,
  opts: { zoom?: number; endpoint?: string } = {},
): Promise<Place[]> {
  const endpoint = (opts.endpoint ?? NOMINATIM_ENDPOINT).replace(/\/$/, '');
  const params = new URLSearchParams({
    lat: String(point[1]),
    lon: String(point[0]),
    format: 'jsonv2',
    zoom: String(opts.zoom ?? 18),
    addressdetails: '1',
    namedetails: '1',
  });

  return throttle(async () => {
    const res = await fetchWithTimeout(`${endpoint}/reverse?${params}`, { headers: headers() });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`Nominatim reverse failed (HTTP ${res.status})`);
    return [toPlace((await res.json()) as NominatimPlace)];
  });
}

/** Category browse used to populate the AA-style quick-pick chips. */
export const CATEGORIES = [
  { key: 'restaurant', label: 'Restaurants', term: 'restaurant' },
  { key: 'fuel', label: 'Gas', term: 'fuel station' },
  { key: 'cafe', label: 'Coffee', term: 'cafe' },
  { key: 'hotel', label: 'Hotels', term: 'hotel' },
  { key: 'parking', label: 'Parking', term: 'parking' },
  { key: 'shopping', label: 'Shopping', term: 'shopping mall' },
  { key: 'hospital', label: 'Hospitals', term: 'hospital' },
  { key: 'gas_charging', label: 'EV Charging', term: 'charging station' },
] as const;
