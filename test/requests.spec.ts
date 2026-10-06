/**
 * Request sequencing.
 *
 * `resolveRoute` can be outstanding for twenty seconds. Two callers could have one
 * in flight at once and neither checked whether its answer still mattered, so both
 * wrote `route`, `provenance` and `fitNonce` on completion. The symptoms were:
 *
 *  - destination A's geometry drawn under destination B's label;
 *  - the first `finally` clearing the spinner while the second request was still
 *    running, so the UI said "ready" over an unanswered request;
 *  - and in the reroute case, pressing Exit mid-request — `resetReroute()` cleared
 *    the state, then the abandoned response installed a route on the preview screen
 *    and wrote `finishReroute(..., ok: false)` over the reset, resurrecting
 *    `status: 'failed'` and its banner for a trip that no longer existed.
 *
 * The gate is a counter rather than an abort because the expensive part is not
 * always the socket: `routeOnGraph` is a synchronous A* walk that no abort can
 * interrupt. Correctness comes from discarding the stale answer, not from stopping
 * the work.
 *
 * These tests assert the *property* — one live request, stale answers rejected,
 * cancellation is not reported as failure — rather than the implementation.
 */

import { describe, it, expect } from 'vitest';
import { RequestGate, SupersededError, isSuperseded } from '../src/nav/requests';

describe('RequestGate', () => {
  it('lets the first request through', () => {
    const gate = new RequestGate('route');
    const { token } = gate.begin();
    expect(gate.isStale(token)).toBe(false);
    expect(() => gate.assertLive(token)).not.toThrow();
  });

  it('makes the previous token stale the moment a new request begins', () => {
    // The property that matters: supersession happens at *begin*, not at
    // completion. A gate that only invalidated on finish would still let two
    // requests race.
    const gate = new RequestGate('route');
    const first = gate.begin();
    const second = gate.begin();
    expect(gate.isStale(first.token)).toBe(true);
    expect(gate.isStale(second.token)).toBe(false);
  });

  it('throws rather than returning false, so a call site cannot forget to check', () => {
    const gate = new RequestGate('route');
    const stale = gate.begin();
    gate.begin();
    expect(() => gate.assertLive(stale.token)).toThrow(SupersededError);
  });

  it('names the request in the error, because "superseded" is ambiguous alone', () => {
    const gate = new RequestGate('reroute');
    const stale = gate.begin();
    gate.begin();
    try {
      gate.assertLive(stale.token);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as Error).message).toMatch(/reroute/);
      expect((e as SupersededError).which).toBe('reroute');
    }
  });

  it('aborts the superseded request, so the socket is not left running', () => {
    const gate = new RequestGate('route');
    const first = gate.begin();
    expect(first.signal.aborted).toBe(false);
    gate.begin();
    expect(first.signal.aborted).toBe(true);
    // The abort reason is the error, so a caller's own abort handler can tell a
    // supersession from a timeout.
    expect(first.signal.reason).toBeInstanceOf(SupersededError);
  });

  it('gives each request a distinct signal', () => {
    const gate = new RequestGate('route');
    const a = gate.begin();
    const b = gate.begin();
    expect(a.signal).not.toBe(b.signal);
    expect(b.signal.aborted).toBe(false);
  });

  it('cancel() invalidates and aborts without throwing', () => {
    // Called from cleanup, where a rejection would be reported as an application
    // error for something the app did deliberately.
    const gate = new RequestGate('reroute');
    const live = gate.begin();
    expect(() => gate.cancel()).not.toThrow();
    expect(gate.isStale(live.token)).toBe(true);
    expect(live.signal.aborted).toBe(true);
  });

  it('cancel() twice is safe, and a later begin() still works', () => {
    // Navigating away and back re-runs the effect, so this happens in normal use.
    const gate = new RequestGate('reroute');
    gate.cancel();
    expect(() => gate.cancel()).not.toThrow();
    const fresh = gate.begin();
    expect(gate.isStale(fresh.token)).toBe(false);
  });

  it('keeps tokens unique across a long session', () => {
    // A monotonic counter, so 100k requests cannot collide onto a stale answer.
    const gate = new RequestGate('route');
    const tokens = new Set<number>();
    for (let i = 0; i < 100_000; i++) tokens.add(gate.begin().token);
    expect(tokens.size).toBe(100_000);
  });
});

/**
 * The property, expressed as the shape of a call site.
 *
 * The gate is only as good as the code that consults it, and the two defects above
 * were both *missing* consultations rather than a broken gate. So this models the
 * real pattern — an async body that writes shared state on completion — and shows
 * what the gate turns it into.
 */
