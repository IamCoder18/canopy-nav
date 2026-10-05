/**
 * Backoff behaviour once failures have actually accumulated.
 *
 * `test/reroute.spec.ts` checks that the wait grows and never exceeds 120 s.
 * That is the shape of the curve, not its behaviour. What matters to a driver
 * stuck in a city canyon with no signal is the other half:
 *
 *   - does the countdown stay sane once the wait is two minutes long
 *   - does the failure count keep climbing, or does it saturate
 *   - does anything ever bring it back down
 *
 * and the one case the whole mechanism exists for — an engine that keeps saying
 * no — which is at the bottom, marked `it.fails`.
 *
 * Everything is driven off an explicit clock, so there are no real timers and
 * the sequence is exact rather than approximate.
 *
 * Run with `npx vitest run test/reroute-backoff.spec.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  createRerouteState,
  observeFix,
  beginReroute,
  finishReroute,
  backoffMs,
  type RerouteState,
} from '../src/nav/reroute';
import { CONFIRM_WINDOW_MS } from '../src/nav/offroute';
import type { LatLng } from '../src/geo';

/** The two constants the module documents, restated so a change is loud. */
const MIN_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 120_000;

const ROUTE: LatLng[] = [
  [-114.0700, 51.0450],
  [-114.0650, 51.0450],
  [-114.0600, 51.0450],
  [-114.0550, 51.0450],
];
const FAR_OFF: LatLng = [-114.0650, 51.0461];
const ON: LatLng = [-114.0650, 51.0450];

/** Confirm, request, refuse. Returns the state and the clock. */
function refuse(
  from: RerouteState,
  at: number,
  reason = 'engine unreachable',
): { state: RerouteState; at: number } {
  let s = from;
  for (let i = 0; i < 10; i++) {
    const now = at + i * 2_000;
    const r = observeFix(s, ROUTE, FAR_OFF, 0, now);
    if (r.trigger) {
      return { state: finishReroute(beginReroute(r.state), false, now, reason), at: now };
    }
    s = r.state;
  }
  throw new Error('never triggered');
}

/**
 * Walk `count` refusals, each one starting as soon as the previous backoff has
 * expired. Returns the final state plus the wait in force after each refusal.
 */
function refuseMany(count: number, start = 0): { state: RerouteState; waits: number[] } {
  let s = createRerouteState();
  let clock = start;
  const waits: number[] = [];
  for (let i = 0; i < count; i++) {
    const { state, at } = refuse(s, clock);
    s = state;
    waits.push(backoffMs(s));
    clock = at + backoffMs(s) + 1;
  }
  return { state: s, waits };
}

/* ------------------------- the ladder ------------------------- */

describe('backoffMs — the ladder, with exact values', () => {
  it('doubles from 30 s and reaches the 120 s cap on the third failure', () => {
    const { waits } = refuseMany(6);
    expect(waits).toEqual([
      MIN_BACKOFF_MS,
      MIN_BACKOFF_MS * 2,
      MAX_BACKOFF_MS,
      MAX_BACKOFF_MS,
      MAX_BACKOFF_MS,
      MAX_BACKOFF_MS,
    ]);
  });

  it('uses the settle period when nothing has failed yet', () => {
    // The wait after a *success* is the same constant, and it must not be
    // shorter: an earlier version used 15 s here and made the first failure
    // shorten the wait.
    expect(backoffMs(createRerouteState())).toBe(MIN_BACKOFF_MS);
    const ok = finishReroute(createRerouteState(), true, 1_000);
    expect(backoffMs(ok)).toBe(MIN_BACKOFF_MS);
  });

  it('never exceeds the cap, and never produces a non-finite wait', () => {
    let s = createRerouteState();
    // Past ~1024 failures `2 ** n` overflows to Infinity; the cap has to hold
    // anyway or the countdown would say "retrying in Infinity s".
    for (let i = 0; i < 2_000; i++) {
      s = finishReroute(s, false, i * 1_000);
      expect(backoffMs(s)).toBeLessThanOrEqual(MAX_BACKOFF_MS);
      expect(Number.isFinite(backoffMs(s))).toBe(true);
      expect(backoffMs(s)).toBeGreaterThan(0);
    }
    expect(s.failures).toBe(2_000);
    expect(backoffMs(s)).toBe(MAX_BACKOFF_MS);
  });

  it('keeps counting failures after the cap, and a success clears the lot', () => {
    let s = createRerouteState();
    for (let i = 0; i < 50; i++) s = finishReroute(s, false, i * 1_000);
    expect(s.failures).toBe(50);
    expect(backoffMs(s)).toBe(MAX_BACKOFF_MS);

    const ok = finishReroute(s, true, 1_000_000);
    expect(ok.failures).toBe(0);
    expect(backoffMs(ok)).toBe(MIN_BACKOFF_MS);
    expect(ok.lastFinished).toBe(1_000_000);
  });
});

/* ------------------------- the countdown at the cap ------------------------- */

