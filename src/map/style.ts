/**
 * The map's cartography: a warm night style, and the navigation overlays.
 *
 * We start from OpenFreeMap's `liberty` vector style (free, no API key) and
 * remap its palette to ours, then declare the navigation overlays ourselves
 * (route casing + route line + traffic tint + markers).
 *
 * ## Why a night style
 *
 * This used to re-create Google Maps' *light* cartography — near-white land,
 * white roads, blue water — which put a bright basemap behind a dark UI and
 * under a driver's dark-adapted eyes at night. The chrome has since gone warm
 * dark (`src/theme.ts`), and the cartography follows: brown-shifted charcoal
 * land, roads a step or two lighter than the ground they cross, deep blue-grey
 * water, and warm amber/tan motorways so the road hierarchy still reads at a
 * glance. The layer *roles* are unchanged — this is Google's land/green/water/
 * road ramp structure with the values inverted and warmed, not a different
 * cartographic design.
 *
 * The basemap palette below is also what `offlineStyleSpec` draws from, so the
 * online and offline maps are the same map. They used to retype the palette as
 * separate literals and had drifted (different motorway fills, different road
 * casings) — the two modes were visibly different maps.
 *
 * The overlay colours come from `gmaps` in `theme.ts`, so the route colour the
 * contrast suite certifies is the route colour the map draws.
 */

import type { StyleSpecification } from 'maplibre-gl';
import { gmaps } from '../theme';

export const TILES = 'https://tiles.openfreemap.org/styles/liberty';

/** Warm night cartography palette. */
export const NIGHT = {
  land: '#1C1712',
  landAlt: '#221C15',
  water: '#1D2B3A',
  waterDeep: '#17222E',
  waterLabel: '#7FA8C9',
  green: '#202B1D',
  greenDeep: '#1A2418',
  building: '#292219',
  buildingOutline: '#332A1F',
  road: '#3B3227',
  roadCasing: '#2A231B',
  arterial: '#4A3E2E',
  arterialCasing: '#2E271E',
  highway: '#5E4E33',
  highwayCasing: '#7A6236',
  motorway: '#7A6132',
  motorwayCasing: '#A9822F',
  link: '#5A4A2E',
  label: '#A2937D',
  labelHalo: '#171208',
  labelMajor: '#EDE2CC',
} as const;

/**
 * A MapLibre layer definition, as the loose JSON the style API actually is.
 *
 * The library's own `LayerSpecification` types every paint property per layer
 * type, which is the right thing for a hand-written style and the wrong thing
 * here: these layers are built as data and shipped through `as` casts to
 * `StyleSpecification`, and fighting the type system with `any` at every
 * signature was eighteen lint warnings and not one useful guarantee. This is
 * the one honest shape — an id, a type, and opaque payload — and everything
 * that consumes it does so as data.
 */
