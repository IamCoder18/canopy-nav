/**
 * The large-text detector, and the claim it rests on.
 *
 * ## Why this file exists
 *
 * `src/textscale.ts` has carried an unverified claim about Android's behaviour since it
 * was written: *"On Android, the system font-size setting reaches a WebView by scaling
 * the root font size. Absolute px lengths are not affected by it."* Nobody could check
 * it, because §7 gap 1 is that this app has never run on physical hardware.
 *
 * It also had **no test at all** — the detector that decides whether the entire
 * large-text layout (§12.7, §13.8, §14.1) turns on was a `useEffect` with a threshold in
 * it and nothing asserting what it did.
 *
 * ## What was measured instead
 *
 * Chromium, 892×412, a probe span with an inline `font-size: 16px`:
 *
 * | platform behaviour | root font size | probe's rendered height | original code |
 * |---|---|---|---|
 * | nothing | 16px | 19px | normal — correct |
 * | root enlarged to 28px | 28px | 19px | large — correct |
 * | rendered text scaled 1.75× | 16px | **33px** | normal — **blind** |
 *
 * The original code read only the middle column and so could not see the third row,
 * which is the mechanism `WebSettings.setTextZoom` implements. Since the platform's
 * actual behaviour is unverified here, the detector now reads both, and the property
 * under test is that **either one alone is sufficient** — which is what makes it robust
 * to not knowing which the device uses.
 */

import { describe, it, expect } from 'vitest';
import {
  textScaleVerdict,
  rootFontSizePx,
  TEXT_SCALE_THRESHOLD_PX,
  PROBE_THRESHOLD_PX,
  type TextScaleReading,
} from '../src/textscale';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** An unscaled 16px line box, measured in Chromium at 892×412. */
const UNSCALED_PROBE_PX = 19;
/** The same probe with the type scaled 1.75×. */
const SCALED_PROBE_PX = 33;

const at = (rootPx: number, probePx: number | null): TextScaleReading => ({ rootPx, probePx });

describe('textScaleVerdict', () => {
  it('reports normal when nothing has scaled anything', () => {
    expect(textScaleVerdict(at(16, UNSCALED_PROBE_PX))).toBe('normal');
  });

  it('sees the mechanism it was written for: the root font size grows', () => {
    // The original detection, and still correct for this mechanism.
    expect(textScaleVerdict(at(28, UNSCALED_PROBE_PX))).toBe('large');
  });

  it('sees the mechanism it was blind to: rendered text scales, root untouched', () => {
    // The row the original code got wrong. A 1.75× platform scale leaves the root at
    // 16px, so the root-only check said "normal" and every large-text rule stayed off
    // while the screen rendered at 200% type — which is the §12.7 collision.
    expect(textScaleVerdict(at(16, SCALED_PROBE_PX))).toBe('large');
  });

  it('needs only one of the two signals, because they are mutually blind', () => {
    // Neither signal is necessary. That is the whole robustness argument: the
    // platform's mechanism is unverified on hardware (§7 gap 1), so the detector must
    // not depend on having guessed right about it.
    expect(textScaleVerdict(at(TEXT_SCALE_THRESHOLD_PX + 1, null))).toBe('large');
    expect(textScaleVerdict(at(16, PROBE_THRESHOLD_PX + 1))).toBe('large');
  });

  it('never treats an unmeasurable probe as evidence of scaling', () => {
    // `null` means "could not measure" — no body, or an engine that refuses layout.
    //
    // The first version of this test asserted the verdict was 'normal', which is
    // **vacuous**: coercing `null` to 0 gives the same answer, so it passed against
    // `reading.probePx ?? 0` as happily as against the guard. The mistake worth
    // guarding against is the opposite coercion — defaulting an unknown measurement to
    // something *large*, which would switch the large-text layout on for an engine
    // that simply could not measure. So the assertion is directional.
    expect(textScaleVerdict(at(16, null))).toBe('normal');
    // And the root signal still works with no probe at all, which is what the previous
    // implementation relied on exclusively.
    expect(textScaleVerdict(at(28, null))).toBe('large');
  });

  it('still reads normal when both signals agree the type is small', () => {
    expect(textScaleVerdict(at(16, 19))).toBe('normal');
    expect(textScaleVerdict(at(16, 20))).toBe('normal');
  });

  it('puts both thresholds at the same scale, roughly 125%', () => {
    // 20/16 on the root and 24/19 on the probe. They are the same boundary expressed
    // two ways, so a platform using either mechanism trips at the same point — if they
    // disagreed, one mechanism would start reflowing before the other.
    expect(TEXT_SCALE_THRESHOLD_PX / 16).toBeCloseTo(1.25, 2);
    expect(PROBE_THRESHOLD_PX / UNSCALED_PROBE_PX).toBeGreaterThan(1.2);
    expect(PROBE_THRESHOLD_PX / UNSCALED_PROBE_PX).toBeLessThan(1.35);
  });

  it('keeps its threshold between the measured unscaled and scaled values', () => {
    // Derived, not chosen: 19px is what an unscaled 16px line box measures here and
    // 33px is what it measures at 1.75×, so the threshold has to sit between them or
    // one of the two states is unreachable.
    expect(PROBE_THRESHOLD_PX).toBeGreaterThan(UNSCALED_PROBE_PX);
    expect(PROBE_THRESHOLD_PX).toBeLessThan(SCALED_PROBE_PX);
  });
});

describe('rootFontSizePx', () => {
  it('falls back to the browser default when there is no document', () => {
    // The module is imported by the service worker and by tests that render nothing,
    // where `document` and `getComputedStyle` are absent.
    expect(rootFontSizePx()).toBe(16);
  });
});

describe('the detector keeps its documentation honest', () => {
  const src = readFileSync(join(ROOT, 'src', 'textscale.ts'), 'utf8');

  it('states that the platform mechanism is unverified rather than asserting it', () => {
    // The claim this replaces asserted a platform behaviour with no device to check it
    // on. That assertion is what made the second mechanism invisible.
    // "unfalsifiable here" is the load-bearing phrase: the claim was about a
    // platform this has never run on, and that is why it went unchecked.
    expect(src).toMatch(/unfalsifiable here/);
    expect(src).toMatch(/Guessing wrong here is not a cosmetic failure/);
  });

  it('records both mechanisms and the measurements that distinguish them', () => {
    expect(src).toMatch(/enlarges the root/i);
    expect(src).toMatch(/scaled text|text zoom/i);
    expect(src).toMatch(/19px/);
    expect(src).toMatch(/33px/);
  });

  it('keeps the probe absolute, so it cannot mistake mechanism A for no scaling', () => {
    // If the probe inherited the root size it would read 19px under mechanism A and
    // the two mechanisms would look identical — which is the bug it is here to avoid.
    expect(src).toMatch(/font-size:\$\{PROBE_FONT_PX\}px/);
    expect(src).toMatch(/absolute on purpose/);
  });

  it('removes the probe on unmount', () => {
    // It is appended to `document.body`, which outlives the component.
    expect(src).toMatch(/probe\?\.remove\(\)/);
  });
});