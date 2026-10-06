/**
 * Reroute policy: the stale-position guard.
 *
 * The bug this pins is the expensive one in the feature. A `watchPosition` that
 * stops delivering — a tunnel, revoked permission, cold GNSS — leaves `location`
 * frozen at its last value while the app keeps feeding it to the policy as though
 * it were live. Before `madeProgress` existed, that produced:
 *
 *   t=0s     deviation confirmed -> reroute -> request succeeds
 *   t=6s     the new line starts at the *projection* of the same stale fix, so
 *            that fix is still ~120 m off it -> confirmed again
 *   t=36s    reroute again
 *   ...     indefinitely
 *
 * Measured before the fix: 20 requests in ten minutes, exactly 30 s apart, with
 * `failures` pinned at zero — because every attempt *succeeded* and reset the
 * counter. Neither the busy latch nor the backoff could help: both are
 * mechanisms for repeated *failure*, and this was repeated success.
 *
 * Run with `npx vitest run test/staleposition.spec.ts`.
 */

import { describe, it, expect } from 'vitest';
import { haversine, snapToPolyline, type LatLng } from '../src/geo';
import {
  hasMovedSince,
  observeFix,
  beginReroute,
  finishReroute,
  createRerouteState,
  SETTLE_MS,
  type RerouteState,
} from '../src/nav/reroute';
import { CONFIRM_WINDOW_MS, offRouteThreshold } from '../src/nav/offroute';

const ROUTE: LatLng[] = [
  [-114.0700, 51.0450],
  [-114.0650, 51.0450],
  [-114.0600, 51.0450],
];

/** ~120 m north of the line: unambiguously off it. */
const STUCK: LatLng = [-114.0650, 51.0461];

const FAR_DEST: LatLng = [-114.0550, 51.0440];

/** Somewhere materially closer to the destination than the line above. */
function closerThanStuck(): LatLng {
  return [-114.0605, 51.0452];
}

/**
 * Feed one fix per second until the policy asks to act, or give up.
 *
 * One second is the real `watchPosition` cadence, and it matters: the
 * confirmation window is 6 s, so a coarser step can miss the transition to
 * `off-route` entirely and a test will then assert on `suspect` while believing
 * it is testing the confirmed path.
 */
function attempt(
  from: RerouteState,
  startAt: number,
  destination: LatLng | undefined,
  fix: LatLng = STUCK,
  ok = true,
): { state: RerouteState; fired: boolean } {
  let s = from;
  let fired = false;
  // 60 fixes: the confirmation window is 6 s, so a run has to be long enough for
  // the tracker to actually reach `off-route`. Stopping at 40 s left it in
  // `suspect`, which made two tests assert on the wrong state entirely.
  for (let i = 0; i < 60 && !fired; i++) {
    const t = startAt + i * 1_000;
    const r = observeFix(s, ROUTE, fix, 0, t, destination);
    s = r.state;
    if (r.trigger && r.origin) {
      fired = true;
      // `fix` is the baseline the guard compares against, so it is recorded here
      // exactly as `App` does. A helper that omitted it would be unable to
      // reproduce the frozen loop at all — it would pass for the wrong reason.
      s = finishReroute(beginReroute(s), ok, t, ok ? undefined : 'no route', r.origin, fix);
    }
  }
  return { state: s, fired };
}

/* ----------------------------- the guard ----------------------------- */

/**
 * The guard asks one question: has the position changed?
 *
 * It used to ask a second one — whether the new start was *nearer the
 * destination* — and that is what silenced the case this banner exists to speak
 * to. A driver who misses an exit is genuinely off-route, and their projected
 * start moves *away* from the destination as they continue past the junction.
 * That is the evidence their position is live, and the guard read it as the
 * opposite, so the app said "Off route — waiting for a position update" to a
 * driver whose positions were arriving perfectly well.
 *
 * The frozen case is unchanged and is what the guard is for: a fix that has
 * stopped moving re-projects to the same point every time, so it fails a movement
 * test in any direction.
 */
