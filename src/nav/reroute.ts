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
 *
 * This module owns the *policy* around those primitives: when to act, how long
 * to wait afterwards, and what to tell the driver. It is deliberately pure and
 * separate from `offroute.ts` so the decisions can be tested without React,
 * timers or a network.
 *
 * The invariants, in priority order:
 *
 *   1. A reroute never removes guidance. The existing route stays on screen and
 *      on the map until a replacement exists. A driver who is lost is exactly
 *      the driver who cannot afford a blank screen.
 *   2. One attempt at a time. Concurrent reroutes from successive fixes would
 *      race, and the loser would overwrite the winner.
 *   3. Back off after failure. If the engine cannot route, retrying every few
 *      seconds drains the battery and will not start working on its own.
 *   4. A *silent* hold is not a hold. When the policy declines to act it has to
 *      say why in words the driver can act on, because "nothing happened" on a
 *      navigation screen is indistinguishable from a frozen app.
 */

import { formatDistance, haversine, type LatLng } from '../geo';
import {
  createTracker,
  distanceToRouteAhead,
  rerouteOrigin,
  updateTracker,
  type OffRouteTracker,
} from './offroute';

export type RerouteStatus =
  /** On the route, nothing to do. */
  | 'idle'
  /** Off the tolerance band but not yet for long enough to act on. */
  | 'suspect'
  /** Confirmed off-route; a request is in flight. */
  | 'rerouting'
  /** Confirmed off-route, but the engine could not produce a route. */
  | 'failed';

export interface RerouteState {
  tracker: OffRouteTracker;
  status: RerouteStatus;
  /** A reroute is in flight. */
  busy: boolean;
  /** Consecutive failed attempts; drives the backoff. */
  failures: number;
  /** When the last attempt finished, for the cooldown. */
  lastFinished: number | null;
  /**
   * Where the last successful reroute started.
   *
   * Kept for the record and the engine trace — it is the point the new route was
   * built from. It is deliberately *not* what the stale-position guard compares;
   * see `lastFix`.
   */
  lastOrigin: LatLng | null;
  /**
   * The raw position that started the last successful reroute.
   *
   * This is what the guard compares against, and the distinction is not cosmetic.
   * `lastOrigin` is a *projection* onto the route line, and a projection is
   * clamped to the line's extent: measured, a driver receding perpendicular from a
   * 3-vertex line projects to the same western endpoint forever, from 111 m of
   * deviation to 594 m. Comparing projections therefore reads "nothing has
   * changed" for a driver who has driven 600 m — indistinguishable from a frozen
   * sensor, which is the one thing the guard exists to catch.
   *
   * The raw fix has no such ceiling, so it is the honest signal for "has the
   * position changed".
   */
  lastFix: LatLng | null;
  /**
   * Why the last attempt failed, kept separately from `message`.
   *
   * `message` is rebuilt on every fix, so it becomes "retrying in 29 s" a second
   * after a failure. That deleted the one actionable line — a dead API key, no
   * offline map — for the whole 30-to-120-second wait. Holding the reason makes
   * it survive, and lets the banner name the cause and the countdown together.
   */
  reason: string | null;
  /** One line for the driver, or null when there is nothing to say. */
  message: string | null;
}

export function createRerouteState(): RerouteState {
  return {
    tracker: createTracker(),
    status: 'idle',
    busy: false,
    failures: 0,
    lastFinished: null,
    lastOrigin: null,
    lastFix: null,
    reason: null,
    message: null,
  };
}

/** Quiet period after a *successful* reroute, so the new line can be driven. */
export const SETTLE_MS = 30_000;

/**
 * First backoff after a failed attempt; doubles up to MAX_BACKOFF_MS.
 *
 * Not lower than SETTLE_MS on purpose. A failed attempt must never be retried
 * *sooner* than a successful one was — an earlier version used 15 s here, which
 * made the first failure shorten the wait. Retrying a dead engine faster than
 * you would settle a fresh route is exactly backwards.
 */
export const MIN_BACKOFF_MS = 30_000;
export const MAX_BACKOFF_MS = 120_000;

