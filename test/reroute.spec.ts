/**
 * Reroute policy tests.
 *
 * The interesting failures in a rerouting policy are all about *when not to*
 * act: a jitter storm, a request that loops, a driver left without guidance.
 * So most of what follows asserts restraint, not routing.
 *
 * The policy is pure (`observeFix` takes a state and returns a new one), which
 * is why these need no React, no timers and no network.
 *
 * Run with `npx vitest run test/reroute.spec.ts`.
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

/** ~120 m north of the line: unambiguously off it at any plausible speed. */
const FAR_OFF: LatLng = [-114.0650, 51.0461];

const ON: LatLng = [-114.0650, 51.0450];

/** Drive the policy forward until it asks to act. Returns the final state. */
function driveToTrigger(
  from: RerouteState,
  route = ROUTE,
  fix = FAR_OFF,
  speed = 0,
  start = 1_000,
  step = 2_000,
): { state: RerouteState; triggered: boolean } {
  let s = from;
  let triggered = false;
  for (let i = 0; i < 8 && !triggered; i++) {
    const r = observeFix(s, route, fix, speed, start + i * step);
    s = r.state;
    triggered = r.trigger;
  }
  return { state: s, triggered };
}

/* ------------------------- when to act ------------------------- */

describe('observeFix — acting', () => {
  it('does not act on a single bad fix', () => {
    const r = observeFix(createRerouteState(), ROUTE, FAR_OFF, 0, 1_000);
    expect(r.trigger).toBe(false);
    expect(r.state.status).toBe('suspect');
  });

  it('does not act inside the confirmation window', () => {
    const first = observeFix(createRerouteState(), ROUTE, FAR_OFF, 0, 1_000);
    const second = observeFix(first.state, ROUTE, FAR_OFF, 0, 1_000 + CONFIRM_WINDOW_MS - 1);
    expect(second.trigger).toBe(false);
    expect(second.state.status).toBe('suspect');
  });

  it('acts once the deviation has persisted past the window', () => {
    const { triggered } = driveToTrigger(createRerouteState());
    expect(triggered).toBe(true);
  });

  it('starts the new route from the projected point, never the fix', () => {
    let s = createRerouteState();
    let origin: LatLng | null = null;
    for (let i = 0; i < 8 && !origin; i++) {
      const r = observeFix(s, ROUTE, FAR_OFF, 0, 1_000 + i * 2_000);
      s = r.state;
      if (r.trigger) origin = r.origin;
    }
    expect(origin).not.toBeNull();
    // must lie on the line, i.e. at latitude 51.0450
    expect(origin![1]).toBeCloseTo(51.0450, 3);
    expect(origin![1]).not.toBeCloseTo(51.0461, 3);
  });

  it('never acts without a usable route', () => {
    const r = observeFix(createRerouteState(), [], FAR_OFF, 0, 1_000);
    expect(r.trigger).toBe(false);
    expect(r.state.status).toBe('idle');
  });

  it('clears suspicion the moment the driver is back on the line', () => {
    const off = observeFix(createRerouteState(), ROUTE, FAR_OFF, 0, 1_000);
    const back = observeFix(off.state, ROUTE, ON, 0, 2_000);
    expect(back.state.status).toBe('idle');
    expect(back.state.message).toBeNull();
  });
});

/* ------------------------- storm guards ------------------------- */

describe('observeFix — one attempt at a time', () => {
  it('latches busy so a fix storm cannot queue requests', () => {
    const { state } = driveToTrigger(createRerouteState());
    const busy = beginReroute(state);
    expect(busy.busy).toBe(true);

    // Five more fixes arrive while the request is in flight.
    let s = busy;
    for (let i = 0; i < 5; i++) {
      const r = observeFix(s, ROUTE, FAR_OFF, 0, 20_000 + i * 1_000);
      expect(r.trigger).toBe(false);
      s = r.state;
    }
    expect(s.busy).toBe(true);
  });

  it('does not re-trigger immediately after a successful reroute', () => {
    const { state } = driveToTrigger(createRerouteState());
    const done = finishReroute(beginReroute(state), true, 20_000);
    // Still off the *old* line for a moment while the new one loads.
    const r = observeFix(done, ROUTE, FAR_OFF, 0, 20_500);
    expect(r.trigger).toBe(false);
  });

  it('allows a new attempt once the settle period has passed', () => {
    const { state } = driveToTrigger(createRerouteState());
    const done = finishReroute(beginReroute(state), true, 20_000);
    // A successful reroute resets the tracker, so a *new* deviation has to earn
    // its own confirmation window — and the clock has to clear both that and the
    // settle period before the next attempt is allowed.
    const first = 20_000 + backoffMs(done) + 1;
    const suspect = observeFix(done, ROUTE, FAR_OFF, 0, first);
    expect(suspect.trigger).toBe(false);
    const r = observeFix(suspect.state, ROUTE, FAR_OFF, 0, first + CONFIRM_WINDOW_MS + 1);
    expect(r.trigger).toBe(true);
  });
});

