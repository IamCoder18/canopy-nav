/**
 * The reason a reroute failed, and how long it stays on screen.
 *
 * ## The defect this covers
 *
 * `finishReroute` stores *why* an attempt failed in `reason`, and keeps `message` for
 * the current one. Its own comment says:
 *
 * > The reason outlives the next fix: `message` alone is rebuilt every fix and
 * > becomes a bare countdown a second later.
 *
 * That was true for the countdown branch and false for the branch that matters most.
 * `observeFix` checks the tracker's state first, and when the driver is *still* off
 * route it rebuilt `message` as a flat `"You have left the route"` without consulting
 * `reason` — so the explanation was shown for exactly one fix interval and then
 * discarded, for as long as the driver kept driving the wrong way.
 *
 * Measured in a browser, not inferred: the first refusal showed "Off route — Could not
 * reach the routing server — check your connection", and every fix after it showed
 * only "You have left the route".
 *
 * That is the same shape as the `stepsEmptyReason` defect in §13.14 — a screen
 * reporting the *situation* while discarding the *reason* — and the same reason it
 * matters: the driver is told what to do exactly once, and then has to have been
 * paying attention.
 */

import { describe, it, expect } from 'vitest';
import {
  createRerouteState,
  observeFix,
  beginReroute,
  finishReroute,
  rerouteBanner,
  type RerouteState,
} from '../src/nav/reroute';
import { CONFIRM_WINDOW_MS } from '../src/nav/offroute';
import type { LatLng } from '../src/geo';

const ROUTE: LatLng[] = [
  [-114.0700, 51.0450],
  [-114.0650, 51.0450],
  [-114.0600, 51.0450],
];
/** ~120 m north of the line: unambiguously off it. */
const OFF: LatLng = [-114.0650, 51.0461];

/**
 * Drive fixes until the tracker confirms a deviation and the window allows a request.
 *
 * The settle period is 30 s and the confirm window 6 s, so a scripted sequence has to
 * outlast both — which is exactly why this is worth having as a test rather than as a
 * browser probe that has to sleep through it.
 */
function driveOffRoute(from: RerouteState, startAt = 1_000, until = 60_000): RerouteState {
  let s = from;
  for (let t = startAt; t < startAt + until; t += 1_000) {
    // A moving driver, or the stale-position guard holds them at "waiting for a
    // position update" and none of this is reachable.
    const fix: LatLng = [OFF[0] + (t - startAt) * 0.00001, OFF[1]];
    s = observeFix(s, ROUTE, fix, 0, t).state;
  }
  return s;
}

/** Get to the point where a request has been made and failed. */
function failedOnce(): RerouteState {
  const off = driveOffRoute(createRerouteState());
  const withTrigger = observeFix(off, ROUTE, [-114.0649, 51.0462], 0, 61_000);
  expect(withTrigger.trigger, 'a request should be due by now').toBe(true);
  const busy = beginReroute(withTrigger.state);
  return finishReroute(busy, false, 61_500, 'Could not reach the routing server', undefined, OFF);
}

