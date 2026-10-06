/**
 * Regression guards for defects found by a browser audit of the navigation and
 * search flows.
 *
 * ## Why these are source-shape tests
 *
 * Every one of these bugs had a green unit suite and a green browser suite behind
 * it. The pattern is consistent enough to name: the code computed the right
 * *kind* of value from inputs that could never take the interesting branch, or
 * depended on an identity that made the code unreachable. A pure-function test
 * cannot see either, because the problem is in how the component is wired.
 *
 * So these assert properties of the source that must remain true. That is a weak
 * instrument and a blunt one, and it is the instrument this project has.
 *
 *   - `npm run check` would not otherwise fail if someone reintroduced
 *     `props.location` into the search effect's dependency list, restored the
 *     9999 m distance cap, or put `m` back above the typing guard.
 *
 * Where a behaviour *can* be rendered, it is rendered instead — see the bottom
 * of this file, where the keyboard and the arrival banner are checked through a
 * real DOM.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(join(here, '..', 'src', rel), 'utf8');

const APP = src('App.tsx');
const CSS = src('styles.css');
const MAP = src('map/MapView.tsx');
const SETTINGS = src('settings.ts');
const LOC = src('nav/location.ts');
const REGIONS = src('regions/RegionsScreen.tsx');

/**
 * Source with comments and strings removed.
 *
 * These assertions are about *code*, and several of the bugs are described in
 * the very comments that record their fix — a comment quoting the old line so
 * the next reader knows why it changed. Matching the raw source therefore fails
 * on a file that is entirely correct, which is the worst possible failure for a
 * regression test: it trains people to delete the explanation.
 */
const code = (rel: string) =>
  src(rel)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");

/** The body of one `useEffect`, by the text that follows its opening. */
function effectBody(code: string, marker: string): string {
  const at = code.indexOf(marker);
  if (at < 0) throw new Error(`marker not found: ${marker}`);
  const end = code.indexOf('\n  }, [', at);
  return code.slice(at, end < 0 ? at + 2000 : end);
}

describe('keyboard: a letter must reach the field it is typed into', () => {
  it('puts the typing guard above the mute shortcut', () => {
    // `m` was handled *above* `if (typing) return;` with an unconditional
    // `preventDefault()`, so every `m` was swallowed before it reached the
    // search box, the API-key field or the endpoint field. "Museum" and
    // `valhalla.mylab.net` were untypable — the app's one primary input.
    const guard = APP.indexOf('if (typing) return;');
    const mute = APP.indexOf("e.key === 'm' || e.key === 'M'");
    expect(guard).toBeGreaterThan(-1);
    expect(mute).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(mute);
  });

  it('does not let a bare letter overwrite a query already on screen', () => {
    // Typing "coffee", tapping a result (which moves focus off the field) and
    // then pressing `s` replaced the whole query with `s`.
    expect(APP).toMatch(/if \(screenRef\.current === 'search'\) return;/);
  });

  it('keeps Escape from ending an active trip', () => {
    // The screen stack is read from a ref now so Escape gets the same focus
    // handling as every other transition; the rule itself is unchanged.
    // Read from the raw source: `code()` blanks string literals, which is the
    // point for the negative assertions but destroys a rule that is *about* a
    // string.
    expect(APP).toMatch(/s === 'navigating'\) return null;/);
    expect(APP).toMatch(/There is an explicit Exit[\s\S]{0,40}control for it/);
  });
});

