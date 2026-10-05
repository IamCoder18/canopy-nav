/**
 * Routing provider abstraction.
 *
 * The app is offline-first but may regain connectivity mid-trip, so routing is
 * a *chain* of providers rather than a single endpoint:
 *
 *   local (.osm graph, always available)
 *     -> online Valhalla presets (used only when a network route is better)
 *
 * Once a route is fetched it is snapshotted into memory: maneuvers, geometry,
 * ETA and every intermediate leg are all resolved client-side. Losing signal
 * mid-trip therefore degrades gracefully — guidance continues, traffic and
 * rerouting become unavailable, and the UI says so instead of breaking.
 */

import type { LatLng } from '../geo';
import {
  routeOnValhalla,
  valhallaStatus,
  RoutingError,
  type Costing,
  type Route,
} from './valhalla';
import { routeOnGraph, type OsmDataset, type RouteResult } from '../osm/engine.worker';

export type ProviderId = 'local' | 'valhalla-fossgis' | 'valhalla-simplerouting' | 'valhalla-custom';

export interface Provider {
  id: ProviderId;
  label: string;
  subtitle: string;
  /** Requires connectivity. */
  online: boolean;
  endpoint: string;
  /** Extra headers, e.g. the bearer token simplerouting.io requires. */
  headers?: Record<string, string>;
  requiresKey?: boolean;
}

export const PROVIDERS: readonly Provider[] = [
  {
    id: 'local',
    label: 'Offline (.osm)',
    subtitle: 'Routes from your imported map. No network needed.',
    online: false,
    endpoint: '',
  },
  {
    id: 'valhalla-fossgis',
    label: 'Valhalla — FOSSGIS',
    subtitle: 'Public community demo server. Best quality, rate-limited.',
    online: true,
    endpoint: 'https://valhalla1.openstreetmap.de',
  },
  {
    id: 'valhalla-simplerouting',
    label: 'Valhalla — Simplerouting.io',
    subtitle: 'Hosted Valhalla. Requires an API key.',
    online: true,
    endpoint: 'https://api.simplerouting.io/valhalla',
    requiresKey: true,
    headers: { Authorization: '' },
  },
  {
    id: 'valhalla-custom',
    label: 'Valhalla — custom',
    subtitle: 'Point at your own valhalla_service instance.',
    online: true,
    endpoint: '',
  },
];

export interface RouteRequest {
  from: LatLng;
  to: LatLng;
  costing?: Costing;
  units?: 'km' | 'miles';
  avoid?: LatLng[][];
  provider: ProviderId;
  /**
   * Ordered engines to try, best first.
   *
   * Optional so the single-provider call shape stays valid: when absent the plan
   * is derived from `provider` exactly as it behaved before plans existed (an
   * online provider still falls through to the local engine).
   */
  plan?: ProviderId[];
  /**
   * Treat the plan as the whole world: never append the offline engine, and fail
   * with an explanation rather than a generic "no route".
   *
   * Walking *within* the plan is still allowed — that is what `any-online` means,
   * since its plan is three hosted engines and stopping at the first failure
   * would make the choice a lie.
   */
  strict?: boolean;
}

/** What happened to one engine during a route request. */
export type AttemptOutcome = 'served' | 'failed' | 'skipped' | 'not-tried';

/**
 * One row of the engine trace.
 *
 * Every engine on the plan gets a row, including the ones never reached
 * (`not-tried`). A trace that only lists what was tried cannot answer "why did
 * it use that engine", which is the question this whole record exists to answer.
 */
export interface EngineAttempt {
  engine: ProviderId;
  label: string;
  online: boolean;
  outcome: AttemptOutcome;
  /** Why it was skipped or failed. Null only when it served the route. */
  reason: string | null;
  /** Wall-clock cost, when an attempt was actually made. */
  ms: number | null;
}

export type RouteAttempt =
  | { provider: ProviderId; ok: true; route: Route }
  | { provider: ProviderId; ok: false; reason: string; fatal: boolean };

export interface RouteOutcome {
  route: Route;
  /** Which provider actually served it. */
  used: ProviderId;
  /** Providers that were tried and failed, for the UI banner. */
  degraded: { provider: ProviderId; reason: string }[];
  /** Every engine on the plan and what became of it, in order. */
  attempts: EngineAttempt[];
  /**
   * True when the engine that answered was not the one that was asked for.
   *
   * Worth showing on its own: the route is valid, but it came from somewhere
   * other than where the driver pointed, and its capabilities differ (the local
   * engine has no maneuvers, so turn-by-turn is simply absent).
   */
  fellBack: boolean;
}