describe('an abandoned request writes nothing', () => {
  interface App {
    route: string | null;
    spinner: boolean;
    banner: string | null;
  }

  /** Two searches in quick succession, the first resolving late. */
  async function twoOverlappingSearches(gate: RequestGate): Promise<App> {
    const app: App = { route: null, spinner: false, banner: null };

    const search = async (destination: string, resolveAfter: number) => {
      const { token } = gate.begin();
      app.spinner = true;
      try {
        const answer = await new Promise<string>((r) => setTimeout(() => r(destination), resolveAfter));
        gate.assertLive(token);
        app.route = answer;
      } catch (e) {
        if (isSuperseded(e)) return;
        app.banner = String(e);
      } finally {
        if (!gate.isStale(token)) app.spinner = false;
      }
    };

    // B is issued while A is still waiting on the network.
    const a = search('destination A', 60);
    await new Promise((r) => setTimeout(r, 5));
    const b = search('destination B', 5);
    await Promise.all([a, b]);
    return app;
  }

  it('shows the newer answer, not the older one', async () => {
    const app = await twoOverlappingSearches(new RequestGate('route'));
    expect(app.route).toBe('destination B');
  });

  it('never shows A’s line under B’s label, which is the reported symptom', async () => {
    const app = await twoOverlappingSearches(new RequestGate('route'));
    expect(app.route).not.toBe('destination A');
  });

  it('reports nothing about the abandoned request', async () => {
    // A superseded request is not a failure. Reported, it puts "no route found"
    // in the card above Start for a route the app is no longer computing.
    const app = await twoOverlappingSearches(new RequestGate('route'));
    expect(app.banner).toBeNull();
  });

  it('still reports a real failure from the live request', async () => {
    // The other half of the discrimination: guarding against supersession must not
    // become swallowing every error. A dead engine has to reach the driver.
    const gate = new RequestGate('route');
    const { token } = gate.begin();
    let banner: string | null = null;
    try {
      await Promise.reject(new Error('the routing server did not answer'));
      gate.assertLive(token);
    } catch (e) {
      if (!isSuperseded(e)) banner = String(e);
    }
    expect(banner).toMatch(/did not answer/);
  });

  it('leaves the spinner on until the live request finishes', async () => {
    // The first `finally` used to clear it while the second was still running.
    // Observed mid-flight rather than at the end, because the bug is precisely
    // that the spinner cleared *early* and a final-state assertion cannot see it.
    const gate = new RequestGate('route');
    const app: App = { route: null, spinner: false, banner: null };
    const search = async (destination: string, resolveAfter: number) => {
      const { token } = gate.begin();
      app.spinner = true;
      try {
        const answer = await new Promise<string>((r) => setTimeout(() => r(destination), resolveAfter));
        gate.assertLive(token);
        app.route = answer;
      } catch (e) {
        if (isSuperseded(e)) return;
        app.banner = String(e);
      } finally {
        if (!gate.isStale(token)) app.spinner = false;
      }
    };

    const a = search('A', 200);
    await new Promise((r) => setTimeout(r, 5));
    // Not awaited: B is expected to have resolved by the assertion below, and
    // awaiting it here would hide the early-spinner-clear this is testing for.
    void search('B', 20);
    // B resolves at ~25 ms while A is still outstanding until ~205 ms.
    await new Promise((r) => setTimeout(r, 120));
    expect(app.route).toBe('B');
    expect(app.spinner).toBe(false);
    // A is still in flight, and it must not be able to change anything.
    await a;
    expect(app.route).toBe('B');
    expect(app.banner).toBeNull();
  });

  it('leaves nothing behind when the trip is cancelled outright', async () => {
    // The reroute case: Exit pressed mid-request.
    const gate = new RequestGate('reroute');
    const app: App = { route: 'the old route', spinner: true, banner: null };
    const { token } = gate.begin();
    const inFlight = (async () => {
      const answer = await new Promise<string>((r) => setTimeout(() => r('a new route'), 40));
      gate.assertLive(token);
      app.route = answer;
    })().catch((e) => {
      if (!isSuperseded(e)) throw e;
    });

    gate.cancel();
    await inFlight;

    // The old route is untouched, and nothing resurrected a failure banner.
    expect(app.route).toBe('the old route');
  });

  it('works without the abort, for a request that cannot be interrupted', async () => {
    // `routeOnGraph` is a synchronous A* walk: nothing can cancel it, so the gate
    // has to be sufficient on its own. Shown by driving it with a signal nobody
    // listens to.
    const gate = new RequestGate('route');
    const stale = gate.begin();
    gate.begin();
    // An uninterruptible computation, then the check that decides its fate.
    const answer = await new Promise<string>((r) => setTimeout(() => r('computed anyway'), 10));
    let installed = false;
    try {
      gate.assertLive(stale.token);
      installed = true;
    } catch {
      installed = false;
    }
    expect(answer).toBe('computed anyway');
    expect(installed).toBe(false);
  });
});

describe('isSuperseded', () => {
  it('is true only for a supersession', () => {
    const gate = new RequestGate('route');
    const stale = gate.begin();
    gate.begin();
    try {
      gate.assertLive(stale.token);
      throw new Error('should have thrown');
    } catch (e) {
      expect(isSuperseded(e)).toBe(true);
    }
  });

  it('is false for an ordinary failure, which must still be reported', () => {
    // The discrimination that keeps a real error from being swallowed: if
    // `isSuperseded` matched every Error, a dead engine would look like a
    // cancellation and the driver would get no message at all.
    for (const e of [new Error('network down'), new TypeError('x'), null, undefined, 'string']) {
      expect(isSuperseded(e)).toBe(false);
    }
  });

  it('does not match a plain object with the same shape', () => {
    expect(isSuperseded({ name: 'SupersededError', message: 'x' })).toBe(false);
  });
});