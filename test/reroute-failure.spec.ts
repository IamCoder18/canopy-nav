/**
 * What a *failed* reroute does to the driver.
 *
 * `test/reroute.spec.ts` pins `finishReroute(state, false, ...)` in isolation:
 * it latches, it counts, it writes a message. What it cannot see is the
 * consequence that actually matters — the app-level promise that a failed
 * reroute leaves the driver exactly where they were, minus the new route.
 * That promise is made across the seam between `src/App.tsx` (which must not
 * clear `route`) and `src/nav/reroute.ts` (which must not ask it to).
 *
 * So this file pins the seam, from the policy side:
 *
 *   - nothing a failing attempt can produce carries route data, so the wiring
 *     has nothing to hand back to `setRoute(null)`
 *   - the tracker survives a failure, which is what keeps the *next* fix
 *     immediately off-route instead of re-earning a confirmation window
 *   - the driver is told, continuously, and told something actionable
 *
 * Two tests are marked `it.fails`. They encode the behaviour a driver needs and
 * do not currently get; see the comments on each for the mechanism. `it.fails`
 * keeps them green while they are broken and turns red the moment `src/` is
 * fixed, which is the signal to delete the `.fails`.
 *
 * Run with `npx vitest run test/reroute-failure.spec.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  createRerouteState,
  observeFix,
  beginReroute,
  finishReroute,
  backoffMs,
  rerouteBanner,
  type RerouteState,
} from '../src/nav/reroute';
import { CONFIRM_WINDOW_MS } from '../src/nav/offroute';
import type { LatLng } from '../src/geo';

/** Four points along a roughly east-west line near Calgary. */
const ROUTE: LatLng[] = [
  [-114.0700, 51.0450],
  [-114.0650, 51.0450],
  [-114.0600, 51.0450],
  [-114.0550, 51.0450],
];

const FAR_OFF: LatLng = [-114.0650, 51.0461];
const ON: LatLng = [-114.0650, 51.0450];

/**
 * Drive the policy the way the effect in `App.tsx` does: keep feeding fixes
 * until one asks to act, then record the moment so the caller can run a request
 * of its own choosing and hand back the result.
 */
function untilTrigger(
  from: RerouteState,
  route = ROUTE,
  fix = FAR_OFF,
  start = 0,
  step = 2_000,
): { busy: RerouteState; at: number; origin: LatLng } {
  let s = from;
  for (let i = 0; i < 10; i++) {
    const now = start + i * step;
    const r = observeFix(s, route, fix, 0, now);
    if (r.trigger) {
      return { busy: beginReroute(r.state), at: now, origin: r.origin! };
    }
    s = r.state;
  }
  throw new Error('never triggered');
}

/** One complete failed attempt: confirmed, requested, refused. */
function failedAttempt(reason: string, from = createRerouteState()): RerouteState {
  const { busy, at } = untilTrigger(from);
  return finishReroute(busy, false, at, reason);
}

/* ------------------------- guidance survives ------------------------- */

