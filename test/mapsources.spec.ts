/**
 * Every source id this app writes to must exist.
 *
 * ## The defect this exists to prevent
 *
 * `applyOverlays` called
 *
 * ```ts
 * set('canopy-osm-roads', layers.roads);
 * ```
 *
 * `canopy-osm-roads` is the id of the **layer** that draws arterials. The **source**
 * every road layer reads is `canopy-osm` — `canopy-osm-casing`, `canopy-osm-minor` and
 * `canopy-osm-roads` all declare `source: 'canopy-osm'`.
 *
 * So `m.getSource('canopy-osm-roads')` returned `undefined`, `set` took its
 * `if (src && 'setData' in src)` no-op branch, and **the imported `.osm` road network
 * was never drawn.** Water and green rendered; roads did not; and nothing anywhere
 * errored, because the miss was handled by design — `set` is written to tolerate a
 * style that has not loaded yet, and that tolerance is exactly what swallowed it.
 *
 * This is the app's *primary* mode. It survived because the id looks right: it matches
 * the layer a reader would check in order to confirm roads are being styled, and
 * `test/basemap.spec.ts` asserts on the *text* of `MapView.tsx` rather than on whether
 * the data reached anything.
 *
 * ## What is checked
 *
 * Every id passed to `set(...)` in `MapView.tsx` is resolved against
 * `overlaySources()`, which is the single place sources are declared. A layer id
 * mistaken for a source id cannot survive this, and a source removed from the style
 * cannot leave a caller writing to it.
 *
 * The reverse direction is checked too: every source `overlaySources()` declares is
 * written to by something, so an orphaned source cannot accumulate.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { overlaySources } from '../src/map/style';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const mapview = readFileSync(join(ROOT, 'src', 'map', 'MapView.tsx'), 'utf8');

/** The sources the style declares. */
const declared = new Set(Object.keys(overlaySources()));

/** Every id handed to `set('…', …)` inside `applyOverlays`. */
const written = [...mapview.matchAll(/\bset\('([^']+)'/g)].map((m) => m[1]);

describe('every source this app writes to is one the style declares', () => {
  it('finds the writes, so the checks below are not vacuous', () => {
    // A regex that matches nothing would make every assertion below pass for the
    // wrong reason, which is the §14.11 lesson about a check that cannot fail.
    expect(written.length, 'ids passed to set()').toBeGreaterThan(3);
  });

  it('resolves every id against overlaySources()', () => {
    const missing = written.filter((id) => !declared.has(id));
    expect(missing, `ids written but never declared: ${missing.join(', ')}`).toEqual([]);
  });

  it('writes roads to the source the road layers actually read', () => {
    // The specific bug, asserted on its own so a future rename fails here with a
    // clear message rather than in the loop above.
    expect(written).toContain('canopy-osm');
    expect(written).not.toContain('canopy-osm-roads');
  });

  it('does not confuse a layer id for a source id anywhere in the file', () => {
    // The general form of the trap: `canopy-osm-roads` and `canopy-osm-casing` are
    // layer ids that read as source ids. If either is ever passed to `set` again, this
    // is the assertion that catches it.
    for (const layerId of ['canopy-osm-roads', 'canopy-osm-casing', 'canopy-osm-minor']) {
      expect(declared.has(layerId), `${layerId} is a layer, not a source`).toBe(false);
      expect(written, `${layerId} must not be written to`).not.toContain(layerId);
    }
  });

  it('leaves no declared source unwritten', () => {
    // `canopy-route-travelled` and `canopy-avoid` are written elsewhere in the file
    // with `getSource(...)` rather than through this helper, so the assertion is on the
    // *sources this helper owns*: the three offline overlays.
    for (const id of ['canopy-osm', 'canopy-osm-water', 'canopy-osm-green']) {
      expect(written, `${id} should receive data`).toContain(id);
    }
  });
});

describe('the road overlay is wired to a source that exists in both styles', () => {
  const style = readFileSync(join(ROOT, 'src', 'map', 'style.ts'), 'utf8');

  it('every layer that draws roads reads canopy-osm', () => {
    // The other half of the original bug: the ids `set` is called with have to be the
    // ids the drawing layers read, or data lands in a source nothing draws.
    const roadLayers = [...style.matchAll(/id: '(canopy-osm-[a-z]+)',\s*type: 'line',\s*source: '([^']+)'/g)];
    expect(roadLayers.length, 'road layers found').toBeGreaterThanOrEqual(3);
    for (const [, layerId, sourceId] of roadLayers) {
      expect(declared.has(sourceId), `${layerId} reads ${sourceId}, which is not declared`).toBe(true);
    }
  });
});