/** How long to wait after the last attempt before trying again. */
/**
 * Has the driver's position changed since the last reroute?
 *
 * This is what stops the frozen-position loop. A `watchPosition` that stops
 * delivering — a tunnel, revoked permission, cold GNSS — leaves `location` at its
 * last value while `App` keeps feeding it to `observeFix` as though it were live.
 * The first reroute succeeds, the map reframes, and the same stale fix is still
 * off the *new* line, so the confirmation window elapses again and another
 * request goes out. Measured before this check existed: 20 requests in ten
 * minutes, exactly 30 s apart, with `failures` stuck at zero — so neither the
 * busy latch nor the backoff could help, because every attempt *succeeded* and
 * reset the counter.
 *
 * ## Why "has it moved" and not "is it getting closer"
 *
 * The first version asked `madeProgress`: the candidate start had to be measurably
 * *nearer the destination* than the last one. It closed the loop and it closed it
 * too well — it also silenced the case the banner exists to speak to. A driver who
 * **misses an exit** is genuinely off-route, and their projected start moves *away*
 * from the destination as they continue past the junction, which is exactly the
 * evidence that the position is live. So the app said "Off route — waiting for a
 * position update" to a driver whose positions were arriving perfectly well, and
 * kept saying it for as long as they drove on the wrong road.
 *
 * The distinction the guard is actually for is *frozen* versus *moving*, and
 * movement alone is the honest test. A frozen fix re-projects to the same point
 * every time, so it fails this; a driver travelling at any speed passes it. There
 * is no direction to require, because there is no direction that is right for
 * every driver — half of all off-route corrections involve moving away from the
 * destination.
 *
 * ## Why the raw fix and not the projected start
 *
 * The first version compared two *projections* onto the route line, reasoning that
 * a reroute would be built from the projection, so the projection was the thing
 * being compared. That is wrong in a way only measurement finds: a projection is
 * clamped to the line's extent. Against a 3-vertex route, a driver receding
 * perpendicular from it projects to the **same western endpoint** from 111 m of
 * deviation all the way to 594 m — measured, every step identical after the first.
 *
 * So the projection reads "nothing has changed" for a driver who has driven 600 m,
 * which is indistinguishable from a frozen sensor. The guard then told a driver
 * who was demonstrably moving that it was "waiting for a position update", and
 * kept saying it for the whole drive.
 *
 * `lastFix` therefore holds the raw position, and that is what the guard compares.
 * A driver stationary in a car park jitters by a metre or two and is caught by the
 * 10 m floor; a driver 600 m away from where they were is not.
 */
export function hasMovedSince(before: LatLng, after: LatLng, minMove = 10): boolean {
  return haversine(after, before) >= minMove;
}

export function backoffMs(state: RerouteState): number {
  if (state.failures === 0) return SETTLE_MS;
  return Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** (state.failures - 1));
}

/**
 * Metres until the route line comes back under the driver, for messaging.
 *
 * Only meaningful once the deviation is *confirmed*. Telling someone they are
 * "122 m off the route, rejoining in 700 m" while a single outlier fix is all
 * that has happened would be alarming and wrong.
 */
function rejoinMetres(state: RerouteState, route: LatLng[]): number | null {
  if (state.status !== 'failed' || route.length < 2) return null;
  const d = distanceToRouteAhead(route, state.tracker.snappedIndex);
  return d > 0 ? Math.round(d) : null;
}

export interface ObserveResult {
  state: RerouteState;
  /**
   * True exactly once per confirmed deviation, when a request should be made.
   *
   * The caller must treat this as an edge, not a level: it stays true only for
   * the fix that crosses into `rerouting`, and `busy` latches until the attempt
   * finishes.
   */
  trigger: boolean;
  /** Where to start the new route from — the projected point, never the fix. */
  origin: LatLng | null;
}

/**
 * Advance the policy with a new fix.
 *
 * Pure: takes a state, returns a new one. Nothing here touches the network,
 * which is what makes the storm guards testable — the interesting failures are
 * all about *when not to* act.
 */
