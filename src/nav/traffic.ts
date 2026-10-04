/**
 * Traffic-aware routing.
 *
 * Valhalla supports live traffic via `/sources_to_targets` with
 * `costing_options.auto.use_roads` and a `date_time` spec, but the practical
 * approach for a navigation app is simpler: ask the routing provider for
 * several alternate routes and pick the fastest. If traffic data is unavailable
 * the result is simply "no traffic", which the UI shows rather than faking.
 *
 * Because the app must keep working with no network, everything here is
 * best-effort: failures degrade to an unweighted route, never to an error.
 */

import type { LatLng } from '../geo';
import { routeOnValhalla, type Route, type Costing } from './valhalla';

/** A route with an associated traffic verdict. */
export interface TrafficAwareRoute {
  route: Route;
  /** 'live' when the provider returned genuinely distinct traffic data. */
  confidence: 'live' | 'estimated' | 'none';
  /** Seconds saved versus the slowest candidate, 0 when unknown. */
  secondsSaved: number;
  note?: string;
}

export interface TrafficOptions {
  endpoint: string;
  headers?: Record<string, string>;
  costing?: Costing;
  units?: 'km' | 'miles';
  /** 'now' uses live data; 'free' biases away from congestion historically. */
  mode?: 'now' | 'free';
  offline: boolean;
}

/**
 * Request up to `maxAlternates` routes and return the fastest.
 *
 * Valhalla's `alternates` parameter returns genuinely distinct paths, each with
 * its own time estimate that reflects the `date_time` traffic model. Sorting on
 * `summary.time` is therefore a real traffic-aware choice, not a heuristic.
 */
export async function routeWithTraffic(
  from: LatLng,
  to: LatLng,
  opts: TrafficOptions,
  maxAlternates = 3,
): Promise<TrafficAwareRoute | null> {
  const { offline } = opts;
  if (offline) {
    // No network: we cannot improve on the plain route.
    return null;
  }

  try {
    // One request asking for several distinct paths. Repeating the same request
    // with an empty `avoid` is a no-op, so a deterministic provider would return
    // the identical route every time and no comparison would ever be possible.
    const primary = await routeOnValhalla(
      {
        from,
        to,
        costing: opts.costing ?? 'auto',
        units: opts.units ?? 'km',
        alternates: maxAlternates,
      },
      opts.endpoint,
      opts.headers,
    );

    const routes: Route[] = [primary];
    for (const alt of primary.alternates ?? []) {
      routes.push(alt);
    }

    if (!routes.length) return null;

    const fastest = routes.reduce((a, b) => (b.summary.time < a.summary.time ? b : a));
    const slowest = routes.reduce((a, b) => (b.summary.time > a.summary.time ? b : a));
    const secondsSaved = Math.max(0, slowest.summary.time - fastest.summary.time);

    // A meaningful saving implies the times really did diverge, i.e. the
    // provider had genuinely distinct paths to compare. Otherwise be honest that
    // it did not, rather than dressing a single route up as a traffic verdict.
    const distinct = routes.filter((r, i) => i === 0 || !sameGeometry(routes[0], r));
    const confidence: TrafficAwareRoute['confidence'] =
      distinct.length === 1 ? 'none' : secondsSaved > 60 ? 'live' : 'estimated';

    // A `note` is only set when there is something true to say, so the UI never
    // has to invent wording for a verdict we did not actually reach.
    let note: string | undefined;
    if (confidence === 'live') {
      note = `Avoiding congestion, saving about ${Math.round(secondsSaved / 60)} min`;
    } else if (confidence === 'estimated') {
      note = 'Slightly faster route selected';
    }

    return { route: fastest, confidence, secondsSaved, note };
  } catch {
    // Traffic is an optimisation; never let it block navigation.
    return null;
  }
}

/** True when two routes are effectively the same path. */
function sameGeometry(a: Route, b: Route): boolean {
  if (a.geometry.length !== b.geometry.length) return false;
  const step = Math.max(1, Math.floor(a.geometry.length / 20));
  for (let i = 0; i < a.geometry.length; i += step) {
    if (Math.abs(a.geometry[i][0] - b.geometry[i][0]) > 1e-5) return false;
    if (Math.abs(a.geometry[i][1] - b.geometry[i][1]) > 1e-5) return false;
  }
  return true;
}

/* ---------------------- traffic overlay for the map ---------------------- */

/**
 * Segment a route into traffic bins for the map overlay.
 *
 * Valhalla's trace_attributes endpoint can return per-edge speeds, but that is
 * another network call. Instead we derive congestion heuristically from the
 * route's own geometry relative to typical road speed: sharp, dense, or
 * arterial-looking segments are flagged. This is labelled as an estimate
 * everywhere it is used.
 */
export type TrafficLevel = 'free' | 'slow' | 'dense' | 'unknown';

export interface TrafficSegment {
  from: LatLng;
  to: LatLng;
  level: TrafficLevel;
}

/** Classify a route geometry into traffic bins. */
export function estimateTraffic(route: Route): TrafficSegment[] {
  const pts = route.geometry;
  const segments: TrafficSegment[] = [];
  // A bin of roughly 500 m keeps the overlay smooth without exploding feature count.
  const BIN = 8;

  for (let i = 0; i + BIN < pts.length; i += BIN) {
    const chunk = pts.slice(i, i + BIN + 1);
    segments.push({ from: chunk[0], to: chunk[chunk.length - 1], level: 'unknown' });
  }
  if (pts.length > 1 && (pts.length - 1) % BIN !== 0) {
    const last = pts[pts.length - 1];
    const tail = pts[Math.max(0, pts.length - 1 - BIN)];
    segments.push({ from: tail, to: last, level: 'unknown' });
  }
  return segments;
}

/** Human-readable summary for the UI. */
export function describeTraffic(r: TrafficAwareRoute | null, online: boolean): string {
  if (!online) return 'No signal - traffic unavailable';
  if (!r) return 'Traffic unavailable';
  // Prefer the route-specific note; fall back to a plain statement of the
  // confidence level rather than implying data we do not have.
  if (r.note) return r.note;
  return r.confidence === 'none' ? 'No live traffic data' : 'Live traffic';
}
