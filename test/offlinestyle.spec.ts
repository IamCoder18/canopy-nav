/**
 * The offline basemap has to survive MapLibre's own validator.
 *
 * `Style._load` returns early on the first validation error — the style is not
 * applied, no layers are created, and no `style.load` fires. A style with one
 * cosmetic mistake is therefore not "slightly wrong": it is a style that draws
 * nothing at all. The offline style had exactly that mistake — `glyphs:
 * undefined` is a *present* key, the validator reads a present key as a
 * declaration and reports "glyphs: string expected, undefined found", and the
 * fallback that the whole no-network story depends on was silently rejected.
 * The map stayed blank behind a UI that claimed a map was loaded, and the only
 * trace was one error line in logcat.
 *
 * So this gate runs the real validator, the one the runtime runs, against the
 * real style object. Asserting on the source text would have passed throughout
 * the bug: the text said `glyphs: undefined`, which looks like "no glyphs". The
 * failure is MapLibre's *reaction* to the object, so the object is what has to
 * be checked.
 *
 * The second half of the gate is the promise this app is packaged on: with no
 * network, nothing in the offline style may point at something to fetch.
 */

import { describe, it, expect } from 'vitest';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { offlineStyleSpec, navOverlays } from '../src/map/style';

/** The style exactly as MapView hands it to MapLibre. */
const spec = offlineStyleSpec(navOverlays());

describe('the offline style is accepted by the validator the runtime runs', () => {
  it('has no validation errors', () => {
    // If this ever fails the map is not degraded, it is not drawn. Every message
    // is listed rather than only the count, because the message is the bug.
    const errors = validateStyleMin(spec as never).map((e) => e.message);
    expect(errors).toEqual([]);
  });

  it('does not declare glyphs at all — absent, not undefined', () => {
    // `expect(spec.glyphs).toBeUndefined()` passes for the broken form too: the
    // value *was* undefined. What the validator objects to is the key's
    // presence, so the key's presence is what is asserted.
    expect('glyphs' in spec).toBe(false);
  });

  it('declares no sprite either', () => {
    expect('sprite' in spec).toBe(false);
  });
});

describe('the offline style fetches nothing', () => {
  it('every source draws from local data, with no tiles or url to request', () => {
    const sources = Object.entries(spec.sources ?? {});
    expect(sources.length).toBeGreaterThan(0);
    for (const [id, source] of sources) {
      const s = source as Record<string, unknown>;
      // GeoJSON with inline `data`, never a tilejson `url` or a `tiles` array:
      // those are the two shapes that make a source a network request.
      expect(s.type, `source ${id}`).toBe('geojson');
      expect(s, `source ${id}`).not.toHaveProperty('tiles');
      expect(s, `source ${id}`).not.toHaveProperty('url');
      expect(s, `source ${id}`).toHaveProperty('data');
    }
  });

  it('the only URLs anywhere in the style are credits, which nothing fetches', () => {
    // `attribution` is HTML the attribution control displays; it is never
    // requested. Strip those properties and the serialized style may not name a
    // URL at all — the promise in its strongest form: not a glyphs endpoint, not
    // a sprite, not a tilejson, and nothing a future root key can quietly add.
    // (This is also the assertion that would have failed on `style.glyphs =
    // 'https://tiles.openfreemap.org/…'` had that landed in the offline style.)
    //
    // Stripped structurally, not by regex: an attribution value is HTML with
    // quoted attributes, and matching it out of `JSON.stringify` output means
    // matching through escaped quotes.
    const stripCredits = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(stripCredits);
      if (node && typeof node === 'object') {
        return Object.fromEntries(
          Object.entries(node as Record<string, unknown>)
            .filter(([key]) => key !== 'attribution')
            .map(([key, value]) => [key, stripCredits(value)]),
        );
      }
      return node;
    };
    expect(JSON.stringify(stripCredits(spec))).not.toMatch(/https?:\/\//);
  });
});