export class NoRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoRouteError';
  }
}

/**
 * Normalise the local engine's output into the shared `Route` shape.
 *
 * The bbox is reduced with a loop rather than `Math.min(...geometry.map(...))`:
 * spreading one argument per point exceeds the engine's argument limit at
 * roughly 125 000 points, which a provincial extract reaches easily — and this
 * function runs in the *offline fallback*, so a stack overflow here would take
 * down the very path that exists to keep the trip alive.
 */
export function localToRoute(r: RouteResult, units: 'km' | 'miles'): Route {
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
  for (const [lon, lat] of r.geometry) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  if (!r.geometry.length) { minLat = minLon = 0; maxLat = maxLon = 0; }

  const summary = {
    length: r.metres,
    time: r.time,
    min_lat: minLat,
    min_lon: minLon,
    max_lat: maxLat,
    max_lon: maxLon,
  };
  return {
    geometry: r.geometry,
    legs: [{ geometry: r.geometry, maneuvers: [], summary }],
    maneuvers: [],
    summary,
    units,
    engine: 'osm-local',
  };
}

/** True if we plausibly have connectivity. Cheap, no round-trip. */
export function isOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
}

export type ConnectivityListener = (online: boolean) => void;

/**
 * Observe connectivity. `navigator.onLine` only reports link state, so we also
 * treat any network failure during routing as an offline signal.
 */
export function watchConnectivity(cb: ConnectivityListener): () => void {
  const up = () => cb(true);
  const down = () => cb(false);
  window.addEventListener('online', up);
  window.addEventListener('offline', down);
  return () => {
    window.removeEventListener('online', up);
    window.removeEventListener('offline', down);
  };
}

/**
 * Resolve a route, walking an ordered plan of engines.
 *
 * The plan is the visibility surface and the fallback policy in one: each engine
 * is tried in turn, every outcome recorded, and the engine that actually
 * answered is reported as `used` — never the one that was asked for. `strict`
 * stops the walk after the first real attempt so a pinned engine fails loudly
 * instead of quietly answering from somewhere else.
 */
