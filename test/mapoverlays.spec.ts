/**
 * `applyOverlays`'s change detection — the smoothness guarantee.
 *
 * The map re-fills its sources on every GPS fix (1 Hz, even at a standstill),
 * every zoom end and every style boot. Before the skip, each of those rebuilt
 * every FeatureCollection and handed it to `setData`, which serialises the
 * geometry into the render worker — for a provincial route, megabytes per
 * second, while the driver is dragging the map. The stutter was that.
 *
 * So the contract asserted here is narrow and important: **identical data is
 * never re-sent**, fresh-but-equal arrays included (the "already driven" line
 * is rebuilt from the same vertices every fix while a car waits at a light),
 * while anything that really changed goes to its own source and nothing else.
 * A style swap must re-fill the new sources even when the data is unchanged —
 * "nothing changed" must never leave a fresh style blank.
 *
 * Run with `npx vitest run test/mapoverlays.spec.ts`.
 */

import { describe, it, expect } from 'vitest';
import { applyOverlays, type OverlayInputs } from '../src/map/overlays';
import type { Map as MLMap } from 'maplibre-gl';
import type { LatLng } from '../src/geo';

const OVERLAY_IDS = [
  'canopy-route',
  'canopy-route-travelled',
  'canopy-route-traffic',
  'canopy-maneuvers',
  'canopy-reports',
  'canopy-origin',
  'canopy-destination',
  'canopy-location',
];

/** A stub map: sources that count `setData` calls, and nothing else. */
function stubMap() {
  const calls = new Map<string, number>();
  const sources = new Map<string, { setData: (d: unknown) => void }>();
  const install = () => {
    calls.clear();
    sources.clear();
    for (const id of OVERLAY_IDS) {
      calls.set(id, 0);
      sources.set(id, { setData: () => calls.set(id, (calls.get(id) ?? 0) + 1) });
    }
  };
  install();
  const map = {
    getSource: (id: string) => sources.get(id),
    getZoom: () => 14,
  } as unknown as MLMap;
  return {
    map,
    calls,
    /** Replace every source with a fresh one — what `setStyle` does. */
    swap: install,
  };
}

function props(over: Partial<OverlayInputs> = {}): OverlayInputs {
  return {
    dataset: null,
    route: null,
    travelled: null,
    origin: null,
    destination: null,
    location: null,
    maneuverPoints: [],
    ...over,
  };
}

/** 60° north, one degree wide in longitude — a realistic driving scale. */
const A: LatLng = [12.5, 60.0];
const B: LatLng = [12.5005, 60.0004];
const C: LatLng = [12.5012, 60.0009];
const route = [A, B, C];

describe('applyOverlays skips unchanged data', () => {
  it('fills every source once on first sight', () => {
    const { map, calls } = stubMap();
    applyOverlays(map, props({ route, location: A, destination: C, origin: A }));
    for (const id of OVERLAY_IDS) expect(calls.get(id), id).toBe(1);
  });

  it('does not touch a source that already holds the same data', () => {
    const { map, calls } = stubMap();
    applyOverlays(map, props({ route, travelled: [A, B], location: A }));
    // Fresh arrays holding the same tuples: what a stationary car produces
    // every fix, since `travelled` is re-sliced from the route geometry.
    applyOverlays(map, props({ route: route.slice(), travelled: [A, B].slice(), location: A }));
    for (const id of OVERLAY_IDS) expect(calls.get(id), id).toBe(1);
  });

  it('treats freshly-allocated but equal coordinates as unchanged', () => {
    const { map, calls } = stubMap();
    applyOverlays(map, props({ origin: [12.5, 60.0], destination: [12.5012, 60.0009] }));
    applyOverlays(map, props({ origin: [12.5, 60.0], destination: [12.5012, 60.0009] }));
    expect(calls.get('canopy-origin')).toBe(1);
    expect(calls.get('canopy-destination')).toBe(1);
  });

  it('treats freshly-allocated but equal traffic spans as unchanged', () => {
    const { map, calls } = stubMap();
    applyOverlays(map, props({ route, traffic: [{ level: 'slow', path: [A, B] }] }));
    applyOverlays(map, props({ route, traffic: [{ level: 'slow', path: [A, B] }] }));
    expect(calls.get('canopy-route-traffic')).toBe(1);
    // A different level is a different claim and must be re-sent.
    applyOverlays(map, props({ route, traffic: [{ level: 'dense', path: [A, B] }] }));
    expect(calls.get('canopy-route-traffic')).toBe(2);
  });

  it('a new GPS fix updates the puck and only the puck', () => {
    const { map, calls } = stubMap();
    applyOverlays(map, props({ route, location: A }));
    applyOverlays(map, props({ route, location: B }));
    expect(calls.get('canopy-location')).toBe(2);
    expect(calls.get('canopy-route')).toBe(1);
    // The absent destination is sent once on the first fill and then not
    // re-sent: "no destination" is data, and unchanged data is not re-sent.
    expect(calls.get('canopy-destination')).toBe(1);
  });

  it('a reroute re-sends the route without disturbing anything else', () => {
    const { map, calls } = stubMap();
    applyOverlays(map, props({ route, travelled: [A], location: A, destination: C }));
    applyOverlays(map, props({ route: [A, C], travelled: [A], location: A, destination: C }));
    expect(calls.get('canopy-route')).toBe(2);
    expect(calls.get('canopy-route-travelled')).toBe(1);
    expect(calls.get('canopy-destination')).toBe(1);
    expect(calls.get('canopy-location')).toBe(1);
  });

  it('a growing travelled line updates the travelled source', () => {
    const { map, calls } = stubMap();
    applyOverlays(map, props({ route, travelled: [A] }));
    applyOverlays(map, props({ route, travelled: [A, B] }));
    expect(calls.get('canopy-route-travelled')).toBe(2);
    expect(calls.get('canopy-route')).toBe(1);
  });

  it('re-fills the new sources after a style swap, even with identical data', () => {
    const { map, calls, swap } = stubMap();
    applyOverlays(map, props({ route, location: A, destination: C }));
    swap();
    applyOverlays(map, props({ route, location: A, destination: C }));
    for (const id of OVERLAY_IDS) expect(calls.get(id), id).toBe(1);
  });

  it('is a no-op before the style has loaded', () => {
    // No sources yet: `getSource` answers undefined and the fill must not
    // throw or attempt any writes.
    const bare = {
      getSource: () => undefined,
      getZoom: () => 14,
    } as unknown as MLMap;
    expect(() => applyOverlays(bare, props({ route }))).not.toThrow();
  });
});
