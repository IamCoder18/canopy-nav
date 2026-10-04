/**
 * Engine selection and visibility tests.
 *
 * Two things are being pinned here, and they are different in kind:
 *
 *   1. `planRoute` — selection policy. Which engines are eligible, in what order,
 *      and whether a fallback may substitute at all.
 *   2. The attempt trace — what the app is now prepared to *say* about a route.
 *      A trace that quietly drops the engines it skipped cannot answer "why did
 *      it use that one", which is the only reason to keep a trace at all.
 *
 * `fetch` is stubbed and a small in-memory OSM dataset stands in for the imported
 * .osm file, so this runs with no network and no worker.
 *
 * Run with `npx vitest run test/engines.spec.ts`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveRoute, NoRouteError } from '../src/nav/providers';
import {
  ANY_ONLINE,
  DEFAULT_SELECTION,
  planRoute,
  engineStatuses,
  probeEngine,
  describeProvenance,
  describeAttempt,
  hasManeuvers,
  isOnlineEngine,
  type EngineSelection,
} from '../src/nav/engines';
import { parseOsmXml, buildDataset, type OsmDataset } from '../src/osm/engine.worker';
import type { LatLng } from '../src/geo';

const XML = `<osm>
  <node id="1" lat="0" lon="0"/>
  <node id="2" lat="0" lon="0.005"/>
  <node id="3" lat="0" lon="0.01"/>
  <way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/><tag k="name" v="Main"/></way>
  <way id="11"><nd ref="2"/><nd ref="3"/><tag k="highway" v="residential"/><tag k="name" v="Main"/></way>
</osm>`;

const FROM: LatLng = [0, 0];
const TO: LatLng = [0.01, 0];
const FAR_AWAY: LatLng = [80, 40];

let fetchMock: ReturnType<typeof vi.fn>;

function okTrip(): unknown {
  return {
    trip: {
      units: 'km',
      summary: { length: 1, time: 60, min_lat: 0, min_lon: 0, max_lat: 0, max_lon: 0.01 },
      legs: [{
        maneuvers: [{ type: 1, instruction: 'Go.', begin_shape_index: 0, end_shape_index: 1, length: 1, time: 60 }],
        summary: { length: 1, time: 60, min_lat: 0, min_lon: 0, max_lat: 0, max_lon: 0.01 },
        shape: 'oh`eBoh`eB',
      }],
    },
  };
}

function respondOnline() {
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => okTrip() });
}

function respondError(status: number, error: string) {
  fetchMock.mockResolvedValue({ ok: false, status, json: async () => ({ error, error_code: 1 }) });
}

function dataset(): OsmDataset {
  const { nodes, ways } = parseOsmXml(XML);
  return buildDataset(nodes, ways, () => {});
}

function online(onLine = true) {
  vi.stubGlobal('navigator', { onLine });
}

function sel(over: Partial<EngineSelection> = {}): EngineSelection {
  return { ...DEFAULT_SELECTION, ...over };
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  online(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ----------------------------- planRoute ----------------------------- */

describe('planRoute — preference order', () => {
  it('puts the offline engine first by default', () => {
    expect(planRoute(DEFAULT_SELECTION)[0]).toBe('local');
  });

  it('keeps the online engines behind the offline one so local can answer first', () => {
    const plan = planRoute(sel({ preferred: 'local', allowFallback: true }));
    expect(plan[0]).toBe('local');
    expect(plan.slice(1)).toContain('valhalla-fossgis');
  });

  it('expands "any online" to every hosted engine in registry order', () => {
    const plan = planRoute(sel({ preferred: ANY_ONLINE, allowFallback: true }));
    expect(plan.slice(0, 3)).toEqual([
      'valhalla-fossgis',
      'valhalla-simplerouting',
      'valhalla-custom',
    ]);
  });

  it('appends the offline engine after "any online" when fallback is allowed', () => {
    const plan = planRoute(sel({ preferred: ANY_ONLINE, allowFallback: true }));
    expect(plan[plan.length - 1]).toBe('local');
  });

  it('appends the offline engine after a named online engine', () => {
    const plan = planRoute(sel({ preferred: 'valhalla-fossgis', allowFallback: true }));
    expect(plan).toEqual(['valhalla-fossgis', 'local']);
  });
});