export interface LayerDef {
  id: string;
  type: string;
  source?: string;
  filter?: unknown;
  layout?: Record<string, unknown>;
  paint?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Remap a Liberty style's paint properties onto the night palette. */
function remapPaint(layer: LayerDef): void {
  const p = layer.paint ?? {};
  const fill: string = String(layer['source-layer'] ?? '');

  switch (layer.type) {
    case 'background':
      p['background-color'] = NIGHT.land;
      break;

    case 'fill':
      if (/water|ocean|river|stream/.test(fill)) p['fill-color'] = NIGHT.water;
      else if (/park|forest|wood|grass|cemetery|golf|scrub|pitch|garden|nature/.test(fill))
        p['fill-color'] = /forest|wood/.test(fill) ? NIGHT.greenDeep : NIGHT.green;
      else if (/building/.test(fill)) {
        p['fill-color'] = NIGHT.building;
        p['fill-outline-color'] = NIGHT.buildingOutline;
      } else if (/land|earth|ground|beach|sand/.test(fill)) p['fill-color'] = NIGHT.landAlt;
      else if (/residential|industrial|commercial|retail|suburb|quarter|neighbourhood/.test(fill))
        p['fill-color'] = NIGHT.landAlt;
      break;

    case 'line': {
      const isWater = /water|river|stream|canal/.test(fill);
      if (isWater) {
        p['line-color'] = NIGHT.water;
        break;
      }
      // Motorway / trunk keep a warm tan fill with an amber casing, so the road
      // hierarchy still reads at night without the glare of a light style.
      if (/motorway|trunk/.test(fill)) {
        p['line-color'] = NIGHT.motorway;
        p['line-opacity'] = 1;
        // The Liberty style still uses the legacy `{stops: […]}` form of a
        // property function, so this scales its widths by the same 1.15 the
        // lighter style needed. Typed rather than cast three times: it is one
        // shape and `stops` is its only field.
        const lw = p['line-width'] as { stops?: [number, number][] } | undefined;
        if (lw && typeof lw === 'object' && Array.isArray(lw.stops)) {
          lw.stops = lw.stops.map(([k, v]) => [k, Math.max(0.4, v * 1.15)]);
        }
        break;
      }
      if (/primary|secondary|trunk_link/.test(fill)) {
        p['line-color'] = NIGHT.highway;
        p['line-opacity'] = 1;
        break;
      }
      // Everything else: a step lighter than the ground, with the casing layers
      // doing the separation.
      if (/road|street|path|bridge|tunnel|service|railway|ferry/.test(fill)) {
        p['line-color'] = NIGHT.road;
        p['line-opacity'] = 1;
        break;
      }
      p['line-color'] = NIGHT.roadCasing;
      break;
    }

    case 'symbol': {
      const isRoadLabel = /road|street|place/.test(fill) || /place/.test(layer.id);
      const isWater = /water|ocean|river/.test(fill);
      if (isWater) p['text-color'] = NIGHT.waterLabel;
      else if (isRoadLabel) p['text-color'] = NIGHT.labelMajor;
      else p['text-color'] = NIGHT.label;
      p['text-halo-color'] = NIGHT.labelHalo;
      p['text-halo-width'] = 1.2;
      break;
    }
  }

  // Casing layers sit directly under their fill layer with the same id prefix.
  if (/casing/i.test(layer.id)) {
    const isWater = /water|river/.test(fill);
    p['line-color'] = isWater ? NIGHT.waterDeep : NIGHT.roadCasing;
    p['line-opacity'] = 0.9;
  }
}

/**
 * Order-comparison operators that compare a bare `["get", …]` against a number.
 *
 * `<`, `<=`, `>` and `>=` are the only operators MapLibre's expression parser
 * wraps in a runtime type assertion when one side is untyped, which is what
 * turns a missing property into a thrown error rather than a `false`.
 */
const ORDER_OPS = new Set(['<', '<=', '>', '>=']);

/**
 * Guard order comparisons against absent properties.
 *
 * The upstream style's three US route-shield layers filter on
 * `["<=", ["get", "ref_length"], 6]`. `["get", …]` is statically untyped, so
 * MapLibre wraps the comparison in an assertion that the value is a number. A
 * named road with no route ref has no `ref_length`, the assertion throws, and
 * `StyleExpression.evaluate` catches it and logs
 * "Expected value to be of type number, but found null instead." — once per
 * layer, on the first tile containing such a road. The filter result is correct
 * either way (`false`); only the log is noise, but it looks like a fault in this
 * app on every cold start.
 *
 * `["all", …]` short-circuits, so testing `has` first means the comparison is
 * never evaluated for a feature that lacks the property.
 */
function guardOrderComparisons(node: unknown): unknown {
  if (!Array.isArray(node)) return node;

  // Already guarded by an earlier pass? Return it untouched, so the transform is
  // idempotent. `buildStyle` always re-fetches the style so this cannot arise
  // today, but a remap that wraps twice is a trap for the next caller.
  if (
    node[0] === 'all' &&
    Array.isArray(node[1]) && node[1][0] === 'has' && typeof node[1][1] === 'string' &&
    Array.isArray(node[2]) && ORDER_OPS.has(node[2][0]) &&
    Array.isArray(node[2][1]) && node[2][1][0] === 'get' && node[2][1][1] === node[1][1]
  ) {
    return node;
  }

  if (
    ORDER_OPS.has(node[0]) &&
    Array.isArray(node[1]) &&
    node[1][0] === 'get' &&
    typeof node[1][1] === 'string'
  ) {
    return ['all', ['has', node[1][1]], node];
  }
  return node.map(guardOrderComparisons);
}

export async function buildStyle(): Promise<StyleSpecification> {
  const res = await fetch(TILES);
  if (!res.ok) throw new Error(`Tile style unavailable (HTTP ${res.status})`);
  const style = (await res.json()) as StyleSpecification;

  const layers = style.layers as LayerDef[];
  for (const layer of layers) {
    layer.paint = layer.paint ?? {};
    remapPaint(layer);
    // Google Maps labels sit above the road network but below POI icons.
    if (layer.type === 'symbol') layer.layout = { ...(layer.layout ?? {}), 'symbol-z-order': 'source' };
    if (layer.filter) layer.filter = guardOrderComparisons(layer.filter);
  }

  // The tile style has no offline overlay sources; add them (empty) so the
  // overlay layers always resolve, whichever style is active.
  for (const [id, src] of Object.entries(overlaySources())) {
    if (!style.sources) style.sources = {};
    if (!style.sources[id]) style.sources[id] = src as StyleSpecification['sources'][string];
  }

  // The loose `LayerDef` is the same data `StyleSpecification` holds — that is
  // what the interface above is for — and the boundary where it is accepted is
  // written down as exactly one cast rather than one per layer.
  style.layers = [...layers, ...overlays()] as unknown as StyleSpecification['layers'];

  style.glyphs = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
  return style;
}

/**
 * Google's route line width, shared by the route, the portion already
 * driven and the traffic tint. All three are the same physical stripe: the tint
 * recolours it rather than sitting beside it.
 */
export const ROUTE_LINE_WIDTH = ['interpolate', ['linear'], ['zoom'], 4, 3.5, 10, 6.5, 14, 14, 18, 24];

/** The casing is the same stripe, stepped wider so it reads as an edge. */
export const ROUTE_CASING_WIDTH = ['interpolate', ['linear'], ['zoom'], 4, 5, 10, 10, 14, 20, 18, 30];

/** GeoJSON source holding the traffic tint, one feature per stretch of road. */
export const TRAFFIC_SOURCE = 'canopy-route-traffic';

/**
 * The traffic tint, as separate layers over one GeoJSON source.
 *
 * Only `slow` and `dense` stretches get a layer. A stretch the provider reported
 * no congestion for is left as the normal route stripe, because a green line
 * would claim "clear road" that we were never told about.
 *
 * These are drawn *after* `canopy-route`: a tint underneath a route of at least
 * the same width is not a tint, it is a hidden layer.
 */
export function trafficLayers(): LayerDef[] {
  return [
    {
      id: 'canopy-route-traffic',
      type: 'line',
      source: TRAFFIC_SOURCE,
      filter: ['==', ['get', 'level'], 'dense'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-width': ROUTE_LINE_WIDTH, 'line-color': gmaps.routeTrafficSlow },
    },
    {
      id: 'canopy-route-traffic-slow',
      type: 'line',
      source: TRAFFIC_SOURCE,
      filter: ['==', ['get', 'level'], 'slow'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-width': ROUTE_LINE_WIDTH, 'line-color': gmaps.routeTraffic },
    },
  ];
}

/**
 * The navigation overlays, in draw order: avoid boxes, the route and its
 * casing, the traffic tint, the driven portion, then the markers.
 *
 * The route is a thick emerald stripe over a darker casing; traffic tints the
 * stripe amber/red rather than replacing it.
 *
 * Shared by both basemaps. There used to be two copies of this list — one here
 * for the tile style, one in `map/MapView.tsx` for the offline style — and they
 * had drifted: different casing ramps and a destination shadow called
 * `canopy-dest-shadow` in one and `canopy-destination-shadow` in the other.
 * Duplicated paint is duplicated bugs, so the offline style now asks for the
 * same list.
 */
export function navOverlays(): LayerDef[] {
  return [
    {
      id: 'canopy-avoid-fill',
      type: 'fill',
      source: 'canopy-avoid',
      filter: ['==', '$type', 'Polygon'],
      paint: { 'fill-color': gmaps.routeTravelled, 'fill-opacity': 0.45 },
    },
    {
      id: 'canopy-avoid-line',
      type: 'line',
      source: 'canopy-avoid',
      filter: ['==', '$type', 'LineString'],
      paint: { 'line-color': gmaps.routeTravelled, 'line-width': 3, 'line-dasharray': [2, 2] },
    },

    // --- route casing ---
    {
      id: 'canopy-route-casing',
      type: 'line',
      source: 'canopy-route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': gmaps.routeCasing, 'line-width': ROUTE_CASING_WIDTH, 'line-opacity': 0.9 },
    },
    // --- the route itself ---
    {
      id: 'canopy-route',
      type: 'line',
      source: 'canopy-route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': gmaps.route, 'line-width': ROUTE_LINE_WIDTH },
    },
    // --- traffic tint, above the route so it can actually be seen ---
    ...trafficLayers(),
    // --- travelled portion (dimmed, greys out the part already driven) ---
    // Drawn last of the three, and deliberately: all three are the same stripe
    // in the same place, so a grey line *under* a route line of equal width is
    // not a dimmed route, it is an invisible one.
    {
      id: 'canopy-route-travelled',
      type: 'line',
      source: 'canopy-route-travelled',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': gmaps.routeTravelled, 'line-width': ROUTE_LINE_WIDTH, 'line-opacity': 0.75 },
    },

    // --- maneuver markers along the route ---
    {
      id: 'canopy-maneuver-markers',
      type: 'circle',
      source: 'canopy-maneuvers',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 4, 14, 7, 18, 10],
        'circle-color': NIGHT.land,
        'circle-stroke-color': gmaps.maneuverRing,
        'circle-stroke-width': 2.5,
      },
    },

