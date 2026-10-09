/**
 * The drive simulator — §15.5.
 *
 * ## Why this exists, and why it is a debug setting
 *
 * Offline turn-by-turn is *inferred* from bearing changes, and §7 gap 6 measured it missing
 * three of seven real maneuvers on a 4 km stretch, inventing one and reversing a direction.
 * It has been wrong for four passes and there has been no way to check it quickly: every
 * maneuver bug so far has been found by reading the built app in a browser and reasoning about
 * what the driver would see. That is a slow way to learn whether a turn instruction is right,
 * and it is the reason the inference has survived four audits unchanged.
 *
 * **Off by default, and not a setting a driver should ever find.** It replaces the position
 * source. Nothing here is safe on a real road.
 *
 * ## The one rule that shapes everything
 *
 * **No production code path is stubbed.** The simulator produces positions and hands them to
 * `navigator.geolocation.watchPosition`'s callbacks — the same seam Playwright's
 * `setGeolocation` uses — so they travel the real `watchPosition → offroute → progress →
 * guidance` chain. A simulator that bypassed the reroute policy would not find reroute bugs,
 * which is most of what is worth finding.
 *
 * That is also why this file contains no React and no DOM: it is a pure state machine over a
 * route, a clock and a seed, so every fault and every boundary is testable in a millisecond
 * rather than in a browser.
 *
 * ## Determinism
 *
 * A seed, and a jitter generator derived from it, because "a bug found in a browser" has to be
 * reproducible — otherwise the next run is a different run and the finding is a rumour. The
 * same seed and the same script produce the same run, which is what makes a browser-found bug
 * convertible into a fixture (§15.5 item 39).
 */

import type { LatLng } from '../geo';
import { haversine, lineLength, vertexAt } from '../geo';
import type { Fix } from './location';

/**
 * A small, fast, deterministic PRNG.
 *
 * `mulberry32`: 32 bits of state, no dependencies, and identical output in every JS engine —
 * which `Math.random` cannot promise. Seeded so a reported bug carries a seed rather than a
 * description.
 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A fault to inject.
 *
 * `at` is the simulator's own clock, so a fault scheduled for t = 40 s starts after exactly
 * 40 simulated seconds however long that takes in real time, and the same script reproduces
 * the same run. It is on the type rather than hidden behind a cast because a scheduled fault
 * is a thing you construct, not an internal detail.
 */
export type Fault = {
  /** When to start, in ms on the simulator's clock. Omit to start on the next tick. */
  at?: number;
} & (
  /**
   * Drive N metres perpendicular to the route — a wrong exit.
   *
   * Lasts until it is superseded, or for `ms` if given. It is the one fault a driver stays
   * *in*: the default `0 ms` in the first version made it expire on the tick it started, so
   * the car was never actually off the route and the test asserting a 120 m deviation
   * measured zero.
   */
  | { kind: 'off-route'; metres: number; ms?: number }
  /** Deliver nothing for N ms — a tunnel, or a receiver that has lost the sky. */
  | { kind: 'freeze'; ms: number }
  /** Put the car somewhere else entirely, for `ms` (default one fix interval). */
  | { kind: 'teleport'; to: LatLng; ms?: number }
  /** Put the car further along, as if a leg had been skipped. One-shot. */
  | { kind: 'jump-ahead'; metres: number }
  /** Put the car back down the route. One-shot. */
  | { kind: 'jump-back'; metres: number }
  /** Walk the route backwards at the current speed. */
  | { kind: 'reverse'; ms: number }
  /** Stop dead — a red light, and the case that used to trip the stale-position guard. */
  | { kind: 'stop'; ms: number }
);

export interface SimulatorOptions {
  /** The route to drive, as `[lon, lat]`. */
  route: LatLng[];
  /** Seed for the jitter. Two runs with the same seed are identical. */
  seed?: number;
  /** Metres per second. Default 13 m/s ≈ 47 km/h, an urban average. */
  speed?: number;
  /** Horizontal accuracy reported to the app, in metres. */
  accuracy?: number;
  /** Jitter in metres, peak. Real GPS is not smooth and §3.17's tests needed it to be. */
  jitter?: number;
  /** Where along the route to start, in metres. Default 0. */
  startAt?: number;
}