describe('planRoute — fallback disabled', () => {
  it('reduces a local preference to exactly the offline engine', () => {
    expect(planRoute(sel({ preferred: 'local', allowFallback: false }))).toEqual(['local']);
  });

  it('reduces a named online preference to exactly that engine', () => {
    expect(planRoute(sel({ preferred: 'valhalla-fossgis', allowFallback: false })))
      .toEqual(['valhalla-fossgis']);
  });

  it('keeps all three hosted engines for "any online" but drops the offline one', () => {
    const plan = planRoute(sel({ preferred: ANY_ONLINE, allowFallback: false }));
    expect(plan).toHaveLength(3);
    expect(plan).not.toContain('local');
  });

  it('never repeats an engine, so a trace cannot show the same row twice', () => {
    for (const preferred of ['local', ANY_ONLINE, 'valhalla-fossgis'] as const) {
      for (const allowFallback of [true, false]) {
        const plan = planRoute(sel({ preferred, allowFallback }));
        expect(new Set(plan).size).toBe(plan.length);
      }
    }
  });
});

/* ----------------------------- readiness ----------------------------- */

describe('engineStatuses', () => {
  it('lists "any online" ahead of the four concrete engines', () => {
    const s = engineStatuses({}, false);
    expect(s[0].id).toBe(ANY_ONLINE);
    expect(s).toHaveLength(5);
  });

  it('names a concrete reason per unready engine rather than a generic one', () => {
    const s = engineStatuses({ endpoint: '', apiKey: '' }, false);
    const byId = Object.fromEntries(s.map((x) => [x.id, x]));
    expect(byId.local.reason).toBe('No offline map loaded');
    expect(byId['valhalla-custom'].reason).toBe('No endpoint configured');
    expect(byId['valhalla-simplerouting'].reason).toBe('API key required');
  });

  it('marks the offline engine ready once a map is loaded', () => {
    const local = engineStatuses({}, true).find((x) => x.id === 'local')!;
    expect(local.ready).toBe(true);
    expect(local.reason).toBeNull();
  });

  it('marks hosted engines unready with the link down', () => {
    online(false);
    const s = engineStatuses({}, true);
    expect(s.find((x) => x.id === 'valhalla-fossgis')!.reason).toBe('No network connection');
    // The offline engine is unaffected by the link.
    expect(s.find((x) => x.id === 'local')!.ready).toBe(true);
  });

  it('resolves "any online" to a concrete engine that is actually usable', () => {
    const any = engineStatuses({ endpoint: '', apiKey: '' }, false).find((x) => x.id === ANY_ONLINE)!;
    expect(any.resolved).toBe('valhalla-fossgis');
  });
});

/* ------------------------------ probeEngine ------------------------------ */

describe('probeEngine', () => {
  it('reports the version and a latency when a hosted engine answers', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ version: '3.9.0' }) });
    const r = await probeEngine('valhalla-fossgis', {}, false);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('3.9.0');
    expect(r.ms).not.toBeNull();
  });

  it('says unreachable without inventing a latency', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502, json: async () => ({}) });
    const r = await probeEngine('valhalla-fossgis', {}, false);
    expect(r.ok).toBe(false);
    expect(r.ms).toBeNull();
  });

  it('confirms the offline engine from the loaded map without a request', async () => {
    const r = await probeEngine('local', {}, true);
    expect(r.ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is honest about the offline engine when no map is loaded', async () => {
    const r = await probeEngine('local', {}, false);
    expect(r.ok).toBe(false);
    expect(r.detail).toBe('No offline map loaded');
  });
});

/* ------------------------- the attempt trace ------------------------- */

