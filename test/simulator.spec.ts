/**
 * The simulator's tests.
 *
 * These exist because the thing being simulated is *wrong* — §7 gap 6 measured the offline
 * guidance inference missing three of seven maneuvers, inventing one and reversing a direction —
 * and there has been no fast way to reproduce a manoeuvre. So the properties asserted here are
 * the ones a driver would notice, and each is a property of the *positions* rather than of
 * any guidance code, because the simulator's job is to produce positions that are wrong in
 * the specific ways a real device is wrong.
 *
 * Every test here is deterministic: a seeded run with a fixed clock produces the same fixes,
 * which is what makes a browser-found bug convertible into a fixture (§15.5 item 39).
 */

import { describe, it, expect } from 'vitest';

import {
  initialState, tick, positionAlong, headingAlong, offsetPerpendicular,
  rng, progressFraction, withFault, FIX_INTERVAL_MS, lifetimeOf,
  type SimulatorOptions, type SimulatorState,
} from '../src/nav/simulator';
import { haversine, lineLength } from '../src/geo';
import type { LatLng } from '../src/geo';

/** A 1 km straight north, then 1 km east — enough geometry to interpolate meaningfully. */
const L: LatLng[] = [
  [-1.400, 51.500],
  [-1.400, 51.509],
  [-1.391, 51.509],
];
const TOTAL = lineLength(L);

const OPTS: Required<Pick<SimulatorOptions, 'route' | 'speed' | 'accuracy' | 'jitter' | 'seed'>> = {
  route: L, speed: 13, accuracy: 8, jitter: 0, seed: 1,
};

/** Run for `seconds`, returning every fix produced. */
function run(
  state: SimulatorState,
  seconds: number,
  opts: Partial<typeof OPTS> = {},
) {
  const o = { ...OPTS, ...opts };
  const fixes = [];
  // `let` because the loop reassigns it from `tick`'s return value.
  let s = state;
  for (let t = 0; t <= seconds * 1000; t += FIX_INTERVAL_MS) {
    const r = tick(s, o, t);
    s = r.state;
    fixes.push(...r.fixes);
  }
  return { state: s, fixes };
}