describe('backoff after failure', () => {
  it('grows with consecutive failures and is capped', () => {
    let s = createRerouteState();
    const seen: number[] = [];
    for (let i = 0; i < 8; i++) {
      seen.push(backoffMs(s));
      s = finishReroute(s, false, i * 1_000);
    }
    expect(seen[0]).toBeGreaterThan(0);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    }
    expect(Math.max(...seen)).toBeLessThanOrEqual(120_000);
  });

  it('resets the backoff after a success', () => {
    const failed = finishReroute(createRerouteState(), false, 0);
    expect(backoffMs(failed)).toBeGreaterThan(0);
    const ok = finishReroute(failed, true, 1_000);
    expect(backoffMs(ok)).toBe(30_000);
    expect(ok.failures).toBe(0);
  });

  it('says when the next attempt is due rather than failing silently', () => {
    const { state } = driveToTrigger(createRerouteState());
    const failed = finishReroute(beginReroute(state), false, 20_000, 'no route');
    const r = observeFix(failed, ROUTE, FAR_OFF, 0, 20_100);
    expect(r.trigger).toBe(false);
    expect(r.state.status).toBe('failed');
    expect(r.state.message).toMatch(/retrying in \d+ s/);
  });

  it('reports the engine reason on failure', () => {
    const { state } = driveToTrigger(createRerouteState());
    const failed = finishReroute(beginReroute(state), false, 20_000, 'no route found');
    expect(failed.message).toMatch(/no route found/);
    expect(failed.busy).toBe(false);
  });
});

describe('finishReroute — the driver is never left without guidance', () => {
  it('resets the tracker so the new line is measured from scratch', () => {
    const { state } = driveToTrigger(createRerouteState());
    expect(state.tracker.state).toBe('off-route');
    const done = finishReroute(beginReroute(state), true, 20_000);
    // Keeping the old snapped index would put the driver "ahead" on a route
    // they have not started, so the first fix after a reroute would read as
    // instantly off-route.
    expect(done.tracker.state).toBe('on-route');
    expect(done.tracker.snappedIndex).toBe(0);
  });

  it('clears the message on success', () => {
    const { state } = driveToTrigger(createRerouteState());
    const done = finishReroute(beginReroute(state), true, 20_000);
    expect(done.message).toBeNull();
    expect(rerouteBanner(done, ROUTE)).toBeNull();
  });

  it('does not mutate the state it was given', () => {
    const before = createRerouteState();
    const snapshot = JSON.stringify(before);
    observeFix(before, ROUTE, FAR_OFF, 0, 1_000);
    finishReroute(before, false, 1_000);
    beginReroute(before);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

/* ------------------------- the banner ------------------------- */

describe('rerouteBanner', () => {
  it('says nothing while on route', () => {
    expect(rerouteBanner(createRerouteState(), ROUTE)).toBeNull();
  });

  it('reports the deviation while merely suspicious', () => {
    const s = observeFix(createRerouteState(), ROUTE, FAR_OFF, 0, 1_000).state;
    const banner = rerouteBanner(s, ROUTE);
    // Qualitative, not a raw metre count: this used to render
    // `6978332 m off the route` — unformatted, seven digits, always metric.
    expect(banner).toMatch(/left the route/);
    expect(banner).not.toMatch(/\d{4,}\s*m\b/);
    expect(banner).not.toMatch(/rejoining/);
  });

  it('says it is working, without a rejoin distance it cannot know yet', () => {
    const { state } = driveToTrigger(createRerouteState());
    const banner = rerouteBanner(beginReroute(state), ROUTE);
    expect(banner).toMatch(/finding a new way/i);
    expect(banner).not.toMatch(/rejoining/);
  });

  it('adds the rejoin distance while waiting to retry after a failure', () => {
    const { state } = driveToTrigger(createRerouteState());
    const failed = finishReroute(beginReroute(state), false, 20_000);
    // Inside the backoff window, so the driver is confirmed lost and waiting —
    // which is the only state where a rejoin distance is meaningful.
    const s = observeFix(failed, ROUTE, FAR_OFF, 0, 20_100).state;
    expect(s.status).toBe('failed');
    const banner = rerouteBanner(s, ROUTE);
    expect(banner).toMatch(/rejoining the route in/);
  });

  it('honours imperial units', () => {
    const { state } = driveToTrigger(createRerouteState());
    const failed = finishReroute(beginReroute(state), false, 20_000);
    const s = observeFix(failed, ROUTE, FAR_OFF, 0, 20_100).state;
    expect(rerouteBanner(s, ROUTE, 'imperial')).toMatch(/ft|mi/);
  });

  it('drops the rejoin distance once a new attempt is under way', () => {
    const { state } = driveToTrigger(createRerouteState());
    const failed = finishReroute(beginReroute(state), false, 20_000);
    const s = observeFix(failed, ROUTE, FAR_OFF, 0, 20_000 + backoffMs(failed) + 1).state;
    expect(s.status).toBe('rerouting');
    expect(rerouteBanner(s, ROUTE)).not.toMatch(/rejoining/);
  });
});

/* ------------------------- speed tolerance ------------------------- */

describe('observeFix — speed-scaled tolerance', () => {
  it('ignores a deviation that is normal at motorway speed', () => {
    // ~55 m off the line: clearly lost when stopped, unremarkable at 25 m/s.
    const modest: LatLng = [-114.0650, 51.04549];
    const slow = observeFix(createRerouteState(), ROUTE, modest, 0, 1_000);
    const fast = observeFix(createRerouteState(), ROUTE, modest, 25, 1_000);
    expect(slow.state.status).toBe('suspect');
    expect(fast.state.status).toBe('idle');
  });
});