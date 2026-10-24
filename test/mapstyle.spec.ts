/**
 * Offline map style tests.
 *
 * The offline style is the only cartography this app can draw without a
 * network, so its zoom behaviour is load-bearing rather than cosmetic: gap 5 was
 * "the map is sparse when zoomed out", and the cause was a width ramp whose
 * first stop was zoom 10 while a province fits the viewport at about zoom 6.
 * Nothing crashed -- the map simply drew every road at one pixel and looked
 * empty.
 *
 * These assert the shape of the ramp rather than its rendered output, because
 * the failure mode is structural: a missing floor stop, or a layer that lost its
 * zoom expression entirely.
 *
 * Run with `npx vitest run test/mapstyle.spec.ts`.
 */

import { describe, it, expect } from 'vitest';
import { offlineStyleSpec, overlays, roadClassColour } from '../src/map/style';

/**
 * The real style, built by the real function.
 *
 * An earlier draft of this file rebuilt the layer list locally and asserted
 * against that copy -- which would have passed even if the shipped style
 * drifted, which is the one thing a test here must not do. `offlineStyleSpec`
 * lives in `style.ts` precisely so this can reach it without pulling
 * `maplibre-gl` (and a DOM) into a unit test.
 */
const style = offlineStyleSpec([]) as unknown as {
  version: number;
  sources: Record<string, any>;
  layers: { id: string; type: string; source?: string; filter?: any; paint?: Record<string, any> }[];
};

const lineLayers = style.layers.filter((l) => l.type === 'line');
const layerById = (id: string) => style.layers.find((l) => l.id === id);

/** Pull the zoom stops out of an `['interpolate', ['linear'], ['zoom'], ...]` expression. */
function zoomStops(expr: any): number[] {
  if (!Array.isArray(expr) || expr[0] !== 'interpolate') return [];
  const out: number[] = [];
  // Values may themselves be expressions (a `match` per zoom), so only collect
  // the numeric entries that sit at even indices after the zoom input.
  const rest = expr.slice(3);
  for (let i = 0; i < rest.length; i += 2) {
    const z = rest[i];
    if (typeof z === 'number') out.push(z);
  }
  return out;
}

describe('offline line layers have a low-zoom floor', () => {
  for (const layer of lineLayers) {
    it(`${layer.id} scales with zoom`, () => {
      const stops = zoomStops(layer.paint?.['line-width']);
      expect(stops.length, `${layer.id} has no zoom ramp`).toBeGreaterThanOrEqual(2);
    });

    it(`${layer.id} starts below zoom 10`, () => {
      // This is the regression, stated as a test. A ramp whose first stop is 10
      // leaves a province (fitted at ~6) rendering at a single flat pixel.
      const stops = zoomStops(layer.paint?.['line-width']);
      expect(Math.min(...stops), `${layer.id} starts too far in`).toBeLessThan(10);
    });

    it(`${layer.id} grows as you zoom in`, () => {
      const stops = zoomStops(layer.paint?.['line-width']);
      for (let i = 1; i < stops.length; i++) {
        expect(stops[i]).toBeGreaterThan(stops[i - 1]);
      }
    });
  }
});

describe('arterials stay legible at province zoom', () => {
  const roads = layerById('canopy-osm-roads')!;

  it('has a width defined at zoom 6, where a province sits', () => {
    const stops = zoomStops(roads.paint?.['line-width']);
    expect(stops).toContain(6);
  });

  it('keeps motorways distinguishable from minor roads when zoomed out', () => {
    // A single flat width for every class is what made the map read as empty:
    // one pixel of motorway is indistinguishable from one pixel of service road.
    const expr: any = roads.paint?.['line-width'];
    expect(Array.isArray(expr)).toBe(true);
    // The low-zoom value must itself branch on class.
    const lowZoomValue = expr.slice(3).find((_: unknown, i: number) => i % 2 === 1);
    expect(Array.isArray(lowZoomValue)).toBe(true);
    expect(lowZoomValue[0]).toBe('match');
  });

  it('separates minor roads into their own layer', () => {
    // They cannot share a width expression with arterials, because the two need
    // opposite behaviour: minor roads recede, arterials persist.
    expect(lineLayers.some((l) => l.id === 'canopy-osm-minor')).toBe(true);
  });

  it('fades minor roads in rather than drawing them at full strength when far out', () => {
    const minor = layerById('canopy-osm-minor')!;
    const opacity = minor.paint?.['line-opacity'];
    expect(Array.isArray(opacity)).toBe(true);
    // ['interpolate', ['linear'], ['zoom'], stop, value, ...] -- the first value
    // is index 4, not 3, which is the zoom. Below the first stop MapLibre holds
    // that value, so it must be under 1 or minor roads compete with the
    // arterials drawn on top of them.
    expect(typeof opacity[3]).toBe('number');
    expect(typeof opacity[4]).toBe('number');
    expect(opacity[4]).toBeLessThan(1);
    expect(opacity[opacity.length - 1]).toBe(1);
  });
});

