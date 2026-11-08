/**
 * `chrome.ts` — the bottom sheet's measured height, as behaviour rather than as a source.
 *
 * `test/textscale-layout.spec.ts` asserts the *invariants* that stop the old bug
 * coming back: leading is a multiplier, bars have floors, positions read the
 * measurements. Those are all things a future edit could break by accident, and none
 * of them would notice if the mechanism itself stopped working — that the observer
 * exists, that it publishes, that it stops cleanly, and that the sheet growing actually
 * changes what it publishes.
 *
 * The last one is the point of the whole module. Everything else exists so that a sheet
 * which grows by 52px pushes the right lane and the status sign out of its way; if the
 * observer did not fire on a resize, the stylesheet would read `--nav-h` from the first
 * paint forever and every fix in `styles.css` would be decoration.
 *
 * One bar since the Google-style layout: the sheet is the only chrome whose height is a
 * function of its own content. The old module published the ETA strip too; that strip
 * moved into this sheet, and with it its reason to be measured separately.
 *
 * ## Why a hand-built root rather than a DOM
 *
 * There is no `jsdom` or `happy-dom` in this project, and adding one to ten
 * assertions would be a worse trade than the thing it tests: it would put a
 * synthesised layout engine in the path of a module whose entire purpose is to measure
 * a *real* one. What `observeChromeHeights` needs from its argument is two things —
 * `querySelector` and a `style` — so the test supplies exactly those and nothing else.
 * The consequence is stated plainly: this file cannot catch a bug that depends on real
 * layout, because real layout is what it replaces. `npm run reflow` is the browser-side
 * proof, and it is where the actual overlap numbers are measured.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { observeChromeHeights } from '../src/nav/chrome';

/** The minimum of `HTMLElement` that the module actually touches. */
interface FakeStyle {
  setProperty(name: string, value: string): void;
  getPropertyValue(name: string): string;
  removeProperty(name: string): void;
}

function makeStyle(): FakeStyle {
  const props = new Map<string, string>();
  return {
    setProperty: (name, value) => void props.set(name, value),
    getPropertyValue: (name) => props.get(name) ?? '',
    removeProperty: (name) => void props.delete(name),
  };
}

/** A stand-in element with a height the test controls. */
class FakeBar {
  height = 0;
  readonly style = makeStyle();
}

/**
 * A stand-in document root that resolves the observed selector.
 *
 * Elements are cached per selector and returned by identity, because a real
 * `querySelector` does: the observer registers one, and the thing that later triggers
 * its callback is that same object. Returning a fresh literal each call broke exactly
 * that, and made a faithful stub impossible to write.
 */
class FakeRoot {
  readonly style = makeStyle();
  private cache = new Map<string, unknown>();
  constructor(private bars: Map<string, FakeBar>) {}
  querySelector(selector: string): unknown {
    if (!this.bars.has(selector)) return null;
    let el = this.cache.get(selector);
    if (!el) {
      const bar = this.bars.get(selector)!;
      el = { getBoundingClientRect: () => ({ height: bar.height }) };
      this.cache.set(selector, el);
    }
    return el;
  }
}

/**
 * A stub `ResizeObserver` faithful about *why* its callback fires.
 *
 * The first version let a test call the captured callback directly, which meant
 * "republishes when a bar changes height" passed even with every `observe()` call
 * deleted — the test was exercising the callback, not the observation, and so would
 * not have caught the module's central mechanism being removed.
 *
 * So a callback is only reachable through an element that was actually observed, and
 * `fire(el)` resizes that specific element. That is what a real observer does, and it
 * is the difference between a test that proves the mechanism and one that proves a
 * closure.
 */
function stubResizeObserver(): { fire: (el: unknown) => void; observed: Set<unknown> } {
  const observed = new Set<unknown>();
  const registry = new Map<unknown, () => void>();
  globalThis.ResizeObserver = class {
    constructor(private cb: () => void) {}
    observe(el: unknown) { observed.add(el); registry.set(el, this.cb); }
    unobserve(el: unknown) { observed.delete(el); registry.delete(el); }
    disconnect() { observed.clear(); registry.clear(); }
  } as unknown as typeof ResizeObserver;
  return {
    observed,
    fire: (el: unknown) => registry.get(el)?.(),
  };
}

const RealResizeObserver = globalThis.ResizeObserver;

let bars: Map<string, FakeBar>;
let root: FakeRoot;

