/**
 * The type scale's leading, and the two bars' heights.
 *
 * ## What is being defended
 *
 * Android's font scale multiplies text. Two things in this app did not follow it, and
 * between them they are the whole of §7 gap 11's layout half:
 *
 *   1. **`lineHeight` was a px length.** A length stays the length it was, so at 175%
 *      a 32dp heading had 56dp of glyphs in a 40dp line box — measured, 12px of
 *      overflow on every ETA value and across the five lines of a maneuver
 *      instruction. `tools/reflow.mjs` called those five labels "clipped", which is
 *      what the overflow looked like from outside the element.
 *   2. **The bars' heights were constants in CSS.** `.banner-stack`'s top and bottom,
 *      and `.nav-controls`' top, were `var(--app-bar)` and `var(--navbot)` — correct
 *      only while the bars really were that tall.
 *
 * `src/nav/chrome.ts` publishes the bars' *measured* heights as `--eta-h` and
 * `--nav-h`, and the type scale now emits leading as a multiplier of its own font, so
 * both follow the text.
 *
 * ## What these tests can and cannot do
 *
 * Every assertion here is about a **source invariant**, not about a rendered pixel.
 * A test that could only fail in a browser is a test that runs in CI-shaped
 * environments too, and the browser-side proof is `npm run reflow` — 12 checks over
 * three text sizes, green for the first time. What is asserted here is the thing that
 * would let the bug back in unnoticed: a token that stops being a multiplier, a bound
 * that goes back to reading a design constant, or a token whose ratio is not the one
 * the specification states.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type } from '../src/theme';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(ROOT, 'src', 'styles.css'), 'utf8');
const chrome = readFileSync(join(ROOT, 'src', 'nav', 'chrome.ts'), 'utf8');

/** The scale as Google's *Design for Driving* states it: dp type, dp leading. */
const SPEC: Record<string, [number, number]> = {
  display1: [56, 64],
  display2: [44, 52],
  display3: [36, 44],
  body1: [32, 40],
  body1m: [32, 40],
  body2: [28, 36],
  body3: [24, 32],
  body3m: [24, 32],
  sub1: [22, 28],
  sub2: [20, 26],
  sub3: [18, 24],
};

describe('the type scale emits leading as a multiplier, not a length', () => {
  it('never emits a px string for lineHeight', () => {
    // The defect, stated as the smallest possible test: a length that does not scale.
    for (const [name, token] of Object.entries(type)) {
      expect(typeof token.lineHeight, `${name}.lineHeight`).toBe('number');
      expect(`${token.lineHeight}`, `${name}.lineHeight is not a CSS length`).not.toMatch(/px|rem|em$/);
    }
  });

  it('keeps the specification\'s own ratios', () => {
    for (const [name, [fontSize, lineHeightPx]] of Object.entries(SPEC)) {
      const token = type[name as keyof typeof type];
      expect(token.fontSize, `${name} font-size`).toBe(fontSize);
      // `lineHeight` *is* the ratio — it is not a length to be divided again.
      expect(token.lineHeight, `${name} leading ratio`).toBeCloseTo(lineHeightPx / fontSize, 3);
    }
  });

  it('renders 100% within a hundredth of a pixel of the published leading', () => {
    // The point of the change is that 100% looks identical. A multiplier is rounded to
    // 4dp in `step`, so the box is `fontSize * ratio` rather than the spec's dp; this
    // is the bound on what that costs.
    for (const [name, [fontSize, lineHeightPx]] of Object.entries(SPEC)) {
      const rendered = type[name as keyof typeof type].lineHeight * fontSize;
      expect(Math.abs(rendered - lineHeightPx), `${name} at 100%`).toBeLessThan(0.01);
    }
  });

  it('grows the leading in step with the font, which is the whole point', () => {
    // At 175% a length-based token would still be `lineHeightPx`, and this is the
    // assertion that catches it. 56dp of glyphs in a 40dp line is the bug.
    const at = (name: keyof typeof type, factor: number) =>
      type[name].lineHeight * (type[name].fontSize * factor);
    // Two decimals: `step` rounds the ratio to 4dp, so a 36dp font at 2x lands on
    // 87.9984 rather than 88. The bound is the rounding, not the scale.
    expect(at('body1', 1.75)).toBeCloseTo(70, 2);
    expect(at('display3', 2)).toBeCloseTo(88, 2);
  });

  it('states the reason in the source, so the next reader does not "fix" it back', () => {
    // This has already been reverted once in spirit: §14's predecessor wrote a long
    // comment justifying the px length. The comment now has to justify the multiplier.
    const theme = readFileSync(join(ROOT, 'src', 'theme.ts'), 'utf8');
    expect(theme).toMatch(/Why .*lineHeight.* is a multiplier, not a px length/);
    expect(theme).toMatch(/does not scale with its font/);
    expect(theme).toMatch(/Google states leading as a length/);
  });
});

