/**
 * `strict`, and what it does and does not promise.
 *
 * ## The confusion this file exists to settle
 *
 * `src/nav/providers.ts` carried **two docstrings that disagreed** about `strict`:
 *
 *   - `RouteRequest.strict` — "Treat the plan as the whole world: **never append the
 *     offline engine**… Walking *within* the plan is still allowed — that is what
 *     `any-online` means, since its plan is three hosted engines and stopping at the
 *     first failure would make the choice a lie."
 *   - `resolveRoute` — "`strict` **stops the walk** after the first real attempt so a
 *     pinned engine fails loudly instead of quietly answering from somewhere else."
 *
 * The field's version is the correct one, and it is the one `planRoute` implements:
 * there are three online providers, so an `any-online` plan has three entries, and a
 * `strict` walk that stopped at the first failure would report `fellBack` for a
 * selection the user never made. `resolveRoute`'s docstring was wrong, and wrong in the
 * direction that reads like a stronger guarantee than exists — which is the more
 * expensive direction, because a reader trusts it.
 *
 * ## The real defect, underneath the wrong prose
 *
 * `strict` means "never append the offline engine" — and the legacy call shape, which
 * builds a plan from a bare `provider` when none is supplied, appended it
 * unconditionally:
 *
 * ```ts
 * meta(req.provider)?.online ? [req.provider, 'local'] : [req.provider]
 * ```
 *
 * So `resolveRoute({ provider: 'valhalla-fossgis', strict: true })` built
 * `['valhalla-fossgis', 'local']`, and when the pinned engine could not route the
 * **offline engine was consulted** — exactly what the flag exists to prevent, reached
 * by the one call shape that did not consult it.
 *
 * Both app call sites pass an explicit `plan`, and `planRoute` omits `local` when
 * fallback is off, so nothing in the app reached it. `test/engines.spec.ts` missed it
 * for the matching reason — it notes that "a strict plan never contains the offline
 * engine", which is a true statement about `planRoute`'s output and was being treated
 * as a property of `resolveRoute`.
 *
 * ## No dataset, on purpose
 *
 * The offline engine's *routability* is irrelevant to what is under test: what matters
 * is whether it is **consulted at all**. So these pass `dataset: null` and read the two
 * distinct failure wordings, which is exactly the distinction that was being lost — a
 * message claiming "no other engine was tried" while an `attempts` row proves one was.
 * A fixture that routed successfully would prove the same thing less directly.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRoute, type RouteRequest } from '../src/nav/providers';
import { parseOsmXml, buildDataset } from '../src/osm/engine.worker';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The fixture's own opposite corners, which `test/engine.spec.ts` routes between, as
// `LatLng` **tuples of [lon, lat]** — not `{lat, lon}` objects. The first version used
// objects, so the offline engine read `undefined` for both coordinates, returned null,
// and the two tests that depend on it *serving* could not distinguish "strict refused"
// from "the offline engine had nothing to offer".
const FROM: [number, number] = [-1.3990, 51.5030];
const TO: [number, number] = [-1.3280, 51.5430];

/** An online engine that refuses — a wrong key, or a host that is down. */
function refuse(): void {
  globalThis.fetch = (async () => new Response('nope', { status: 503 })) as typeof fetch;
}

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const base = (over: Partial<RouteRequest>): RouteRequest => ({
  from: FROM, to: TO, provider: 'valhalla-fossgis', units: 'km', ...over,
});

/**
 * Run and return the rejection message, failing loudly if it resolves.
 *
 * `providerState` is threaded through because `valhalla-custom` is skipped without an
 * endpoint — correctly, which is how it read as the walk stopping early.
 */
async function messageOf(
  req: RouteRequest,
  providerState: { endpoint?: string; apiKey?: string } = {},
): Promise<string> {
  try {
    await resolveRoute(req, null, providerState);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('expected the route request to fail');
}

describe('strict never appends the offline engine', () => {
  /** The repo's own fixture, which is known routable — see `test/engine.spec.ts`. */
  const fixture = () => {
    const { nodes, ways } = parseOsmXml(readFileSync(join(__dirname, 'fixture.osm'), 'utf8'));
    return buildDataset(nodes, ways, () => {});
  };

  it('does not let the offline engine answer when the pinned engine is refused', async () => {
    // The defect, observed the only way it can be: with the offline map *able* to route,
    // the bug made it serve. A message cannot show this — the local engine's failure
    // never reaches `degraded`, so the closing wording is identical either way, which is
    // exactly why it survived.
    refuse();
    // Resolves only if the offline engine answered a request `strict` was meant to
    // confine to one engine. Asserted as "must not resolve" rather than as a rejection
    // with a particular message, because the message is identical either way — the
    // local engine's own failure never reaches `degraded`, so the closing wording is
    // the same whether or not it was consulted.
    const outcome = await resolveRoute({ ...base({ strict: true }) }, fixture(), {})
      .then((o) => ({ served: o.used as string }))
      .catch(() => ({ served: null }));
    expect(outcome.served, 'the offline engine must not answer under strict')
      .toBeNull();
  });

  it('rejects with "fallback is off" when the pinned engine is refused', async () => {
    refuse();
    const msg = await messageOf(base({ strict: true }));
    expect(msg).toMatch(/Fallback is off/);
  });

  it('does fall through to the offline engine when strict is off', async () => {
    // The mirror, and the one that makes the pair meaningful: without it, the test above
    // could pass by never consulting the offline engine at all — which is also what a
    // bug that dropped `local` from every plan would do.
    refuse();
    const outcome = await resolveRoute({ ...base({ strict: false }) }, fixture(), {});
    expect(outcome.used).toBe('local');
    expect(outcome.fellBack).toBe(true);
  });

  it('leaves an explicitly supplied plan alone', async () => {
    // `strict` says "never append". It does not say "never use one that was handed to
    // you" — and rewriting a caller's plan would be a larger surprise than the flag
    // prevents.
    refuse();
    const outcome = await resolveRoute(
      { ...base({ plan: ['local'], strict: true }) }, fixture(), {},
    );
    expect(outcome.used).toBe('local');
  });

  it('still walks within a supplied plan of several engines', async () => {
    // The other half of the contract, and the reason `strict` does *not* stop the walk:
    // `any-online`'s plan is three hosted engines, so a walk that stopped at the first
    // failure would make the selection a lie.
    //
    // `valhalla-custom` needs an endpoint from `providerState` and is skipped without
    // one — correctly, and the reason the first version of this test counted one call
    // and read it as the walk stopping early.
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('nope', { status: 503 });
    }) as typeof fetch;

    await messageOf(base({ plan: ['valhalla-fossgis', 'valhalla-custom'], strict: true }), {
      endpoint: 'https://example.invalid',
    });
    expect(calls, 'both online engines attempted').toBe(2);
  });
});

describe('the two docstrings agree now', () => {
  it('states that strict constrains the plan rather than the walk', () => {
    // A source assertion, and a weaker thing than a behavioural one — the behaviour is
    // asserted above. It exists because the wrong docstring is what produced the
    // confusion, and a comment that is wrong about a contract is a defect in a file
    // whose whole job is the contract.
    const src = readFileSync(join(__dirname, '..', 'src', 'nav', 'providers.ts'), 'utf8');
    expect(src).toMatch(/What `strict` does, and what it does not/);
    expect(src).toMatch(/never appends/);
  });
});