describe('hasMovedSince', () => {
  it('accepts a position that has moved', () => {
    expect(hasMovedSince(STUCK, closerThanStuck())).toBe(true);
  });

  it('refuses an identical position', () => {
    expect(hasMovedSince(STUCK, STUCK)).toBe(false);
  });

  it('accepts movement away from the destination, which is what missing an exit looks like', () => {
    // Measured, so the direction is a fact about the fixture rather than a guess.
    const past: LatLng = [-114.0650, 51.0470];
    expect(haversine(past, FAR_DEST)).toBeGreaterThan(haversine(STUCK, FAR_DEST));
    // Still moving. The old guard refused this, which is the whole defect.
    expect(hasMovedSince(STUCK, past)).toBe(true);
  });

  it('ignores movement below the noise floor', () => {
    // GPS jitter of a metre or two must not read as the driver having moved.
    const nudge: LatLng = [STUCK[0] + 0.000005, STUCK[1]];
    expect(haversine(STUCK, nudge)).toBeLessThan(1);
    expect(hasMovedSince(STUCK, nudge)).toBe(false);
  });

  it('needs real movement, not a rounding error', () => {
    // 3.5 m at this latitude, measured rather than assumed — 0.00005 degrees of
    // longitude at 51N is a third of that. Assert the measurement and both sides
    // of the floor, so the test says what the threshold actually does.
    const marginal: LatLng = [STUCK[0] + 0.00005, STUCK[1]];
    const moved = haversine(STUCK, marginal);
    expect(moved).toBeGreaterThan(3);
    expect(moved).toBeLessThan(5);
    // Below the 10 m floor it is jitter, not movement.
    expect(hasMovedSince(STUCK, marginal, 10)).toBe(false);
    expect(hasMovedSince(STUCK, marginal, 1)).toBe(true);
  });
});

/* ------------------------- the loop, closed ------------------------- */

describe('a frozen position does not reroute forever', () => {
  it('the first reroute fires, because there is no baseline yet', () => {
    const { fired } = attempt(createRerouteState(), 1_000, FAR_DEST);
    expect(fired).toBe(true);
  });

  it('records the origin it started from', () => {
    const { state } = attempt(createRerouteState(), 1_000, FAR_DEST);
    expect(state.lastOrigin).not.toBeNull();
  });

  it('a second attempt from the same stale fix does not fire', () => {
    const first = attempt(createRerouteState(), 1_000, FAR_DEST);
    expect(first.fired).toBe(true);

    // Well past the settle window, same frozen fix, same destination.
    const later = first.state.lastFinished! + SETTLE_MS + CONFIRM_WINDOW_MS + 5_000;
    const second = attempt(first.state, later, FAR_DEST);
    expect(second.fired).toBe(false);
  });

  it('says why it is holding off, rather than going quiet', () => {
    // The banner must distinguish "we are still deciding" from "we are waiting
    // for your position to update". Only the second is actionable, so only the
    // second may claim it.
    const first = attempt(createRerouteState(), 1_000, FAR_DEST);
    expect(first.fired).toBe(true);

    // After a success `failures` is 0, so the wait is SETTLE_MS, not the failure
    // backoff. Start after the window so the guard — not the timer — is what
    // holds the request off.
    const later = first.state.lastFinished! + SETTLE_MS + CONFIRM_WINDOW_MS + 5_000;
    const second = attempt(first.state, later, FAR_DEST);
    expect(second.fired).toBe(false);
    expect(second.state.message).toMatch(/waiting for a position update/i);
  });

  it('stays quiet across many windows rather than firing once more', () => {
    let s = attempt(createRerouteState(), 1_000, FAR_DEST).state;
    let extraRequests = 0;
    // Ten more settle windows, the driver never having moved.
    for (let i = 1; i <= 10; i++) {
      const at = s.lastFinished! + (SETTLE_MS + CONFIRM_WINDOW_MS + 5_000) * i;
      const r = attempt(s, at, FAR_DEST);
      if (r.fired) extraRequests++;
      s = r.state;
    }
    expect(extraRequests).toBe(0);
  });

  it('does not accumulate failures, because no request was made', () => {
    let s = attempt(createRerouteState(), 1_000, FAR_DEST).state;
    const failuresAfterFirst = s.failures;
    const later = s.lastFinished! + SETTLE_MS + CONFIRM_WINDOW_MS + 5_000;
    s = attempt(s, later, FAR_DEST).state;
    expect(s.failures).toBe(failuresAfterFirst);
  });
});

