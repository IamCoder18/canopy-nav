/**
 * The drive simulator's position source — §15.5 items 35–37, 39.
 *
 * ## The one rule, and why it lives here and not in `simulator.ts`
 *
 * **No production code path is stubbed.** Positions are delivered through
 * `navigator.geolocation.watchPosition`'s own callbacks — the seam Playwright's
 * `setGeolocation` uses — so they travel the real `watchPosition → offroute → progress →
 * guidance` chain. `src/nav/simulator.ts` is pure and knows nothing about the DOM; this is
 * the only file that does, and the only place anything is replaced.
 *
 * ## Why this installs at startup rather than when the toggle is pressed
 *
 * **The first version installed on the toggle, and delivered nothing.** `useLocation` runs
 * its subscription in an effect at mount — before any driver has reached Settings — so the
 * callback it registered went to the *real* `watchPosition`. Replacing the method afterwards
 * put an override in front of a subscription that had already gone past it, and the simulator
 * generated positions that nobody received.
 *
 * Every symptom was consistent with that and none of them named it: the panel counted fixes
 * correctly, the app's distance readout sat frozen at "670 m to destination", and no error
 * was raised anywhere. It was found by the browser check that asserts the app's *own* readout
 * moves — the check that a rising fix count had been standing in for, which it cannot do,
 * because the fix count is `tick`'s and `tick` runs either way.
 *
 * So the position source is a **multiplexer installed once at startup**, in `main.tsx`, before
 * React mounts. It keeps the real receiver running and adds the synthetic one on top. The
 * toggle starts and stops the synthetic clock; nothing re-subscribes, because the app is
 * already subscribed to *this* and always was.
 *
 * ## Off by default
 *
 * It replaces nothing and emits nothing beyond the real fix until asked for. Nothing here is
 * safe on a real road.
 *
 * ## What it deliberately does not do
 *
 * It does not stub `Date.now()`, `setTimeout`, or the route engine. A simulator that faked the
 * clock would make the off-route settle windows pass at a speed the code never sees, and
 * timing bugs are much of the class worth finding. What it offers instead is a *seed*, so a
 * run that found something can be repeated exactly.
 */

import { lineLength, type LatLng } from '../geo';
import {
  initialState, tick, withFault, progressFraction,
  type Fault, type SimulatorOptions, type SimulatorState,
} from './simulator';
import type { Fix } from './location';

export type SimHandle = {
  /**
   * Where to drive, re-read on every fix.
   *
   * Point `SimHandle.setRoute` at the app's *current* geometry rather than passing a closure
   * built during one render: a reroute replaces the array, and a closure captured at click
   * time keeps serving the pre-reroute one.
   */
  route: () => LatLng[];
  /** Replace the route source. The app calls this whenever `route.geometry` changes. */
  setRoute: (fn: () => LatLng[]) => void;
  /** Stop the synthetic clock. The real receiver is untouched throughout. */
  stop: () => void;
  /** Inject a fault now, or at `atMs` on the simulator's clock. */
  fault: (f: Fault, atMs?: number) => void;
  /** Jump to a fraction of the route — the scrub control. */
  scrubTo: (fraction: number) => void;
  /** Read the state, for the panel. */
  state: () => SimulatorState;
};

/* ------------------------- the multiplexer ------------------------- */

type Watch = {
  success: PositionCallback;
  error: PositionErrorCallback | null;
};

let geo: Geolocation | null = null;
let realWatch: Geolocation['watchPosition'] | null = null;
let realClear: Geolocation['clearWatch'] | null = null;
/** Watch id → what we handed out. */
const watches = new Map<number, Watch>();
/** Our id → the real provider's id, for the watches that asked for the real thing. */
const realIds = new Map<number, number>();
let nextId = 1;
let installed = false;

/**
 * Deliver synthetic fixes to **every** watcher.
 *
 * Not only to the ones registered while the simulator was running. `useLocation` subscribes
 * at mount, long before anyone reaches the toggle, so a per-watch flag left the app's only
 * subscription permanently attached to the real receiver -- and the simulator drove a car the
 * app never heard about. The symptom was a panel reporting seven fixes emitted next to a
 * frozen position and a speed of 0 km/h, with nothing thrown anywhere.
 *
 * The real receiver stays subscribed throughout, so nothing is lost: its fixes stop being
 * delivered while a simulator is driving, and resume the moment it stops.
 */
function deliver(fixes: Fix[]) {
  for (const f of fixes) {
    const pos = fixToPosition(f);
    for (const w of watches.values()) {
      try {
        w.success(pos);
      } catch {
        // One subscriber throwing must not stop the others or the simulator. `offroute` and
        // the progress tracker are independent; letting one kill the loop would hide exactly
        // the bug this exists to find.
      }
    }
  }
}