describe('resolveRoute — the trace', () => {
  it('records the serving engine with a latency and no reason', async () => {
    respondOnline();
    const out = await resolveRoute(
      { from: FROM, to: TO, provider: 'valhalla-fossgis', plan: ['valhalla-fossgis'] },
      dataset(),
      {},
    );
    expect(out.used).toBe('valhalla-fossgis');
    expect(out.attempts).toHaveLength(1);
    expect(out.attempts[0].outcome).toBe('served');
    expect(out.attempts[0].reason).toBeNull();
    expect(out.attempts[0].ms).toBeGreaterThanOrEqual(0);
    expect(out.fellBack).toBe(false);
  });

  it('marks engines it never reached as not-tried, not absent', async () => {
    respondOnline();
    const out = await resolveRoute(
      { from: FROM, to: TO, provider: 'valhalla-fossgis', plan: ['valhalla-fossgis', 'local'] },
      dataset(),
      {},
    );
    // FOSSGIS answered, so the offline engine must appear as an explicit row
    // saying it was not needed — otherwise the trace cannot show a full plan.
    expect(out.attempts).toHaveLength(2);
    expect(out.attempts[1].engine).toBe('local');
    expect(out.attempts[1].outcome).toBe('not-tried');
  });

  it('explains a skip without pretending the engine failed', async () => {
    const out = await resolveRoute(
      { from: FROM, to: TO, provider: 'valhalla-custom', plan: ['valhalla-custom', 'local'] },
      dataset(),
      {},
    );
    expect(out.attempts[0].outcome).toBe('skipped');
    expect(out.attempts[0].reason).toBe('No endpoint configured');
    expect(out.attempts[0].ms).toBeNull();
    expect(out.used).toBe('local');
  });

  it('records a real failure with its reason and elapsed time', async () => {
    respondError(500, 'boom');
    const out = await resolveRoute(
      { from: FROM, to: TO, provider: 'valhalla-fossgis', plan: ['valhalla-fossgis', 'local'] },
      dataset(),
      {},
    );
    expect(out.attempts[0].outcome).toBe('failed');
    expect(out.attempts[0].reason).toBeTruthy();
    expect(out.attempts[0].ms).not.toBeNull();
  });

  it('flags fellBack when the answering engine was not the first choice', async () => {
    respondError(500, 'boom');
    const out = await resolveRoute(
      { from: FROM, to: TO, provider: 'valhalla-fossgis', plan: ['valhalla-fossgis', 'local'] },
      dataset(),
      {},
    );
    expect(out.used).toBe('local');
    expect(out.fellBack).toBe(true);
  });

  it('does not flag fellBack when the first choice answered', async () => {
    respondOnline();
    const out = await resolveRoute(
      { from: FROM, to: TO, provider: 'local', plan: ['local'] },
      dataset(),
      {},
    );
    expect(out.used).toBe('local');
    expect(out.fellBack).toBe(false);
  });

  it('walks past one online engine to the next rather than dropping to local', async () => {
    respondError(500, 'boom');
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: 'boom' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => okTrip() });
    const out = await resolveRoute(
      {
        from: FROM,
        to: TO,
        provider: 'valhalla-fossgis',
        plan: ['valhalla-fossgis', 'valhalla-custom', 'local'],
      },
      dataset(),
      { endpoint: 'http://valhalla.internal' },
    );
    expect(out.used).toBe('valhalla-custom');
    expect(out.attempts[0].outcome).toBe('failed');
    expect(out.attempts[1].outcome).toBe('served');
    expect(out.attempts[2].outcome).toBe('not-tried');
  });
});

/* ----------------------------- strict mode ----------------------------- */