    // --- origin puck ---
    {
      id: 'canopy-origin-halo',
      type: 'circle',
      source: 'canopy-origin',
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 9, 14, 16, 18, 24], 'circle-color': gmaps.originDot, 'circle-opacity': 0.18 },
    },
    {
      id: 'canopy-origin',
      type: 'circle',
      source: 'canopy-origin',
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 4.5, 14, 7.5, 18, 11], 'circle-color': NIGHT.labelMajor, 'circle-stroke-width': 3, 'circle-stroke-color': gmaps.originDot },
    },

    // --- destination pin ---
    {
      id: 'canopy-dest-shadow',
      type: 'circle',
      source: 'canopy-destination',
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 6, 14, 10, 18, 14], 'circle-color': '#000000', 'circle-opacity': 0.32, 'circle-translate': [0, 2] },
    },
    {
      id: 'canopy-destination',
      type: 'circle',
      source: 'canopy-destination',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 5, 14, 8.5, 18, 12],
        'circle-color': gmaps.destinationPin,
        'circle-stroke-color': '#FFFFFF',
        'circle-stroke-width': 2.5,
      },
    },
    {
      id: 'canopy-destination-inner',
      type: 'circle',
      source: 'canopy-destination',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 1.8, 14, 3.2, 18, 4.6],
        'circle-color': '#FFFFFF',
      },
    },

    // --- live location puck ---
    {
      id: 'canopy-location-accuracy',
      type: 'circle',
      source: 'canopy-location',
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 12, 14, 40, 18, 90], 'circle-color': gmaps.accuracyCircle, 'circle-opacity': 0.14 },
    },
    {
      id: 'canopy-location',
      type: 'circle',
      source: 'canopy-location',
      paint: { 'circle-radius': 7, 'circle-color': gmaps.originDot, 'circle-stroke-width': 3, 'circle-stroke-color': NIGHT.land },
    },

    // --- driver reports (hazards, closures, …) ---
    // Amber, the chrome accent, because a report is a "something ahead" mark
    // rather than a traffic state: the traffic ramp owns red/orange/green on the
    // route stripe, and reusing it here would make a user report indistinguishable
    // from provider data — which this app never does.
    {
      id: 'canopy-report-marks',
      type: 'circle',
      source: 'canopy-reports',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 5, 14, 9, 18, 13],
        'circle-color': gmaps.originDot,
        'circle-stroke-color': NIGHT.land,
        'circle-stroke-width': 2,
      },
    },
  ];
}

