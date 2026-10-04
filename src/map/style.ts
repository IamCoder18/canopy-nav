/**
 * A MapLibre style that reproduces Google Maps' light cartography as closely as
 * an open-data source allows.
 *
 * We start from OpenFreeMap's `liberty` vector style (free, no API key) and
 * remap the palette to Google's, then declare the navigation overlays ourselves
 * (route casing + route line + traffic tint + markers).
 *
 * Google's style is proprietary; this is an independent re-creation of its
 * visual conventions (land/green/water/road ramps), not a copy of their tiles.
 */

import type { StyleSpecification } from 'maplibre-gl';

export const TILES = 'https://tiles.openfreemap.org/styles/liberty';

/** Google Maps light-mode cartography palette. */
const G = {
  land: '#F8F7F5',
  landAlt: '#F1EFEA',
  water: '#AADAFF',
  waterDeep: '#8FC8F5',
  green: '#C5E8C0',
  greenDeep: '#A8D5A0',
  grass: '#CFEDC9',
  building: '#EFEDE8',
  buildingOutline: '#E2DFD8',
  road: '#FFFFFF',
  roadCasing: '#E3E0D8',
  arterial: '#FFFFFF',
  arterialCasing: '#DCD8CE',
  highway: '#FFE8A8',
  highwayCasing: '#F0C970',
  motorway: '#FFDFA6',
  motorwayCasing: '#E8A33D',
  label: '#5F6368',
  labelHalo: '#FFFFFF',
  labelMajor: '#3C4043',
} as const;