describe('the bars are measured, not assumed', () => {
  it('publishes both bars as separate properties', () => {
    expect(chrome).toMatch(/selector: '\.eta-bar', property: '--eta-h'/);
    expect(chrome).toMatch(/selector: '\.nav-bottom', property: '--nav-h'/);
  });

  it('does not overwrite the design tokens with the measurements', () => {
    // `--app-bar` says how tall a bar *should* be; `--eta-h` says how tall it *is*.
    // Collapsing them would make each bar's height feed back into its own input.
    expect(chrome).not.toMatch(/property: '--app-bar'/);
    expect(chrome).not.toMatch(/property: '--navbot'/);
  });

  it('reads the measurements before the design tokens, everywhere it is anchored', () => {
    // The order is the fix: `--eta-h` first so a measurement wins, the token as the
    // fallback so the first paint — and any platform without a ResizeObserver — is
    // still correct.
    for (const pattern of [
      /\.banner-stack \{[^}]*top: calc\(var\(--eta-h, var\(--app-bar/,
      /\.banner-stack \{[^}]*bottom: calc\(var\(--nav-h, var\(--navbot/,
      /\.nav-controls \{[^}]*top: calc\(var\(--eta-h, var\(--app-bar/,
    ]) {
      expect(css).toMatch(pattern);
    }
  });

  it('gives every bar a floor rather than a height, so content can exceed it', () => {
    // A `height` here is how the bottom bar ended up clipping its own labels by 4px
    // at 200%, and the ETA bar 52px of glyphs in a 40dp box at 175%.
    const eta = /\.eta-bar \{[^}]*\}/.exec(css)?.[0] ?? '';
    const nav = /\.nav-bottom \{[^}]*\}/.exec(css)?.[0] ?? '';
    expect(eta).not.toMatch(/^\s*height: var\(--app-bar/m);
    expect(eta).toMatch(/min-height:/);
    expect(nav).not.toMatch(/^\s*height: var\(--navbot/m);
    expect(nav).toMatch(/min-height: var\(--navbot/);
  });

  it('bounds the banner stack below, at every text size', () => {
    // The bound used to exist only under `[data-textsize="large"]`, so the commonest
    // layout had none: the off-route notice ran to y=384 while the bottom bar began
    // at y=316 — a warning about being lost, invisible, at 100% text.
    const base = /\.banner-stack \{[^}]*\}/.exec(css)?.[0] ?? '';
    expect(base).toMatch(/bottom: calc\(var\(--nav-h/);
    expect(base).toMatch(/overflow-y: auto/);
  });

  it('bounds the control column by the same two measurements', () => {
    // `max-height: none` in the short-screen block undid the base rule's bound, and
    // the column met the bottom bar by 4px at 200%.
    const short = /@media \(max-height: 520px\) \{[\s\S]*?\n\}/.exec(css)?.[0] ?? '';
    expect(short).toMatch(/\.nav-controls \{[\s\S]*max-height: calc\(/);
    expect(short).not.toMatch(/\.nav-controls \{[\s\S]*?max-height: none/);
  });
});

describe('the alert is above the instruction it interrupts', () => {
  it('renders the off-route notice before the maneuver banner', () => {
    // Reverses §13.13's placement. Measured: the stack has 216px between the bars on
    // a 892x412 landscape phone and the two cards need 264, so with the notice second
    // the thing below the fold was the alert — 56px of "You have left the route"
    // entirely behind the bottom bar at 100%, and out of view at 175% and 200%.
    const app = readFileSync(join(ROOT, 'src', 'App.tsx'), 'utf8');
    // `[ ]` rather than a run of spaces: `no-regex-spaces` is right that a count of
    // spaces is not readable, and it is right that this one is meaningful indentation.
    const stack = /<div className="banner-stack">([\s\S]*?)\n[ ]{6}<\/div>/.exec(app)?.[1] ?? '';
    const notice = stack.indexOf('offroute-banner');
    const maneuver = stack.indexOf('maneuver-banner');
    expect(notice).toBeGreaterThan(-1);
    expect(maneuver).toBeGreaterThan(-1);
    expect(notice, 'the alert must come first').toBeLessThan(maneuver);
  });

  it('says why the placement changed', () => {
    const app = readFileSync(join(ROOT, 'src', 'App.tsx'), 'utf8');
    expect(app).toMatch(/reverses/);
    expect(app).toMatch(/216px/);
    expect(app).toMatch(/y=384/);
  });
});