beforeEach(() => {
  bars = new Map([['.nav-bottom', new FakeBar()]]);
  root = new FakeRoot(bars);
});

afterEach(() => {
  globalThis.ResizeObserver = RealResizeObserver;
});

const asRoot = () => root as unknown as HTMLElement;

describe('observeChromeHeights', () => {
  it('publishes the sheet\'s height on the first pass', () => {
    bars.get('.nav-bottom')!.height = 100;
    stubResizeObserver();

    observeChromeHeights(asRoot());

    expect(root.style.getPropertyValue('--nav-h')).toBe('100px');
  });

  it('observes the sheet, so a later resize is noticed', () => {
    bars.get('.nav-bottom')!.height = 96;
    const ro = stubResizeObserver();

    observeChromeHeights(asRoot());

    expect(ro.observed.size).toBe(1);
  });

  it('republishes when the sheet changes height', () => {
    // The whole reason this module exists. The sheet grows by 52px at 200% — measured —
    // and everything anchored to it has to move with it.
    bars.get('.nav-bottom')!.height = 96;
    const ro = stubResizeObserver();
    observeChromeHeights(asRoot());
    expect(root.style.getPropertyValue('--nav-h')).toBe('96px');

    bars.get('.nav-bottom')!.height = 148;
    // Resizing the element itself, not "call the callback" — the observation has to be
    // what connects them.
    ro.fire(root.querySelector('.nav-bottom'));

    expect(root.style.getPropertyValue('--nav-h')).toBe('148px');
  });

  it('does not notice a bar it was never asked to watch', () => {
    // The negative of the above, and the case that would slip through a loose stub:
    // an unobserved element resizing must change nothing.
    bars.get('.nav-bottom')!.height = 96;
    const ro = stubResizeObserver();
    observeChromeHeights(asRoot());
    const stranger = { getBoundingClientRect: () => ({ height: 999 }) };

    ro.fire(stranger);

    expect(root.style.getPropertyValue('--nav-h')).toBe('96px');
  });

  it('rounds to whole pixels', () => {
    // Sub-pixel churn would push a custom property onto every inheriting element on
    // every frame of a zoom gesture, and the gain is invisible.
    bars.get('.nav-bottom')!.height = 95.984;
    stubResizeObserver();

    observeChromeHeights(asRoot());

    expect(root.style.getPropertyValue('--nav-h')).toBe('96px');
  });

  it('keeps the previous value when the sheet measures zero', () => {
    // A hidden or not-yet-laid-out sheet measures 0. Publishing that would collapse the
    // anchored bounds to nothing — a worse failure than being briefly wrong.
    bars.get('.nav-bottom')!.height = 96;
    const ro = stubResizeObserver();
    observeChromeHeights(asRoot());

    const sheet = root.querySelector('.nav-bottom');
    bars.get('.nav-bottom')!.height = 0;
    ro.fire(sheet);

    expect(root.style.getPropertyValue('--nav-h')).toBe('96px');
  });

  it('writes nothing when the sheet is absent', () => {
    // Before navigation renders there is no `.nav-root` at all. Falling back to the
    // design tokens is correct; publishing 0 or throwing is not.
    root = new FakeRoot(new Map());
    stubResizeObserver();

    expect(() => observeChromeHeights(asRoot())).not.toThrow();
    expect(root.style.getPropertyValue('--nav-h')).toBe('');
  });

  it('removes what it wrote on stop, and disconnects', () => {
    bars.get('.nav-bottom')!.height = 100;
    const ro = stubResizeObserver();
    const handle = observeChromeHeights(asRoot());
    expect(root.style.getPropertyValue('--nav-h')).toBe('100px');

    handle.stop();

    expect(root.style.getPropertyValue('--nav-h')).toBe('');
    expect(ro.observed.size).toBe(0);
  });

  it('measures once and does not track where there is no ResizeObserver', () => {
    // Graceful degradation, asserted rather than hoped for: the stylesheet falls back
    // to the design tokens either way, and a caller should not assume tracking.
    globalThis.ResizeObserver = undefined as unknown as typeof ResizeObserver;
    bars.get('.nav-bottom')!.height = 112;

    const handle = observeChromeHeights(asRoot());

    expect(root.style.getPropertyValue('--nav-h')).toBe('112px');
    expect(() => handle.stop()).not.toThrow();
  });

  it('is inert with no root at all', () => {
    stubResizeObserver();
    expect(() => observeChromeHeights(undefined).stop()).not.toThrow();
  });
});