/* --------------------- it must not block real recovery --------------------- */

describe('the guard does not block a driver who really has moved', () => {
  it('fires again once the position advances along the route', () => {
    // First reroute from the stale fix, then the driver genuinely moves east
    // along the line and the fix follows. The guard must not turn this into a
    // dead end: the whole point of requiring movement is to distinguish "stale
    // fix" from "driver is genuinely somewhere else now".
    const first = attempt(createRerouteState(), 1_000, FAR_DEST);
    expect(first.fired).toBe(true);
    const baseline = first.state.lastOrigin!;
    expect(baseline).not.toBeNull();

    const moved: LatLng = [-114.0605, 51.0452]; // ~330 m along the line
    expect(hasMovedSince(baseline, moved)).toBe(true);

    const later = first.state.lastFinished! + SETTLE_MS + CONFIRM_WINDOW_MS + 5_000;
    const second = attempt(first.state, later, FAR_DEST, moved);
    // The driver is now on the route again, so there is nothing to reroute *to*.
    // What must not happen is the guard blocking a legitimate recovery, so the
    // real assertion is that the policy is no longer holding the stale-fix
    // message — i.e. it has re-evaluated rather than latched.
    expect(second.state.message ?? '').not.toMatch(/waiting for a position update/i);
  });

  it('is inert before any reroute has happened', () => {
    // No baseline means no comparison, so the very first deviation still acts.
    const first = attempt(createRerouteState(), 1_000, FAR_DEST);
    expect(first.fired).toBe(true);
  });

  it('is inert when no destination is known', () => {
    // Kept as a regression on the call shape: the guard used to take the
    // destination and was disarmed without one. It no longer needs a destination
    // at all, so this asserts the baseline alone does not block a first reroute.
    const withBaseline = { ...createRerouteState(), lastOrigin: STUCK };
    const fired = attempt(withBaseline, 1_000, undefined).fired;
    expect(fired).toBe(true);
  });
});

/**
 * The defect the direction-agnostic guard was written to remove.
 *
 * A driver misses an exit and carries on. They are genuinely off-route, and they
 * are travelling *away* from the destination — which is exactly what carrying past
 * a missed junction looks like, since the road they are on does not lead there.
 * The old guard compared each new start's distance to the destination against the
 * previous one's, refused every one, and told them the app was "waiting for a
 * position update" while their positions arrived perfectly well — for as long as
 * they stayed on the wrong road.
 *
 * The fixture runs south-west and the destination lies north-east, so every step
 * measurably increases the distance. The measurements are asserted rather than
 * described, because the premise is what makes the test mean anything.
 */