/** Send a real fix -- to everyone, unless a simulator is currently driving. */
function deliverReal(pos: GeolocationPosition) {
  if (running) return;
  for (const w of watches.values()) {
    try {
      w.success(pos);
    } catch {
      // As above.
    }
  }
}

/**
 * Put the multiplexer in front of `navigator.geolocation`.
 *
 * Idempotent, and safe to call before React mounts — which is the whole point.
 */
export function installPositionSource(): void {
  if (installed) return;
  const g: Geolocation | undefined =
    typeof navigator !== 'undefined' ? navigator.geolocation : undefined;
  if (!g || typeof g.watchPosition !== 'function') return;

  geo = g;
  realWatch = g.watchPosition.bind(g);
  realClear = g.clearWatch.bind(g);

  /*
   * The assignments are guarded, and that is not belt-and-braces.
   *
   * This is called at module scope from `main.tsx`, before `createRoot`. A module is strict
   * mode, and assigning to a non-writable host property *throws* there rather than failing
   * silently -- so an engine or a locked-down WebView that refuses the write would have taken
   * the whole app to a blank page, with the trace pointing at line 8 of `main.tsx`.
   *
   * A debug affordance may fail to install. It may not take the app down with it.
   */
  try {
    g.watchPosition = ((
      success: PositionCallback,
      error?: PositionErrorCallback | null,
      options?: PositionOptions,
    ) => {
      const id = nextId++;
      watches.set(id, { success, error: error ?? null });
      // The real provider is subscribed for every watch, always. Stopping the simulator
      // therefore restores real fixes with no re-subscription, so nothing is leaked and a
      // device with the simulator on by accident loses nothing.
      const rid = realWatch!(
        (p) => deliverReal(p),
        error ? (e) => deliverError(e) : undefined,
        options,
      );
      realIds.set(id, rid);
      return id;
  }) as Geolocation['watchPosition'];

    g.clearWatch = ((id: number) => {
      const rid = realIds.get(id);
      if (rid !== undefined) realClear!(rid);
      realIds.delete(id);
      watches.delete(id);
    }) as Geolocation['clearWatch'];
    installed = true;
  } catch {
    // A refused write leaves the platform untouched, which is the correct outcome: the
    // simulator simply is not available, and the app runs exactly as it would without this
    // file having been imported. `installed` stays false, so `startSimulator` will say so.
    installed = false;
  }
}

/** Whether the multiplexer is actually in place. */
export function positionSourceInstalled(): boolean {
  return installed;
}

function deliverError(e: GeolocationPositionError) {
  // Suppressed while driving: a synthetic car has no receiver to lose, and a permission
  // error arriving mid-simulation would be the one thing that could stop the app moving.
  if (running) return;
  for (const w of watches.values()) {
    if (w.error) {
      try {
        w.error(e);
      } catch {
        // As above.
      }
    }
  }
}

/* ----------------------------- the clock ---------------------------- */

type Running = {
  handle: SimHandle;
  timer: ReturnType<typeof setInterval>;
  opts: { route: LatLng[]; speed: number; accuracy: number; jitter: number; seed: number };
};

let running: Running | null = null;

const listeners = new Set<(s: SimulatorState) => void>();
let lastState: SimulatorState | null = null;

function notify(state: SimulatorState) {
  lastState = state;
  for (const fn of [...listeners]) fn(state);
}

/**
 * Start the synthetic clock.
 *
 * Returns `null` when there is nothing to drive — fewer than two points — because a simulator
 * pointed at an empty route emits a position the app tries to route to, and the resulting
 * failure would be reported as a product bug.
 */
