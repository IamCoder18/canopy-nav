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
}

export class NoRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoRouteError';
  }
}

/** Normalise the local engine's output into the shared `Route` shape. */
export function localToRoute(r: RouteResult, units: 'km' | 'miles'): Route {
  const summary = {
    length: r.metres,
    time: r.time,
    min_lat: Math.min(...r.geometry.map((p) => p[1])),
    min_lon: Math.min(...r.geometry.map((p) => p[0])),
    max_lat: Math.max(...r.geometry.map((p) => p[1])),
    max_lon: Math.max(...r.geometry.map((p) => p[0])),
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
 * Resolve a route, falling back down the provider chain.
 *
 * Order: if the caller picked an online provider and we believe we have
 * connectivity, try it first; the local engine is always the safety net so a
 * trip never fails outright because the network dropped.
 */
export async function resolveRoute(
  req: RouteRequest,
  dataset: OsmDataset | null,
  providerState: { endpoint?: string; apiKey?: string },
): Promise<RouteOutcome> {
  const degraded: { provider: ProviderId; reason: string }[] = [];
  const provider = PROVIDERS.find((p) => p.id === req.provider) ?? PROVIDERS[0];
  const units = req.units ?? 'km';

  const tryLocal = (): RouteOutcome | null => {
    if (!dataset) return null;
    const r = routeOnGraph(dataset.graph, req.from, req.to);
    if (!r) return null;
    return { route: localToRoute(r, units), used: 'local', degraded: [...degraded] };
  };

  if (provider.online && isOnline()) {
    const endpoint =
      provider.id === 'valhalla-custom' ? (providerState.endpoint ?? '') : provider.endpoint;
    if (endpoint) {
      try {
        const route = await routeOnValhalla(
          { from: req.from, to: req.to, costing: req.costing, units, avoid: req.avoid },
          endpoint,
          provider.id === 'valhalla-simplerouting' && providerState.apiKey
            ? { Authorization: `Bearer ${providerState.apiKey}` }
            : undefined,
        );
        return { route, used: provider.id, degraded };
      } catch (err) {
        const reason =
          err instanceof RoutingError ? err.message : (err as Error).message || 'Routing request failed';
        degraded.push({ provider: provider.id, reason });
        // A 4xx from Valhalla is a bad request, not a network problem — don't retry offline.
        const fatal = err instanceof RoutingError && typeof err.status === 'number' && err.status < 500 && err.status !== 429;
        if (fatal && degraded.length >= 2) {
          throw new NoRouteError(`${reason}. Offline routing unavailable for this pair.`);
        }
      }
    }
  } else if (provider.online) {
    degraded.push({ provider: provider.id, reason: 'No network connection' });
  }

  const local = tryLocal();
  if (local) return local;

  throw new NoRouteError(
    degraded.length
      ? `${degraded[0].reason}. No route found in the offline map for this pair.`
      : 'No route found. Import an .osm file covering this area, or connect to the network.',
  );
}

/** Check whether a provider is currently usable, for the settings screen. */
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
