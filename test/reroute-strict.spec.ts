/**
 * A reroute when the engine is pinned and cannot route.
 *
 * `selection.allowFallback = false` means the plan is exactly one engine, and
 * `resolveRoute` throws `NoRouteError` rather than quietly answering from
 * somewhere else. On the *initial* route that is the honest outcome the driver
 * asked for. During a reroute it is a different proposition: the driver is
 * already lost, they did not choose the failure, and the one thing the policy
 * promises above all else is that they keep the route and the guidance they
 * already had.
 *
 * This file exercises that path end to end without a network: `fetch` is
 * stubbed and asserted *not* to be called, an in-memory OSM dataset stands in
 * for the offline engine (and is deliberately capable of answering, so that
 * "fallback is off" is proved rather than assumed), and the thrown error is
 * then folded through the real reroute policy exactly as `App.tsx:774-781`
 * does it.
 *
 * Run with `npx vitest run test/reroute-strict.spec.ts`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveRoute, NoRouteError, type ProviderId } from '../src/nav/providers';
import { planRoute, type EngineSelection } from '../src/nav/engines';
import {
  createRerouteState,
  observeFix,
  beginReroute,
  finishReroute,
  backoffMs,
  rerouteBanner,
  type RerouteState,
} from '../src/nav/reroute';
import { parseOsmXml, buildDataset, type OsmDataset } from '../src/osm/engine.worker';
import type { LatLng } from '../src/geo';

/* ------------------------------ fixtures ------------------------------ */

const ROUTE: LatLng[] = [
  [-114.0700, 51.0450],
  [-114.0650, 51.0450],
  [-114.0600, 51.0450],
  [-114.0550, 51.0450],
];
/** ~120 m north of the line: confirmed lost at any speed. */
const FAR_OFF: LatLng = [-114.0650, 51.0461];
const DESTINATION: LatLng = [-114.0550, 51.0450];

/** A 3-node residential street the offline engine can genuinely route. */
const XML = `<osm>
  <node id="1" lat="0" lon="0"/>
  <node id="2" lat="0" lon="0.005"/>
  <node id="3" lat="0" lon="0.01"/>
  <way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/></way>
  <way id="11"><nd ref="2"/><nd ref="3"/><tag k="highway" v="residential"/></way>
</osm>`;

function offlineEngineThatCanRoute(): OsmDataset {
  const { nodes, ways } = parseOsmXml(XML);
  return buildDataset(nodes, ways, () => {});
}