/** Remap a Liberty style's paint properties onto Google's palette. */
function remapPaint(layer: any): void {
  const p = layer.paint ?? {};
  const fill: string = layer['source-layer'] ?? '';

  switch (layer.type) {
    case 'background':
      p['background-color'] = G.land;
      break;

    case 'fill':
      if (/water|ocean|river|stream/.test(fill)) p['fill-color'] = G.water;
      else if (/park|forest|wood|grass|cemetery|golf|scrub|pitch|garden|nature/.test(fill))
        p['fill-color'] = /forest|wood/.test(fill) ? G.greenDeep : G.green;
      else if (/building/.test(fill)) {
        p['fill-color'] = G.building;
        p['fill-outline-color'] = G.buildingOutline;
      } else if (/land|earth|ground|beach|sand/.test(fill)) p['fill-color'] = G.landAlt;
      else if (/residential|industrial|commercial|retail|suburb|quarter|neighbourhood/.test(fill))
        p['fill-color'] = G.landAlt;
      break;

    case 'line': {
      const isWater = /water|river|stream|canal/.test(fill);
      if (isWater) {
        p['line-color'] = G.water;
        break;
      }
      // Motorway / trunk keep Google's warm fill with an orange casing.
      if (/motorway|trunk/.test(fill)) {
        p['line-color'] = G.motorway;
        p['line-opacity'] = 1;
        if (p['line-width'] && typeof p['line-width'] === 'object' && (p['line-width'] as any)['stops'])
          (p['line-width'] as any).stops = ((p['line-width'] as any).stops as [number, number][]).map(([k, v]) => [
            k,
            Math.max(0.4, v * 1.15),
          ]);
        break;
      }
      if (/primary|secondary|trunk_link/.test(fill)) {
        p['line-color'] = G.highway;
        p['line-opacity'] = 1;
        break;
      }
      // Everything else: white fill, light grey casing (done by the casing layers).
      if (/road|street|path|bridge|tunnel|service|railway|ferry/.test(fill)) {
        p['line-color'] = G.road;
        p['line-opacity'] = 1;
        break;
      }
      p['line-color'] = G.roadCasing;
      break;
    }

    case 'symbol': {
      const isRoadLabel = /road|street|place/.test(fill) || /place/.test(layer.id);
      const isWater = /water|ocean|river/.test(fill);
      if (isWater) p['text-color'] = '#4A90C4';
      else if (isRoadLabel) p['text-color'] = G.labelMajor;
      else p['text-color'] = G.label;
      p['text-halo-color'] = G.labelHalo;
      p['text-halo-width'] = 1.2;
      break;
    }
  }

  // Casing layers sit directly under their fill layer with the same id prefix.
  if (/casing/i.test(layer.id)) {
    const isWater = /water|river/.test(fill);
    p['line-color'] = isWater ? G.waterDeep : G.roadCasing;
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
function guardOrderComparisons(node: any): any {
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

  const layers = style.layers as any[];
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
    if (!style.sources[id]) style.sources[id] = src;
  }

  style.layers = [...layers, ...overlays()];

  style.glyphs = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
  return style;
}

/**
 * Google Maps' route line width, shared by the route, the portion already
 * driven and the traffic tint. All three are the same physical stripe: the tint
 * recolours it rather than sitting beside it.
 */
export const ROUTE_LINE_WIDTH = ['interpolate', ['linear'], ['zoom'], 4, 3.5, 10, 6.5, 14, 14, 18, 24];

/** GeoJSON source holding the traffic tint, one feature per stretch of road. */
export const TRAFFIC_SOURCE = 'canopy-route-traffic';

/**
 * The traffic tint, as separate layers over one GeoJSON source.
 *
 * Only `slow` and `dense` stretches get a layer. A stretch the provider reported
 * no congestion for is left as the normal blue route, because a green line
 * would claim "clear road" that we were never told about.
 *
 * These are drawn *after* `canopy-route`: a tint underneath a route of at least
 * the same width is not a tint, it is a hidden layer.
 */
export function trafficLayers(): any[] {
  return [
    {
      id: 'canopy-route-traffic',
      type: 'line',
      source: TRAFFIC_SOURCE,
      filter: ['==', ['get', 'level'], 'dense'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-width': ROUTE_LINE_WIDTH, 'line-color': '#E5484D' },
    },
    {
      id: 'canopy-route-traffic-slow',
      type: 'line',
      source: TRAFFIC_SOURCE,
      filter: ['==', ['get', 'level'], 'slow'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-width': ROUTE_LINE_WIDTH, 'line-color': '#E8A33D' },
    },
  ];
}

/**
 * Navigation overlays, in draw order.
 * Google draws the route as a thick blue line with a darker blue casing and
 * slightly rounded joins; traffic tints the line amber/red rather than replacing it.
 */
export function overlays(): any[] {
  return [
    {
      id: 'canopy-avoid-fill',
      type: 'fill',
      source: 'canopy-avoid',
      filter: ['==', '$type', 'Polygon'],
      paint: { 'fill-color': '#5F6368', 'fill-opacity': 0.55 },
    },
    {
      id: 'canopy-avoid-line',
      type: 'line',
      source: 'canopy-avoid',
      filter: ['==', '$type', 'LineString'],
      paint: { 'line-color': '#80868B', 'line-width': 3, 'line-dasharray': [2, 2] },
    },

    // --- route casing ---
    {
      id: 'canopy-route-casing',
      type: 'line',
      source: 'canopy-route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#0B4FB0', 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 5, 10, 10, 14, 20, 18, 30], 'line-opacity': 0.55 },
    },
    // --- the route itself ---
    {
      id: 'canopy-route',
      type: 'line',
      source: 'canopy-route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#1A73E8', 'line-width': ROUTE_LINE_WIDTH },
    },
    // --- traffic tint, above the route so it can actually be seen ---
    ...trafficLayers(),
    // --- travelled portion (dimmed, Google Maps greys out the part already driven) ---
    // Drawn last of the three, and deliberately: all three are the same stripe
    // in the same place, so a grey line *under* a blue line of equal width is
    // not a dimmed route, it is an invisible one.
    {
      id: 'canopy-route-travelled',
      type: 'line',
      source: 'canopy-route-travelled',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#9AA0A6', 'line-width': ROUTE_LINE_WIDTH, 'line-opacity': 0.75 },
    },

    // --- maneuver markers along the route ---
    {
      id: 'canopy-maneuver-markers',
      type: 'circle',
      source: 'canopy-maneuvers',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 4, 14, 7, 18, 10],
        'circle-color': '#FFFFFF',
        'circle-stroke-color': '#1A73E8',
        'circle-stroke-width': 2.5,
      },
    },

    // --- origin puck ---
    {
      id: 'canopy-origin-halo',
      type: 'circle',
      source: 'canopy-origin',
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 9, 14, 16, 18, 24], 'circle-color': '#1A73E8', 'circle-opacity': 0.18 },
    },
    {
      id: 'canopy-origin',
      type: 'circle',
      source: 'canopy-origin',
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 4.5, 14, 7.5, 18, 11], 'circle-color': '#FFFFFF', 'circle-stroke-width': 3, 'circle-stroke-color': '#1A73E8' },
    },

    // --- destination pin ---
    {
      id: 'canopy-dest-shadow',
      type: 'circle',
      source: 'canopy-destination',
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 6, 14, 10, 18, 14], 'circle-color': '#000000', 'circle-opacity': 0.2, 'circle-translate': [0, 2] },
    },
    {
      id: 'canopy-destination',
      type: 'circle',
      source: 'canopy-destination',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 5, 14, 8.5, 18, 12],
        'circle-color': '#EA4335',
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
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 12, 14, 40, 18, 90], 'circle-color': '#1A73E8', 'circle-opacity': 0.12 },
    },
    {
      id: 'canopy-location',
      type: 'circle',
      source: 'canopy-location',
      paint: { 'circle-radius': 7, 'circle-color': '#1A73E8', 'circle-stroke-width': 3, 'circle-stroke-color': '#FFFFFF' },
    },

    // --- imported .osm overlay ---
    {
      id: 'canopy-osm-roads',
      type: 'line',
      source: 'canopy-osm',
      filter: ['==', ['geometry-type'], 'LineString'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['match', ['get', 'class'], 'motorway', '#F0A03C', 'trunk', '#F0A03C', 'primary', '#FFE8A8', 'secondary', '#FFF3D0', '#FFFFFF'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 14, 3, 18, 8],
      },
    },
  ];
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
export function widthAt(stops: readonly (number | any[])[]): any {
  return ['interpolate', ['linear'], ['zoom'], ...stops.flat()];
}

