/**
 * The basemap's actual source has to be sayable.
 *
 * If the tile host cannot be reached, `MapView` substitutes the offline style.
 * That is the right behaviour — the map keeps working — and it used to be
 * silent. Nothing on screen said the picture behind the route had changed source,
 * and the layers panel answered "Online map tiles" while showing something else.
 *
 * This is a *claim* about data rather than a rendering defect, which is why it is
 * worth a gate: nothing crashes, nothing looks wrong, and the only evidence is the
 * absence of a sentence that should have been there.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const mapView = readFileSync(join(ROOT, 'src', 'map', 'MapView.tsx'), 'utf8');
const app = readFileSync(join(ROOT, 'src', 'App.tsx'), 'utf8');

describe('a basemap substitution is reported, not silent', () => {
  it('MapView tells its caller which style it actually adopted', () => {
    expect(mapView).toMatch(/onBasemapChange/);
    // Reported on every boot, not only on failure: the caller cannot know the
    // source without being told, and a later switch back to tiles must be
    // reported too or the stale "offline" explanation would persist.
    expect(mapView).toMatch(/onBasemapRef\.current\?\.\(mode\)/);
  });

  it('reports the adopted mode rather than the requested one', () => {
    // `mode` is the variable the catch reassigns; `want` is what was asked for.
    // Reporting `want` would report "tiles" at exactly the moment it stopped
    // being true.
    expect(mapView).toMatch(/mode = 'offline';/);
    expect(mapView).not.toMatch(/onBasemapRef\.current\?\.\(want\)/);
  });

  it('reports only after the boot was not cancelled', () => {
    // An abandoned boot must not announce a source the map never adopted, or the
    // status line describes a map that is not on screen.
    const cancelAt = mapView.indexOf('if (cancelled) return;');
    const reportAt = mapView.indexOf('onBasemapRef.current?.(mode)');
    expect(cancelAt).toBeGreaterThan(-1);
    expect(reportAt).toBeGreaterThan(cancelAt);
  });

  it('App passes a callback that does not change identity per render', () => {
    // Otherwise the style re-boots on every render of the navigation screen,
    // which is the one thing the style effect exists to avoid.
    expect(app).toMatch(/const onBasemapChange = useCallback\(/);
    expect(app).toMatch(/onBasemapChange=\{onBasemapChange\}/);
  });

  it('the layers panel names the difference between asked-for and drawn', () => {
    // `online` is the request; `basemap` is the outcome. The panel used to answer
    // with the request alone.
    expect(app).toMatch(/basemap === 'offline' && online/);
    expect(app).toMatch(/could not be loaded/i);
    // And the honest offline case still says what it is drawing.
    expect(app).toMatch(/online \? 'Online map tiles' : 'Your offline \.osm map'/);
  });

  it('still degrades silently-free when the substitution is expected', () => {
    // A deliberate offline session is the normal path, not a failure, and must not
    // claim the tiles failed.
    expect(app).not.toMatch(/could not be loaded[\s\S]{0,120}!online/);
  });
});