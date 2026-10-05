/**
 * Render smoke test for `App`.
 *
 * Why this exists: the rest of this suite tests pure logic under node, with no
 * DOM, and that is a good trade — it is fast, and it is why 747 tests can run in
 * four seconds. But it has a blind spot with a demonstrated cost. A `useMemo`
 * callback runs *during render*, so a ref or helper it closes over must already
 * be initialised; one declared further down the component is in its temporal
 * dead zone and throws `Cannot access 'x' before initialization`.
 *
 * That is not hypothetical. It shipped: the ETA fix added a `routePos` ref
 * below the guidance memos that read it, every one of the 747 unit tests stayed
 * green, and the app rendered nothing but the error boundary's recovery card.
 * Only the browser suite caught it, because only the browser suite renders the
 * component. This test is the cheap half of closing that: it does not verify
 * behaviour, it verifies that `App` can be rendered at all.
 *
 * React's server renderer re-throws rather than honouring an error boundary,
 * which is exactly what is wanted here — the boundary is what made the failure
 * quiet, and this test must not be quiet about it either.
 *
 * Run with `npx vitest run test/app-render.spec.ts`.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The map is a `React.lazy` chunk that needs WebGL, a canvas and a network.
// None of that exists here and none of it is what this test is about; the real
// map is covered by `test/e2e.mjs` in a browser, which is a stronger check.
vi.mock('../src/map/MapView', () => ({
  default: () => React.createElement('div', { className: 'map' }),
}));

describe('App renders without throwing', () => {
  /** Rendered once and shared: `App` is a 2000-line component, not cheap. */
  let cached: string | null = null;
  const renderApp = async (): Promise<string> => {
    if (cached !== null) return cached;
    // Imported lazily so the MapView mock above is installed first.
    const { default: App } = await import('../src/App');
    cached = renderToStaticMarkup(React.createElement(App));
    return cached;
  };

  beforeAll(() => {
    // `readSelection` and friends touch localStorage on first render. Node has
    // no localStorage, and the app is written to degrade rather than throw, but a
    // stub that behaves like the browser's keeps a storage failure from being
    // mistaken for a render failure.
    const store = new Map<string, string>();
    const g = globalThis as unknown as Record<string, unknown>;
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    };
  });

  it('produces the app chrome on the first render, not a crash card', async () => {
    const html = await renderApp();
    expect(html.length).toBeGreaterThan(0);
    // The error boundary's own wording. This is the failure that shipped: the
    // app rendered the recovery card on every screen, and because the boundary
    // works as designed, nothing anywhere reported a crash.
    expect(html).not.toContain('Canopy Nav stopped');
  });

  it('exposes a labelled landmark, so the root is reachable without sight', async () => {
    // §10 found the app had no `main` and no headings on any of its screens, and
    // added a labelled region on the root element. This is the only test in the
    // suite that renders that element, so it is where the landmark is pinned.
    //
    // The assertion was `role="(region|main)"` — which a real `<main>` element
    // does *not* have, so satisfying it required keeping the weaker form. The
    // element is a `<main>` now: `role="region"` made the entire application a
    // single landmark whose accessible name changed as the driver moved between
    // screens, and "jump to main" still had nothing to jump to. The test is
    // tightened to the real thing rather than loosened to match it.
    const html = await renderApp();
    expect(html).toMatch(/<main class="app"/);
    expect(html).toMatch(/aria-label="Canopy Nav/);
  });

  it('gives the launcher a real heading, so heading navigation has somewhere to land', async () => {
    // The document had no `<h1>` on any screen, so a screen-reader user
    // navigating by heading found nothing to move between. The brand line is the
    // launcher's heading; the other screens use their app-bar title.
    const html = await renderApp();
    // The wordmark, with its short form as a nested span so narrow screens can drop
    // " Nav" without duplicating the accessible name.
    expect(html).toMatch(/<h1[^>]*class="brand-title"[^>]*>Canopy<span class="brand-tail"> Nav<\/span><\/h1>/);
  });

  it('names the current screen in the landmark, not just the app', async () => {
    // A landmark labelled only "Canopy Nav" tells a screen-reader user where they
    // are in the app but not which screen they are on, which is the thing worth
    // announcing after a jump.
    const html = await renderApp();
    expect(html).toMatch(/aria-label="Canopy Nav — [A-Za-z]/);
  });
});