/**
 * The imported-`.osm` road overlay, for the *tile* style only.
 *
 * On the tile basemap the imported extract is drawn as a class-coloured road
 * network over the tiles. The offline style draws its own `canopy-osm-*`
 * layers with a zoom ramp tuned for province scale, and a second
 * `canopy-osm-roads` there would be a duplicate layer id — which MapLibre
 * rejects outright. That split is why this is a separate function rather than
 * one more entry in `navOverlays()`.
 */
export function tileOsmOverlay(): LayerDef[] {
  return [
    {
      id: 'canopy-osm-roads',
      type: 'line',
      source: 'canopy-osm',
      filter: ['==', ['geometry-type'], 'LineString'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': roadClassColour(),
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 14, 3, 18, 8],
      },
    },
  ];
}

/**
 * Every overlay layer the tile style draws: the shared navigation set plus the
 * imported-extract roads.
 */
export function overlays(): LayerDef[] {
  return [...navOverlays(), ...tileOsmOverlay()];
}

/**
 * Zoom-dependent width for the offline road layers.
 *
 * The offline map's problem was never missing geometry -- `roadsToGeoJSON`
 * already mirrors every road in the dataset -- it was that the width ramp
 * started at zoom 10, so a province fitted to the viewport (zoom ~6) drew as a
 * one-pixel hairline and read as empty. Two rungs matter more than the rest:
 *
 *   - a floor at the low end, so the network is legible when zoomed out;
 *   - arterials held near their high width down to zoom ~7, because at province
 *     scale a motorway is the only thing that should still be readable.
 *
 * Keeping arterials and minor roads as separate layers (rather than one `match`
 * on class) is what allows that: a single `line-width` cannot make one class
 * thick at zoom 6 and another almost invisible.
 */