describe('resolveRoute — strict (fallback off)', () => {
  // Plans come from planRoute rather than being written out, because a strict
  // plan never contains the offline engine — hand-writing one with 'local' in it
  // describes a state the selection model cannot produce.
  const strictFossgis = sel({ preferred: 'valhalla-fossgis', allowFallback: false });

  it('fails loudly instead of answering from the offline engine', async () => {
    respondError(500, 'boom');
    await expect(
      resolveRoute(
        { from: FROM, to: TO, provider: 'valhalla-fossgis', plan: planRoute(strictFossgis), strict: true },
        dataset(),
        {},
      ),
    ).rejects.toThrow(NoRouteError);
  });

  it('says that fallback was off, so the message is actionable', async () => {
    respondError(500, 'boom');
    await expect(
      resolveRoute(
        { from: FROM, to: TO, provider: 'valhalla-fossgis', plan: planRoute(strictFossgis), strict: true },
        dataset(),
        {},
      ),
    ).rejects.toThrow(/Fallback is off/);
  });

  it('does not blame the offline map for a failure it never consulted', async () => {
    online(false);
    const err = await resolveRoute(
      { from: FROM, to: TO, provider: 'valhalla-fossgis', plan: planRoute(strictFossgis), strict: true },
      dataset(),
      {},
    ).catch((e: Error) => e);
    expect(err.message).not.toMatch(/offline map/i);
    expect(err.message).toMatch(/Fallback is off/);
  });

  it('never reaches the offline engine even with a map loaded', async () => {
    online(false);
    const outcome = await resolveRoute(
      { from: FROM, to: TO, provider: 'valhalla-fossgis', plan: planRoute(strictFossgis), strict: true },
      dataset(),
      {},
    ).catch((e: Error) => e);
    expect(outcome).toBeInstanceOf(NoRouteError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still succeeds when the pinned engine itself answers', async () => {
    respondOnline();
    const out = await resolveRoute(
      { from: FROM, to: TO, provider: 'valhalla-fossgis', plan: planRoute(strictFossgis), strict: true },
      dataset(),
      {},
    );
    expect(out.used).toBe('valhalla-fossgis');
    expect(out.fellBack).toBe(false);
  });

  it('still walks between hosted engines for "any online", which is what it means', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: 'boom' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => okTrip() });
    const strictAny = sel({ preferred: ANY_ONLINE, allowFallback: false });
    const out = await resolveRoute(
      {
        from: FROM,
        to: TO,
        provider: 'valhalla-fossgis',
        plan: planRoute(strictAny),
        strict: true,
      },
      dataset(),
      { endpoint: 'http://valhalla.internal' },
    );
    expect(out.used).toBe('valhalla-custom');
    expect(out.attempts.some((a) => a.engine === 'local')).toBe(false);
  });
});

/* ----------------------------- provenance ----------------------------- */

describe('describeProvenance', () => {
  it('names the serving engine plainly when nothing was substituted', () => {
    expect(describeProvenance('local', false)).toBe('Offline (.osm)');
  });

  it('marks a substituted engine, because its capabilities differ', () => {
    expect(describeProvenance('local', true)).toContain('fallback');
  });

  it('knows the offline engine cannot supply turn-by-turn', () => {
    expect(hasManeuvers('local')).toBe(false);
    expect(hasManeuvers('valhalla-fossgis')).toBe(true);
  });
});

describe('describeAttempt', () => {
  const base = { engine: 'local' as const, label: 'Offline (.osm)', online: false, ms: 12 };

  it('reports a served engine with its latency', () => {
    expect(describeAttempt({ ...base, outcome: 'served', reason: null }))
      .toBe('Offline (.osm) answered in 12 ms');
  });

  it('distinguishes skipped from failed', () => {
    expect(describeAttempt({ ...base, outcome: 'skipped', reason: 'No network connection' }))
      .toContain('skipped');
    expect(describeAttempt({ ...base, outcome: 'failed', reason: 'HTTP 500' }))
      .toContain('failed');
  });

  it('says plainly that an engine was never tried', () => {
    expect(describeAttempt({ ...base, outcome: 'not-tried', reason: null, ms: null }))
      .toBe('Offline (.osm) not tried');
  });
});

describe('isOnlineEngine', () => {
  it('treats "any online" as online and the offline engine as not', () => {
    expect(isOnlineEngine(ANY_ONLINE)).toBe(true);
    expect(isOnlineEngine('local')).toBe(false);
  });
});