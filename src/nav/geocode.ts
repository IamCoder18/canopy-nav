import type { LatLng } from '../geo';

/**
 * Nominatim (OpenStreetMap) geocoding — forward search + reverse lookup.
 * Docs: https://nominatim.org/release-docs/develop/api/
 *
 * The public demo service requires a valid HTTP Referer or User-Agent and caps
 * usage at 1 request/second. We serialise calls through `lastRequest`.
 */

export const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.de';

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

function headers(): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'Accept-Language': 'en',
    // FOSSGIS asks distributed clients to identify themselves.
    'X-Client-Id': 'canopy-nav',
  };
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
    bbox: p.boundingbox
      ? [parseFloat(p.boundingbox[0]), parseFloat(p.boundingbox[1]), parseFloat(p.boundingbox[2]), parseFloat(p.boundingbox[3])]
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
    addressdetails: String(opts.addressDetails ?? 1),
    limit: String(opts.limit ?? 10),
    extratags: '1',
    namedetails: '1',
  });
  if (opts.near) {
    // viewbox=NW,NE,SW,SE + bounded=0 biases results without excluding distant hits
    const d = 0.6;
    params.set('viewbox', [opts.near[1] + d, opts.near[0] + d, opts.near[1] - d, opts.near[0] - d].join(','));
  }

  return throttle(async () => {
    const res = await fetch(`${endpoint}/search?${params}`, { headers: headers() });
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
    const res = await fetch(`${endpoint}/reverse?${params}`, { headers: headers() });
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