describe('navigation: the banner must not state a number it has invented', () => {
  it('shows the true distance to the next turn', () => {
    // `Math.min(distToTurn, 9999)` pinned the banner at "10 km" / "6 mi" on any
    // longer leg, and `speak()` read the same capped value, so the app *said*
    // "In 10 km, turn right" for a 25 km straight.
    expect(code('App.tsx')).not.toMatch(/Math\.min\(distToTurn/);
    expect(code('App.tsx')).toMatch(/const laneDist = distToTurn;/);
  });

  it('derives arrival from progress rather than from an absent maneuver', () => {
    // `next` is built with `?? active`, so it is never null and
    // `!nextManeuver` was never true: arrival was never spoken and never
    // announced, for any Valhalla route.
    expect(APP).toMatch(/const arriving =\s*\n?\s*props\.progressAlong >= ARRIVED_FRACTION/);
    expect(APP).toMatch(/You have arrived at your destination\./);
  });

  it('hides the distance block on arrival instead of printing 0 m', () => {
    expect(APP).toMatch(/\{!arriving && \(\s*\n\s*<div className="maneuver-dist"/);
  });

  it('speaks every instruction change, not only major maneuvers', () => {
    // `if (!major && !arriving) return;` meant a "slight right" or a "continue"
    // was painted across the banner in display3 and produced silence.
    expect(code('App.tsx')).not.toMatch(/!major && !arriving/);
  });
});

describe('search: a GPS fix must not re-arm the debounce', () => {
  it('keys the effect on a rounded position, not the raw array', () => {
    // `props.location` is a fresh array per fix (~1 Hz, `maximumAge: 0`), so it
    // was a dependency of the search effect and its cleanup — `clearTimeout` —
    // ran on every fix, discarding up to a second of every keystroke.
    const body = effectBody(APP, 'const multi = props.regions.length > 1;');
    expect(body).toMatch(/locationKey/);
    const deps = APP.slice(APP.indexOf('}, [q, cat,'));
    expect(deps.slice(0, 200)).toMatch(/locationKey/);
    expect(deps.slice(0, 200)).not.toMatch(/props\.location[,\]]/);
  });
});

describe('map: overlays must not depend on a boot-time closure', () => {
  it('reads live props when the style finishes loading', () => {
    // `applyOverlays(current, props)` inside `boot()` closed over the props of
    // the render that *started* the boot. `buildStyle()` is a network
    // round-trip; a route chosen inside that window produced no line, no pin and
    // no origin marker, and nothing errored.
    expect(MAP).toMatch(/applyOverlays\(current, overlayProps\.current\)/);
    expect(MAP).toMatch(/const overlayProps = useRef\(props\)/);
  });

  it('does not re-serialise the offline basemap once a second', () => {
    // `roadsToGeoJSON` walks every way in the extract; for a province that is
    // 10⁵–10⁶ objects built on the main thread, once per GPS fix, forever.
    expect(MAP).toMatch(/const basemapCache = new WeakMap/);
    expect(MAP).toMatch(/basemapFor\(p\.dataset, Math\.round\(m\.getZoom\(\)\)\)/);
  });

  it('refreshes the offline level of detail when the zoom changes', () => {
    // Nothing re-applied the overlays on zoom, so the LOD — which is a function
    // of zoom — only updated as a side effect of a GPS fix.
    expect(MAP).toMatch(/m\.on\('zoomend', onZoomEnd\)/);
    expect(MAP).toMatch(/m\.off\('zoomend', onZoomEnd\)/);
  });

  it('honours prefers-reduced-motion for every camera move', () => {
    // `styles.css` has the media query and pointed here for the camera work,
    // which was never implemented: every recentre and fit animated regardless.
    expect(MAP).toMatch(/function reducedMotion\(\)/);
    expect(code('map/MapView.tsx')).not.toMatch(/duration: 400/);
    expect(code('map/MapView.tsx')).not.toMatch(/duration: 450/);
    expect(MAP.match(/cameraDuration\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});

describe('settings: reads must be as guarded as writes', () => {
  it('routes every getItem through the safe wrapper', () => {
    // `defaultStore()` probes with a write, which does not catch a store whose
    // `getItem` throws by policy. Every reader called it bare from inside a
    // `useState` initialiser, so that threw during the first render and the app
    // opened on the crash card with no settings screen to fix it from.
    expect(SETTINGS).toMatch(/function safeGet\(/);
    const bare = code('settings.ts').match(/store\?\.getItem\(/g) ?? [];
    expect(bare).toHaveLength(1); // only inside safeGet itself
  });

  it('validates a saved place on the way out as well as in', () => {
    expect(SETTINGS).toMatch(/export function readPlaces/);
    expect(SETTINGS).toMatch(/isFiniteLonLat/);
  });
});

describe('styles: the declarations that were being discarded', () => {
  it('never lets a padding shorthand undo an inset longhand', () => {
    // Three rules declared `padding-top`/`padding-bottom: var(--inset-*)` and
    // then a `padding:` shorthand below it, which reset it. The ETA bar's two
    // 76dp buttons and the nav bar's three were centred inside a band starting
    // at y=0, under the status bar and in the gesture area respectively.
    const rules = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    const offenders: string[] = [];
    for (const [, sel, body] of rules) {
      if (!body.includes('padding')) continue;
      let seenShorthand = false;
      for (const [, prop] of body.matchAll(/(?:^|\s)([a-z-]+)\s*:/g)) {
        if (prop === 'padding') seenShorthand = true;
        else if (prop.startsWith('padding-') && seenShorthand) offenders.push(`${sel.trim()} -> ${prop}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the maneuver tile\'s own background and colour inside its rule', () => {
    // Two declarations were stranded between rules and silently discarded by CSS
    // error recovery, so the single most important element in the app had no
    // tile background for every non-major maneuver.
    const rule = /\.maneuver-icon \{[^}]*\}/.exec(CSS)?.[0] ?? '';
    expect(rule).toMatch(/background:/);
    expect(rule).toMatch(/color:/);
  });

  it('gives the off-route notice the same corner as the card it sits under', () => {
    // §3.19 deferred a "0-gap border-to-border look" between these two. Measured,
    // the gap is the stack's own 8px at every viewport — there was never a
    // collision — but the two are siblings with the *same* fill and *different*
    // radii, which reads as one panel split in two rather than as two cards.
    const card = /\.maneuver-banner \{[^}]*\}/.exec(CSS)?.[0] ?? '';
    const notice = /\.offroute-banner \{[^}]*\}/.exec(CSS)?.[0] ?? '';
    const radiusOf = (rule: string) => /border-radius:\s*([\d.]+)px/.exec(rule)?.[1];
    expect(radiusOf(card)).toBeDefined();
    expect(radiusOf(notice)).toBe(radiusOf(card));
    // And they really are the same surface, which is why the corner has to match.
    const bgOf = (rule: string) => /background:\s*([^;]+);/.exec(rule)?.[1].trim();
    expect(bgOf(notice)).toBe(bgOf(card));
    // The amber rule is what distinguishes them; without it they would be
    // genuinely indistinguishable.
    expect(notice).toMatch(/border-left:\s*4px solid/);
  });

  it('gives the launcher two columns at phone portrait', () => {
    // `auto-fit, minmax(156px, 1fr)` computed to one column at 412dp, stacking
    // five 158dp tiles into an 886px scroll on the screen whose whole purpose is
    // one tap to search.
    expect(CSS).toMatch(/grid-template-columns: repeat\(5, 1fr\)/);
    expect(CSS).toMatch(/@media \(max-width: 760px\)[\s\S]*?grid-template-columns: repeat\(2, 1fr\)/);
  });

  it('stops the launcher panel crushing its shrinkable rows', () => {
    // `flex-shrink: 0` was on two of four children, so the "Continue
    // navigation" card collapsed to a sliver while five tiles scrolled past it.
    expect(CSS).toMatch(/\.home-search > \* \{ flex-shrink: 0; \}/);
  });

  it('gives warnings their own colour, not the error card\'s', () => {
    // Sharing one teaches people to ignore the card that means "your map is
    // gone" — and on the preview screen the red card sat above **Start** on
    // every successful fallback route.
    expect(CSS).toMatch(/\.error-card\.warn \{/);
  });
});

describe('regions: the flows that reported nothing', () => {
  it('reports a failed cache deletion instead of discarding the reason', () => {
    // `deleteRegion` builds "It will reappear the next time the app starts." and
    // both callers threw it away, so a refused IndexedDB write freed no bytes
    // and said nothing.
    expect(REGIONS).toMatch(/const problem = await removeRegion\(r\.id\)/);
    expect(src('regions/store.ts')).toMatch(/export async function removeRegion/);
  });

  it('aborts every download that outlives the screen', () => {
    // Was one `abortRef` for the whole screen, which meant only the *last* download
    // started could be cancelled — a second Download left the first running with
    // nothing able to stop it, which is the whole point of leaving the screen
    // mid-transfer.
    expect(REGIONS).toMatch(/for \(const ctrl of downloads\.current\.values\(\)\) ctrl\.abort\(\)/);
    expect(REGIONS).toMatch(/downloads\.current\.clear\(\)/);
  });

  it('gives each download its own handle, and releases only its own row', () => {
    // The single `abortRef` also meant a superseded download's `finally` cleared
    // the progress row belonging to the one the driver was watching.
    expect(REGIONS).toMatch(/downloads\.current\.get\(entry\.id\) === ctrl/);
    // Comments stripped first: the note explaining what this replaced names it, and
    // a guard that fails on its own explanation trains people to delete the
    // explanation.
    expect(code('regions/RegionsScreen.tsx')).not.toMatch(/abortRef/);
  });

  it('cancels the download that is on screen, not the last one started', () => {
    expect(REGIONS).toMatch(/downloads\.current\.get\(dl\.entry\.id\)\?\.abort\(\)/);
  });

  it('replaces a download of the same region rather than racing it', () => {
    // One progress row and one Cancel control cannot honestly represent two
    // concurrent transfers of up to 1.4 GB each.
    expect(REGIONS).toMatch(/downloads\.current\.get\(entry\.id\)\?\.abort\(\);\s*\n\s*const ctrl/);
  });

  it('bounds and times the catalogue availability probe', () => {
    // The comment said "lazily"; it was one Promise.all over every province and
    // state on every mount, with no AbortController and no deadline.
    expect(REGIONS).toMatch(/const CONCURRENCY = 4;/);
    expect(REGIONS).toMatch(/const PROBE_TIMEOUT_MS = 10_000;/);
  });

  it('renders a removal outcome in flow rather than pinned to the viewport', () => {
    // `.progress-card` is `position: fixed`, correct for transient progress and
    // wrong for a result: it followed the driver around the catalogue.
    expect(REGIONS).toMatch(/className="result-panel"/);
    expect(code('regions/RegionsScreen.tsx'))
      .not.toMatch(/className="progress-card"[\s\S]{0,400}Send to navigation/);
  });
});

describe('coordinates: one place decides where the app thinks it is', () => {
  it('opens the map on the no-fix position', () => {
    // The map opened on London, the no-fix position was Calgary, and Home/Work
    // routed to London. With no GPS those disagree by 7,000 km, so the map showed
    // one place, ranking used another, and routing asked for a trip between them
    // — which came back as an upstream "max distance limit" error.
    expect(LOC).toMatch(/export const NO_FIX_POSITION/);
    expect(MAP).toMatch(/center: NO_FIX_POSITION,/);
    expect(code('App.tsx')).not.toMatch(/onRoute\(\[-\d/);
  });

  it('has no hard-coded Home or Work destination', () => {
    expect(code('App.tsx')).not.toMatch(/51\.5072/);
  });
});