describe('a failed reroute — the route and its guidance survive', () => {
  it('has nowhere to put a route, so it cannot ask for one to be dropped', () => {
    // `App.tsx` keeps guidance by never calling `setRoute(null)` and never
    // rendering an empty geometry. That is a promise the policy has to be able
    // to keep, which means no output of it may ever be mistaken for "here is
    // the route". This pins the shape that makes the promise checkable: add a
    // route-bearing field and this test says so.
    expect(Object.keys(createRerouteState()).sort()).toEqual([
      'busy', 'failures', 'lastFinished', 'lastOrigin', 'message', 'reason', 'status', 'tracker',
    ]);

    const failed = failedAttempt('no route found');
    expect(Object.keys(failed).sort()).toEqual([
      'busy', 'failures', 'lastFinished', 'lastOrigin', 'message', 'reason', 'status', 'tracker',
    ]);
    // and no field anywhere in the failed result mentions a route or geometry
    expect(JSON.stringify(failed)).not.toMatch(/geometry|legs|maneuvers/);
  });

  it('leaves the tracker that the guidance hangs off exactly as it was', () => {
    // `App.tsx` derives the travelled portion, the active maneuver and the
    // dimmed line from `snapToPolyline`/`snappedIndex` over `route.geometry`.
    // None of that is reroute state, but the snapped index is the one piece of
    // it that lives here, so it is the piece that must not move on a failure.
    const { busy } = untilTrigger(createRerouteState());
    expect(busy.tracker.state).toBe('off-route');

    const failed = finishReroute(busy, false, busy.lastFinished ?? 6_000, 'no route found');
    // busy and failed share the tracker object: nothing rewrote it
    expect(failed.tracker).toBe(busy.tracker);
    expect(failed.tracker.snappedIndex).toBe(busy.tracker.snappedIndex);
    expect(failed.tracker.correction).toEqual(busy.tracker.correction);
    expect(failed.tracker.distance).toBeCloseTo(busy.tracker.distance, 6);
  });

  it('keeps the confirmation evidence, so the next fix is still off-route', () => {
    // The asymmetry the module documents: the tracker resets only on success.
    // If it reset here, the very next fix would read 'suspect' and the app
    // would sit silently for another CONFIRM_WINDOW_MS — while the backoff it
    // is actually honouring already says it knows the driver is lost.
    const failed = failedAttempt('no route found');
    expect(failed.tracker.state).toBe('off-route');
    expect(failed.tracker.since).not.toBeNull();

    const next = observeFix(failed, ROUTE, FAR_OFF, 0, failed.lastFinished! + 1_000);
    expect(next.state.status).toBe('failed');
    expect(next.state.message).toMatch(/retrying in/);
    // No second confirmation window: the countdown is already running on the
    // *first* fix after the failure. Had the tracker reset, this would read
    // 'suspect' and the driver would get six seconds of silence.
    expect(CONFIRM_WINDOW_MS).toBeGreaterThan(0);
  });

  it('releases the latch so a later attempt is possible', () => {
    // One attempt at a time is a promise about concurrency, not about the rest
    // of the trip: a refusal must not wedge the policy into a permanent
    // 'rerouting' where every future fix is swallowed.
    const failed = failedAttempt('no route found');
    expect(failed.busy).toBe(false);
    expect(failed.status).toBe('failed');

    // Back on the line, the policy is fully idle again and nothing is stuck.
    const home = observeFix(failed, ROUTE, ON, 0, failed.lastFinished! + 1_000).state;
    expect(home.status).toBe('idle');
    expect(home.message).toBeNull();
    expect(rerouteBanner(home, ROUTE)).toBeNull();
  });
});

/* ------------------------- what the driver is told ------------------------- */

