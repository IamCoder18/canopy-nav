/**
 * Off-route detection and in-app rerouting.
 *
 * The hard part of "losing the route" is not deciding you are off it, it is
 * not re-routing the driver on every bad GPS reading. A car in a city street
 * canyon will read 30-50 m off the line constantly. So:
 *
 *   - off-route is confirmed only when the deviation exceeds a distance that
 *     scales with speed (at motorway speed you can be 40 m off and perfectly
 *     on course, because GPS error and road width both scale with speed)
 *   - confirmation is sticky for several seconds, so a single bad fix cannot
 *     trigger a reroute
 *   - during rerouting the app keeps the *existing* route and guidance active;
 *     the driver is never left without directions
 */

import { haversine, snapToPolyline, type LatLng } from '../geo';

/** Deviation (metres) beyond which we consider the driver off route. */
export function offRouteThreshold(speed: number): number {
  // 25 m when stationary, growing to ~90 m at 30 m/s (108 km/h).
  return 25 + Math.min(65, speed * 2);
}

/** How long a deviation must persist before we act. */
const CONFIRM_MS = 6000;

export type OffRouteState = 'on-route' | 'suspect' | 'off-route';

export interface OffRouteTracker {
  state: OffRouteState;
  /** Metres from the route line. */
  distance: number;
  /** Index of the closest point on the route. */
  snappedIndex: number;
  /** Suggested new start point: the projected position, not the raw fix. */
  correction: LatLng;
  since: number | null;
}

export function createTracker(): OffRouteTracker {
  return { state: 'on-route', distance: 0, snappedIndex: 0, correction: [0, 0], since: null };
}

/**
 * Advance the tracker with a new fix.
 *
 * @param route current route geometry; an empty route disables detection
 */
export function updateTracker(
  t: OffRouteTracker,
  route: LatLng[],
  fix: LatLng,
  speed: number,
  now: number,
): OffRouteTracker {
  if (route.length < 2) return { ...t, state: 'on-route', distance: 0, since: null };

  const snap = snapToPolyline(fix, route);
  const threshold = offRouteThreshold(speed);

  if (snap.dist > threshold) {
    if (t.state === 'on-route') {
      return { ...t, state: 'suspect', distance: snap.dist, snappedIndex: snap.index, correction: snap.point, since: now };
    }
    const held = t.since !== null && now - t.since >= CONFIRM_MS;
    return {
      ...t,
      state: held ? 'off-route' : 'suspect',
      distance: snap.dist,
      snappedIndex: snap.index,
      correction: snap.point,
      since: t.since,
    };
  }

  // Back within tolerance: clear any suspicion immediately.
  return { ...t, state: 'on-route', distance: snap.dist, snappedIndex: snap.index, correction: snap.point, since: null };
}

/** Progress along the route, 0..1, based on the snapped index. */
export function progressAlong(route: LatLng[], snappedIndex: number): number {
  if (route.length < 2) return 0;
  return Math.max(0, Math.min(1, snappedIndex / (route.length - 1)));
}

/**
 * Reroute from a point near the route rather than the raw fix.
 *
 * Using the snapped projection avoids snapping the new start to the far side of
 * an overpass, which is the classic cause of "rerouted me backwards".
 */
export function rerouteOrigin(track: OffRouteTracker, route: LatLng[]): LatLng {
  // Look a little way ahead along the route so the new route rejoins cleanly.
  const ahead = Math.min(route.length - 1, track.snappedIndex + 3);
  return track.correction && track.state !== 'on-route' ? track.correction : route[ahead] ?? track.correction;
}

/** Distance from the route ahead of the driver, for "rejoin in X m" messaging. */
export function distanceToRouteAhead(route: LatLng[], index: number): number {
  let d = 0;
  for (let i = index; i < route.length - 1; i++) {
    d += haversine(route[i], route[i + 1]);
    if (d > 500) break;
  }
  return d;
}
