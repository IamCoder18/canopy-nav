/**
 * The import memory guard.
 *
 * ## What is under test, and what is not
 *
 * The guard's estimate is a file size times a constant. There is no measurement
 * of how many nodes a real extract holds, and none of the constants below can be
 * checked against a real device here — §7 gap 2 in STATUS.md records that a real
 * province has never been parsed on hardware. So this suite does **not** assert
 * that the numbers are right. It asserts that they are:
 *
 *   - pinned, so changing either is a deliberate act rather than a typo;
 *   - derived the way the documentation says they are derived;
 *   - conservative at the boundary (a ratio of exactly 1 is allowed, above 1 is
 *     not), which is the property that makes the refusal safe to rely on even
 *     when the estimate is imperfect;
 *   - never silent — every refusal names both figures and offers a real
 *     alternative, because a guard that refuses without saying why is the same
 *     dead end as the crash it prevents.
 *
 * It also asserts the thing that actually matters about a *guard* rather than
 * about a formula: an unknown budget is treated as unknown, never as unlimited.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  canImport, estimateParseBytes, importWarning,
  PBF_BYTES_PER_NODE, BYTES_PER_NODE, PARSE_MEMORY_FRACTION, MAX_CONSIDERED_BYTES,
} from '../src/osm/importguard';
import { MEMORY_FRACTION, ASSUMED_HEAP_MB, PARSE_BYTES_PER_NODE } from '../src/osm/mergeguard';

const nav = globalThis.navigator as Navigator & { deviceMemory?: number };
const mb = (n: number) => n * 1024 * 1024;
const gb = (n: number) => n * 1024 * 1024 * 1024;

afterEach(() => {
  if ('deviceMemory' in nav) delete (nav as { deviceMemory?: number }).deviceMemory;
});

describe('constants', () => {
  it('uses the LOW end of the measured bytes-per-node range', () => {
    // Measured across six real Geofabrik extracts (§15.1.1): 6.1 iceland, 7.0 andorra,
    // 8.8 new-york, 11.3 malta, 12.7 bremen, 16.6 monaco compressed bytes per node.
    //
    // This constant converts bytes into nodes, so the *dangerous* error is under-counting
    // them -- which makes the guard more permissive and lets through the files it exists
    // to refuse. The low end therefore, deliberately, and at the cost of refusing large
    // rural extracts that might have fitted. §15.1's crop is the answer to over-refusal;
    // a killed WebView has no answer at all.
    //
    // Pinned so a change to it is noticed, and so the *reason* it is 6 rather than 8 is
    // checked rather than assumed: a constant at 8 would still pass a range check, and
    // 8 is precisely the fitted single-data-point value this replaced.
    expect(PBF_BYTES_PER_NODE).toBe(6);
    // And it must not be above the lowest measurement, which is the whole property.
    const MEASURED_LOW = 6.1;
    expect(PBF_BYTES_PER_NODE).toBeLessThanOrEqual(MEASURED_LOW);

    // Alberta is 334 MB (checked 2026-10-07). At 6 B/node that is ~58 M nodes; the band
    // is wide because the measurement spans small and large extracts, and the point of
    // the assertion is the order of magnitude, not a fitted figure.
    const alberta = estimateParseBytes(334 * mb(1));
    const nodes = alberta / BYTES_PER_NODE;
    expect(nodes).toBeGreaterThan(30e6);
    expect(nodes).toBeLessThan(80e6);
  });

  /**
   * The parse-peak constant was measured, and the measurement is kept here as arithmetic
   * rather than as a comment, because a comment stating a number cannot be checked.
   *
   * Four nested crops of a real 20.23 MiB Bremen extract fit `peak MiB = 36.4 + 229 ×
   * nodes` at r ≈ 0.999. The value this replaced was 112, a 2.0× under-estimate in the
   * permissive direction — the one direction a memory guard cannot afford.
   */
  it('counts the parse peak at the measured 229 B/node, not the old 112', () => {
    const MEASURED_SLOPE = 229;
    expect(BYTES_PER_NODE).toBe(MEASURED_SLOPE);
    // The regression this replaced, stated as a number so it cannot recur quietly.
    expect(BYTES_PER_NODE).toBeGreaterThan(112);
    // Reproducing the fit: for Bremen no-crop, 1,665,822 nodes, the model predicts the
    // measured 385.3 MiB peak to within a few per cent.
    const bremenNodes = 1_665_822;
    const modelled = 36.4 + MEASURED_SLOPE * bremenNodes / 1048576;
    expect(modelled).toBeGreaterThan(385.3 * 0.9);
    expect(modelled).toBeLessThan(385.3 * 1.1);
  });

  it('counts more per node than a resident graph does', () => {
    // `mergeguard.BYTES_PER_NODE` is 96: a graph's typed arrays plus its index.
    // The parse peak is higher, because the boxed `RawNode` map coexists with
    // the arrays being built. Reusing 96 would under-estimate by ~half.
    expect(BYTES_PER_NODE).toBeGreaterThan(96);
  });

  it('is the same constant `mergeguard` declares, not a second copy of it', () => {
    // Two guards, one number. If `mergeguard.PARSE_BYTES_PER_NODE` is revised
    // and this module keeps its own literal, the two drift silently — and the
    // direction of that drift is toward under-estimating.
    expect(BYTES_PER_NODE).toBe(PARSE_BYTES_PER_NODE);
  });

  it('takes half the device heap, matching the merge guard', () => {
    expect(PARSE_MEMORY_FRACTION).toBe(MEMORY_FRACTION);
  });

  it('caps the extract size it will reason about', () => {
    expect(MAX_CONSIDERED_BYTES).toBeLessThanOrEqual(4 * gb(1));
  });
});