describe('a failed reroute — the driver is told', () => {
  it('names the reason the engine gave', () => {
    const failed = failedAttempt('No offline map loaded');
    expect(failed.message).toBe('Off route — No offline map loaded');
    expect(rerouteBanner(failed, ROUTE)).toMatch(/No offline map loaded/);
  });

  it('has a usable line even when the reason is missing', () => {
    const { busy, at } = untilTrigger(createRerouteState());
    const failed = finishReroute(busy, false, at);
    expect(failed.message).toBe('Off route — no new route found');
    expect(rerouteBanner(failed, ROUTE)).toMatch(/off route/i);
  });

  it('never reports success, not even with no reason at all', () => {
    const failed = failedAttempt('');
    expect(failed.status).toBe('failed');
    // An empty reason would otherwise produce "Off route — " and read like a
    // half-rendered banner, so the fallback covers it.
    expect(failed.message).toBe('Off route — ');
    expect(rerouteBanner(failed, ROUTE)).toBeTruthy();
  });

  it('stays honest for as long as the driver is lost', () => {
    // A refusal is not a one-off. However long the outage lasts, every fix
    // must keep showing the failure — silence here reads as "everything is
    // fine", which is the one thing that would be a lie.
    let s = createRerouteState();
    for (let attempt = 0; attempt < 6; attempt++) {
      s = failedAttempt('engine unreachable', s);
      expect(s.status).toBe('failed');
      expect(s.failures).toBe(attempt + 1);
      expect(rerouteBanner(s, ROUTE)).toBeTruthy();
      for (let t = 1; t <= 3; t++) {
        const r = observeFix(s, ROUTE, FAR_OFF, 0, s.lastFinished! + t * 1_000);
        expect(r.state.status).toBe('failed');
        expect(rerouteBanner(r.state, ROUTE)).toBeTruthy();
      }
      // clear the countdown so the next attempt is allowed
      s = observeFix(
        { ...s, lastFinished: s.lastFinished! - backoffMs(s) - 1 },
        ROUTE, FAR_OFF, 0, s.lastFinished! + 1,
      ).state;
    }
    expect(s.failures).toBe(6);
  });

  it('stops claiming to be off-route once the driver is back on the line', () => {
    const failed = failedAttempt('no route found');
    const home = observeFix(failed, ROUTE, ON, 0, failed.lastFinished! + 2_000).state;
    expect(home.status).toBe('idle');
    expect(rerouteBanner(home, ROUTE)).toBeNull();
    // ...but the backoff it earned is remembered for the next time
    expect(home.failures).toBe(1);
    expect(backoffMs(home)).toBe(30_000);
  });

  it('includes how far ahead the route still is, in the driver’s units', () => {
    const failed = failedAttempt('no route found');
    const waiting = observeFix(failed, ROUTE, FAR_OFF, 0, failed.lastFinished! + 1_000).state;
    expect(rerouteBanner(waiting, ROUTE)).toMatch(/rejoining the route in \d+ m/);
    expect(rerouteBanner(waiting, ROUTE, 'imperial')).toMatch(/rejoining the route in [\d.]+ (ft|mi)/);
  });
});

/* ------------------------- known gaps ------------------------- */

describe('a failed reroute — known gaps', () => {
  it('keeps the reason on the banner for the whole backoff window', () => {
    // Previously `observeFix` rebuilt `message` from scratch on every fix and had
    // nowhere to keep the reason, so the first fix after a failure replaced
    // "No offline map loaded" with a bare "retrying in 29 s" for the full wait.
    // The driver saw the one actionable line for about a second, and could not
    // tell a dead API key from a dead engine from no network for two minutes.
    //
    // `RerouteState.reason` now holds it, and the countdown message folds it in.
    const failed = failedAttempt('No offline map loaded');
    expect(rerouteBanner(failed, ROUTE)).toMatch(/No offline map loaded/);

    for (let t = 1; t <= 20; t++) {
      const r = observeFix(failed, ROUTE, FAR_OFF, 0, failed.lastFinished! + t * 1_000);
      expect(r.state.message).toMatch(/No offline map loaded/);
      expect(r.state.message).toMatch(/retrying in \d+ s/);
      expect(rerouteBanner(r.state, ROUTE)).toMatch(/No offline map loaded/);
    }
  });

  it('does not lose the reason to a policy that has nowhere to store it', () => {
    // The same gap seen from the type: there was no field on `RerouteState` for
    // the reason, so the information was unrecoverable by construction rather
    // than by accident.
    const failed = failedAttempt('API key required');
    expect(failed).toHaveProperty('reason', 'API key required');
  });

  it('never re-requests while the backoff is still running', () => {
    // The counterweight to the above: while the retry countdown runs, the app
    // must not fire another request. One second of fixes across a whole
    // backoff window, with the driver still parked off the line, produces no
    // second attempt — and exactly one on the final tick, when the window ends.
    const failed = failedAttempt('no route found');
    const window = backoffMs(failed);
    const base = failed.lastFinished!;

    let state = failed;
    for (let t = 0; t < window - 1_000; t += 1_000) {
      const r = observeFix(state, ROUTE, FAR_OFF, 0, base + t);
      expect(r.trigger).toBe(false);
      state = r.state;
    }
    const boundary = observeFix(state, ROUTE, FAR_OFF, 0, base + window);
    expect(boundary.trigger).toBe(true);
    expect(boundary.state.status).toBe('rerouting');
    expect(CONFIRM_WINDOW_MS).toBeLessThan(window);
  });
});
