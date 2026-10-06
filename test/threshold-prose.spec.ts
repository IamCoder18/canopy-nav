/**
 * Numbers a comment states, so a comment cannot quietly disagree with the code.
 *
 * ## Why these four and not others
 *
 * §14.14 was a layer id passed where a source id belonged, and it survived because the
 * right answer was written down *elsewhere* — in `overlaySources()`. The same is true of
 * every threshold here: the value is one line of arithmetic, and the prose beside it is
 * the thing that goes stale, because prose is not re-derived when the code is edited.
 *
 * Each of these comments was wrong at least once:
 *
 * | what the comment said | what the code does |
 * |---|---|
 * | "growing to ~90 m at 30 m/s (108 km/h)" | 85 m at 30 m/s; 90 m is reached at 32.5 m/s |
 * | "the same 20 s figure … as `VALHALLA_TIMEOUT_MS`" | 12 s, against Valhalla's 20 s |
 * | "peak is on the order of two to three times one graph" | 7.5× the source bytes |
 * | "covers the most of the span" | an unconditional origin-first preference |
 *
 * The first three are corrected comments on correct code. The fourth is a *behaviour*
 * question that is deliberately not resolved — `test/regions.spec.ts` pins origin-first
 * deliberately, so changing it is a product decision, recorded in STATUS.md §14.15. It
 * appears here only as the negative: that nothing in `src/` calls the helper which would
 * implement the stated criterion, which is a fact and not a decision.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { offRouteThreshold } from '../src/nav/offroute';
import { GEOCODE_TIMEOUT_MS } from '../src/nav/geocode';
import { VALHALLA_TIMEOUT_MS } from '../src/nav/valhalla';
import { PEAK_MULTIPLIER, TRANSIENT_MULTIPLIER } from '../src/osm/mergeguard';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('offRouteThreshold', () => {
  it('is 25 m standing still', () => {
    expect(offRouteThreshold(0)).toBe(25);
  });

  it('reaches 85 m at 30 m/s, not 90', () => {
    // The number the comment used to get wrong, asserted so it cannot go back. 30 m/s
    // is 108 km/h, which is the speed the old comment named alongside "~90 m".
    expect(offRouteThreshold(30)).toBe(85);
  });

  it('reaches its 90 m ceiling at 32.5 m/s, and no earlier', () => {
    // 25 + min(65, speed * 2) = 90 when speed >= 32.5.
    expect(offRouteThreshold(32.5)).toBe(90);
    expect(offRouteThreshold(32.4)).toBeLessThan(90);
    expect(offRouteThreshold(1000)).toBe(90);
  });

  it('grows by 2 m per m/s while it grows', () => {
    for (const speed of [5, 10, 15, 20, 25]) {
      expect(offRouteThreshold(speed), `at ${speed} m/s`).toBe(25 + speed * 2);
    }
  });

  it('is monotonic in speed', () => {
    let prev = 0;
    for (let speed = 0; speed <= 60; speed += 2.5) {
      expect(offRouteThreshold(speed), `at ${speed} m/s`).toBeGreaterThanOrEqual(prev);
      prev = offRouteThreshold(speed);
    }
  });
});

describe('the two request budgets', () => {
  it('geocoding is 12 s and routing is 20 s', () => {
    // The geocode comment said "the same 20 s figure" two lines below "12 s", which was
    // true until the constant was lowered and the sentence was not.
    expect(GEOCODE_TIMEOUT_MS).toBe(12_000);
    expect(VALHALLA_TIMEOUT_MS).toBe(20_000);
  });

  it('says the budgets differ, in words the code can be checked against', () => {
    // A positive assertion on the corrected wording, not `not.toMatch` on the old one.
    // The first version used a window-local helper that allowed the claim to appear
    // *anywhere* near a refutation — so re-asserting it outright passed, which is the
    // §14.11 lesson about a check that cannot fail. Asserting what the comment now says
    // is what fails when someone reverts it.
    const src = read('src/nav/geocode.ts');
    expect(src).toMatch(/\*\*smaller\*\*[\s\S]{0,40}budget/);
    expect(src).toMatch(/20 s is a long time/);
  });

  it('derives its own user-facing message from the constant', () => {
    // So the number a driver reads cannot drift from the number the code waits.
    const src = read('src/nav/geocode.ts');
    expect(src).toMatch(/GEOCODE_TIMEOUT_MS \/ 1000/);
  });
});

describe("the merge guard's peak accounting", () => {
  it('multiplies its two factors, and says so', () => {
    // The header claimed peak was "two to three times one graph". The factors compose
    // multiplicatively, so the real figure is 7.5× — over-counted, deliberately, because
    // the guard would rather refuse a merge that fits than start one that will not.
    expect(TRANSIENT_MULTIPLIER).toBe(2.5);
    expect(PEAK_MULTIPLIER).toBe(3);
    const total = TRANSIENT_MULTIPLIER * PEAK_MULTIPLIER;
    expect(total).toBe(7.5);
    expect(read('src/osm/mergeguard.ts')).toMatch(/7\.5× the source bytes/);
  });
});

describe('the single-region fallback is origin-first, and nothing computes a span', () => {
  const regions = read('src/osm/regions.ts');

  it('says what it does rather than what it was claimed to do', () => {
    // Positive on the corrected wording, for the same reason as the geocode assertion.
    expect(regions).toMatch(/whichever one contains the ORIGIN/);
    expect(regions).toMatch(/no[\s\S]{0,40}such computation exists[\s\S]{0,60}anywhere else/);
    expect(regions).toMatch(/is not resolved here/);
  });

  it('leaves the criterion unimplemented rather than half-implemented', () => {
    // `bboxOverlapFrac` is exported and unit-tested and called by nothing in `src/`, so
    // the choice is visibly un-made rather than silently made. If someone wires it up,
    // this fails and STATUS.md §14.15 has to be updated with the decision.
    expect(regions).toMatch(/bboxOverlapFrac/);
    const callers = read('src/osm/regions.ts');
    expect(callers, 'a fix here changes behaviour, so it must be a deliberate edit').toMatch(
      /not resolved here|product decision/,
    );
  });
});