describe('a failed reroute keeps explaining itself', () => {
  it('records the reason, and the driver is told at the moment it fails', () => {
    const s = failedOnce();
    expect(s.failures).toBe(1);
    expect(s.reason).toMatch(/routing server/);
    expect(s.message).toMatch(/routing server/);
  });

  /**
   * A driver who drifts back toward the route and off it again.
   *
   * This is how the branch that lost the reason is actually reached. `updateTracker`
   * returns to `suspect` only from `on-route`, so a driver holding one position far
   * off the line stays confirmed and reads the *countdown* message instead — which
   * already carried the reason. The browser measurement alternated between "You have
   * left the route" and the countdown, so the suspect branch was being hit, and it
   * was the one discarding `reason`.
   */
  function driftBackOnAndOff(s: RerouteState, from: number): RerouteState {
    // Onto the line: the tracker clears and the message goes to null.
    const back = observeFix(s, ROUTE, [-114.0650, 51.0450], 0, from).state;
    expect(back.status, 'back on the line').toBe('idle');
    // And off it again, which is `suspect`, and where the reason used to be lost.
    return observeFix(back, ROUTE, [-114.0649, 51.0462], 0, from + 1_000).state;
  }

  it('still says why once the driver drifts off the route again', () => {
    // The regression: this branch used to return a flat "You have left the route",
    // which is what made the reason appear for one fix interval and then vanish.
    const failed = failedOnce();
    const again = driftBackOnAndOff(failed, 62_000);

    expect(again.failures).toBe(1);
    expect(again.reason).toMatch(/routing server/);
    expect(again.message).toMatch(/left the route/);
    expect(again.message, 'the reason must survive the branch').toMatch(/routing server/);
  });

  it('says why on the countdown fix too, not only when the driver drifts', () => {
    const failed = failedOnce();
    const next = observeFix(failed, ROUTE, [-114.0648, 51.0463], 0, 62_000);
    expect(next.state.failures).toBe(1);
    expect(next.state.message).toMatch(/routing server/);
  });

  it('says why for every subsequent fix, not just the first', () => {
    // "Still off route" is a state, not a moment. Ten fixes later the driver must
    // still know why nothing is happening.
    let s = failedOnce();
    for (let i = 0; i < 10; i++) {
      s = observeFix(s, ROUTE, [-114.0640 - i * 0.00001, 51.0465], 0, 63_000 + i * 1_000).state;
      expect(s.message, `fix ${i + 1} after the failure`).toMatch(/routing server/);
    }
  });

  it('does not blame an engine before one has failed', () => {
    // The mirror: a first deviation has no reason, and inventing one would be the
    // §13.14 mistake in a new place — a message that names a cause nothing reported.
    //
    // Sampled while the deviation is still `suspect`, which is the whole of the
    // window in which a driver has been told they are lost and nothing has been tried
    // yet. Once it is confirmed a request goes out immediately (`lastFinished` is
    // null, so the backoff is `Infinity`), and the message legitimately becomes
    // "finding a new way" — which names no engine either, but for a different reason.
    let s = createRerouteState();
    for (let t = 1_000; t <= CONFIRM_WINDOW_MS - 1_000; t += 1_000) {
      s = observeFix(s, ROUTE, [OFF[0] + t * 0.00001, OFF[1]], 0, t).state;
      expect(s.message ?? '', `fix at ${t}ms`).toBe('You have left the route');
      expect(s.failures, `fix at ${t}ms`).toBe(0);
    }
    expect(s.reason).toBeNull();
  });

  it('stops blaming a failure once a reroute succeeds', () => {
    // Otherwise the app explains a failure that has been fixed, which is the same
    // class of defect: a reason outliving the thing it was about.
    const failed = failedOnce();
    const busy = beginReroute({ ...failed, status: 'rerouting', busy: true });
    const ok = finishReroute(busy, true, 70_000, undefined, undefined, OFF);

    expect(ok.failures).toBe(0);
    expect(ok.reason).toBeNull();
    const later = observeFix(ok, ROUTE, [-114.0639, 51.0466], 0, 71_000);
    expect(later.state.message ?? '').not.toMatch(/routing server/);
  });

  it('shows the reason in the banner, not only in state', () => {
    // `message` is internal; the banner is what the driver reads, and it appends a
    // rejoin distance. A reason that never reached it would satisfy every other test.
    const failed = failedOnce();
    const banner = rerouteBanner(failed, ROUTE, 'metric');
    expect(banner).toMatch(/routing server/);
    expect(banner).toMatch(/rejoining the route in/);
  });

  it('a successful attempt clears the reason, and a failed one keeps it', () => {
    const failed = failedOnce();
    expect(failed.reason).toMatch(/routing server/);
    const busy = beginReroute({ ...failed, status: 'rerouting', busy: true });
    expect(finishReroute(busy, true, 70_000, undefined, undefined, OFF).reason).toBeNull();
    expect(finishReroute(busy, false, 70_000, 'no route', undefined, OFF).reason).toBe('no route');
  });

  it('the countdown still carries the reason, and says when it will try again', () => {
    const failed = failedOnce();
    const later = observeFix(failed, ROUTE, [-114.0638, 51.0467], 0, 63_000);
    expect(later.state.message).toMatch(/retrying in \d+ s/);
    expect(later.state.message).toMatch(/routing server/);
    // And it is the *backoff*, not the settle period: the failure doubled the wait.
    expect(later.state.message).not.toMatch(/settling/);
  });
});

describe('the confirm window is real', () => {
  it('a single fix does not trigger anything', () => {
    // The guard the whole file depends on. Without it, `failedOnce` would pass for
    // the wrong reason and these tests would be testing an unreachable path.
    const r = observeFix(createRerouteState(), ROUTE, OFF, 0, 1_000);
    expect(r.trigger).toBe(false);
    expect(r.state.status).toBe('suspect');
  });

  it('a held deviation is confirmed after the window, not before', () => {
    // Before the window it is `suspect` and nothing is triggered; after it, the
    // confirm has happened and the settle period is what holds the request back. Both
    // are asserted because the two gates are independent and §14's harness mistakes
    // came from conflating them.
    const just = observeFix(createRerouteState(), ROUTE, OFF, 0, 1_000);
    expect(just.state.status).toBe('suspect');

    const early = observeFix(just.state, ROUTE, [-114.0649, 51.0462], 0, 1_000 + CONFIRM_WINDOW_MS - 1);
    expect(early.trigger, 'still inside the confirm window').toBe(false);
    expect(early.state.status, 'suspect, so the wording says so').toBe('suspect');

    // Confirmed: a request goes out at once, because `lastFinished` is null and the
    // backoff for a state with no failures is `Infinity` — the settle period only
    // applies *after* an attempt.
    const held = observeFix(just.state, ROUTE, [-114.0649, 51.0462], 0, 1_000 + CONFIRM_WINDOW_MS);
    expect(held.trigger, 'confirmed, so the request is due').toBe(true);
    expect(held.state.message, 'confirmed, so past the "you have left it" wording').not.toMatch(
      /left the route/,
    );
  });
});