describe('the retry countdown once the cap is reached', () => {
  it('counts down from the cap, monotonically, and never reaches zero', () => {
    const { state } = refuseMany(3);
    expect(backoffMs(state)).toBe(MAX_BACKOFF_MS);
    expect(state.failures).toBe(3);

    let s = state;
    let previous = MAX_BACKOFF_MS / 1_000;
    const seen: number[] = [];
    for (let t = 0; t < MAX_BACKOFF_MS; t += 7_000) {
      const r = observeFix(s, ROUTE, FAR_OFF, 0, state.lastFinished! + t);
      expect(r.trigger).toBe(false);
      expect(r.state.status).toBe('failed');
      const seconds = Number(/retrying in (\d+) s/.exec(r.state.message!)?.[1]);
      expect(Number.isFinite(seconds)).toBe(true);
      expect(seconds).toBeGreaterThan(0);
      expect(seconds).toBeLessThanOrEqual(previous);
      seen.push(seconds);
      previous = seconds;
      s = r.state;
    }
    // Strictly decreasing, never repeating a tick backwards, and it gets close
    // to the cap rather than sitting at it.
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen[0]).toBe(MAX_BACKOFF_MS / 1_000);
    expect(Math.min(...seen)).toBeLessThan(15);
  });

  it('fires on the first fix at the boundary, not a fix late', () => {
    const { state } = refuseMany(3);
    const base = state.lastFinished!;
    const just_before = observeFix(state, ROUTE, FAR_OFF, 0, base + MAX_BACKOFF_MS - 1);
    expect(just_before.trigger).toBe(false);
    expect(just_before.state.status).toBe('failed');

    const at_boundary = observeFix(state, ROUTE, FAR_OFF, 0, base + MAX_BACKOFF_MS);
    expect(at_boundary.trigger).toBe(true);
    expect(at_boundary.state.status).toBe('rerouting');
    expect(at_boundary.origin).not.toBeNull();
  });

  it('counts a two-minute wait honestly on a sparse fix stream', () => {
    // A driver whose phone only produces a fix every 30 s still has to be told
    // something true. The number is the time left, not the time of the last
    // attempt.
    const { state } = refuseMany(3);
    const base = state.lastFinished!;
    const sparse = [0, 30_000, 60_000, 90_000].map(
      (t) => Number(/retrying in (\d+) s/.exec(
        observeFix(state, ROUTE, FAR_OFF, 0, base + t).state.message!,
      )![1]),
    );
    expect(sparse).toEqual([120, 90, 60, 30]);
  });

  it('keeps the deviation confirmed after a failure, so the countdown is honest', () => {
    // `finishReroute` preserves the tracker on failure, so the very next fix
    // is already 'off-route' rather than 'suspect'. The driver is not told
    // "122 m off the route" as though nothing had happened, and the countdown
    // does not have to wait out a second confirmation window to be true.
    const { state } = refuseMany(3);
    const base = state.lastFinished!;
    const brief = observeFix(state, ROUTE, FAR_OFF, 0, base);
    expect(brief.state.status).toBe('failed');
    expect(brief.state.message).toMatch(/retrying in 120 s/);
  });

  it('hedges on a fresh outlier that has not been confirmed', () => {
    // Back on the line, a single bad fix during the backoff window is not
    // evidence of anything: it gets the short "N m off the route" line and no
    // promise about a retry, even though `failures` is still 3.
    const { state } = refuseMany(3);
    const base = state.lastFinished!;
    const home = observeFix(state, ROUTE, ON, 0, base + 30_000).state;
    expect(home.status).toBe('idle');
    expect(home.failures).toBe(3);

    const outlier = observeFix(home, ROUTE, FAR_OFF, 0, base + 40_000);
    expect(outlier.state.status).toBe('suspect');
    expect(outlier.state.message).toMatch(/m off the route/);
    expect(outlier.state.message).not.toMatch(/retrying/);
    expect(outlier.trigger).toBe(false);
  });
});

/* ------------------------- what resets it ------------------------- */