export function widthAt(stops: readonly (number | readonly number[])[]): unknown {
  return ['interpolate', ['linear'], ['zoom'], ...stops.flat()];
}

/** Highways that must stay legible at province zoom. */
const ARTERIAL = ['motorway', 'trunk', 'primary', 'secondary'];

/**
 * Class → colour for the imported road network.
 *
 * This used to be written as one `match` expression with `...LINK` spread into
 * it — four labels sprayed against a *single* output — which is not a `match`
 * at all: after the input, MapLibre wants label/output *pairs* plus a fallback,
 * and the hand-written form had an even argument count where an odd one was
 * required. MapLibre rejected the whole style with
 * `layers[N].paint.line-color: Expected an even number of arguments`, and the
 * rejection is total — no layers, no attribution, an empty map — while the unit
 * tests, which inspect the object rather than load it, saw nothing wrong.
 *
 * The colours now come from this table and the expression is built by pairing
 * them mechanically, so the shape cannot drift again: every key is a label, the
 * value beside it is its output, and the fallback is added last.
 */
const ROAD_CLASS_COLOUR: Record<string, string> = {
  motorway: NIGHT.motorway,
  trunk: NIGHT.motorway,
  motorway_link: NIGHT.link,
  trunk_link: NIGHT.link,
  primary_link: NIGHT.link,
  secondary_link: NIGHT.link,
  primary: NIGHT.highway,
  secondary: NIGHT.arterial,
};

/** `['match', ['get', 'class'], label, colour, …, fallback]`, well-formed by construction. */
export function roadClassColour(): unknown[] {
  return [
    'match', ['get', 'class'],
    ...Object.entries(ROAD_CLASS_COLOUR).flatMap(([klass, colour]) => [klass, colour]),
    NIGHT.road,
  ];
}

/** MapLibre filter matching only arterial classes. */
export function arterialFilter(): unknown[] {
  // Label/output pairs, mechanically — the same mistake as `roadClassColour`'s
  // predecessor lived here: `['match', input, ...four labels, true, false]` is
  // six arguments after the input where `match` wants 2N+1, so MapLibre
  // rejected the whole offline style and the tests, which only looked at the
  // array's shape from the outside, saw a plausible-looking filter.
  return ['match', ['get', 'class'], ...ARTERIAL.flatMap((klass) => [klass, true]), false];
}

/**
 * The offline style: the night palette over our own parsed `.osm` geometry.
 *
 * Takes the navigation overlay layers as an argument rather than importing them,
 * because those live with the map component that owns them, and importing the
 * component here would drag `maplibre-gl` into a pure module.
 */