/** Highways that must stay legible at province zoom. */
const ARTERIAL = ['motorway', 'trunk', 'primary', 'secondary'];

/** Links and ramps: real roads, but not the structure of the network. */
const LINK = ['motorway_link', 'trunk_link', 'primary_link', 'secondary_link'];

/** MapLibre filter matching only arterial classes. */
export function arterialFilter(): any {
  return ['match', ['get', 'class'], ...ARTERIAL, true, false];
}

/**
 * The offline style: Google's palette over our own parsed `.osm` geometry.
 *
 * Takes the navigation overlay layers as an argument rather than importing them,
 * because those live with the map component that owns them, and importing the
 * component here would drag `maplibre-gl` into a pure module.
 */
export function offlineStyleSpec(overlayLayerDefs: any[]): StyleSpecification {
  return {
    version: 8,
    glyphs: undefined,
    sources: overlaySources(),
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#F8F7F5' } },
      {
        id: 'canopy-osm-green', type: 'fill', source: 'canopy-osm-green',
        paint: {
          'fill-color': ['match', ['get', 'class'], 'forest', '#A8D5A0', 'wood', '#A8D5A0', '#C5E8C0'],
          'fill-opacity': 0.9,
        },
      },
      {
        id: 'canopy-osm-water', type: 'line', source: 'canopy-osm-water',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        // Floored for the same reason as the roads: a river that vanishes below
        // zoom 9 makes a province look like it has no geography.
        paint: {
          'line-color': '#AADAFF',
          'line-width': widthAt([4, 0.8, 8, 1.4, 14, 4, 18, 12]),
        },
      },
      // Casing under everything, so a pale road still reads against the pale
      // background. Drawn first for that reason.
      {
        id: 'canopy-osm-casing', type: 'line', source: 'canopy-osm',
        filter: ['==', ['geometry-type'], 'LineString'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#E3E0D8',
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
          'line-color': '#FFFFFF',
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
          'line-color': [
            'match', ['get', 'class'],
            'motorway', '#F0A03C', 'trunk', '#F0A03C',
            ...LINK, '#FFD98A',
            'primary', '#FFE8A8', 'secondary', '#FFF3D0',
            '#FFFFFF',
          ],
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

/** Empty GeoJSON sources for every layer the overlays reference. */
export function overlaySources(): Record<string, any> {
  return {
    'canopy-route': { type: 'geojson', data: EMPTY },
    'canopy-route-travelled': { type: 'geojson', data: EMPTY },
    // The tint is its own source so a stretch of road can carry a `level`
    // without every other feature having to pretend to be a road.
    [TRAFFIC_SOURCE]: { type: 'geojson', data: EMPTY },
    'canopy-maneuvers': { type: 'geojson', data: EMPTY },
    'canopy-origin': { type: 'geojson', data: EMPTY },
    'canopy-destination': { type: 'geojson', data: EMPTY },
    'canopy-location': { type: 'geojson', data: EMPTY },
    'canopy-avoid': { type: 'geojson', data: EMPTY },
    'canopy-osm': { type: 'geojson', data: EMPTY },
    'canopy-osm-water': { type: 'geojson', data: EMPTY },
    'canopy-osm-green': { type: 'geojson', data: EMPTY },
  };
}
