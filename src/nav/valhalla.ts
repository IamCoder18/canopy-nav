import { decodePolyline, PolylineError, type LatLng } from '../geo';

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
  /**
   * The server's own words, kept alongside the message shown to the driver.
   *
   * `readError` used to hand Valhalla's `error` string straight through, so the
   * route preview displayed
   *
   *   > Path distance exceeds the max distance limit: 1500000 meters.
   *
   * in a red card. That is an upstream developer's sentence about an
   * implementation limit; it names no place, no cause the driver can act on,
   * and no next step. The raw text is genuinely useful, just not *to them* —
   * so it is carried here for the engine trace, which is the surface a person
   * debugging this app actually reads, while `message` becomes something a
   * driver can act on.
   */
  constructor(message: string, readonly status?: number, readonly detail?: string) {
    super(message);
    this.name = 'RoutingError';
  }
}

/**
 * Valhalla `error_code` values that a driver can be told something about.
 *
 * From Valhalla's `TripLeg`/`PathEdge` error table. Codes not listed fall
 * through to `HTTP <status>`, which is honest rather than invented: this app
 * does not know what a code it has never seen means.
 *
 * The right-hand column is the driver's problem, not Valhalla's: pick a pair of
 * places closer together, use the offline map, or try another engine.
 */
const VALHALLA_ERRORS: Record<number, string> = {
  100: 'The routing server rejected the request as malformed.',
  101: 'The routing server could not read the request.',
  110: 'The routing server rejected the request URL.',
  125: 'The routing server could not read the request body.',
  154: 'That trip is longer than the routing server will plan. Pick a closer destination, or use the offline map.',
  155: 'The routing server cannot plan a route with no start or destination.',
  156: 'That trip is longer than the routing server will plan. Pick a closer destination, or use the offline map.',
  157: 'That route has more turns than the routing server will plan. Split the trip into shorter legs.',
  160: 'The routing server could not plan that route.',
  161: 'The routing server could not find a path between those points.',
  171: 'No route found between those points on this server. Try another engine, or use the offline map.',
  172: 'The routing server found no alternative routes.',
  442: 'The routing server could not find a road to snap the start or destination to.',
  443: 'The destination is too close to the start to route.',
};

/**
 * Status codes worth naming on their own.
 *
 * 429 is here because it is the one failure where the driver knows something
 * useful: the server is rate-limiting, not refusing the trip. Valhalla does not
 * send an `error_code` for it, and the generic "the routing server refused this
 * route" would turn a five-second wait into an apparent dead end.
 */
const ROUTING_STATUS: Record<number, string> = {
  429: 'The routing server is busy and is limiting requests. Try again in a moment, or use the offline map.',
};

/**
 * Turn an upstream failure into a sentence a driver can act on.
 *
 * Prefers the documented `error_code`, then a phrase match on the raw text for
 * servers that do not send one, and never echoes the upstream string verbatim
 * into the UI.
 */
export function describeRoutingFailure(status: number, code: number | null, raw: string): string {
  const known = code !== null ? VALHALLA_ERRORS[code] : undefined;
  if (known) return known;
  // Checked before the phrase match: a rate limit's own wording ("too many
  // requests") is not in the phrase list, but its *status* is unambiguous.
  const byStatus = ROUTING_STATUS[status];
  if (byStatus) return byStatus;

  // Servers vary in whether they send `error_code`. A phrase match covers the
  // common shapes without pretending to have read the whole table.
  const text = raw.toLowerCase();
  if (/max distance|exceeds the max/.test(text))
    return 'That trip is too long for the routing server to plan. Pick a closer destination, or use the offline map.';
  if (/no path|no route|no edges|not connected|cannot find/.test(text))
    return 'No route found between those points on this server. Try another engine, or use the offline map.';
  if (/origin|destination|snap/.test(text))
    return 'The routing server could not match the start or destination to a road.';
  if (/maneuver|turn limit/.test(text))
    return 'That route has too many turns to plan. Split the trip into shorter legs.';

  // Nothing recognisable: say what actually happened, not what we guessed.
  return `The routing server refused this route (HTTP ${status}). Try another engine, or use the offline map.`;
}