export interface SimulatorState {
  /** Metres travelled along the route. */
  along: number;
  /** Metres per second, signed: negative while a `reverse` fault is active. */
  speed: number;
  /** Accumulator for the next fix, in ms. */
  pendingMs: number;
  /** Faults not yet started. */
  queue: Fault[];
  /** Faults currently in force, with the time at which each ends. */
  active: { fault: Fault; endsAt: number }[];
  /** When the next fix is due, on the simulator's clock. */
  nextFixAt: number;
  /**
   * When the previous fix was emitted.
   *
   * The car's motion is integrated over the interval between fixes, so `dt` has to be
   * measured from the last one. Measuring to the *next* fix — the obvious thing, since that
   * is the timestamp a tick carries — gives zero whenever a tick lands exactly on schedule,
   * which is how the harness drives it. The car then never moved: every position was the
   * start of the route and every "does it drive" assertion was measuring nothing.
   */
  lastFixAt: number;
  /** How many fixes have been produced, so a test can assert on the count. */
  emitted: number;
}

/** The fault-free initial state. */
export function initialState(opts: SimulatorOptions): SimulatorState {
  const speed = opts.speed ?? 13;
  return {
    along: opts.startAt ?? 0,
    speed,
    pendingMs: 0,
    queue: [],
    active: [],
    nextFixAt: 0,
    lastFixAt: Number.NEGATIVE_INFINITY,
    emitted: 0,
  };
}

/**
 * Where the car is, as `[lon, lat]`.
 *
 * Interpolated along the route **in metres**, not by segment index: an index cannot express a
 * position within a segment, and §3.17 is the record of what that cost once — an ETA that read
 * `0 m` to destination while the driver was 900 m off course. `vertexAt` gives the bracketing
 * vertices and the leftover distance is spent proportionally.
 */
export function positionAlong(route: LatLng[], along: number): LatLng {
  if (route.length === 0) return [0, 0];
  if (route.length === 1) return route[0]!;
  const total = lineLength(route);
  if (total <= 0) return route[0]!;

  const clamped = Math.max(0, Math.min(along, total));
  let walked = 0;
  for (let i = 0; i + 1 < route.length; i++) {
    const seg = haversine(route[i]!, route[i + 1]!);
    if (walked + seg >= clamped) {
      const f = seg <= 0 ? 0 : (clamped - walked) / seg;
      return [
        route[i]![0] + (route[i + 1]![0] - route[i]![0]) * f,
        route[i]![1] + (route[i + 1]![1] - route[i]![1]) * f,
      ];
    }
    walked += seg;
  }
  return route[route.length - 1]!;
}

/** Heading in degrees from north, along the route at `along`. */
export function headingAlong(route: LatLng[], along: number): number {
  const a = positionAlong(route, along - 3);
  const b = positionAlong(route, along + 3);
  const dLon = (b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180) * 111320;
  const dLat = (b[1] - a[1]) * 111320;
  if (dLon === 0 && dLat === 0) return 0;
  return (Math.atan2(dLon, dLat) * 180) / Math.PI;
}

/** Offset a position perpendicular to the route's heading — the `off-route` fault. */
export function offsetPerpendicular(pos: LatLng, headingDeg: number, metres: number): LatLng {
  // East/north in metres, then back to degrees. The cosine factor is what keeps the offset
  // the same number of metres at 60 N as at the equator, which matters because the fixture
  // is in Edinburgh and a driver in Calgary is not being simulated.
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos((pos[1] * Math.PI) / 180);
  // Bearing is degrees clockwise from north, so a bearing θ has east = sin θ and
  // north = cos θ. "To the right of travel" is θ + 90°, which gives east = cos θ and
  // north = -sin θ. The first version used the (θ, θ+90) pair directly, which is the
  // transposed mapping: a car heading north was moved 200 m NORTH rather than east, and the
  // test caught it only because it asserted a direction rather than a distance.
  const rad = (headingDeg * Math.PI) / 180;
  const east = Math.cos(rad) * metres;
  const north = -Math.sin(rad) * metres;
  return [pos[0] + east / mPerDegLon, pos[1] + north / mPerDegLat];
}

/**
 * Advance the simulator and return the fixes produced.
 *
 * `now` is the simulator's clock in ms. The interval between fixes is the device's real
 * cadence — 1000 ms — because `offroute` and the progress tracker are built around fixes
 * arriving roughly that often, and a simulator emitting 10 Hz would exercise a code path no
 * device has.
 */
export const FIX_INTERVAL_MS = 1000;

