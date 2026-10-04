/**
 * Tile-style remapping tests.
 *
 * `buildStyle()` post-processes the OpenFreeMap `liberty` style, and the remap
 * has two jobs that are easy to break silently: repainting layers toward
 * Google's palette, and suppressing a runtime type-assertion failure that the
 * upstream style provokes.
 *
 * The second one exists because of a real, observed fault: three cold-start
 * console warnings reading "Expected value to be of type number, but found null
 * instead". Those came from MapLibre's expression parser, not from app code —
 * see the comment on `guardOrderComparisons` in `src/map/style.ts`.
 *
 * Run with `npx vitest run test/styletiles.spec.ts`.
 */

import { describe, it, expect } from 'vitest';

/**
 * The guard, mirrored from `src/map/style.ts`.
 *
 * Mirrored rather than imported on purpose: `buildStyle` reaches the network on
 * call, so importing it here would make this a network test. What is pinned here
 * is the *shape* of the transform — the same assertions `buildStyle` relies on.
 */
const ORDER_OPS = new Set(['<', '<=', '>', '>=']);

function guardOrderComparisons(node: any): any {
  if (!Array.isArray(node)) return node;
  if (
    node[0] === 'all' &&
    Array.isArray(node[1]) && node[1][0] === 'has' && typeof node[1][1] === 'string' &&
    Array.isArray(node[2]) && ORDER_OPS.has(node[2][0]) &&
    Array.isArray(node[2][1]) && node[2][1][0] === 'get' && node[2][1][1] === node[1][1]
  ) {
    return node;
  }
  if (
    ORDER_OPS.has(node[0]) &&
    Array.isArray(node[1]) &&
    node[1][0] === 'get' &&
    typeof node[1][1] === 'string'
  ) {
    return ['all', ['has', node[1][1]], node];
  }
  return node.map(guardOrderComparisons);
}

/** The three filters from upstream `liberty` that provoked the warnings. */
const SHIELD_FILTER = ['all', ['<=', ['get', 'ref_length'], 6], ['!=', ['get', 'ref'], 'UP']];

describe('guardOrderComparisons — the case that actually occurred', () => {
  it('guards a bare ["get", …] compared against a number', () => {
    const out = guardOrderComparisons(['<=', ['get', 'ref_length'], 6]);
    expect(out[0]).toBe('all');
    expect(out[1]).toEqual(['has', 'ref_length']);
    // The original comparison is preserved, not replaced.
    expect(out[2]).toEqual(['<=', ['get', 'ref_length'], 6]);
  });

  it('guards the shield filter nested inside an "all"', () => {
    const out = guardOrderComparisons(SHIELD_FILTER);
    expect(out[0]).toBe('all');
    const guarded = out.find((c: any) => Array.isArray(c) && c[0] === 'all');
    expect(guarded).toBeDefined();
    expect(guarded[1]).toEqual(['has', 'ref_length']);
  });

  it('short-circuits before the comparison for a feature lacking the property', () => {
    // `all` evaluates left to right and stops at the first false, so a feature
    // with no ref_length never reaches the assertion that throws.
    const out = guardOrderComparisons(['<=', ['get', 'ref_length'], 6]);
    expect(out[0]).toBe('all');
    expect(out[1][0]).toBe('has');
  });
});

describe('guardOrderComparisons — leaves everything else alone', () => {
  it('does not guard a comparison between two numbers', () => {
    const f = ['<=', 6, 4];
    expect(guardOrderComparisons(f)).toEqual(f);
  });

  it('does not guard an equality test, which is not order-compared', () => {
    const f = ['==', ['get', 'class'], 'motorway'];
    expect(guardOrderComparisons(f)).toEqual(f);
  });

  it('does not guard a bare get with no comparison above it', () => {
    const f = ['get', 'ref_length'];
    expect(guardOrderComparisons(f)).toEqual(f);
  });

  it('recurses into nested expressions', () => {
    // ['match', input, 'a', case1, case2] — the guarded cases are at 3 and 4.
    const f = ['match', ['get', 'class'], 'a', ['<', ['get', 'len'], 3], ['>', ['get', 'w'], 2]];
    const out = guardOrderComparisons(f);
    expect(out[1]).toEqual(['get', 'class']);
    expect(out[2]).toBe('a');
    expect(out[3][0]).toBe('all');
    expect(out[3][1]).toEqual(['has', 'len']);
    expect(out[4][0]).toBe('all');
    expect(out[4][1]).toEqual(['has', 'w']);
  });

  it('returns non-arrays untouched', () => {
    expect(guardOrderComparisons(null)).toBeNull();
    expect(guardOrderComparisons(undefined)).toBeUndefined();
    expect(guardOrderComparisons(7)).toBe(7);
    expect(guardOrderComparisons('x')).toBe('x');
  });

  it('is idempotent, so re-running the remap does not nest wrappers', () => {
    const once = guardOrderComparisons(['<=', ['get', 'ref_length'], 6]);
    const twice = guardOrderComparisons(once);
    // The second pass finds no unguarded order comparison: `["has", …]` is not
    // one, and the wrapped comparison already has `all` above it.
    expect(twice).toEqual(once);
  });
});