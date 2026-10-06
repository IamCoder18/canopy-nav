/**
 * Backoff and request sequencing, together.
 *
 * These are two mechanisms added in different passes, and they now interact in a way
 * neither test file covers on its own:
 *
 *  - the **backoff** decides *when* the next reroute request is allowed, and it grows
 *    to a 120 s cap across consecutive failures;
 *  - the **gate** (§13.6) decides whether a request's *answer* is still wanted, and a
 *    driver pressing Exit mid-flight makes every outstanding token stale.
 *
 * The interesting case is a failed reroute whose retry lands after the trip has ended.
 * Before the gate, the abandoned response would install its route on whatever screen
 * was showing and write `finishReroute(..., ok: false)` over the reset state —
 * resurrecting `status: 'failed'` and its banner for a trip that no longer existed,
 * *and* leaving `failures` incremented on state nobody is looking at. Worse in the
 * other direction: if the gate had swallowed the failure, a genuinely dead engine
 * would look like a cancellation and the driver would get no message at all.
 *
 * So the property to pin is the discrimination: an abandoned attempt must leave no
 * trace on state, and a real failure must leave exactly one.
 */

import { describe, it, expect } from 'vitest';
import { RequestGate, SupersededError, isSuperseded } from '../src/nav/requests';
import {
  createRerouteState,
  observeFix,
  beginReroute,
  finishReroute,
  resetReroute,
  MAX_BACKOFF_MS,
  SETTLE_MS,
  type RerouteState,
} from '../src/nav/reroute';
import type { LatLng } from '../src/geo';

const ROUTE: LatLng[] = [
  [-114.0700, 51.0450],
  [-114.0650, 51.0450],
  [-114.0600, 51.0450],
];
/** ~120 m north of the line: unambiguously off it, and it does not move. */
const STUCK: LatLng = [-114.0650, 51.0461];

/** Drive one confirmation window of fixes, returning whether a request was due. */
function window_(from: RerouteState, startAt: number): { state: RerouteState; due: boolean } {
  let s = from;
  for (let t = startAt; t < startAt + 40_000; t += 1_000) {
    const r = observeFix(s, ROUTE, STUCK, 0, t);
    s = r.state;
    if (r.trigger) return { state: s, due: true };
  }
  return { state: s, due: false };
}

/**
 * The reroute effect's contract with the gate, as a testable shape.
 *
 * Deliberately not React: the effect supplies a fix and does what the policy asks, so
 * what can go wrong is exactly the sequence below — assert before installing, guard
 * the failure report, and settle only if still live. `test/requests.spec.ts` covers the
 * gate on its own and `test/reroute-backoff.spec.ts` the backoff; this covers the
 * interaction, which is where a stale write would land.
 */
async function attempt(
  gate: RequestGate,
  state: RerouteState,
  resolve: () => Promise<void>,
): Promise<{ state: RerouteState; reported: string | null }> {
  const { token } = gate.begin();
  let reason: string | undefined;
  let ok = false;
  try {
    await resolve();
    gate.assertLive(token);
    ok = true;
  } catch (e) {
    if (isSuperseded(e)) return { state, reported: null };
    reason = e instanceof Error ? e.message : String(e);
  }
  if (gate.isStale(token)) return { state, reported: null };
  return {
    state: finishReroute(state, ok, Date.now(), reason, undefined, STUCK),
    reported: reason ?? null,
  };
}