/** Valhalla returns 400 with a JSON body on failure. */
async function readError(res: Response): Promise<{ message: string; detail: string }> {
  let raw = `HTTP ${res.status}`;
  let code: number | null = null;
  try {
    const j = (await res.json()) as { error?: string; error_code?: number; status_code?: number };
    if (typeof j.error === 'string' && j.error.trim()) raw = j.error.trim();
    if (typeof j.error_code === 'number') code = j.error_code;
    else if (typeof j.status_code === 'number') code = j.status_code;
  } catch {
    // Not JSON. The status line is all there is.
  }
  return { message: describeRoutingFailure(res.status, code, raw), detail: raw };
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
  const legs = trip.legs.map((leg) => {
    let geometry: LatLng[];
    try {
      geometry = decodePolyline(leg.shape, 6);
    } catch (e) {
      // A cut polyline is not a route. Left alone it decoded to `[NaN, NaN]`,
      // which the ETA bar formatted as "NaN hr NaN min" and the off-route
      // tracker read as `dist: Infinity` — so the app showed a corrupt distance
      // and then asked for a new route forever, without ever reporting a fault.
      throw new RoutingError(
        'The routing server sent an incomplete route. Try again, or use the offline map.',
        undefined,
        e instanceof PolylineError ? e.message : String(e),
      );
    }
    // A single-point geometry is degenerate but not corrupt, and the app already
  // handles it honestly: `guidance` returns null for a line under two points
  // rather than inventing turns, and `snapToPolyline` reports a distance of 0
  // instead of Infinity. Refusing here would turn a case that degrades into one
  // that fails, so it is deliberately left alone — the decode failure above is
  // the case that silently produces a *wrong* answer.
  return {
    geometry,
      // Absent rather than malformed on a healthy response, but a server that
      // omits it must not turn into `undefined` reaching the guidance model,
      // which walks `maneuvers` as an array.
      maneuvers: Array.isArray(leg.maneuvers) ? leg.maneuvers : [],
      summary: leg.summary,
    };
  });

  // Normalise to metres once, here, so no consumer has to know which engine or
  // unit produced a length — and refuse a summary that is missing rather than
  // inventing one. See `requireSummary`.
  const summary = requireSummary(trip.summary ?? legs[0].summary, units);

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

  if (!res.ok) {
    const { message, detail } = await readError(res);
    throw new RoutingError(message, res.status, detail);
  }

  // `res.json()` rejects with a bare `SyntaxError` on a body that stops part-way
  // through, which reached the driver as "Unexpected end of JSON input" — a
  // sentence about the HTTP client's internals, for a failure whose real cause is
  // a transfer that did not finish.
  // `body` above is the request; this is the response. Named apart because a
  // truncated body is the failure this whole block exists for.
  let payload: unknown;
  try {
    payload = await res.json();
  } catch (e) {
    throw new RoutingError(
      'The reply from the routing server was cut short. Check your connection and try again.',
      res.status,
      e instanceof Error ? e.message : String(e),
    );
  }
  return parseTrip(payload, units);
}

/**
 * A summary that is actually a summary.
 *
 * Measured, because the alternative was a guess: a response whose `trip.summary`
 * carries a length and no `time` produced `summary.time === undefined`, and every
 * comparison against `undefined` is false, so the ETA bar fell through to the
 * arithmetic and printed `NaN hr NaN min`. A response with no summary anywhere
 * threw a `TypeError` on `rawSummary.length`, which reached the driver as an
 * internal message about an object being undefined.
 *
 * Both are *missing* rather than malformed, and this is the last place that can
 * tell the difference. What it cannot do is invent a duration, so a route with no
 * usable summary is refused instead: the offline engine is the fallback, and a
 * route whose arrival time is unknown is better than one that claims `NaN`.
 */
function requireSummary(
  raw: ValhallaLeg['summary'] | undefined,
  units: 'km' | 'miles',
): ValhallaLeg['summary'] {
  if (!raw || typeof raw !== 'object') {
    throw new RoutingError(
      'The routing server sent a route with no summary, so its arrival time is unknown. ' +
      'Try another engine, or use the offline map.',
      undefined,
      'trip.summary and every leg summary were absent',
    );
  }
  const length = Number(raw.length);
  if (!Number.isFinite(length) || length < 0) {
    throw new RoutingError(
      'The routing server sent a route with an unreadable distance. ' +
      'Try another engine, or use the offline map.',
      undefined,
      `summary.length was ${JSON.stringify(raw.length)}`,
    );
  }
  const time = Number(raw.time);
  /**
   * A missing time stays missing: `NaN`, deliberately, not a `0`.
   *
   * `0` would be a claim — `<1 min` for a two-hour drive. `NaN` is inert in every
   * consumer, because `NaN || fallback` is the fallback (`NaN` is falsy), so the
   * progress tick falls back to 1 and the remaining-seconds product to 0, while
   * `formatDuration` prints `—` rather than a duration nobody measured. The
   * geometry is good and the trip is worth showing; only the ETA is unknown.
   */
  return {
    ...raw,
    length: lengthToMetres(length, units),
    time: Number.isFinite(time) ? time : NaN,
  };
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
