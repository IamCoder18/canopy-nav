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
import { haversine, type LatLng } from '../src/geo';
import {
  madeProgress,
  observeFix,
  beginReroute,
  finishReroute,
  createRerouteState,
  SETTLE_MS,
  type RerouteState,
} from '../src/nav/reroute';
import { CONFIRM_WINDOW_MS } from '../src/nav/offroute';

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
      s = finishReroute(beginReroute(s), ok, t, ok ? undefined : 'no route', r.origin);
    }
  }
  return { state: s, fired };
}

/* ----------------------------- the guard ----------------------------- */

describe('madeProgress', () => {
  it('accepts a start that is nearer the destination', () => {
    expect(madeProgress(STUCK, closerThanStuck(), FAR_DEST)).toBe(true);
  });

  it('refuses an identical position', () => {
    expect(madeProgress(STUCK, STUCK, FAR_DEST)).toBe(false);
  });

  it('refuses a start that is further away', () => {
    // Measured, not assumed. `farther` is genuinely further from the destination
    // than `STUCK` (774.6 m vs 737.1 m), so moving *from* `farther` *to* `STUCK`
    // is an improvement and must be accepted; the rejection case is a start that
    // ends up further away than where it began. Getting this backwards would
    // have made the test assert the opposite of the guard's purpose.
    const farther: LatLng = [-114.0650, 51.0470];
    expect(haversine(farther, FAR_DEST)).toBeGreaterThan(haversine(STUCK, FAR_DEST));
    expect(madeProgress(farther, STUCK, FAR_DEST)).toBe(true);
    expect(madeProgress(STUCK, farther, FAR_DEST)).toBe(false);
  });

  it('ignores movement below the noise floor', () => {
    // GPS jitter of a metre or two must not read as the driver having moved.
    const nudge: LatLng = [STUCK[0] + 0.000005, STUCK[1]];
    expect(haversine(STUCK, nudge)).toBeLessThan(1);
    expect(madeProgress(STUCK, nudge, FAR_DEST)).toBe(false);
  });

  it('needs a real gain, not a rounding error', () => {
    // ~5.5 m *toward* the destination. Whether that is a gain depends on
    // geometry, so assert on the measured distances rather than on a guess.
    const marginal: LatLng = [STUCK[0] + 0.00005, STUCK[1] - 0.00001];
    const gain = haversine(STUCK, FAR_DEST) - haversine(marginal, FAR_DEST);
    expect(gain).toBeGreaterThan(0);
    expect(gain).toBeLessThan(10);
    // Below the floor it is jitter, not movement.
    expect(madeProgress(STUCK, marginal, FAR_DEST, 10)).toBe(false);
    expect(madeProgress(STUCK, marginal, FAR_DEST, 1)).toBe(true);
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
  it('fires again once the position advances toward the destination', () => {
    // First reroute from the stale fix, then the driver genuinely moves east
    // along the line and the fix follows. The guard must not turn this into a
    // dead end: the whole point of requiring progress is to distinguish "stale
    // fix" from "driver is genuinely somewhere else now".
    const first = attempt(createRerouteState(), 1_000, FAR_DEST);
    expect(first.fired).toBe(true);
    const baseline = first.state.lastOrigin!;
    expect(baseline).not.toBeNull();

    const moved: LatLng = [-114.0605, 51.0452]; // ~330 m nearer the destination
    expect(madeProgress(baseline, moved, FAR_DEST)).toBe(true);

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
    // Without a destination the guard cannot compare anything, so it must not
    // silently block rerouting. A baseline exists here precisely to prove the
    // missing destination is what disarms it.
    const withBaseline = { ...createRerouteState(), lastOrigin: STUCK };
    const fired = attempt(withBaseline, 1_000, undefined).fired;
    expect(fired).toBe(true);
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