describe('a backoff-to-cap reroute that the driver abandons', () => {
  it('reaches the cap on its own, so the case under test is real', () => {
    // If the cap were never reached this whole file would be testing nothing.
    let s = createRerouteState();
    let at = 1_000;
    for (let i = 0; i < 6; i++) {
      const w = window_(s, at);
      s = beginReroute(w.state);
      s = finishReroute(s, false, at, 'no route found', undefined, STUCK);
      at += MAX_BACKOFF_MS;
    }
    expect(s.failures).toBeGreaterThanOrEqual(3);
    expect(s.lastFinished).not.toBeNull();
  });

  it('leaves the reset state untouched when the trip ends mid-retry', async () => {
    // The regression this is here for: the abandoned retry wrote
    // `finishReroute(..., ok: false)` over `resetReroute()`, which resurrected
    // `status: 'failed'` and its banner on a screen with no trip.
    const s = createRerouteState();
    const w = window_(s, 1_000);
    expect(w.due).toBe(true);
    void beginReroute(w.state);

    // The driver presses Exit: navigation ends, state resets, and the gate is
    // cancelled *while the request is still pending*. That ordering is the whole
    // case — cancelling before the attempt starts would be a different scenario,
    // and would leave the request legitimately live.
    const afterExit = resetReroute();
    const gate = new RequestGate('reroute');
    let release!: () => void;
    const pending = new Promise<void>((r) => { release = r; });

// The effect settles onto whatever `rerouteState.current` holds when the answer
    // arrives — which, after Exit, is the reset state.
    const inFlight = attempt(gate, afterExit, async () => {
      await pending;
      // The request eventually fails, long after the trip is over.
      throw new Error('no route found');
    });

    await Promise.resolve();          // let `attempt` take the gate
    gate.cancel();                    // navigation ended, mid-request
    release();

    const { state: settled, reported } = await inFlight;

    expect(reported).toBeNull();
    // Untouched: not merely "not failed", but the same object the effect would
    // have written onto. A stale write here is the original defect.
    expect(settled).toEqual(afterExit);
    expect(settled.status).toBe('idle');
    expect(settled.failures).toBe(0);
    expect(settled.message).toBeNull();
    expect(settled.busy).toBe(false);
  });

  it('never reports a superseded failure as a reason the driver should see', async () => {
    // The other direction, and the one that would be easy to get wrong: if the
    // guard matched every Error, a dead engine would look like a cancellation and
    // the driver would get no message at all.
    const gate = new RequestGate('reroute');
    const s = { ...createRerouteState(), status: 'failed' as const, reason: 'API key required' };
    gate.begin();
    // `assertLive(-1)` is stale by construction: token 0 was never issued.
    const out = await attempt(gate, s, async () => gate.assertLive(-1));
    expect(out.reported).toBeNull();
    // The state the driver was already seeing is untouched.
    expect(out.state.reason).toBe('API key required');
  });

  it('does report a real failure once, from the live attempt', async () => {
    // Without this, the two tests above would also pass with the gate simply
    // swallowing everything.
    const gate = new RequestGate('reroute');
    const s = beginReroute(window_(createRerouteState(), 1_000).state);
    const { state, reported } = await attempt(gate, s, async () => {
      throw new Error('The routing server did not answer within 20 seconds.');
    });

    expect(reported).toMatch(/did not answer/);
    expect(state.status).toBe('failed');
    expect(state.failures).toBe(1);
    expect(state.message).toMatch(/did not answer/);
    expect(state.reason).toMatch(/did not answer/);
  });

  it('a cancellation is not a failure, so it cannot inflate the backoff', () => {
    // `failures` drives a 30 s → 120 s curve. An abandoned request must not count,
    // or leaving the screen and coming back would double the next wait for a trip
    // that had no failures at all.
    const gate = new RequestGate('reroute');
    const stale = gate.begin();
    gate.cancel();
    expect(gate.isStale(stale.token)).toBe(true);
    expect(() => gate.assertLive(stale.token)).toThrow(SupersededError);
  });

  it('a fresh trip starts from a clean slate, not from the last trip’s failures', () => {
    // The reset already clears `failures`; this is the assertion that it stays
    // cleared once a gate is involved.
    const gate = new RequestGate('reroute');
    let s = createRerouteState();
    const w = window_(s, 1_000);
    s = finishReroute(beginReroute(w.state), false, 2_000, 'no route found', undefined, STUCK);
    expect(s.failures).toBe(1);

    gate.cancel();
    const fresh = resetReroute();
    expect(fresh.failures).toBe(0);
    // And the settle period, not a failure backoff, is what the next trip gets.
    expect(SETTLE_MS).toBeLessThan(MAX_BACKOFF_MS);
  });

  it('a re-armed gate accepts the next attempt after a cancellation', () => {
    // `cancel()` runs from an effect cleanup, so it happens on every unmount and
    // every screen change. If it left the gate permanently poisoned, the second trip
    // of a session could never reroute at all — which is the mirror image of the bug
    // this file is about.
    const gate = new RequestGate('reroute');
    gate.begin();
    gate.cancel();
    gate.cancel();
    const next = gate.begin();
    expect(gate.isStale(next.token)).toBe(false);
    expect(() => gate.assertLive(next.token)).not.toThrow();
  });
});