export function startSimulator(
  options: SimulatorOptions,
  routeFn?: () => LatLng[],
): SimHandle | null {
  installPositionSource();
  stopSimulator();

  /*
   * The route, read fresh -- and read from a *ref*, not from the closure.
   *
   * The first version took `() => simRoute` from a click-time render. A reroute replaces
   * `route.geometry` with a new array, and the closure kept returning the old one: the
   * simulator drove the pre-reroute geometry while the app followed the new one, so the two
   * silently disagreed and the panel divided the old route's progress by the new route's
   * length. The claim on `SimHandle.route` -- "re-read every fix, so a reroute is followed" --
   * was false of the code that carried it.
   */
  const routeRef: { current: () => LatLng[] } = { current: routeFn ?? (() => options.route) };
  const getRoute = () => routeRef.current();
  if (getRoute().length < 2) return null;

  let state = initialState(options);
  const opts = {
    route: getRoute(),
    speed: options.speed ?? 13,
    accuracy: options.accuracy ?? 8,
    jitter: options.jitter ?? 2,
    seed: options.seed ?? 1,
  };

  /**
   * 250 ms, not 1000: `tick` emits on its own 1000 ms grid, so a faster poll only makes the
   * panel's scrub and fault buttons feel responsive. It does not change the cadence the app
   * sees, which is the thing that has to match a device.
   */
  const timer = setInterval(() => {
    const route = getRoute();
    if (route.length < 2) return;
    const r = tick(state, { ...opts, route }, Date.now());
    state = r.state;
    deliver(r.fixes);
    notify(state);
  }, 250);

  const handle: SimHandle = {
    route: getRoute,
    setRoute: (fn) => { routeRef.current = fn; },
    // Bound to this run, not to the module function: `stopSimulator` stops whichever run is
    // current, so an old handle's `stop()` used to stop the *new* one.
    stop: () => stopRun(running),
    fault: (f, atMs) => {
      state = withFault(state, f, atMs);
      notify(state);
    },
    scrubTo: (fraction) => {
      const total = totalOf(getRoute());
      state = { ...state, along: Math.max(0, Math.min(1, fraction)) * total };
      notify(state);
    },
    state: () => state,
  };

  running = { handle, timer, opts };
  notify(state);
  return handle;
}

/**
/**
 * Stop the synthetic clock.
 *
 * **The real receiver resumes immediately and no re-subscription is needed.** Every watch is
 * subscribed to the real provider from the moment it is registered —
 * `installPositionSource` does that unconditionally — and `deliverReal` suppresses delivery
 * only while `running`. Nulling `running` is the whole of the restore.
 *
 * Which corrects an earlier claim in this file and in STATUS.md §14.22, both of which said
 * a driver would need a reload. That was invented: it followed from a per-watch `real` flag
 * that does not exist in this file, and it was never tested. The reload is not needed.
 */
/** Stop a specific run. Separate so a stale handle cannot stop a newer one. */
function stopRun(target: Running | null): void {
  if (!target || target !== running) return;
  stopSimulator();
}

export function stopSimulator(): void {
  if (!running) return;
  clearInterval(running.timer);
  // Read through the handle, which closes over the live state. A `running.state` field
  // cannot work: the interval reassigns the closure variable and never touches the field, so
  // the field stays on `initialState`'s object with `emitted: 0` forever.
  const finished = running.handle.state();
  running = null;
  // The counts are kept. The run happened, and a debug panel that forgets it the moment you
  // stop looking is worse than useless when the question is "did that work".
  notify({ ...finished, active: [], queue: [] });
}


/** Whether the synthetic clock is running. */
export function simulatorInstalled(): boolean {
  return running !== null;
}

/** The handle, for the panel. `null` when not running. */
export function currentSimulator(): SimHandle | null {
  return running?.handle ?? null;
}

/** The most recent state, for a panel that mounts after the simulator started. */
export function simulatorState(): SimulatorState | null {
  return lastState;
}

/** Subscribe to every simulator state change. */
export function onSimulatorChange(fn: (s: SimulatorState) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Put the real `watchPosition` back. Only useful in tests and on teardown. */
export function uninstallPositionSource(): void {
  if (!installed || !geo || !realWatch || !realClear) return;
  geo.watchPosition = realWatch;
  geo.clearWatch = realClear;
  for (const rid of realIds.values()) {
    try {
      realClear(rid);
    } catch {
      // An id the real provider never issued throws in some engines, and the override is
      // already gone, which is what matters.
    }
  }
  realIds.clear();
  watches.clear();
  installed = false;
}

/**
 * `lineLength`, not a second implementation of it.
 *
 * This re-derived the route length with a flat equirectangular approximation, while
 * `simulator.ts` and the panel both use `geo.lineLength`. On the test route the two disagreed
 * by 0.11%, which is small and entirely sufficient: `scrubTo(1.0)` set `along` *past* the
 * end, the panel rendered `100%` from `round(1.0011 * 100)`, and the slider was handed
 * `value={1001}` against `max={1000}`.
 *
 * One measurement, one function.
 */
function totalOf(route: LatLng[]): number {
  return lineLength(route);
}

/** `Fix` → a `GeolocationPosition`, so the app's own conversion runs unchanged. */
function fixToPosition(f: Fix): GeolocationPosition {
  const coords = {
    longitude: f.pos[0],
    latitude: f.pos[1],
    accuracy: f.accuracy,
    altitude: null,
    altitudeAccuracy: null,
    heading: f.heading,
    speed: f.speed,
  } as unknown as GeolocationCoordinates;
  return {
    coords,
    timestamp: f.ts,
    toJSON: () => ({ type: 'Position', coords, timestamp: f.ts }),
  } as unknown as GeolocationPosition;
}

export { progressFraction };