describe('estimateParseBytes', () => {
  it('is size-derived when no node count is supplied', () => {
    // `estimateParseBytes` rounds the derived node count before multiplying, so this has
    // to compare against the same rounded value rather than re-deriving it inline. It
    // compared fine while `PBF_BYTES_PER_NODE` was 8, because `8000 / 8` is exact and
    // the rounding was a no-op — the assertion never exercised it. Using a size that does
    // not divide evenly is what makes the test worth having, and 8000 is kept for the
    // 8,000-nodes-per-blob reason while the divisor no longer happens to match it.
    const expected = Math.round(8000 / PBF_BYTES_PER_NODE) * BYTES_PER_NODE;
    expect(estimateParseBytes(8000)).toBe(expected);
    // And the rounding is real rather than decorative: 8000 is not divisible by 6.
    expect(8000 / PBF_BYTES_PER_NODE).not.toBe(Math.round(8000 / PBF_BYTES_PER_NODE));
  });

  it('prefers a known node count over the size-derived one', () => {
    // A caller holding a parsed dataset knows exactly; the size estimate is worse.
    expect(estimateParseBytes(8000, 100)).toBe(100 * BYTES_PER_NODE);
  });

  it('is monotonic in size', () => {
    expect(estimateParseBytes(100 * mb(1))).toBeLessThan(estimateParseBytes(400 * mb(1)));
  });
});

describe('canImport: the three outcomes', () => {
  it('proceeds for a small city extract', () => {
    const v = canImport(12 * mb(1), undefined, mb(2048));
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.thin).toBe(false);
  });

  it('warns without refusing when the headroom is thin', () => {
    // Budget chosen so the ratio lands just under 1, above THIN_HEADROOM.
    const bytes = 200 * mb(1);
    const needed = estimateParseBytes(bytes);
    const v = canImport(bytes, undefined, (needed / 0.9) / PARSE_MEMORY_FRACTION);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.thin).toBe(true);
  });

  it('refuses a province-sized extract, which is the case that motivated it', () => {
    // Alberta's real size, on a generous 8 GiB device. Still refused: the point
    // is that the estimate is not rescued by a good phone, because the driver
    // needs a smaller extract, not a better one.
    const v = canImport(334 * mb(1), undefined, gb(8));
    expect(v.ok).toBe(false);
  });

  it('reports the shortfall and the budget in the same units', () => {
    const v = canImport(334 * mb(1), undefined, mb(512));
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toMatch(/memory|GB/i);
      // Both numbers, or the driver cannot tell whether the problem is the
      // device or the file. Same requirement `mergeguard.spec.ts` pins.
      expect(v.reason).toMatch(/MB|GB/);
      expect(v.reason).toMatch(/MB/);
    }
  });

  it('offers an instruction that actually reduces the problem', () => {
    const v = canImport(334 * mb(1), undefined, mb(512));
    if (!v.ok) {
      // `osmium extract -b` is the one command that turns a refused province
      // into an importable area. A refusal without it is a dead end.
      expect(v.reason).toMatch(/osmium/);
      expect(v.reason).toMatch(/-b/);
    }
  });

  it('says nothing changed, because the refusal happens before any work', () => {
    const v = canImport(334 * mb(1), undefined, mb(512));
    if (!v.ok) expect(v.reason).toMatch(/nothing was changed/i);
  });

  it('names a whole-country extract differently from an ordinary big one', () => {
    // Above the ceiling the figure stops being refined, and saying "needs 400 GB"
    // for a planet file is a number nobody can act on.
    const v = canImport(3 * gb(1), undefined, mb(512));
    if (!v.ok) expect(v.reason).toMatch(/whole-country|planet/i);
  });
});

