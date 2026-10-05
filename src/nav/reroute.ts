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
   * Compared against the next candidate reroute's origin by `madeProgress`, so a
   * position that has stopped moving cannot keep triggering requests.
   */
  lastOrigin: LatLng | null;
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
 * Did the last reroute actually move the driver toward the destination?
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
 * Requiring forward progress closes it. A reroute whose start is not nearer the
 * destination than the previous start's is not evidence the driver is lost; it is
 * evidence the fix is stale. Measured in metres rather than shape index, because
 * a stale fix sits at the same snapped index indefinitely.
 */
export function madeProgress(
  before: LatLng,
  after: LatLng,
  destination: LatLng,
  minGain = 10,
): boolean {
  return haversine(after, destination) <= haversine(before, destination) - minGain;
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
  destination?: LatLng,
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
        message: suspect ? 'You have left the route' : null,
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

  // A position that has not advanced since the last successful reroute cannot be
  // evidence of a new deviation, however long ago that reroute was. Checked
  // *before* the settle window so the driver is told the real reason immediately
  // rather than being told "settling" for another half-minute.
  if (state.lastOrigin && destination) {
    const candidate = rerouteOrigin(tracker, route);
    if (!madeProgress(state.lastOrigin, candidate, destination)) {
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
    // one left the driver where they were, so there is no new origin to compare
    // against and the next check must not fire.
    lastOrigin: ok ? (origin ?? state.lastOrigin) : state.lastOrigin,
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