/**
 * The most fixes one tick may emit.
 *
 * A catch-up loop bounded only by "now" is a hang waiting for a clock that starts far from
 * zero. `initialState` puts `nextFixAt` at 0 — right for a simulator whose clock begins at
 * 0, and catastrophic for one handed `Date.now()`, which is what `installSimulator` does: the
 * loop tried to emit ~1.7 trillion fixes and crashed the renderer outright, in about four
 * seconds, with no error.
 *
 * The same trap is waiting for a real machine: a backgrounded tab, a suspended app, or a
 * laptop that slept all produce the same gap, so this is not a debug-tool bug.
 */
const MAX_FIXES_PER_TICK = 4;

/**
 * How long a fault stays in force, in ms.
 *
 * One function rather than a `?:` at each use, because the first version spelled the rule out
 * at the one place where new faults were *added* to `active` — and an `off-route` with no `ms`
 * got `0`, so it was born expired. A fault's lifetime is a property of the fault, not of the
 * code path that happens to install it.
 *
 * `Infinity` means "until superseded". The one-shot faults resolve to `0` and are applied at
 * the moment they start, before any fix is produced.
 */
export function lifetimeOf(fault: Fault): number {
  switch (fault.kind) {
    case 'freeze':
    case 'reverse':
    case 'stop':
      return fault.ms;
    // A position, not a perturbation: a driver who has been teleported to the far side of
    // town is still there on the next fix. Defaulting this to one interval made the fault
    // expire and the car drive itself back to the route, which is a fault this tool invented.
    case 'off-route':
    case 'teleport':
      return fault.ms ?? Number.POSITIVE_INFINITY;
    case 'jump-ahead':
    case 'jump-back':
      return 0;
  }
}