export function offlineStyleSpec(overlayLayerDefs: LayerDef[]): StyleSpecification {
  return {
    version: 8,
    glyphs: undefined,
    sources: overlaySources(),
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': NIGHT.land } },
      {
        id: 'canopy-osm-green', type: 'fill', source: 'canopy-osm-green',
        paint: {
          'fill-color': ['match', ['get', 'class'], 'forest', NIGHT.greenDeep, 'wood', NIGHT.greenDeep, NIGHT.green],
          'fill-opacity': 0.9,
        },
      },
      {
        id: 'canopy-osm-water', type: 'line', source: 'canopy-osm-water',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        // Floored for the same reason as the roads: a river that vanishes below
        // zoom 9 makes a province look like it has no geography.
        paint: {
          'line-color': NIGHT.water,
          'line-width': widthAt([4, 0.8, 8, 1.4, 14, 4, 18, 12]),
        },
      },
      // Casing under everything, so a road still reads against the ground it
      // crosses. Drawn first for that reason.
      {
        id: 'canopy-osm-casing', type: 'line', source: 'canopy-osm',
        filter: ['==', ['geometry-type'], 'LineString'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': NIGHT.roadCasing,
          'line-width': widthAt([4, 1.4, 8, 2.2, 14, 5, 18, 12]),
        },
      },
      // Minor roads: present when zoomed out, fading back as the arterial
      // network takes over. Above zoom 13 they are the point, not the noise.
      {
        id: 'canopy-osm-minor', type: 'line', source: 'canopy-osm',
        filter: ['all', ['==', ['geometry-type'], 'LineString'], ['!', arterialFilter()]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': NIGHT.road,
          'line-width': widthAt([5, 0.5, 9, 1, 13, 2.4, 16, 5, 18, 8]),
          // Slightly translucent when far out: the point is to show that a
          // network exists, not to compete with the arterials drawn on top.
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.55, 11, 0.85, 14, 1],
        },
      },
      // Arterials, drawn last so they sit above the minor network.
      {
        id: 'canopy-osm-roads', type: 'line', source: 'canopy-osm',
        filter: ['==', ['geometry-type'], 'LineString'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': roadClassColour(),
          // Held wide down to zoom 6, which is where a province sits.
          'line-width': [
            'interpolate', ['linear'], ['zoom'],
            6, ['match', ['get', 'class'], 'motorway', 2.2, 'trunk', 2.0, 1.5],
            10, ['match', ['get', 'class'], 'motorway', 2.6, 'trunk', 2.4, 1.9],
            14, ['match', ['get', 'class'], 'motorway', 4, 'trunk', 3.6, 2.6],
            18, 9,
          ],
        },
      },
      ...overlayLayerDefs,
    ],
  } as StyleSpecification;
}

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/**
 * Required credit for the data these layers draw.
 *
 * Every geometry here is derived from OpenStreetMap -- the road graph, the
 * gazetteer, and the simplified render lines -- whether it arrived over the
 * network as tiles or as a local `.osm` import. The ODbL requires that credit be
 * *displayed*, in both cases, so it is attached to the sources here and
 * rendered by MapLibre's attribution control rather than hidden in a comment.
 *
 * `buildStyle` also merges these sources into the online tile style, which is
 * what makes the credit appear next to the tile provider's own rather than only
 * when the offline style is active.
 */
export const OSM_ATTRIBUTION =
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>';

/** Empty GeoJSON sources for every layer the overlays reference. */
export function overlaySources(): Record<string, unknown> {
  return {
    'canopy-route': { type: 'geojson', data: EMPTY, attribution: OSM_ATTRIBUTION },
    'canopy-route-travelled': { type: 'geojson', data: EMPTY, attribution: OSM_ATTRIBUTION },
    // The tint is its own source so a stretch of road can carry a `level`
    // without every other feature having to pretend to be a road.
    [TRAFFIC_SOURCE]: { type: 'geojson', data: EMPTY, attribution: OSM_ATTRIBUTION },
    'canopy-maneuvers': { type: 'geojson', data: EMPTY, attribution: OSM_ATTRIBUTION },
    // The driver's own reports. No attribution: this is not map data, it is
    // what the person in the car just told us.
    'canopy-reports': { type: 'geojson', data: EMPTY },
    'canopy-origin': { type: 'geojson', data: EMPTY, attribution: OSM_ATTRIBUTION },
    'canopy-destination': { type: 'geojson', data: EMPTY, attribution: OSM_ATTRIBUTION },
    'canopy-location': { type: 'geojson', data: EMPTY },
    'canopy-avoid': { type: 'geojson', data: EMPTY },
    'canopy-osm': { type: 'geojson', data: EMPTY, attribution: OSM_ATTRIBUTION },
    'canopy-osm-water': { type: 'geojson', data: EMPTY, attribution: OSM_ATTRIBUTION },
    'canopy-osm-green': { type: 'geojson', data: EMPTY, attribution: OSM_ATTRIBUTION },
  };
}
