/**
 * Attribution tests.
 *
 * The app displayed no map attribution at all until this was caught: MapLibre's
 * control was disabled at construction and `.maplibregl-ctrl-attrib` was set to
 * `display: none` in the stylesheet. Every road, label and POI the app draws is
 * OpenStreetMap data — from OpenFreeMap tiles online, or from a `.osm` the user
 * imported offline — so suppressing the credit was a breach of the ODbL.
 *
 * Attribution is now declared on the map sources, which is the mechanism the
 * map library actually collects, so this file pins three things:
 *
 *  1. the credit is present, well-formed and links to the licence,
 *  2. every OSM-derived source carries it, in both map modes,
 *  3. nothing in the stylesheet or the map constructor hides it again.
 *
 * Point 3 is the regression guard. The original defect survived because nothing
 * asserted its absence, so a future "the attribution is ugly" cleanup is exactly
 * the kind of change that would silently reintroduce a licence breach.
 *
 * Run with `npx vitest run test/attribution.spec.ts`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { overlaySources, OSM_ATTRIBUTION, offlineStyleSpec } from '../src/map/style';
import { contrast } from './contrast.spec';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Sources whose geometry is derived from OSM data and so must be credited. */
const OSM_DERIVED = [
  'canopy-osm',
  'canopy-osm-water',
  'canopy-osm-green',
  'canopy-route',
  'canopy-route-travelled',
  'canopy-maneuvers',
  'canopy-origin',
  'canopy-destination',
] as const;

describe('the attribution string', () => {
  it('names OpenStreetMap contributors', () => {
    expect(OSM_ATTRIBUTION).toContain('OpenStreetMap contributors');
  });

  it('links to the licence rather than naming it in prose', () => {
    // ODbL credit is a link to the copyright page. Plain text naming the
    // licence is not the same thing, and is what most projects get wrong.
    expect(OSM_ATTRIBUTION).toMatch(/href="https:\/\/www\.openstreetmap\.org\/copyright"/);
  });

  it('opens links safely', () => {
    // The credit is rendered inside the map's attribution bar, which is HTML.
    // A bare `target="_blank"` there hands the opened page a reference back to
    // this app, so the rel is not optional.
    expect(OSM_ATTRIBUTION).toMatch(/rel="noopener"/);
  });
});

describe('overlay sources', () => {
  const sources = overlaySources();

  it('credits every OSM-derived source', () => {
    for (const id of OSM_DERIVED) {
      expect(sources[id], `source ${id} is missing`).toBeTruthy();
      expect(
        sources[id].attribution,
        `source ${id} carries no attribution`,
      ).toBe(OSM_ATTRIBUTION);
    }
  });

  it('credits the traffic overlay too', () => {
    // The tint source is keyed by a constant rather than a literal name.
    const traffic = Object.entries(sources).find(([id]) => id.includes('traffic'));
    expect(traffic, 'no traffic source in overlaySources()').toBeTruthy();
    expect(traffic![1].attribution).toBe(OSM_ATTRIBUTION);
  });

  it('does not claim OSM credit for the GPS fix', () => {
    // `canopy-location` is the user's own position. Crediting OSM for it would
    // be inaccurate in the same way that leaving it off the real sources is
    // a breach — the goal is that the credit is true, not merely present.
    expect(sources['canopy-location'].attribution).toBeUndefined();
  });

  it('returns independent source objects per call', () => {
    // `buildStyle` merges these into a live style spec. If two calls shared one
    // object, mutating one style would silently rewrite the other.
    const a = overlaySources();
    const b = overlaySources();
    expect(a['canopy-route']).not.toBe(b['canopy-route']);
  });
});

describe('the offline style', () => {
  it('shows the credit in offline mode, where no tile provider exists to', () => {
    // Offline is the case that is easiest to get wrong: there is no OpenFreeMap
    // style in play, so nothing else would put attribution on screen, yet the
    // geometry is still OSM's.
    const style = offlineStyleSpec([]) as { sources: Record<string, any> };
    for (const id of ['canopy-osm', 'canopy-osm-water', 'canopy-osm-green']) {
      expect(style.sources[id], `offline style is missing ${id}`).toBeTruthy();
      expect(style.sources[id].attribution).toBe(OSM_ATTRIBUTION);
    }
  });
});

describe('nothing suppresses the credit', () => {
  const css = readFileSync(join(root, 'src', 'styles.css'), 'utf8');
  const mapView = readFileSync(join(root, 'src', 'map', 'MapView.tsx'), 'utf8');

  /**
   * Rule bodies whose selector targets the attribution bar itself.
   *
   * Matched on a trailing boundary rather than `includes`, because
   * `.maplibregl-ctrl-attrib-button` and `-close` are *children* of the bar and
   * legitimately have their own rules. Getting this wrong makes the test fail on
   * the very rules that keep the credit usable.
   */
  const attribRules = () =>
    [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, sel]) => /(?:^|[\s,.])\.maplibregl-ctrl-attrib(?![-\w])/.test(sel))
      .map(([, , body]) => body);

  it('does not hide the attribution control in CSS', () => {
    // Read the rule bodies rather than grepping for the selector, so a
    // multi-selector rule cannot hide the control as a side effect.
    const rules = attribRules();
    expect(rules.length, 'no attribution rule found in styles.css').toBeGreaterThan(0);
    for (const body of rules) {
      expect(body).not.toMatch(/display\s*:\s*none/);
      expect(body).not.toMatch(/visibility\s*:\s*hidden/);
      expect(body).not.toMatch(/opacity\s*:\s*0\s*[;}]/);
    }
  });

  it('does not set the text colour to transparent', () => {
    for (const body of attribRules()) {
      expect(body).not.toMatch(/color\s*:\s*transparent/);
    }
  });

  it('enables the map attribution control', () => {
    // `attributionControl: false` is what disabled it in the first place.
    expect(mapView).not.toMatch(/attributionControl\s*:\s*false/);
    expect(mapView).toMatch(/attributionControl\s*:/);
  });

  it('gives the credit a legible colour on the dark chrome', () => {
    // The bar sits on the app's own deep surface. Grey-on-grey at 11px would
    // satisfy "it is present" and still be unreadable in a moving car, so the
    // contrast is pinned rather than left to a later edit.
    //
    // The palette check is against the *token* rather than a list of hex values,
    // because the token is the definition — a hard-coded list here was how the
    // credit ended up still citing the old AAOS ramp after the whole app had
    // moved to Google Maps' dark theme.
    const withColor = attribRules().find((b) => /color\s*:/.test(b));
    expect(withColor, 'no explicit text colour on the attribution bar').toBeTruthy();
    expect(withColor).toMatch(/color\s*:\s*var\(--ink-secondary,\s*#C2C8D0\)/);
    // And that token must clear the floor it is being used for. 13px is body
    // text, not large text, so it is 4.5:1.
    expect(contrast('#C2C8D0', '#1A1D21')).toBeGreaterThanOrEqual(4.5);
  });

  it('does not leave a dead close-button rule behind', () => {
    // The control is constructed with `compact: false`, so MapLibre never
    // renders its close button. A rule for it would be unreachable CSS that
    // reads as if the credit can be dismissed — which, if it ever could, would
    // be a licence problem again.
    expect(mapView).toMatch(/compact\s*:\s*false/);
    expect(css).not.toMatch(/\.maplibregl-ctrl-attrib-close/);
  });
});