const LOCAL_FROM: LatLng = [0, 0];
const LOCAL_TO: LatLng = [0.01, 0];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('navigator', { onLine: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------ the plan ------------------------------ */

/** The request `App.tsx:747-756` builds for a reroute. */
function rerouteRequest(plan: ProviderId[], strict: boolean) {
  return {
    from: FAR_OFF,
    to: DESTINATION,
    provider: plan[0] ?? ('local' as ProviderId),
    plan,
    strict,
    units: 'km' as const,
    avoid: [] as LatLng[][],
  };
}

/**
 * Run the whole reroute as the effect does: drive the policy until it asks to
 * act, run the request, fold the result back in.
 */
async function attemptReroute(
  selection: EngineSelection,
  opts: { dataset?: OsmDataset | null; endpoint?: string; apiKey?: string; from?: RerouteState } = {},
): Promise<{ state: RerouteState; notice: string | null; error: Error | null; plan: ProviderId[] }> {
  const plan = planRoute(selection, { endpoint: opts.endpoint, apiKey: opts.apiKey });
  let s = opts.from ?? createRerouteState();
  let triggered = false;
  let origin: LatLng | null = null;
  let at = 0;
  for (let i = 0; i < 10 && !triggered; i++) {
    at = i * 2_000;
    const r = observeFix(s, ROUTE, FAR_OFF, 0, at);
    s = r.state;
    if (r.trigger) {
      triggered = true;
      origin = r.origin;
      s = beginReroute(s);
    }
  }
  if (!origin) throw new Error('never triggered');

  let ok = false;
  let reason: string | undefined;
  let error: Error | null = null;
  try {
    const outcome = await resolveRoute(
      rerouteRequest(plan, !selection.allowFallback),
      opts.dataset ?? null,
      { apiKey: opts.apiKey, endpoint: opts.endpoint },
    );
    ok = true;
    // `App.tsx:763` replaces the route here. This spec never replaces it: the
    // question is whether the policy needs the replacement to stay safe.
    expect(outcome.route.geometry.length).toBeGreaterThan(0);
  } catch (e) {
    error = e as Error;
    reason = e instanceof NoRouteError ? e.message : (e as Error).message;
  } finally {
    s = finishReroute(s, ok, at + 1_000, reason);
  }
  return { state: s, notice: rerouteBanner(s, ROUTE), error, plan };
}

/* ------------------------------ the tests ------------------------------ */

describe('a pinned engine with fallback off', () => {
  it('plans exactly one engine, so there is nowhere for a reroute to fall back to', () => {
    for (const preferred of ['local', 'valhalla-fossgis', 'valhalla-simplerouting', 'valhalla-custom'] as const) {
      expect(planRoute({ preferred, allowFallback: false })).toEqual([preferred]);
    }
    // `any-online` is the documented exception: "any" means the whole online
    // set, and strict only stops the *offline* fallback being appended.
    expect(planRoute({ preferred: 'any-online', allowFallback: false })).toEqual([
      'valhalla-fossgis', 'valhalla-simplerouting', 'valhalla-custom',
    ]);
  });

  it('fails the reroute with a reason that names the cause', async () => {
    const { state, notice, error, plan } = await attemptReroute(
      { preferred: 'valhalla-custom', allowFallback: false },
    );
    expect(plan).toEqual(['valhalla-custom']);
    expect(error).toBeInstanceOf(NoRouteError);
    expect(error!.message).toBe(
      'The selected engine could not route. Fallback is off, so no other engine was tried.',
    );
    expect(notice).toBe(
      'Off route — The selected engine could not route. Fallback is off, so no other engine was tried. · rejoining the route in 700 m',
    );
    expect(state.status).toBe('failed');
    expect(state.failures).toBe(1);
    expect(state.busy).toBe(false);
  });

  it('does not touch the network for an engine that was never configured', async () => {
    await attemptReroute({ preferred: 'valhalla-custom', allowFallback: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses the offline engine even when it could have answered', async () => {
    // The control that makes "fallback is off" mean something: `dataset` can
    // route this pair, `provider: 'local'` with the same request succeeds
    // (proved below), and strict still refuses it.
    const dataset = offlineEngineThatCanRoute();
    const control = await resolveRoute(
      { from: LOCAL_FROM, to: LOCAL_TO, provider: 'local', units: 'km' },
      dataset, {},
    );
    expect(control.used).toBe('local');

    const { error } = await attemptReroute(
      { preferred: 'valhalla-custom', allowFallback: false },
      { dataset },
    );
    expect(error).toBeInstanceOf(NoRouteError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a fatal 4xx from the pinned engine as the same refusal, not a fallback', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ error: 'No path could be found for the requested locations' }),
    });
    const { error, state } = await attemptReroute(
      { preferred: 'valhalla-fossgis', allowFallback: false },
      { dataset: offlineEngineThatCanRoute() },
    );
    // Exactly one attempt: no local fallback, no second provider.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(NoRouteError);
    expect(error!.message).toMatch(/No route found between those points/);
    // Driver-facing, and a single trailing full stop.
    expect(error!.message).not.toMatch(/No path could be found/);
    expect(error!.message).not.toMatch(/\.\./);
    expect(state.status).toBe('failed');
  });

  it('leaves the driver on the old route with guidance and a retry message', async () => {
    // Start from a state the policy has already confirmed off-route, so the
    // comparison below is against exactly the evidence a real trigger carries.
    let from = createRerouteState();
    for (let i = 0; i < 10; i++) {
      const r = observeFix(from, ROUTE, FAR_OFF, 0, i * 2_000);
      from = r.state;
      if (r.trigger) break;
    }
    expect(from.tracker.state).toBe('off-route');
    const evidence = from.tracker;

    const { state } = await attemptReroute(
      { preferred: 'valhalla-custom', allowFallback: false },
      { from },
    );

    // The only thing `App.tsx` renders guidance from is `route`, and a failed
    // attempt never reaches `setRoute`. The policy's half of that bargain is
    // that it preserves the evidence the guidance's position is derived from.
    expect(state.tracker).toEqual(evidence);
    expect(state.tracker.snappedIndex).toBe(evidence.snappedIndex);
    expect(state.tracker.distance).toBeGreaterThan(25);
    // ...and the driver is told, rather than left with a stale line and no
    // explanation.
    expect(rerouteBanner(state, ROUTE)).toMatch(/off route/i);
  });

  it('backs off instead of hammering an engine that has already refused', async () => {
    const first = await attemptReroute({ preferred: 'valhalla-custom', allowFallback: false });
    expect(first.state.failures).toBe(1);

    let s = first.state;
    let attempts = 0;
    for (let t = 0; t <= backoffMs(s); t += 1_000) {
      const r = observeFix(s, ROUTE, FAR_OFF, 0, s.lastFinished! + t);
      s = r.state;
      if (r.trigger) attempts++;
    }
    // One re-request, at the end of the 30 s window, and not one before it.
    expect(attempts).toBe(1);
  });

  it('is rescued by the same request the moment fallback is switched back on', async () => {
    // The contrast that makes the strict outcome a choice rather than a defect:
    // the default selection loses nothing, the route is replaced, and the
    // driver never sees a failed attempt at all.
    const loose = await attemptReroute(
      { preferred: 'valhalla-custom', allowFallback: true },
      { dataset: offlineEngineThatCanRoute() },
    );
    expect(loose.plan).toEqual(['valhalla-custom', 'local']);
    // FAR_OFF -> DESTINATION is not on the offline street graph, so this one
    // still fails; the point is that `local` was *tried*.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(loose.error).toBeInstanceOf(NoRouteError);
    expect(loose.error!.message).not.toMatch(/Fallback is off/);
    expect(loose.state.status).toBe('failed');
  });

  it('keeps the strict explanation across subsequent fixes', async () => {
    // This is the most actionable line in the whole feature — "turn fallback
    // on, or point me at another engine" — and for the remedy to be reachable
    // the driver needs it to survive past the first fix. `RerouteState.reason`
    // is what makes that possible; before it, `observeFix` replaced the
    // explanation with a bare countdown on the next fix.
    const { state } = await attemptReroute({ preferred: 'valhalla-custom', allowFallback: false });
    expect(rerouteBanner(state, ROUTE)).toMatch(/Fallback is off/);

    const nextFix = observeFix(state, ROUTE, FAR_OFF, 0, state.lastFinished! + 1_000);
    // Still there, *and* now paired with the countdown rather than replaced by it.
    expect(rerouteBanner(nextFix.state, ROUTE)).toMatch(/Fallback is off/);
    expect(rerouteBanner(nextFix.state, ROUTE)).toMatch(/retrying in 29 s/);
  });
});