describe('the seeded generator', () => {
  it('is deterministic for a seed and different across seeds', () => {
    const a = rng(42);
    const b = rng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(rng(42)()).not.toBe(rng(43)());
  });

  it('stays in [0, 1)', () => {
    const r = rng(7);
    for (let i = 0; i < 5000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('is roughly uniform, so jitter does not bias the tracker', () => {
    // A one-sided or skewed jitter would push every fix the same way, which is a systematic
    // error no real receiver has -- and which would make a driver appear to drift off route.
    const r = rng(99);
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 20000; i++) buckets[Math.floor(r() * 10)]++;
    for (const b of buckets) {
      expect(b).toBeGreaterThan(1500);
      expect(b).toBeLessThan(2500);
    }
  });
});

describe('position along the route', () => {
  it('starts at the start and ends at the end', () => {
    expect(positionAlong(L, 0)[0]).toBeCloseTo(L[0]![0], 9);
    const end = positionAlong(L, TOTAL * 10);
    expect(end[0]).toBeCloseTo(L[L.length - 1]![0], 9);
  });

  it('clamps rather than running off the end', () => {
    // A negative or over-long `along` must not produce a position outside the route: a
    // simulator that can put the car in the Gulf of Guinea is worse than useless, because
    // its output looks like a GPS fault.
    expect(positionAlong(L, -500)[0]).toBeCloseTo(L[0]![0], 9);
    expect(haversine(positionAlong(L, TOTAL * 3), L[L.length - 1]!)).toBeLessThan(1);
  });

  it('interpolates in metres, not by vertex index', () => {
    // Half of the first segment. An index-based implementation would report vertex 0 or 1
    // and be up to a full segment wrong — which is §3.17's defect, in the tool built to
    // investigate guidance.
    const mid = positionAlong(L, haversine(L[0]!, L[1]!) / 2);
    expect(haversine(L[0]!, mid)).toBeCloseTo(haversine(L[0]!, L[1]!) / 2, -1);
    expect(mid[1]).toBeGreaterThan(L[0]![1]);
    expect(mid[1]).toBeLessThan(L[1]![1]);
  });

  it('returns a real position for a degenerate route', () => {
    // The app refuses a dataset with no routable ways, so a one-point route should never
    // reach here — and a crash in a debug tool is worse than a useless one.
    expect(() => positionAlong([], 10)).not.toThrow();
    expect(positionAlong([[1, 2]], 10)).toEqual([1, 2]);
    expect(positionAlong([[1, 2], [1, 2]], 10)).toEqual([1, 2]);
  });

  it('is monotonic along a straight route', () => {
    let prev = -Infinity;
    for (let m = 0; m <= TOTAL; m += 25) {
      const lat = positionAlong(L, m)[1];
      expect(lat).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = lat;
    }
  });
});

describe('heading', () => {
  it('is north on a northbound leg and east on an eastbound one', () => {
    expect(Math.abs(headingAlong(L, 400))).toBeLessThan(1);
    const east = headingAlong(L, TOTAL - 200);
    expect(Math.abs(Math.abs(east) - 90)).toBeLessThan(2);
  });

  it('changes through the corner rather than jumping', () => {
    // A discontinuity would be indistinguishable from a wrong turn to anything reading it,
    // which is exactly the class of thing this tool must not introduce.
    const before = headingAlong(L, TOTAL - haversine(L[1]!, L[2]!) - 30);
    const after = headingAlong(L, TOTAL - 5);
    expect(Math.abs(after - before)).toBeGreaterThan(30);
  });
});

describe('the perpendicular offset', () => {
  it('moves the car the requested distance and to the right of travel', () => {
    const p: LatLng = [-1.4, 51.5];
    const q = offsetPerpendicular(p, 0, 200); // heading north, so +200 m is east
    const d = haversine(p, q);
    expect(d).toBeGreaterThan(190);
    expect(d).toBeLessThan(210);
    expect(q[0]).toBeGreaterThan(p[0]);
    expect(q[1]).toBeCloseTo(p[1], 3);
  });

  it('keeps the offset the same number of metres at a high latitude', () => {
    // The fixture is in Edinburgh and a driver in Calgary is not being simulated; an offset
    // that shrank with the cosine of latitude would be smaller in metres than the number it
    // reports, and a driver reading the label would be told a smaller deviation than the app
    // is actually seeing.
    const a = offsetPerpendicular([-114.1, 51.05], 0, 300);
    const b = offsetPerpendicular([-1.4, 51.05], 0, 300);
    expect(haversine([-114.1, 51.05], a)).toBeGreaterThan(290);
    expect(haversine([-1.4, 51.05], a)).toBeGreaterThan(290);
    expect(b[1]).toBeCloseTo(51.05, 3);
  });
});

describe('driving', () => {
  it('emits one fix per interval, at the device cadence', () => {
    const { fixes } = run(initialState({ route: L }), 10);
    expect(fixes.length).toBeGreaterThanOrEqual(10);
    expect(fixes.length).toBeLessThanOrEqual(12);
    for (let i = 1; i < fixes.length; i++) {
      expect(fixes[i]!.ts - fixes[i - 1]!.ts).toBe(FIX_INTERVAL_MS);
    }
  });

  it('advances at the requested speed', () => {
    const { fixes } = run(initialState({ route: L }), 60);
    const travelled = haversine(fixes[0]!.pos, fixes[fixes.length - 1]!.pos);
    // 60 s at 13 m/s is 780 m along a path, but the corner means the straight-line distance
    // between the endpoints is shorter -- so this is a bound, not an equality.
    expect(travelled).toBeGreaterThan(600);
    expect(travelled).toBeLessThan(820);
  });

  it('reports a speed and a heading with every fix', () => {
    const { fixes } = run(initialState({ route: L }), 5);
    for (const f of fixes) {
      expect(f.speed).toBeGreaterThan(0);
      expect(Number.isFinite(f.heading)).toBe(true);
      expect(f.accuracy).toBe(8);
      expect(f.ts).toBeGreaterThanOrEqual(0);
    }
  });

  it('is byte-identical for the same seed and script', () => {
    // This is item 39. Without it, a bug found in a browser is a rumour rather than a
    // fixture, and the next run of the suite is a different run.
    const a = run(initialState({ route: L }), 30, { jitter: 3, seed: 5 });
    const b = run(initialState({ route: L }), 30, { jitter: 3, seed: 5 });
    expect(a.fixes.map((f) => f.pos)).toEqual(b.fixes.map((f) => f.pos));
    const c = run(initialState({ route: L }), 30, { jitter: 3, seed: 6 });
    expect(a.fixes.map((f) => f.pos)).not.toEqual(c.fixes.map((f) => f.pos));
  });

  it('adds jitter around the route rather than along it', () => {
    // On a straight leg the deviation should be lateral, not longitudinal: a longitudinal
    // jitter would make the car appear to move backwards sometimes, which no receiver does.
    const { fixes } = run(initialState({ route: L, seed: 3 }), 20, { jitter: 4, seed: 3 });
    const straight = fixes.filter((f) => f.pos[1] < 51.5085);
    expect(straight.length).toBeGreaterThan(5);
    const lons = straight.map((f) => f.pos[0]);
    const spread = Math.max(...lons) - Math.min(...lons);
    expect(spread).toBeGreaterThan(0);
    expect(spread).toBeLessThan(20); // ±4 m of latitude-scaled longitude, generously
  });
});

describe('how long a fault lasts', () => {
  it('is stated in one place, and the open-ended ones really are open', () => {
    // `off-route` and `teleport` are positions, not perturbations: a driver who has taken a
    // wrong exit is still on that road on the next fix. The first version gave both a
    // lifetime of 0, so an `off-route` was born expired and the test asserting a 120 m
    // deviation measured zero.
    expect(lifetimeOf({ kind: 'off-route', metres: 120 })).toBe(Number.POSITIVE_INFINITY);
    expect(lifetimeOf({ kind: 'off-route', metres: 120, ms: 5_000 })).toBe(5_000);
    expect(lifetimeOf({ kind: 'teleport', to: [1, 2] })).toBe(Number.POSITIVE_INFINITY);
    // The timed ones use exactly what they were told.
    expect(lifetimeOf({ kind: 'freeze', ms: 30_000 })).toBe(30_000);
    expect(lifetimeOf({ kind: 'stop', ms: 2_500 })).toBe(2_500);
    expect(lifetimeOf({ kind: 'reverse', ms: 1_000 })).toBe(1_000);
    // And the jumps are one-shot: they move the car once, then nothing.
    expect(lifetimeOf({ kind: 'jump-ahead', metres: 400 })).toBe(0);
    expect(lifetimeOf({ kind: 'jump-back', metres: 400 })).toBe(0);
  });
});

describe('a clock that is nowhere near zero', () => {
  /**
   * The renderer-crash bug, pinned.
   *
   * `initialState` puts `nextFixAt` at 0. `installSimulator` hands `tick` a `Date.now()`,
   * which is ~1.7 × 10¹² ms, so the catch-up loop tried to emit one fix per second since 1970
   * — and crashed the tab in about four seconds, with no error to report. It was found
   * because the e2e suite's page *died*, not because a check failed.
   *
   * The same gap appears on a real machine whenever the tab is backgrounded or the process is
   * suspended, so this is not only a debug-tool concern.
   */
  it('does not try to replay the time since 1970', () => {
    const now = 1_750_000_000_000;
    const { state, fixes } = tick(initialState({ route: L }), OPTS, now);
    expect(fixes.length).toBeLessThanOrEqual(4);
    expect(fixes.length).toBeGreaterThan(0);
    // And it resumes on the grid rather than staying behind.
    const next = tick(state, OPTS, now + 1000);
    expect(next.fixes.length).toBe(1);
    expect(next.state.emitted).toBe(state.emitted + 1);
  });

  it('skips the gap rather than replaying it', () => {
    const now = 1_750_000_000_000;
    const { fixes } = tick(initialState({ route: L }), OPTS, now);
    // Every fix carries the current clock, not a timestamp from the early 1970s.
    for (const f of fixes) expect(f.ts).toBeGreaterThan(now - 5_000);
    expect(fixes[fixes.length - 1]!.ts).toBeLessThanOrEqual(now);
  });

  it('still emits every interval when the clock advances normally', () => {
    // The cap must not cost a fix per interval on an ordinary run: 10 s at 1 Hz is 11.
    const { fixes } = run(initialState({ route: L }), 10);
    expect(fixes.length).toBeGreaterThanOrEqual(10);
    expect(fixes.length).toBeLessThanOrEqual(12);
  });
});

describe('faults', () => {
  it('off-route moves the car sideways and keeps it moving', () => {
    let s = initialState({ route: L });
    s = { ...s, queue: [{ kind: 'off-route', metres: 120 }] };
    const { fixes } = run(s, 10);
    const onRoute = positionAlong(L, 13 * 5);
    // Every fix should be about 120 m off the path it would otherwise be on.
    for (const f of fixes.slice(2)) {
      const d = haversine(f.pos, positionAlong(L, 13 * (f.ts / 1000)));
      expect(d).toBeGreaterThan(100);
      expect(d).toBeLessThan(140);
    }
    void onRoute;
  });

  it('freeze delivers nothing at all, which is the whole point', () => {
    // §3.11.1: a receiver that stops delivering leaves the app holding a last value, and the
    // defect was 20 requests in ten minutes because nothing invalidated it.
    let s = initialState({ route: L });
    s = { ...s, queue: [{ kind: 'freeze', ms: 30_000 }] };
    const { fixes } = run(s, 20);
    expect(fixes.length).toBe(0);

    // And the car is still moving when the fix comes back, so a frozen-then-resumed stream
    // produces a jump the app has to cope with.
    s = { ...s, queue: [{ kind: 'freeze', ms: 5_000 }] };
    const { fixes: after } = run(s, 30);
    expect(after.length).toBeGreaterThan(20);
    const gap = after[after.length - 1]!.ts - after[0]!.ts;
    expect(gap).toBeGreaterThan(20_000);
  });

  it('a stop delivers fixes with zero speed', () => {
    // §3.13.5's case: a car stopped at a light is not off route, and a stationary fix must not
    // be read as one.
    let s = initialState({ route: L });
    s = { ...s, queue: [{ kind: 'stop', ms: 10_000 }] };
    const { fixes } = run(s, 8);
    expect(fixes.length).toBeGreaterThan(4);
    for (const f of fixes) expect(f.speed).toBe(0);
  });

  it('reverse walks backwards and stops at the start', () => {
    let s = initialState({ route: L });
    s = { ...s, along: 300, queue: [{ kind: 'reverse', ms: 60_000 }] };
    const { fixes } = run(s, 30);
    expect(fixes.some((f) => f.speed < 0)).toBe(true);
    // And it must not run off the beginning of the route into invented positions.
    for (const f of fixes) expect(f.pos[0]).toBeGreaterThan(-1.5);
  });

  it('a jump forward moves the car along and stays on the route', () => {
    let s = initialState({ route: L });
    s = { ...s, queue: [{ kind: 'jump-ahead', metres: 400 }] };
    const { state } = run(s, 3);
    expect(state.along).toBeGreaterThan(400);
  });

  it('a teleport puts the car where it is told, and it is not on the route', () => {
    // Used for reproducing "the driver is nowhere near the route", which the app is supposed
    // to notice rather than route through.
    let s = initialState({ route: L });
    s = { ...s, queue: [{ kind: 'teleport', to: [10, 10] }] };
    const { fixes } = run(s, 3);
    const last = fixes[fixes.length - 1]!;
    expect(last.pos[0]).toBeCloseTo(10, 1);
    expect(haversine(last.pos, L[0]!)).toBeGreaterThan(100_000);
  });

  it('expires, so a fault is not permanent', () => {
    let s = initialState({ route: L });
    s = { ...s, queue: [{ kind: 'stop', ms: 5_000 }] };
    const { fixes } = run(s, 20);
    // Stated as timestamps rather than as a slice length. A `stop` of 5 s began at t = 0, and
    // the contract is "active while `endsAt > now`" -- so the fixes at t = 0, 1000, 2000,
    // 3000 and 4000 are stopped and the one at t = 5000 is not. Counting instead of reading
    // the timestamps makes this test pass or fail for a reason that has nothing to do with
    // the behaviour, which is how it was written first and why it was wrong.
    expect(fixes.filter((f) => f.ts < 5_000).every((f) => f.speed === 0)).toBe(true);
    expect(fixes.filter((f) => f.ts < 5_000).length).toBeGreaterThan(3);
    expect(fixes.filter((f) => f.ts >= 5_000).every((f) => f.speed > 0)).toBe(true);
  });

  it('supersedes rather than stacking', () => {
    // Two `off-route` faults, 100 m and then 250 m. Without replacement the car would be
    // 350 m out, which is a fault this tool invented rather than one that was injected — and
    // it would be reported as a product bug.
    let s = initialState({ route: L });
    s = { ...s, queue: [{ kind: 'off-route', metres: 100 }] };
    s = { ...s, queue: [...s.queue, { kind: 'off-route', metres: 250 }] };
    const { fixes } = run(s, 3);
    const last = fixes[fixes.length - 1]!;
    const dev = haversine(last.pos, positionAlong(L, last.ts / 1000 * 13));
    expect(dev).toBeGreaterThan(230);
    expect(dev).toBeLessThan(270);
  });

  it('honours a fault scheduled for later, and keeps it queued until then', () => {
    const s = withFault(initialState({ route: L }), { kind: 'stop', ms: 3_000 }, 8_000);
    const before = run(s, 6).fixes;
    expect(before.every((f) => f.speed > 0)).toBe(true);
    // Still queued: a fault must survive the ticks that pass before its time.
    expect(s.queue).toHaveLength(1);
    const after = run(s, 14).fixes.filter((f) => f.ts >= 8_000);
    expect(after.some((f) => f.speed === 0)).toBe(true);
  });
});

describe('progress reporting', () => {
  it('is a fraction of the route', () => {
    const s = { ...initialState({ route: L }), along: TOTAL / 4 };
    expect(progressFraction(s, L)).toBeCloseTo(0.25, 6);
  });

  it('is zero for a degenerate route rather than NaN', () => {
    expect(progressFraction({ ...initialState({ route: L }), along: 10 }, [])).toBe(0);
  });
});