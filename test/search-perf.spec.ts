/**
 * Search performance, measured rather than claimed.
 *
 * The old matcher's cost was "the whole gazetteer, every keystroke", and its
 * only defence was a `break` after 4000 matches that made results depend on
 * gazetteer order. This gate holds the new shape to its promise: build the
 * index once per dataset, then answer queries in time proportional to the
 * matches — not to the map.
 *
 * The bounds are order-of-magnitude on purpose. CI machines vary, and a
 * performance test that fails because the runner was busy is a test people
 * stop believing — what these catch is a revert to full scans, or a candidate
 * generator that quietly degrades to one.
 *
 * Run with: npx vitest run test/search-perf.spec.ts
 */

import { describe, it, expect } from 'vitest';
import { searchIndex, scoreGazetteer, type GazEntry } from '../src/search/gaz';

const NEAR: [number, number] = [-114.0719, 51.0447];

/** Deterministic PRNG, so the corpus is the same on every machine. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A gazetteer the size of a small province's worth of names. */
function synthetic(n: number): GazEntry[] {
  const rnd = mulberry32(7);
  const words = ['banff', 'calgary', 'memorial', 'springs', 'trail', 'avenue', 'cafe', 'museum',
    'park', 'river', 'bow', 'elbow', 'street', 'north', 'central', 'station', 'market', 'mill'];
  const gaz: GazEntry[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const len = 1 + Math.floor(rnd() * 3);
    const name = Array.from({ length: len }, () => words[Math.floor(rnd() * words.length)])
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(' ');
    gaz[i] = { name, rank: 20 + Math.floor(rnd() * 80), cat: 'place', lat: NEAR[1], lon: NEAR[0] };
  }
  return gaz;
}

describe('search performance', () => {
  it('indexes 60k names once, then answers queries in milliseconds', () => {
    const gaz = synthetic(60_000);

    const t0 = performance.now();
    searchIndex(gaz);
    const buildMs = performance.now() - t0;

    const queries = ['banff', 'banff sp', 'memorial', 'cafe', 'museum park', 'centrl',
      'st', 'street north', 'bow el', 'musuem', 'station', 'mill market'];
    const t1 = performance.now();
    for (const q of queries) scoreGazetteer(gaz, q, NEAR, 12);
    const queryMs = (performance.now() - t1) / queries.length;

    // eslint-disable-next-line no-console
    console.log(`search-perf: index ${buildMs.toFixed(0)}ms for ${gaz.length} names; query ${queryMs.toFixed(1)}ms avg (${queries.length} queries)`);

    expect(buildMs).toBeLessThan(5_000);
    expect(queryMs).toBeLessThan(250);
  });

  it('reuses the index instead of rebuilding it per query', () => {
    const gaz = synthetic(60_000);
    searchIndex(gaz);
    const t = performance.now();
    for (let i = 0; i < 20; i++) scoreGazetteer(gaz, 'banff springs', NEAR, 12);
    const perQuery = (performance.now() - t) / 20;
    // A rebuild per query would land orders of magnitude over this.
    expect(perQuery).toBeLessThan(250);
  });

  it('does not degrade on the query that matches everything', () => {
    // "st" hits the largest postings in the corpus. The old defence was the
    // order-dependent `break`; the new one is that scoring is bounded by the
    // postings, which is exactly what this measures.
    const gaz = synthetic(60_000);
    const t = performance.now();
    const hits = scoreGazetteer(gaz, 'st', NEAR, 12);
    const ms = performance.now() - t;
    // eslint-disable-next-line no-console
    console.log(`search-perf: worst-case query ${ms.toFixed(1)}ms, ${hits.length} shown`);
    expect(ms).toBeLessThan(1_500);
  });
});