describe('layer ordering', () => {
  const order = ['canopy-osm-casing', 'canopy-osm-minor', 'canopy-osm-roads'];

  it('draws casing under minor roads under arterials', () => {
    // Casing below everything (so pale roads read against a pale background),
    // arterials last (so they are not buried by the minor network).
    const idx = order.map((id) => style.layers.findIndex((l) => l.id === id));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect(idx[0]).toBeLessThan(idx[1]!);
    expect(idx[1]!).toBeLessThan(idx[2]!);
  });

  it('has no duplicate layer ids', () => {
    // A duplicate id makes MapLibre reject the whole style, which presents as a
    // blank map rather than an error worth reading. This is a live hazard: the
    // road layer used to be declared in both `style.ts` and `MapView.tsx`.
    const ids = style.layers.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('declares every source it references', () => {
    for (const l of style.layers) {
      if (!l.source) continue;
      expect(style.sources[l.source], `${l.id} references missing source ${l.source}`).toBeDefined();
    }
  });

  it('background is first, so nothing is drawn under it', () => {
    expect(style.layers[0].id).toBe('bg');
  });
});

/*
 * Every expression a shipped style carries must be well-formed.
 *
 * This is the test the missing one should have been. The imported-road
 * `match` was written with four link classes sprayed against a single output —
 * `...LINK, colour` — which is an even argument count after the input where
 * MapLibre demands label/output *pairs* plus a fallback. MapLibre rejects the
 * style outright (`paint.line-color: Expected an even number of arguments`),
 * and a rejected style is *total*: no layers, no attribution, an empty map.
 *
 * Nothing caught it, because every test here inspected the object graph and
 * none of them asked whether the expressions inside it were legal. These walk
 * the real styles and check the shape of every `match`, which is where that
 * class of error lives.
 */
describe('style expressions are well-formed', () => {
  /** Depth-first over an expression tree, visiting every array node. */
  const walk = (node: unknown, visit: (expr: unknown[]) => void): void => {
    if (!Array.isArray(node)) return;
    visit(node);
    for (const child of node) walk(child, visit);
  };

  /** Every mis-paired `match` in a layer's expressions, for one readable failure. */
  const badMatches = (layers: { id: string; paint?: unknown; layout?: unknown; filter?: unknown }[]): string[] => {
    const bad: string[] = [];
    for (const l of layers) {
      walk([l.paint, l.layout, l.filter], (expr) => {
        if (expr[0] !== 'match') return;
        // ['match', input, (label, output) × N, fallback] — after the input the
        // count is 2N+1, so odd and at least 3.
        const args = expr.slice(2);
        if (args.length < 3 || args.length % 2 !== 1) {
          bad.push(`${l.id}: ${JSON.stringify(expr).slice(0, 160)}`);
        }
      });
    }
    return bad;
  };

  it('the offline style carries no mis-paired match', () => {
    expect(badMatches(style.layers)).toEqual([]);
  });

  it('the tile style\'s overlay layers carry none either', () => {
    expect(badMatches(overlays() as never)).toEqual([]);
  });

  it('the class-colour match pairs every road class with exactly one colour', () => {
    const expr = roadClassColour();
    expect(expr[0]).toBe('match');
    // match + input + pairs + fallback is an odd length by construction.
    expect(expr.length % 2).toBe(1);
    const args = expr.slice(2);
    const labels = args.slice(0, -1).filter((_, i) => i % 2 === 0);
    const outputs = args.slice(0, -1).filter((_, i) => i % 2 === 1);
    expect(labels.length).toBe(outputs.length);
    expect(new Set(labels).size).toBe(labels.length);
    for (const out of [...outputs, args[args.length - 1]]) {
      expect(typeof out).toBe('string');
    }
  });
});