export function observeFix(
  state: RerouteState,
  route: LatLng[],
  fix: LatLng,
  speed: number,
  now: number,
): ObserveResult {
  // No route, or a degenerate one: detection is meaningless.
  if (route.length < 2) {
    return {
      state: { ...state, tracker: createTracker(), status: 'idle', message: null },
      trigger: false,
      origin: null,
    };
  }

  const tracker = updateTracker(state.tracker, route, fix, speed, now);

  // A request is already in flight. Keep its status; the caller owns the result.
  if (state.busy) {
    return {
      state: { ...state, tracker, status: 'rerouting', message: state.message },
      trigger: false,
      origin: null,
    };
  }

  if (tracker.state !== 'off-route') {
    const suspect = tracker.state === 'suspect';
    return {
      state: {
        ...state,
        tracker,
        status: suspect ? 'suspect' : 'idle',
        // Qualitatively, not numerically.
        //
        // This used to interpolate raw metres with a hard-coded "m", producing
        // `6978332 m off the route` — an unformatted seven-digit number in a 24px
        // banner, always in metric, on a screen the user had set to imperial.
        //
        // The exact distance is not what a driver acts on; "you have left the
        // route" is. `rerouteBanner` already appends a properly formatted rejoin
        // distance in the user's units, so the precise figure is still available
        // where it is useful and formatted.
        // Qualitatively, and the *reason* beside it once there is one.
        //
        // This used to be a flat `suspect ? 'You have left the route' : null`, and
        // for a driver who *stays* off route that replaced the explanation on the
        // very next fix. Measured in a browser: the first failed reroute showed
        // "Off route — Could not reach the routing server — check your connection"
        // for one fix interval, and every fix after it said only "You have left the
        // route". So the app told the driver why once and then stopped telling them
        // anything, for as long as they drove the wrong way — which is exactly when
        // the reason is most useful.
        //
        // It contradicts `finishReroute`'s own comment, that "the reason outlives the
        // next fix": `reason` is kept in state and `message` is rebuilt every fix, and
        // this branch was the one rebuilding it without consulting `reason`.
        message: !suspect
          ? null
          : state.failures > 0 && state.reason
            ? `You have left the route — ${state.reason}`
            : 'You have left the route',
      },
      trigger: false,
      origin: null,
    };
  }

  // Confirmed. Decide whether it is time to act.
  //
  // The settle/backoff window gates the *policy*; the stale-position guard below
  // gates the *evidence*. They are checked in that order so each has one job:
  // the window is about not hammering an engine, the guard is about not
  // believing a position that has stopped moving.
  const wait = backoffMs(state);
  const elapsed = state.lastFinished === null ? Infinity : now - state.lastFinished;

  // A position that has not moved since the last successful reroute cannot be
  // evidence of a new deviation, however long ago that reroute was. Checked
  // *before* the settle window so the driver is told the real reason immediately
  // rather than being told "settling" for another half-minute.
  //
  // Compared against the raw fix, not the projected origin, and deliberately not
  // against the destination. Both choices were made by measurement; see
  // `hasMovedSince` and `lastFix`.
  if (state.lastFix && !hasMovedSince(state.lastFix, fix)) {
    return {
      state: {
        ...state,
        tracker,
        status: 'suspect',
        message: 'Off route — waiting for a position update',
      },
      trigger: false,
      origin: null,
    };
  }

  if (elapsed < wait) {
    return {
      state: {
        ...state,
        tracker,
        status: state.failures > 0 ? 'failed' : 'suspect',
        // Keep the cause beside the countdown: "API key required · retrying in
        // 28 s" is actionable, where either half alone is not.
        message: state.failures > 0
          ? `Off route — ${state.reason ?? 'no new route'} · retrying in ${Math.ceil((wait - elapsed) / 1000)} s`
          : 'Off route — settling',
        // `reason` is deliberately *not* cleared here. It is the only place the
        // driver is told what went wrong, and the branch above would otherwise
        // discard it one fix after it is set.
      },
      trigger: false,
      origin: null,
    };
  }

  return {
    state: { ...state, tracker, status: 'rerouting', message: 'Off route — finding a new way' },
    trigger: true,
    origin: rerouteOrigin(tracker, route),
  };
}

/**
 * Note that an attempt succeeded.
 *
 * The tracker resets because the next fix must be measured against the *new*
 * line; keeping the old snapped index would put the driver several hundred
 * metres "ahead" on a route they have not started, and the first fix after a
 * reroute would read as instantly off-route.
 */
export function beginReroute(state: RerouteState): RerouteState {
  return { ...state, busy: true, status: 'rerouting', message: 'Off route — finding a new way' };
}

/**
 * Note that an attempt finished, either way.
 *
 * The tracker resets **only on success**, and the asymmetry matters. After a
 * successful reroute the driver is on a brand-new line, so the old snapped index
 * is meaningless. After a *failed* one they are still off the original route, so
 * discarding the tracker would throw away the very evidence that says so — and
 * the app would sit in "suspect" for another confirmation window before admitting
 * it is lost, while the backoff it is actually honouring says otherwise.
 */
export function finishReroute(
  state: RerouteState,
  ok: boolean,
  now: number,
  reason?: string,
  origin?: LatLng,
  fix?: LatLng,
): RerouteState {
  return {
    ...state,
    busy: false,
    tracker: ok ? createTracker() : state.tracker,
    status: ok ? 'idle' : 'failed',
    failures: ok ? 0 : state.failures + 1,
    lastFinished: now,
    // The reason outlives the next fix: `message` alone is rebuilt every fix and
    // becomes a bare countdown a second later.
    // Only a *successful* reroute advances the stale-position baseline. A failed
    // one left the driver where they were, so there is nothing new to compare
    // against and the next check must not fire.
    lastOrigin: ok ? (origin ?? state.lastOrigin) : state.lastOrigin,
    lastFix: ok ? (fix ?? state.lastFix) : state.lastFix,
    reason: ok ? null : (reason ?? 'no new route found'),
    message: ok ? null : `Off route — ${reason ?? 'no new route found'}`,
  };
}

/** Explicitly stop tracking, e.g. when navigation ends or a route is replaced. */
export function resetReroute(): RerouteState {
  return createRerouteState();
}

/**
 * One line for the nav banner, or null when there is nothing worth saying.
 *
 * Silence is a real answer: a driver does not need a banner for every metre of
 * jitter, and a screen that always has something to report trains people to
 * ignore it.
 */
export function rerouteBanner(
  state: RerouteState,
  route: LatLng[],
  units: 'metric' | 'imperial' = 'metric',
): string | null {
  if (state.status === 'idle' || !state.message) return null;
  const ahead = rejoinMetres(state, route);
  if (ahead === null || state.status === 'rerouting') return state.message;
  return `${state.message} · rejoining the route in ${formatDistance(ahead, units)}`;
}