export async function resolveRoute(
  req: RouteRequest,
  dataset: OsmDataset | null,
  providerState: { endpoint?: string; apiKey?: string },
): Promise<RouteOutcome> {
  const units = req.units ?? 'km';
  const strict = req.strict ?? false;
  const meta = (id: ProviderId) => PROVIDERS.find((p) => p.id === id);

  // Preserve the pre-plan call shape: an online provider still falls through to
  // the local engine, a local one never does.
  // Normalise unknown ids to the offline engine, which is what an unrecognised
  // provider has always meant: no route is better than a crash.
  const plan: ProviderId[] = (req.plan?.length
    ? req.plan
    : meta(req.provider)?.online
      ? [req.provider, 'local' as ProviderId]
      : [req.provider]
  ).map((id) => (meta(id) ? id : ('local' as ProviderId)));

  const attempts: EngineAttempt[] = plan.map((engine) => ({
    engine,
    label: meta(engine)?.label ?? engine,
    online: meta(engine)?.online ?? false,
    outcome: 'not-tried',
    reason: null,
    ms: null,
  }));
  const degraded: { provider: ProviderId; reason: string }[] = [];
  /**
   * `degraded` is what the UI banner shows, so it stays narrow: only the reasons
   * that actually cost something — a request we could not make because there was
   * no link, or no key. Everything else (a missing endpoint, an engine that
   * simply lost) is recorded on the attempt row, which is the surface built to
   * hold detail the banner has no room for.
   */
  const skip = (row: EngineAttempt, reason: string, report = false) => {
    row.outcome = 'skipped';
    row.reason = reason;
    if (report) degraded.push({ provider: row.engine, reason });
  };

  for (let i = 0; i < plan.length; i++) {
    const id = plan[i];
    const row = attempts[i];
    const provider = meta(id)!;

    if (provider.online) {
      const endpoint = id === 'valhalla-custom' ? (providerState.endpoint ?? '') : provider.endpoint;

      // Don't send a request we know cannot succeed: a hosted provider that
      // needs a key and has none would otherwise come back 401 and surface as a
      // server error instead of "API key required".
      if (!isOnline()) skip(row, 'No network connection', true);
      else if (provider.requiresKey && !providerState.apiKey) skip(row, 'API key required', true);
      else if (!endpoint) skip(row, 'No endpoint configured');
      else {
        const t0 = Date.now();
        try {
          const route = await routeOnValhalla(
            { from: req.from, to: req.to, costing: req.costing, units, avoid: req.avoid },
            endpoint,
            id === 'valhalla-simplerouting' && providerState.apiKey
              ? { Authorization: `Bearer ${providerState.apiKey}` }
              : undefined,
          );
          row.outcome = 'served';
          row.ms = Date.now() - t0;
          return { route, used: id, degraded, attempts, fellBack: degraded.length > 0 || i > 0 };
        } catch (err) {
          const reason =
            err instanceof RoutingError ? err.message : (err as Error).message || 'Routing request failed';
          row.outcome = 'failed';
          // `message` is what the driver reads; `detail` is the server's own
          // words. The trace is the surface a person debugging this app reads,
          // so it gets both — but the raw text never becomes the headline.
          row.reason = err instanceof RoutingError && err.detail
            ? `${reason} (${err.detail})`
            : reason;
          row.ms = Date.now() - t0;
          degraded.push({ provider: id, reason });

          // A 4xx from Valhalla is a bad request, not a network problem, so
          // trying the offline engine would only produce a second wrong answer.
          const fatal = err instanceof RoutingError && typeof err.status === 'number' &&
            err.status < 500 && err.status !== 429;
          // Every driver-facing reason is a complete sentence, so appending a
          // full stop unconditionally produced "...for this pair.." in a red
          // card. Composed through `withStop` so the punctuation is a
          // property of the reason, not a guess at the call site.
          if (fatal) throw new NoRouteError(withStop(reason));
        }
      }
    } else {
      const t0 = Date.now();
      const r = dataset ? routeOnGraph(dataset.graph, req.from, req.to) : null;
      if (r) {
        row.outcome = 'served';
        row.ms = Date.now() - t0;
        return {
          route: localToRoute(r, units),
          used: id,
          degraded,
          attempts,
          fellBack: degraded.length > 0 || i > 0,
        };
      }
      row.outcome = 'failed';
      row.ms = Date.now() - t0;
      row.reason = dataset
        ? 'No route in the offline map for this pair'
        : 'No offline map loaded';
    }
  }

  // With fallback off the offline engine was never consulted, so the old closing
  // message ("no route found in the offline map") would blame a map that was
  // never asked. Say what actually happened instead.
  throw new NoRouteError(
    strict
      ? degraded[0]?.reason
        ? `${withStop(degraded[0].reason)} Fallback is off, so no other engine was tried.`
        : 'The selected engine could not route. Fallback is off, so no other engine was tried.'
      : degraded.length
        ? `${withStop(degraded[0].reason)} No route found in the offline map for this pair.`
        : 'No route found. Import an .osm file covering this area, or connect to the network.',
  );
}

/** Check whether a provider is currently usable, for the settings screen. */
/**
 * One terminal full stop, whatever the reason already ends with.
 *
 * Reasons are complete sentences assembled from several sources — this app's
 * own, Valhalla's, and `RoutingError.message` — and the punctuation was
 * previously decided at the call site (`${reason}.`), which printed
 * "…for this pair.." every time a translated server message was fatal. Two
 * sentences composed together need the same treatment as one, so both the
 * single-sentence and two-sentence paths use this.
 */
const withStop = (s: string) => `${s.replace(/[.\s]+$/, '')}.`;

export async function probeProvider(p: Provider, state: { endpoint?: string; apiKey?: string }) {
  if (!p.online) return { ok: true, detail: 'Always available' };
  const endpoint = p.id === 'valhalla-custom' ? (state.endpoint ?? '') : p.endpoint;
  if (!endpoint) return { ok: false, detail: 'No endpoint configured' };
  if (p.requiresKey && !state.apiKey) return { ok: false, detail: 'API key required' };
  const s = await valhallaStatus(endpoint);
  return s.ok
    ? { ok: true, detail: s.version ? `Valhalla ${s.version}` : 'Reachable' }
    : { ok: false, detail: 'Unreachable' };
}