/** One tick. Returns every fix due in this interval, in order. */
export function tick(
  state: SimulatorState,
  opts: Required<Pick<SimulatorOptions, 'route' | 'speed' | 'accuracy' | 'jitter' | 'seed'>>,
  now: number,
): { state: SimulatorState; fixes: Fix[] } {
  const total = lineLength(opts.route);
  const random = rng(opts.seed + state.emitted);
  let s: SimulatorState = { ...state, queue: [...state.queue], active: [...state.active] };
  const fixes: Fix[] = [];

  const dt = Number.isFinite(s.lastFixAt)
    ? Math.min(10_000, Math.max(0, now - s.lastFixAt))
    : 0;
  /**
   * Drain the queue.
   *
   * A queued fault starts on the next tick, or at `at` on the simulator's clock. The first
   * version of this asked `faultStartsAt` when each should fire, and that function returned
   * `Infinity` for everything -- so `started` was always empty, no fault ever began, and the
   * six fault tests below were measuring a simulator with no faults in it. They passed for
   * the wrong reason until one of them asserted a distance.
   */
  // Expire first, so a fault lasts its stated duration rather than its stated duration plus
  // a tick. `endsAt > now` is also true for the `Infinity` an open-ended `off-route` carries,
  // which is what lets a driver stay off the route until something supersedes it.
  const stillActive = s.active.filter((a) => a.endsAt > now);

  const started: Fault[] = [];
  const stillQueued: Fault[] = [];
  for (const f of s.queue) {
    if (f.at === undefined || f.at <= now) started.push(f);
    else stillQueued.push(f);
  }

  /**
   * Build the fault set in force for *this* tick, before anything is emitted.
   *
   * Ordering is the whole content of this function. The first version computed
   * `frozen` / `stopped` / `reversing` from the *previous* tick's `active` and installed the
   * newly-started faults at the end, so a fault queued at t = 0 did not affect the fix
   * emitted at t = 0. Four of the fault tests failed for that reason and no two for the same
   * one: a freeze delivered one fix, a stop reported 13 m/s, a teleport was nowhere near its
   * destination, and an expiry was judged against a run that had not stopped yet.
   *
   * So: start the faults, then ask what is in force, then emit.
   */
  // One fault per kind, last one wins -- including among the faults starting *now*, not just
  // against the ones already running. Two `off-route` faults queued at the same tick both
  // used to apply and the car ended up the sum of the two offsets away, which is a fault this
  // tool invented rather than one that was injected.
  const latest = new Map<Fault['kind'], Fault>();
  for (const f of started) latest.set(f.kind, f);
  const active: { fault: Fault; endsAt: number }[] = stillActive.filter(
    (a) => !latest.has(a.fault.kind),
  );
  for (const f of latest.values()) {
    active.push({ fault: f, endsAt: now + lifetimeOf(f) });
  }

  const reversing = active.some((a) => a.fault.kind === 'reverse');
  const stopped = active.some((a) => a.fault.kind === 'stop');
  const frozen = active.some((a) => a.fault.kind === 'freeze');

  if (!frozen && !stopped) {
    let along = s.along + (reversing ? -opts.speed : opts.speed) * (dt / 1000);
    // A `reverse` that reaches the start stops there rather than running off the end, which
    // would produce positions the app would rightly refuse.
    if (reversing && along < 0) along = 0;
    if (!reversing && along > total) along = total;
    s = { ...s, along };
  }

  // `jump-*` are one-shot and move the car, so they are applied before the position is read.
  // `started` holds bare faults; `active` holds `{ fault, endsAt }` wrappers.
  for (const f of started) {
    if (f.kind === 'jump-ahead') s = { ...s, along: Math.min(total, s.along + f.metres) };
    if (f.kind === 'jump-back') s = { ...s, along: Math.max(0, s.along - f.metres) };
  }

  // A `freeze` delivers nothing at all — that is the whole point, and it is the case §3.11.1
  // is about: the device keeps a last value and the app has to notice it is stale.
  if (frozen) {
    // The clock still advances, so the fixes after the freeze resume on the grid rather than
    // all landing at once.
    return {
      state: { ...s, queue: stillQueued, active, lastFixAt: now, nextFixAt: now + FIX_INTERVAL_MS },
      fixes: [],
    };
  }

  /**
   * Catch up, but only as far as `MAX_FIXES_PER_TICK`, and skip the rest.
   *
   * Skipping rather than emitting is the honest choice: a fix for a moment 40 minutes ago is
   * not a position anyone was at, and delivering 2,400 of them to the app's progress tracker
   * is a thing to be survived rather than reported.
   */
  if (now - s.nextFixAt > MAX_FIXES_PER_TICK * FIX_INTERVAL_MS) {
    const skipped = Math.floor((now - s.nextFixAt) / FIX_INTERVAL_MS) * FIX_INTERVAL_MS;
    s = { ...s, nextFixAt: s.nextFixAt + skipped, lastFixAt: s.nextFixAt };
  }

  let emittedThisTick = 0;
  while (now >= s.nextFixAt && emittedThisTick < MAX_FIXES_PER_TICK) {
    const at = s.nextFixAt;
    let pos = positionAlong(opts.route, s.along);
    const heading = headingAlong(opts.route, s.along);
    const speed = s.speed;

    for (const a of active) {
      if (a.fault.kind === 'off-route') pos = offsetPerpendicular(pos, heading, a.fault.metres);
      else if (a.fault.kind === 'teleport') pos = a.fault.to;
    }

    if (opts.jitter > 0) {
      // Two uniform draws, so the offset is symmetric. A one-sided jitter would bias the
      // tracker in a direction no real device errs.
      const a = (random() * 2 - 1) * opts.jitter;
      const b = (random() * 2 - 1) * opts.jitter;
      pos = [pos[0] + a / (111320 * Math.cos((pos[1] * Math.PI) / 180)), pos[1] + b / 111320];
    }

    fixes.push({
      pos,
      speed: reversing ? -speed : stopped ? 0 : speed,
      heading,
      accuracy: opts.accuracy,
      ts: at,
    });
    s = {
      ...s,
      emitted: s.emitted + 1,
      lastFixAt: at,
      nextFixAt: s.nextFixAt + FIX_INTERVAL_MS,
    };
    emittedThisTick++;
  }

  // `queue` is updated here rather than at drain time so a fault scheduled for the future
  // survives the ticks that pass before its time.
  return { state: { ...s, queue: stillQueued, active }, fixes };
}

/**
 * Add a fault, optionally scheduled for later on the simulator's clock.
 *
 * Scheduling is what makes a *script* reproducible: "drop the fix at t = 40 s" is a fact a
 * test can state, where "drop the fix at some point" is not.
 */
export function withFault(state: SimulatorState, fault: Fault, at?: number): SimulatorState {
  const f: Fault = at === undefined ? fault : { ...fault, at };
  return { ...state, queue: [...state.queue, f] };
}

/** How far along the route the car is, for the UI. */
export function progressFraction(state: SimulatorState, route: LatLng[]): number {
  const total = lineLength(route);
  return total <= 0 ? 0 : state.along / total;
}

/** The vertex index the car is nearest — for the UI's "at segment N of M". */
export function nearestVertex(state: SimulatorState, route: LatLng[]): number {
  return vertexAt(route, state.along);
}