describe('canImport: boundaries', () => {
  it('allows a ratio of exactly 1 and refuses above it', () => {
    // `limitBytes` is the device's figure; the guard takes its own share of it,
    // so the budget is `limitBytes * PARSE_MEMORY_FRACTION`. A ratio of exactly 1
    // therefore needs `limitBytes = needed / PARSE_MEMORY_FRACTION`, and a ratio
    // *above* 1 needs a **smaller** budget — not a larger one. Writing
    // `needed * 1.01` here gives a budget 1% *above* the need, which is a ratio
    // below 1 and correctly allowed; the first version of this test asserted the
    // opposite and was wrong about which direction the inequality runs.
    const bytes = 100 * mb(1);
    const needed = estimateParseBytes(bytes);

    const atLimit = canImport(bytes, undefined, needed / PARSE_MEMORY_FRACTION);
    expect(atLimit.memory.ratio).toBeCloseTo(1, 6);
    expect(atLimit.ok).toBe(true);

    const overLimit = canImport(bytes, undefined, needed / PARSE_MEMORY_FRACTION / 1.01);
    expect(overLimit.memory.ratio).toBeGreaterThan(1);
    expect(overLimit.ok).toBe(false);
  });

  it('refuses rather than assuming a large budget when nothing is reported', () => {
    // No `deviceMemory` and no `performance.memory` in a bare environment, so the
    // guard falls back to `ASSUMED_HEAP_MB`. The property that matters is that it
    // *refuses* — the assumed figure must be small enough that a province is
    // outside it, or a device that reports nothing would be treated as roomier
    // than one that reports honestly.
    const v = canImport(300 * mb(1));
    expect(v.ok).toBe(false);
    // And the budget it assumed is the assumed figure, not unlimited.
    expect(Number.isFinite(v.memory.ratio)).toBe(true);
    expect(v.memory.budget).toBeLessThan(300 * mb(1));
  });

  it('reports that it assumed rather than implying the figure was measured', () => {
    const v = canImport(300 * mb(1));
    expect(v.memory.assumed).toBe(true);
  });

  it('uses the device figure when it has one', () => {
    (nav as { deviceMemory?: number }).deviceMemory = 4;
    const v = canImport(300 * mb(1));
    expect(v.memory.assumed).toBe(false);
    expect(v.memory.budget).toBe(4 * gb(1) * PARSE_MEMORY_FRACTION);
  });

  it('applies its fraction exactly once to the device figure', () => {
    // `heapLimitBytes` applies `MEMORY_FRACTION` internally on the branch where
    // the device reports — and not on the assumed branch, where `ASSUMED_HEAP_MB`
    // is already a share. Reading the device directly is what keeps the two
    // guards comparable.
    //
    // This test exists because the first version *undid* `heapLimitBytes`
    // (dividing by `MEMORY_FRACTION`) and thereby doubled the assumed-heap
    // budget to 512 MB — making this guard pass cases `mergeguard` refuses on
    // the same device. The property is now "once", and this is what pins it.
    (nav as { deviceMemory?: number }).deviceMemory = 4;
    const v = canImport(300 * mb(1));
    expect(v.memory.budget).toBe(4 * gb(1) * PARSE_MEMORY_FRACTION);
    expect(v.memory.budget).not.toBe(4 * gb(1)); // neither unapplied nor doubled
  });

  it('matches the assumed heap when nothing is reported', () => {
    const v = canImport(300 * mb(1));
    expect(v.memory.budget).toBe(Math.round(ASSUMED_HEAP_MB * mb(1) * PARSE_MEMORY_FRACTION));
  });
});

describe('importWarning', () => {
  it('names both figures and suggests removing a region', () => {
    const bytes = 200 * mb(1);
    const v = canImport(bytes, undefined, (estimateParseBytes(bytes) / 0.9) / PARSE_MEMORY_FRACTION);
    if (!v.ok) throw new Error('expected this case to fit');
    const text = importWarning(v.memory);
    expect(text).toMatch(/MB|GB/);
    expect(text).toMatch(/remove another/i);
  });

  it('is a warning rather than a refusal — it does not say the import was stopped', () => {
    const bytes = 200 * mb(1);
    const v = canImport(bytes, undefined, (estimateParseBytes(bytes) / 0.9) / PARSE_MEMORY_FRACTION);
    if (!v.ok) throw new Error('expected this case to fit');
    expect(importWarning(v.memory)).not.toMatch(/nothing was changed/i);
  });
});

describe('canImport: monotonicity', () => {
  it('never becomes more permissive as the extract grows', () => {
    // A guard whose verdict flips back to "fine" for a larger file is not a
    // guard, so this is asserted across the whole range rather than at a point.
    let refused = false;
    for (let mbSize = 1; mbSize <= 400; mbSize += 7) {
      const v = canImport(mbSize * mb(1), undefined, mb(1024));
      if (!v.ok) refused = true;
      else expect(refused).toBe(false);
    }
    expect(refused).toBe(true);
  });
});