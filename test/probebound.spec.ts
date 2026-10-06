/**
 * The Regions screen must not be able to stay undecided.
 *
 * Every individual catalogue probe has a 10 s deadline, but the *screen* had no
 * bound of its own. Sixteen entries four at a time, each burning its full deadline,
 * is 40 s of "Checking…" before the first row says anything — measured at 12.2 s,
 * 18.2 s and 40.0 s on three consecutive runs of the same build against the same
 * network.
 *
 * Worse, the rows are **atomic**: `setAvailability` was called once, after every
 * worker finished, so a slow run showed sixteen "Checking…" and zero decided rows.
 * On screen that is indistinguishable from a probe that has hung, and the e2e gate
 * reported it as a missing UI control for exactly that reason.
 *
 * These assertions are about the two properties that make the screen honest: a
 * bound that exists, and no entry left without a verdict when the bound is hit.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const regions = readFileSync(join(ROOT, 'src', 'regions', 'RegionsScreen.tsx'), 'utf8');

describe('the availability probe is bounded, and always reaches a verdict', () => {
  it('bounds the whole probe, not just each request', () => {
    expect(regions).toMatch(/const OVERALL_TIMEOUT_MS = \d[\d_]*;/);
    expect(regions).toMatch(/Promise\.race\(\[/);
  });

  it('derives the bound rather than picking it', () => {
    // Recorded in the source because this is the number a reader will want to
    // check against the catalogue size and the per-probe deadline.
    expect(regions).toMatch(/16 entries \/ 4 concurrent x 10 s/);
    expect(regions).toMatch(/falls back to a one-byte ranged GET when HEAD/);
  });

  it('gives every entry a verdict, so no row can be left pending', () => {
    // The failure this closes is a row with no answer at all, which the screen has
    // no way to represent.
    expect(regions).toMatch(/const seen = new Set\(results\.map\(\(\[id\]\) => id\)\)/);
    expect(regions).toMatch(/if \(seen\.has\(entry\.id\)\) continue;/);
    expect(regions).toMatch(/No answer within \$\{Math\.round\(OVERALL_TIMEOUT_MS \/ 1000\)\} s/);
  });

  it('still leaves the whole-screen verdict to one atomic write', () => {
    // Atomicity is the defect *and* the fix: it is why a slow run showed nothing,
    // and it is why the deadline can now produce a complete answer in one go.
    const writes = regions.match(/setAvailability\(/g) ?? [];
    expect(writes).toHaveLength(1);
  });

  it('keeps the per-probe deadline inside the overall one', () => {
    const per = Number(regions.match(/PROBE_TIMEOUT_MS = (\d[\d_]*)/)?.[1].replace(/_/g, ''));
    const over = Number(regions.match(/OVERALL_TIMEOUT_MS = (\d[\d_]*)/)?.[1].replace(/_/g, ''));
    expect(per).toBeGreaterThan(0);
    // A whole-screen bound below a single probe's is not a bound.
    expect(over).toBeGreaterThan(per * 2);
  });

  it('reports the stragglers as unavailable rather than as reachable', () => {
    // "We do not know" must not become "yes, you can download this".
    expect(regions).toMatch(/ok: false, status: 0, bytes: null, resumable: false,\s*\n\s*etag: null, modified: null,\s*\n\s*error: `No answer within/);
  });
});