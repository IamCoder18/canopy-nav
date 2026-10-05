/**
 * How far along the route the car is, and how much is left.
 *
 * The ETA bar is the most dangerous readout in the app: a driver does not
 * double-check it, they act on it. It used to be derived from a *single*
 * projection of the *current* fix onto the route line, which made it wrong in
 * two independent ways, both observed in the real app:
 *
 *  1. **It could go backwards.** "Remaining" was recomputed from scratch on
 *     every fix, from whichever part of the line happened to be nearest. A route
 *     that doubles back — a real U-turn, an overpass, two carriageways of one
 *     road — has two near-equal candidates, and the nearer one can be *behind*
 *     the driver. The remaining distance then increased while the car was
 *     driving forwards: measured flipping between `0 m` and `670 m` on a 36 m
 *     move.
 *  2. **It read `0 m` while the driver was 900 m off course.** Beyond the
 *     off-route threshold, "closest point on the route" stops being a fact
 *     about where the car is and becomes an arbitrary point on a line. If that
 *     arbitrary point happened to be near the end, the bar said the driver had
 *     arrived. The progress path already refused to trust such a fix; the ETA
 *     path did not check, so the two disagreed and the bar was the one that lied.
 *
 * So this module is deliberately *policy* and holds no geometry of its own beyond
 * what it needs, mirroring the split in `nav/reroute.ts` and `nav/engines.ts`:
 * every judgement that could be wrong is a pure function over a plain state,
 * testable without React, timers, a map or a network.
 *
 * Three properties, in priority order:
 *
 *  1. **Never reads zero before the last vertex.** Zero remaining means arrived.
 *  2. **Never increases as the car drives forward.** You cannot un-drive a road.
 *  3. **When the fix is untrustworthy, keep the last number.** Blanking true
 *     information is worse than showing it with a caveat — the same reasoning
 *     that keeps verified traffic when signal drops (§3.7). But it is never
 *     *invented* from a fix that was too far away to place.
 */

import { lineLength, snapAlong, type LatLng } from '../geo';

/** Where the car is on the route, and what is left of it. */
export interface RoutePosition {
  /** Metres from the start of the route to the car. Monotonically non-decreasing. */
  along: number;
  /** Metres of route still to drive. Zero only once the car is at the end. */
  remaining: number;
  /** Metres from the car to the route line, for this fix. */
  deviation: number;
  /**
   * Whether the last fix was close enough to the line to place the car with.
   *
   * False means `along` and `remaining` are the last trustworthy values, not
   * values derived from the current fix.
   */
  onRoute: boolean;
}

/** The position of a car that has not moved: at the very start, with all of it left. */
export function startPosition(line: LatLng[]): RoutePosition {
  return { along: 0, remaining: lineLength(line), deviation: 0, onRoute: true };
}

/**
 * Remaining distance for a car `along` metres up the route.
 *
 * Property 1 lives here, structurally: a car that is short of the end is always
 * left a real, positive distance, however close it is. Without this the float
 * residue of `total - along` reaches the display layer and formats as `0 m` —
 * and `0 m` is a claim, not an approximation.
 */
export function remainingFrom(line: LatLng[], along: number): number {
  const total = lineLength(line);
  if (line.length < 2) return 0;
  const clamped = Math.max(0, Math.min(total, along));
  const left = total - clamped;
  // A car short of the end always has distance left to report.
  return left > 0 ? Math.max(left, MIN_REPORTABLE_REMAINING_M) : 0;
}

/**
 * The smallest remaining distance worth reporting, in metres.
 *
 * Below this the number is noise against GPS accuracy: a 5 m readout on a fix
 * that is ±10 m is a number the driver cannot act on, and it is what makes an
 * "almost there" state look like an arrived one. Rounded *up* deliberately, so
 * the reported distance never understates what is left.
 */
export const MIN_REPORTABLE_REMAINING_M = 1;

/**
 * Place a fix on the route, subject to the three properties above.
 *
 * @param line      route geometry
 * @param fix       the current position
 * @param prev      the previous placement — the memory that makes `along` monotonic
 * @param threshold metres off the line beyond which a fix cannot place the car
 */
export function placeOnRoute(
  line: LatLng[],
  fix: LatLng,
  prev: RoutePosition,
  threshold: number,
): RoutePosition {
  if (line.length < 2) return { along: 0, remaining: 0, deviation: 0, onRoute: true };

  const snap = snapAlong(fix, line);

  // Property 3: too far off the line to say where on it the car is. Keep the
  // last trustworthy placement and report the deviation, so the caller can
  // raise the off-route banner without the ETA inventing a position.
  if (snap.dist > threshold) {
    return { ...prev, deviation: snap.dist, onRoute: false };
  }

  // Property 2: a road already driven stays driven. GPS jitter, a stale fix and
  // a doubling-back route all present a candidate behind the car; none of them
  // un-drives it. Note the deviation is still reported from this fix, so a
  // driver who is genuinely off course is still told, rather than having the
  // monotonic clamp hide the deviation.
  const along = Math.max(prev.along, snap.along);
  return {
    along,
    remaining: remainingFrom(line, along),
    deviation: snap.dist,
    onRoute: true,
  };
}
