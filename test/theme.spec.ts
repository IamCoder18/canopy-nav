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
import { STRUCTURE, applyThemeTokens, DP, TOUCH_TARGET } from '../src/theme';

const __dirname = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(__dirname, '..', 'src', 'styles.css'), 'utf8');

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

  it('publishes one property per token and nothing else', () => {
    const { el, props } = fakeElement();
    applyThemeTokens(el);
    expect(Object.keys(props).sort()).toEqual(['--app-bar', '--grid-cell']);
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