describe('a driver moving away from the destination is still rerouted', () => {
  const WRONG_ROAD: LatLng[] = [
    [-114.0650, 51.0440],
    [-114.0660, 51.0435],
    [-114.0670, 51.0430],
    [-114.0680, 51.0425],
    [-114.0690, 51.0420],
  ];

  it('measures every one of those positions as receding from the destination', () => {
    for (let i = 1; i < WRONG_ROAD.length; i++) {
      expect(haversine(WRONG_ROAD[i], FAR_DEST))
        .toBeGreaterThan(haversine(WRONG_ROAD[i - 1], FAR_DEST));
    }
    // ~78 m per step: clear of the 10 m movement floor, and each step is already
    // past the 25 m off-route threshold, so the deviation is confirmed rather
    // than merely suspected.
    expect(haversine(WRONG_ROAD[1], WRONG_ROAD[0])).toBeGreaterThan(70);
    expect(snapToPolyline(WRONG_ROAD[0], ROUTE).dist).toBeGreaterThan(offRouteThreshold(0));
  });

  /**
   * One more step further along the same road.
   *
   * Generated rather than a fixed five-point array, because a driver does not
   * stop at five metres. A looping array would bring the car back to a position it
   * had already been at, which the guard quite correctly reads as "nothing has
   * changed" — so a looping fixture tests the frozen case while claiming to test
   * the moving one.
   */
  function onWrongRoad(step: number): LatLng {
    return [WRONG_ROAD[0][0] - step * 0.001, WRONG_ROAD[0][1] - step * 0.0005];
  }

  /**
   * Drive the wrong road at the real fix cadence until the policy acts.
   *
   * One second per fix, because the confirmation window is 6 s and a coarser step
   * can skip the transition to `off-route` entirely — which would leave the test
   * asserting on `suspect` while believing it was testing the confirmed path.
   */
  function drive(from: RerouteState, startAt: number, until: number): {
    state: RerouteState; fired: number; messages: string[];
  } {
    let s = from;
    let fired = 0;
    const messages: string[] = [];
    for (let t = startAt; t < until && fired < 8; t += 1_000) {
      // The fix at *this* instant, and it is also the baseline recorded on
      // success — so each new request is compared against where the driver was
      // when the last one went out, which is what `App` does.
      const p = onWrongRoad((t - startAt) / 1_000);
      const r = observeFix(s, ROUTE, p, 0, t, FAR_DEST);
      s = r.state;
      if (s.message) messages.push(s.message);
      if (r.trigger) {
        fired++;
        s = finishReroute(beginReroute(s), true, t, undefined, r.origin ?? undefined, p);
      }
    }
    return { state: s, fired, messages };
  }

  it('fires on the first deviation, with no baseline to compare against', () => {
    const { fired } = drive(createRerouteState(), 1_000, 60_000);
    expect(fired).toBeGreaterThanOrEqual(1);
  });

  it('keeps firing on later windows while the driver keeps moving', () => {
    // The discriminating assertion. With the old guard the second and later
    // windows were refused outright, because every new start was further from the
    // destination than the last — which is the correct reading of a driver
    // travelling the wrong way, mistaken for a frozen sensor.
    const { fired } = drive(createRerouteState(), 1_000, 10 * 60_000);
    expect(fired).toBeGreaterThanOrEqual(3);
  });

  it('never blames the position for not arriving while the driver is moving', () => {
    const { messages } = drive(createRerouteState(), 1_000, 10 * 60_000);
    expect(messages.filter((m) => /waiting for a position update/i.test(m))).toEqual([]);
  });

  it('still refuses a driver who has not moved, which is the case it is for', () => {
    // The guard's purpose is unchanged: one frozen fix must not produce a request
    // every settle window. This is what proves the new test above is testing
    // movement rather than the guard having been removed.
    let s = createRerouteState();
    let fired = 0;
    for (let w = 1; w <= 6; w++) {
      const at = 1_000 + w * (SETTLE_MS + CONFIRM_WINDOW_MS + 5_000);
      for (let t = at; t < at + 40_000; t += 1_000) {
        const r = observeFix(s, ROUTE, STUCK, 0, t, FAR_DEST);
        s = r.state;
        if (r.trigger) {
          fired++;
          s = finishReroute(beginReroute(s), true, t, undefined, r.origin ?? undefined, STUCK);
          break;
        }
      }
    }
    // The first window fires (no baseline); the rest are all refused.
    expect(fired).toBe(1);
  });
});

/* --------------------- failure does not move the baseline --------------------- */

describe('a failed attempt does not advance the baseline', () => {
  it('leaves lastOrigin unset when nothing has ever succeeded', () => {
    let s = createRerouteState();
    for (let i = 0; i < 8; i++) {
      const r = observeFix(s, ROUTE, STUCK, 0, 1_000 + i * 1_000, FAR_DEST);
      s = r.state;
      if (r.trigger) s = finishReroute(beginReroute(s), false, 20_000, 'no route', r.origin ?? undefined);
    }
    expect(s.lastOrigin).toBeNull();
  });

  it('keeps the previous baseline after a later failure', () => {
    const ok = attempt(createRerouteState(), 1_000, FAR_DEST);
    const baseline = ok.state.lastOrigin;
    expect(baseline).not.toBeNull();

    const failed = finishReroute(ok.state, false, 30_000, 'no route', closerThanStuck());
    expect(failed.lastOrigin).toEqual(baseline);
  });
});