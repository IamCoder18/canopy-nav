/**
 * Theme token tests.
 *
 * The structural tokens (`--app-bar`, `--grid-cell`) have a contract that spans
 * two files: `theme.ts` publishes the names, `styles.css` consumes them, and
 * nothing in the type system connects the two. A rename on either side alone
 * would leave `var(--app-bar)` resolving to nothing — and with no fallback that
 * is `height: auto`, i.e. a silently collapsed app bar rather than an error.
 *
 * So the contract is pinned here by reading the stylesheet.
 *
 * Run with `npx vitest run test/theme.spec.ts`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRUCTURE, applyThemeTokens, DP, TOUCH_TARGET, elevation, ink, accentNight, R } from '../src/theme';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cssRaw = readFileSync(join(__dirname, '..', 'src', 'styles.css'), 'utf8');

/**
 * The stylesheet with comments removed.
 *
 * Every assertion below is about what the browser will *apply*, and comments are
 * not applied. Matching against the raw text meant that writing down the reason
 * for a rule — "it was shrinking: 96px -> 44px" — counted as using a bare 96px
 * literal and failed the very gate that exists to keep values on their tokens.
 */
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '');

describe('STRUCTURE', () => {
  it('holds the AAOS spec values', () => {
    expect(STRUCTURE.APP_BAR).toBe(96);
    expect(STRUCTURE.GRID_CELL).toBe(158);
  });
});

describe('applyThemeTokens', () => {
  /** Minimal stand-in for an element's inline style. */
  function fakeElement() {
    const props: Record<string, string> = {};
    return {
      props,
      el: { style: { setProperty: (k: string, v: string) => { props[k] = v; } } } as unknown as HTMLElement,
    };
  }

  it('publishes each token as a CSS custom property in px', () => {
    const { el, props } = fakeElement();
    applyThemeTokens(el);
    expect(props['--app-bar']).toBe('96px');
    expect(props['--grid-cell']).toBe('158px');
  });

  it('publishes the palette, not only the two structural numbers', () => {
    /*
     * This assertion used to be the *opposite* one: it asserted that
     * `applyThemeTokens` published exactly `--app-bar` and `--grid-cell` and
     * nothing else, which is a way of pinning in place the arrangement that
     * produced seven near-black card colours — `styles.css` retyped the whole
     * palette as hex literals in around forty places, none of which changing
     * the palette could reach.
     *
     * The palette now crosses the same seam as the structure does, so there is
     * one definition of each colour in `theme.ts` and `styles.css` asks for it
     * by name.
     */
    const { el, props } = fakeElement();
    applyThemeTokens(el);
    expect(props['--surface-page']).toBe(elevation.e1);
    expect(props['--surface-card']).toBe(elevation.e2);
    expect(props['--surface-raised']).toBe(elevation.e3);
    expect(props['--surface-hover']).toBe(elevation.e4);
    expect(props['--accent']).toBe(accentNight);

    // Ink is published under its kebab-case name. `onAccent` -> `--ink-on-accent`,
    // not `--ink-onaccent`: a token published under a name the stylesheet does
    // not read looks like it works while doing nothing.
    expect(props['--ink-on-accent']).toBe(ink.onAccent);
    expect(props['--ink-primary']).toBe(ink.primary);
    expect(props['--ink-secondary']).toBe(ink.secondary);
    expect(props['--ink-tertiary']).toBe(ink.tertiary);
    expect(props['--ink-primary']).not.toBe(ink.secondary);
  });

  it('publishes Google\'s radius scale and elevation, not the AAOS one', () => {
    /*
     * The radius scale is keyed `R1..R6` in `theme.ts` because that is how the
     * scale is written down, and published as `--r-xs`..`--r-pill` because that
     * is what the stylesheet asks for. A first version published
     * `Object.keys(R)` verbatim, which produced `--r-r1` — a token nothing reads,
     * so the scale existed twice and only the literal in `styles.css` was live.
     */
    const { el, props } = fakeElement();
    applyThemeTokens(el);
    expect(props['--r-xs']).toBe(`${R.R1}px`);
    expect(props['--r-sm']).toBe(`${R.R2}px`);
    expect(props['--r-lg']).toBe(`${R.R4}px`);
    expect(props['--r-xl']).toBe(`${R.R5}px`);
    expect(props['--r-pill']).toBe(`${R.R6}px`);
    expect(props['--shadow-2']).toContain('rgba(0,0,0');
  });

  it('publishes no surface token the stylesheet does not read', () => {
    /*
     * The other half of the "one definition" claim.
     *
     * Publishing a token nothing consumes is how a palette ends up defined in
     * three places: once in `theme.ts`, once as the literal in a `var()`
     * fallback in `styles.css`, and once more wherever a rule uses the hex
     * directly. So every surface/accent/radius/elevation token is checked against
     * the stylesheet.
     *
     * Ink is excluded deliberately. Several ink entries (`divider`, `outline`,
     * `scrim84`) are consumed from JS as `ink.*` rather than through CSS custom
     * properties, so requiring the stylesheet to read them would be asserting
     * something untrue about how they are used.
     */
    const { el, props } = fakeElement();
    applyThemeTokens(el);
    const cssOwned = Object.keys(props).filter(
      (k) => !/^--(app-bar|grid-cell|ink-)/.test(k),
    );
    expect(cssOwned.length).toBeGreaterThan(8);
    for (const name of cssOwned) {
      expect(css, `styles.css never reads ${name}, which applyThemeTokens publishes`).toContain(`var(${name}`);
    }
  });

  it('does nothing without a document, rather than throwing', () => {
    expect(() => applyThemeTokens(undefined)).not.toThrow();
  });

  it('is a no-op when handed something that is not an element', () => {
    expect(() => applyThemeTokens(null as unknown as HTMLElement)).not.toThrow();
  });
});

describe('styles.css consumes the tokens', () => {
  it('references every published token', () => {
    for (const name of Object.keys(STRUCTURE)) {
      const prop = `--${name.toLowerCase().replace(/_/g, '-')}`;
      expect(css, `styles.css never uses ${prop}`).toContain(`var(${prop}`);
    }
  });

  it('uses no bare app-bar or grid-cell literals outside the fallback', () => {
    // A stray literal is fine exactly once -- as the fallback inside the token.
    const bareAppBar = css.match(/(?<!var\(--app-bar, )96px/g) ?? [];
    expect(bareAppBar.length).toBeLessThanOrEqual(1);
  });

  it('gives every token reference a fallback, so a missing token cannot collapse layout', () => {
    for (const name of Object.keys(STRUCTURE)) {
      const prop = `--${name.toLowerCase().replace(/_/g, '-')}`;
      const uses = css.match(new RegExp(`var\\(${prop}[^)]*\\)`, 'g')) ?? [];
      expect(uses.length).toBeGreaterThan(0);
      for (const use of uses) {
        expect(use, `${use} has no fallback`).toMatch(/,/);
      }
    }
  });

  it('declares both tokens on :root so they resolve without JS', () => {
    const root = css.slice(0, css.indexOf('}'));
    expect(root).toContain('--app-bar');
    expect(root).toContain('--grid-cell');
  });
});

describe('token scales are consistent with the spec', () => {
  it('keeps the 8dp grid', () => {
    for (const [name, v] of Object.entries(DP)) {
      expect(v % 4, `${name} is not on the 4dp grid`).toBe(0);
    }
  });

  it('keeps the minimum touch target at the AAOS 76dp', () => {
    expect(TOUCH_TARGET).toBe(76);
  });
});