import { decodePolyline, type LatLng } from '../geo';

/**
 * Valhalla (FOSSGIS / OSM) turn-by-turn routing client.
 *
 * Docs: https://valhalla.github.io/valhalla/api/route/api-reference
 *
 * Valhalla returns an encoded polyline (precision 6 by default) plus a list of
 * maneuvers with `begin_shape_index` offsets into that polyline.
 */

export const VALHALLA_ENDPOINT = 'https://valhalla1.openstreetmap.de';

/** FOSSGIS asks distributed clients to identify themselves. */
const CLIENT_ID = 'canopy-nav';

export interface ValhallaManeuver {
  type: number;
  instruction: string;
  verbal_pre_transition_instruction?: string;
  verbal_post_transition_instruction?: string;
  street_names?: string[];
  begin_shape_index: number;
  end_shape_index: number;
  length: number;
  time: number;
  begin_heading?: number;
  end_heading?: number;
  roundabout_exit_count?: number;
  sign?: { exit_number_elements?: {text: string }[]; exit_to_elements?: {text: string }[] };
  toll?: boolean;
  roundabout_exit_streets?: string[];
}

export interface ValhallaLeg {
  shape: string;
  maneuvers: ValhallaManeuver[];
  summary: { length: number; time: number; min_lat: number; min_lon: number; max_lat: number; max_lon: number };
  steps?: { shape: string; length: number; time: number }[];
}

export interface Route {
  /** Full route geometry, [lon, lat] pairs. */
  geometry: LatLng[];
  legs: { geometry: LatLng[]; maneuvers: ValhallaManeuver[]; summary: ValhallaLeg['summary'] }[];
  maneuvers: ValhallaManeuver[];
  summary: { length: number; time: number; min_lat: number; min_lon: number; max_lat: number; max_lon: number };
  units: 'km' | 'miles';
  engine: 'valhalla' | 'osm-local';
}

export type Costing = 'auto' | 'bicycle' | 'pedestrian';

export interface RouteRequest {
  from: LatLng;
  to: LatLng;
  costing?: Costing;
  units?: 'km' | 'miles';
  /** Avoid these polylines (e.g. user-selected avoid areas). */
  avoid?: LatLng[][];
  language?: string;
}

export class RoutingError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'RoutingError';
  }
}

/** Valhalla returns 400 with a JSON body on failure. */
async function readError(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string; error_code?: number; status_code?: number };
    return j.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

function parseTrip(json: unknown, units: 'km' | 'miles'): Route {
  const trip = (json as { trip?: { legs?: ValhallaLeg[]; summary?: ValhallaLeg['summary']; units?: string; language?: string } }).trip;
  if (!trip || !trip.legs?.length) throw new RoutingError('Route not found between the selected points');

  const legs = trip.legs.map((leg) => {
    const geometry = decodePolyline(leg.shape, 6);
    // Valhalla omits the final coordinate from `shape`; close it explicitly.
    const last = leg.maneuvers[leg.maneuvers.length - 1];
    if (last) {
      const i = last.end_shape_index;
      if (i < geometry.length) geometry.push(geometry[i]);
    }
    return { geometry, maneuvers: leg.maneuvers, summary: leg.summary };
  });

  const summary = trip.summary ?? legs[0].summary;
  return {
    geometry: legs[0].geometry,
    legs,
    maneuvers: legs[0].maneuvers,
    summary,
    units: (trip.units as 'km' | 'miles') ?? units,
    engine: 'valhalla',
  };
}

/** Call a Valhalla `/route` endpoint. */
export async function routeOnValhalla(
  req: RouteRequest,
  endpoint = VALHALLA_ENDPOINT,
  extraHeaders?: Record<string, string>,
): Promise<Route> {
  const costing = req.costing ?? 'auto';
  const units = req.units ?? 'km';

  const body: Record<string, unknown> = {
    locations: [
      { lat: req.from[1], lon: req.from[0], type: 'break' },
      { lat: req.to[1], lon: req.to[0], type: 'break' },
    ],
    costing,
    units,
    language: req.language ?? 'en-US',
    directions_options: { units, language: req.language ?? 'en-US' },
  };

  if (costing === 'auto') {
    // Turnarounds, u-turns and unpaved roads are what make car routes feel wrong.
    body.shape_format = 'polyline6';
    (body as Record<string, unknown>).filters = {
      attributes: ['edge.surface', 'edge.access', 'edge.impovability'],
      exclude_polygons: [],
    };
    (body as Record<string, unknown>).costing_options = {
      auto: { use_roads: 0.95, use_tolls: 0.5, ignore_closures: false },
    };
  }
  if (req.avoid?.length) {
    body.exclude_polygons = req.avoid.map((poly) => ({ type: 'polyline', shape: encodePolyline6(poly) }));
  }

  let res: Response;
  try {
    res = await fetch(`${endpoint.replace(/\/$/, '')}/route`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Id': CLIENT_ID,
        ...(extraHeaders ?? {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new RoutingError('Could not reach the routing server — check your connection');
  }

  if (!res.ok) throw new RoutingError(await readError(res), res.status);
  return parseTrip(await res.json(), units);
}

/** Valhalla accepts `exclude_polygons` shapes as encoded polylines. */
function encodePolyline6(coords: LatLng[]): string {
  let out = '';
  let prevLat = 0;
  let prevLon = 0;
  for (const [lon, lat] of coords) {
    const iLat = Math.round(lat * 1e6);
    const iLon = Math.round(lon * 1e6);
    out += encodeSigned(iLat - prevLat) + encodeSigned(iLon - prevLon);
    prevLat = iLat;
    prevLon = iLon;
  }
  return out;
}

function encodeSigned(n: number): string {
  let v = n < 0 ? ~(n << 1) : n << 1;
  let out = '';
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  out += String.fromCharCode(v + 63);
  return out;
}

/** Probe a Valhalla endpoint for availability + version. */
export async function valhallaStatus(endpoint = VALHALLA_ENDPOINT): Promise<{ ok: boolean; version?: string }> {
  try {
    const res = await fetch(`${endpoint.replace(/\/$/, '')}/status`, { headers: { 'X-Client-Id': CLIENT_ID } });
    if (!res.ok) return { ok: false };
    const j = (await res.json()) as { version?: string };
    return { ok: true, version: j.version };
  } catch {
    return { ok: false };
  }
}
