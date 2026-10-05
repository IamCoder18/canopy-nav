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

/**
 * How long to wait before declaring a routing request failed.
 *
 * `fetch` has no timeout of its own: it waits indefinitely unless the socket
 * errors. Measured with a black-holed endpoint, the engines screen sat on
 * "Testing…" at 3 s, 9 s and 39.8 s, and a mistyped LAN address was still
 * spinning at 15 s. A row that never resolves is a row that looks broken, and
 * on a phone the user has no way to tell a slow server from a hung one.
 *
 * 20 s is long enough for a cold Valhalla to answer a real route request over a
 * mobile connection and short enough that "it is not working" arrives while the
 * driver still cares.
 */
export const VALHALLA_TIMEOUT_MS = 20_000;

/**
 * A `fetch` that gives up.
 *
 * Composed with any caller-supplied signal rather than replacing it, so an
 * abort from the UI still cancels promptly. Returns the caller's abort reason
 * when the caller aborts, and a timeout error when the deadline is what fired —
 * those are different events and the message should say which happened.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit & { signal?: AbortSignal } = {},
  timeoutMs = VALHALLA_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort(init.signal?.reason);
  if (init.signal) {
    if (init.signal.aborted) controller.abort(init.signal.reason);
    else init.signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  const timer = setTimeout(
    () => controller.abort(new DOMException(`Timed out after ${timeoutMs} ms`, 'TimeoutError')),
    timeoutMs,
  );
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    // Distinguish "the user navigated away" from "the server never answered".
    if (init.signal?.aborted) throw e;
    if (controller.signal.aborted) {
      throw new RoutingError(
        `The routing server did not answer within ${Math.round(timeoutMs / 1000)} seconds. ` +
        'It may be down, or the address may be wrong.',
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', onOuterAbort);
  }
}

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
  /** Genuinely distinct alternate paths, when the provider returned any. */
  alternates?: Route[];
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
  /**
   * Ask the provider for up to N genuinely distinct alternate paths.
   *
   * This is what makes traffic comparison possible: repeating an identical
   * request returns an identical route, so the alternatives have to be asked
   * for explicitly or there is nothing to compare.
   */
  alternates?: number;
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

/**
 * Valhalla reports `summary.length` in whatever units the request asked for.
 * Everything downstream in this app treats a length as metres, so convert once
 * here rather than making every consumer remember which engine produced it.
 */
function lengthToMetres(value: number, units: 'km' | 'miles'): number {
  return units === 'miles' ? value * 1609.344 : value * 1000;
}

function parseTrip(json: unknown, units: 'km' | 'miles'): Route {
  const trip = (json as { trip?: { legs?: ValhallaLeg[]; summary?: ValhallaLeg['summary']; units?: string; language?: string } }).trip;
  if (!trip || !trip.legs?.length) throw new RoutingError('Route not found between the selected points');

  // A leg's `shape` already includes its final coordinate, and the last
  // maneuver's end_shape_index is that coordinate's index (geometry.length - 1).
  // Appending it again produced a duplicated arrival point.
  const legs = trip.legs.map((leg) => ({
    geometry: decodePolyline(leg.shape, 6),
    maneuvers: leg.maneuvers,
    summary: leg.summary,
  }));

  const rawSummary = trip.summary ?? legs[0].summary;
  // Normalise to metres once, here, so no consumer has to know which engine or
  // unit produced a length.
  const summary = { ...rawSummary, length: lengthToMetres(rawSummary.length, units) };

  // Valhalla may return alternates as extra top-level trips or nested alongside
  // the primary; accept either so traffic comparison has something to work with.
  const alternates: Route[] = [];
  const root = json as { alternatives?: { trip?: { legs?: ValhallaLeg[] } }[] };
  for (const altTrip of root.alternatives ?? []) {
    if (!altTrip?.trip?.legs?.length) continue;
    const alt = parseTrip({ trip: altTrip.trip }, units);
    alternates.push(alt);
  }

  // A multi-leg trip (via/break locations) must be drawn and snapped as one
  // continuous line, or navigation silently ignores every leg after the first.
  // Consecutive legs meet at the break coordinate, which both include, so drop
  // the repeat -- but only when the points genuinely coincide, otherwise a real
  // gap between legs would be closed by silently discarding a coordinate.
  const geometry: LatLng[] = [];
  for (const leg of legs) {
    for (const [i, p] of leg.geometry.entries()) {
      const prev = geometry[geometry.length - 1];
      if (i === 0 && prev && Math.abs(prev[0] - p[0]) < 1e-9 && Math.abs(prev[1] - p[1]) < 1e-9) {
        continue;
      }
      geometry.push(p);
    }
  }

  return {
    geometry,
    legs,
    maneuvers: legs[0].maneuvers,
    summary,
    ...(alternates.length ? { alternates } : {}),
    units: (trip.units as 'km' | 'miles') ?? units,
    engine: 'valhalla',
  };
}

/** Call a Valhalla `/route` endpoint. */
export async function routeOnValhalla(
  req: RouteRequest,
  endpoint = VALHALLA_ENDPOINT,
  extraHeaders?: Record<string, string>,
  /** Caller-side cancellation, composed with the built-in timeout. */
  signal?: AbortSignal,
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

  if (typeof req.alternates === 'number' && req.alternates > 0) {
    body.alternates = req.alternates;
  }

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
    res = await fetchWithTimeout(`${endpoint.replace(/\/$/, '')}/route`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Id': CLIENT_ID,
        ...(extraHeaders ?? {}),
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    // `fetchWithTimeout` already produces a specific message for a timeout;
    // only a bare network failure needs the generic one.
    if (e instanceof RoutingError) throw e;
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
export async function valhallaStatus(
  endpoint = VALHALLA_ENDPOINT,
  signal?: AbortSignal,
): Promise<{ ok: boolean; version?: string }> {
  try {
    const res = await fetchWithTimeout(`${endpoint.replace(/\/$/, '')}/status`, { headers: { 'X-Client-Id': CLIENT_ID }, signal });
    if (!res.ok) return { ok: false };
    const j = (await res.json()) as { version?: string };
    return { ok: true, version: j.version };
  } catch {
    return { ok: false };
  }
}