describe('what brings the backoff back down', () => {
  it('only a successful reroute', () => {
    let s = createRerouteState();
    for (let i = 0; i < 4; i++) s = finishReroute(s, false, i * 1_000);
    expect(backoffMs(s)).toBe(MAX_BACKOFF_MS);

    // Time passing is not recovery: an hour of on-route driving changes nothing.
    for (const later of [60_000, 3_600_000, 86_400_000]) {
      s = observeFix(s, ROUTE, ON, 0, later).state;
      expect(s.status).toBe('idle');
      expect(s.failures).toBe(4);
      expect(backoffMs(s)).toBe(MAX_BACKOFF_MS);
    }

    // So is an explicit reset, e.g. navigation ending and restarting.
    expect(backoffMs({ ...createRerouteState() })).toBe(MIN_BACKOFF_MS);
  });

  it('a success mid-countdown restores a single settle period', () => {
    const { state } = refuseMany(2);
    expect(backoffMs(state)).toBe(60_000);
    const ok = finishReroute(state, true, state.lastFinished! + 10);
    expect(ok.failures).toBe(0);
    expect(backoffMs(ok)).toBe(MIN_BACKOFF_MS);
    expect(ok.status).toBe('idle');
  });

  it('escalates across unrelated deviations, because nothing in between succeeded', () => {
    // Pinned as-is, because it is arguably deliberate — the backoff is a
    // property of the *engine*, not of one wrong turn. Worth knowing though:
    // three unlucky deviations across a four-hour drive leave the driver
    // rerouting only once every two minutes for the rest of the trip, even
    // though the engine may have been fine for all of it.
    const waits: number[] = [];
    let s = createRerouteState();
    let clock = 0;
    for (let trip = 0; trip < 4; trip++) {
      const { state, at } = refuse(s, clock);
      s = state;
      waits.push(backoffMs(s));
      // drive happily back on the line, then park hours later somewhere else
      s = observeFix(s, ROUTE, ON, 0, at + 30_000).state;
      expect(s.status).toBe('idle');
      clock = at + 7_200_000;
    }
    expect(waits).toEqual([MIN_BACKOFF_MS, 60_000, MAX_BACKOFF_MS, MAX_BACKOFF_MS]);
  });
});

/* ------------------------- the case the backoff exists for ------------------------- */

describe('a frozen position', () => {
  it.fails('does not reroute every 30 s for as long as the driver is stuck', () => {
    // THE GAP, and the big one.
    //
    // A fix that stops moving is indistinguishable from a driver parked at the
    // wrong exit: `watchPosition` is opened with `maximumAge: 0` and a 20 s
    // timeout, so a tunnel, a revoked permission or a cold GNSS leaves
    // `location` frozen at the last real position (src/nav/location.ts:77,
    // 129-130 — the timeout only sets `error`, it never moves the fix).
    // Nothing in the reroute effect reads `fix.ts` or `locationMode`, so a
    // frozen position is fed to `observeFix` as if it were live.
    //
    // Sequence, with the driver stopped ~120 m off the line:
    //   t=0s    deviation confirmed -> trigger -> request succeeds
    //           -> `App.tsx:763` setRoute(new line), `:771` setProgressAlong(0),
    //              `:772` resetTraffic, `:773` setFitNonce -> map refits
    //   t=6s    still 122 m from the *new* line, which starts at the projection
    //           -> tracker re-accumulates, `failures` is 0 so the wait is the
    //              30 s settle period, not a backoff
    //   t=36s   trigger again -> and the same six calls repeat
    //   ...     forever, every 30 s, for the whole time the driver is stuck
    //
    // What the driver sees: the banner says "Off route — finding a new way"
    // every thirty seconds, the map yanks itself back to the route each time
    // (`fitNonce`), the grey "already driven" portion and the next-turn card
    // snap back to the start (`setProgressAlong(0)`), and the routing server
    // gets a request every thirty seconds indefinitely. `busy` and the
    // backoff cannot help: every attempt *succeeds*, so `failures` never
    // leaves 0 and `MIN_BACKOFF_MS`/`MAX_BACKOFF_MS` are never reached.
    const STUCK: LatLng = [-114.0650, 51.0461];
    let s = createRerouteState();
    let clock = 0;
    let attempts = 0;
    const tenMinutes = 10 * 60 * 1_000;

    for (let t = 0; t <= tenMinutes; t += 1_000) {
      const r = observeFix(s, ROUTE, STUCK, 0, clock + t);
      s = r.state;
      if (r.trigger) {
        attempts++;
        // the engine is healthy, so every attempt succeeds
        s = finishReroute(beginReroute(s), true, clock + t);
      }
    }

    // Expected of a policy that notices a stale fix: one attempt, then silence
    // (or at worst a cap-sized retry every two minutes).
    expect(attempts).toBe(1);
    // What actually happens.
    expect(s.failures).toBe(0);
    expect(backoffMs(s)).toBe(MIN_BACKOFF_MS);
  });

  it('a genuinely moving car is not mistaken for a frozen one', () => {
    // The control for the test above: the same 30 s cadence, but the driver
    // really is lost and really is moving, so re-requesting is the right thing
    // and the policy should not be slowed down to fix the other case.
    let s = createRerouteState();
    const moving: LatLng[] = [
      [-114.0650, 51.0461], [-114.0651, 51.0463], [-114.0652, 51.0466],
    ];
    let clock = 0;
    let attempts = 0;
    for (let t = 0; t <= 10 * 60 * 1_000; t += 1_000) {
      const fix = moving[Math.floor(t / 30_000) % moving.length];
      const r = observeFix(s, ROUTE, fix, 0, clock + t);
      s = r.state;
      if (r.trigger) {
        attempts++;
        s = finishReroute(beginReroute(s), true, clock + t);
      }
    }
    expect(attempts).toBeGreaterThan(1);
    expect(CONFIRM_WINDOW_MS).toBe(6_000);
  });
});
