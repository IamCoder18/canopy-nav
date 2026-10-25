/**
 * The map's overlay sources: what is drawn on top of the basemap, and when it
 * is re-sent to the render worker.
 *
 * Split out of `MapView.tsx` because this is logic, not a component: the
 * change-detection below is the app's smoothness guarantee, it is asserted in
 * `test/mapoverlays.spec.ts`, and a plain module can be tested without loading
 * MapLibre at all. The component owns the map instance and the camera; this
 * owns the data that goes into it.
 */

import type { GeoJSONSource, Map as MLMap } from 'maplibre-gl';
import type { LatLng } from '../geo';
import type { TrafficLevel } from '../nav/traffic';
import type { OsmDataset } from '../osm/engine.worker';
import {
  greenToGeoJSON,
  lineToGeoJSON,
  pointsToGeoJSON,
  roadsToGeoJSON,
  waterToGeoJSON,
} from '../osm/engine';

/** One stretch of the route, coloured by the congestion the provider reported. */
export interface TrafficOverlay {
  level: TrafficLevel;
  /** The road coordinates this level applies to. */
  path: LatLng[];
}

/**
 * The overlay inputs `applyOverlays` reads.
 *
 * A structural subset of `MapViewProps`, named separately so the writer can be
 * driven by tests (and by any future caller) without a component in the way.
 */
export interface OverlayInputs {
  dataset: OsmDataset | null;
  route: LatLng[] | null;
  /** Portion of the route already driven (drawn greyed out). */
  travelled: LatLng[] | null;
  /**
   * Congestion along the route. Empty means "no data", not "no congestion":
   * nothing is drawn unless a provider actually said a stretch was slow.
   */
  traffic?: TrafficOverlay[];
  origin: LatLng | null;
  destination: LatLng | null;
  location: LatLng | null;
  /** Turn-by-turn points to dot along the route. */
  maneuverPoints: LatLng[];
  /** The driver's own reports, marked where they were made. */
  reportPoints?: LatLng[];
}

/**
 * What was last handed to each source, per map instance.
 *
 * `applyOverlays` runs on every GPS fix (1 Hz — and `maximumAge: 0` means
 * fixes keep arriving even at a standstill), on every zoom end, and on every
 * style boot. Each run rebuilt every FeatureCollection and handed it to
 * `setData`, which serialises the geometry into the render worker — for a
 * provincial route that is megabytes, once a second, while the driver is
 * dragging the map. That is the stutter.
 *
 * The inputs are mostly not changing: the route array is the route array
 * between reroutes, the maneuver dots and report pins are memoised in App, and
 * "already driven" is a fresh array with the same contents whenever the car
 * stands still. So each source remembers what it was last given and skips both
 * the rebuild and the transfer when nothing has changed.
 *
 * Entries hold the *source object* alongside the inputs, and "nothing changed"
 * is only a skip when that object is also the same: a style swap creates new,
 * empty sources, and a cache that only looked at inputs would leave the new
 * style blank forever. Same source, same inputs, is the one skip.
 *
 * Keyed on the map instance so a removed map's cache is collectable with it.
 */
const overlayInputs = new WeakMap<MLMap, Map<string, { src: object; inputs: unknown }>>();

/**
 * Whether two overlay inputs describe the same geometry.
 *
 * Identity first — the common case is the caller passing the same array back —
 * then a recursive walk down to the coordinate numbers. On the equal-but-fresh
 * case (`travelled` rebuilt from the same vertices every fix while stationary)
 * this costs one pointer compare per element and saves a full serialisation.
 */
function sameInput(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameInput(a[i], b[i])) return false;
    return true;
  }
  // Traffic spans are rebuilt as plain objects; their `path` arrays hold the
  // same tuples and their `level` is a string, so the walk reaches both.
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!sameInput((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
    }
    return true;
  }
  return false;
}

/**
 * Fill every overlay source from `p` — skipping the ones that already hold
 * exactly this data.
 *
 * The skip is the app's smoothness guarantee and a promise worth testing:
 * `test/mapoverlays.spec.ts` drives this through a stub map and counts
 * `setData` calls. It is a function of a map-shaped object, so the stub is all
 * it ever needed.
 */
export function applyOverlays(m: MLMap, p: OverlayInputs) {
  // Sources only exist once a style has loaded; setData before that is a no-op.
  if (!m.getSource('canopy-route')) return;
  const cache = overlayInputs.get(m) ?? new Map<string, { src: object; inputs: unknown }>();
  overlayInputs.set(m, cache);
  /**
   * Hand `data` to the source `id` — unless the same source was already given
   * inputs that mean the same thing, in which case there is nothing to draw
   * that is not already on screen.
   */
  const set = (id: string, inputs: unknown, build: () => GeoJSON.FeatureCollection) => {
    const src = m.getSource(id) as GeoJSONSource | undefined;
    if (!src || !('setData' in src)) return;
    const prev = cache.get(id);
    if (prev && prev.src === (src as unknown as object) && sameInput(prev.inputs, inputs)) return;
    cache.set(id, { src: src as unknown as object, inputs });
    src.setData(build());
  };

  // Offline base layers only exist in the offline style.
  if (p.dataset) {
    // The current zoom decides how much road is worth sending: rebuilding every
    // way in a provincial extract to draw sub-pixel lines is the expensive part.
    const layers = basemapFor(p.dataset, Math.round(m.getZoom()));
    //
    // **`canopy-osm`, not `canopy-osm-roads`.**
    //
    // `canopy-osm-roads` is the id of the *layer* that draws arterials; the *source*
    // every road layer reads is `canopy-osm` (`canopy-osm-casing`, `canopy-osm-minor`
    // and `canopy-osm-roads` all declare `source: 'canopy-osm'`). Passing the layer id
    // where a source id belongs meant `m.getSource` returned `undefined`, `set` took
    // its silent no-op branch, and **the imported road network was never drawn** —
    // water and green appeared, roads did not, and nothing errored.
    //
    // It survived because the id *looks* right: it matches the layer you would check
    // to confirm roads are being styled. `test/mapsources.spec.ts` now cross-checks
    // every id this function passes against `overlaySources()`, which is the check
    // that was missing.
    //
    // The basemap GeoJSON is cached per dataset and zoom (`basemapFor`), so the
    // inputs here are the same objects across ticks and the skip above is O(1).
    set('canopy-osm', layers.roads, () => layers.roads);
    set('canopy-osm-water', layers.water, () => layers.water);
    set('canopy-osm-green', layers.green, () => layers.green);
  }

  const route = p.route ?? [];
  set('canopy-route', route, () => lineToGeoJSON(route));
  const travelled = p.travelled ?? [];
  set('canopy-route-travelled', travelled, () => lineToGeoJSON(travelled));
  const traffic = p.traffic ?? [];
  set('canopy-route-traffic', traffic, () => trafficToGeoJSON(traffic));
  set('canopy-maneuvers', p.maneuverPoints, () => pointsToGeoJSON(p.maneuverPoints));
  const reports = p.reportPoints ?? [];
  set('canopy-reports', reports, () => pointsToGeoJSON(reports));
  const origin = p.origin ? [p.origin] : [];
  set('canopy-origin', origin, () => pointsToGeoJSON(origin));
  const destination = p.destination ? [p.destination] : [];
  set('canopy-destination', destination, () => pointsToGeoJSON(destination));
  const location = p.location ? [p.location] : [];
  set('canopy-location', location, () => pointsToGeoJSON(location));
}

/**
 * GeoJSON for the traffic tint.
 *
 * `unknown` and `free` are dropped rather than drawn: "we have no idea" and
 * "clear road" are different claims, and only the second one may be coloured.
 * (A `free` stretch is drawn as the normal blue route underneath.)
 */
function trafficToGeoJSON(spans: TrafficOverlay[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: spans
      .filter((s) => (s.level === 'slow' || s.level === 'dense') && s.path.length > 1)
      .map((s) => ({
        type: 'Feature',
        properties: { level: s.level },
        geometry: { type: 'LineString', coordinates: s.path },
      })),
  };
}

/**
 * The three layers a basemap is made of, at one zoom.
 *
 * `water` and `green` are carried per-entry even though they are built once and
 * shared, because the caller reads all three off one value and splitting them
 * would push that decision into every call site.
 */
type BasemapLayers = {
  roads: GeoJSON.FeatureCollection;
  water: GeoJSON.FeatureCollection;
  green: GeoJSON.FeatureCollection;
};

/**
 * How many zooms' worth of roads to keep per dataset.
 *
 * Two is enough to survive a single boundary crossing; three leaves room to zoom
 * out and back without paying again. Capped because each entry is a serialised
 * copy of the whole extract's road network at one level of detail, so an
 * unbounded per-zoom cache would itself become the memory problem.
 */
const MAX_CACHED_ZOOMS = 3;

/**
 * Serialised offline basemap, cached per dataset and per integer zoom.
 *
 * `roadsToGeoJSON` walks every way in the extract and allocates a Feature per
 * way. For a province — the 100–900 MB extracts this app is built for — that is
 * 10⁵–10⁶ objects and a multi-megabyte JSON string, built on the main thread.
 *
 * `applyOverlays` runs on every GPS fix (~1 Hz, and `maximumAge: 0` means even
 * while stationary), so before this cache the entire provincial road network was
 * re-serialised once a second, forever, while driving — and the code's own
 * comment named the cause and left it in place. The banner and route line
 * stuttered at exactly the moment the driver needed them.
 *
 * Keyed on the dataset object with a `WeakMap`, so an imported region is
 * collectable once it is replaced, and on the integer zoom, because the LOD is
 * a function of zoom only.
 *
 * ## Why this holds several zooms rather than one
 *
 * It held a **single** slot: `WeakMap<dataset, {zoom, roads, water, green}>`,
 * with a hit only when `entry.zoom === zoom`. So the moment the driver crossed an
 * integer zoom boundary — the single most common camera movement there is, and
 * one the LOD exists to make cheaper rather than more expensive — the entire
 * provincial road network was re-serialised on the main thread. Pinch-zoom in,
 * pinch-zoom out, and the whole province was built twice. A guard that pays full
 * price at exactly the boundary it was added to smooth is not a guard.
 *
 * Two further things were rebuilt needlessly. `water` and `green` do not vary
 * with zoom at all — `RENDER_MIN_ZOOM` applies to roads only — so they were being
 * re-walked and re-allocated on every boundary crossing to produce values
 * identical to the ones already in hand.
 *
 * So: roads are cached per integer zoom in a small LRU, and the zoom-independent
 * layers are built exactly once per dataset. Zooming across a boundary now
 * usually finds a cached entry for the level it is arriving at, because the
 * level it came from is still resident.
 */
const basemapCache = new WeakMap<object, {
  /** Zoom-independent. Built once; shared by every zoom's entry. */
  water: GeoJSON.FeatureCollection;
  green: GeoJSON.FeatureCollection;
  /** Roads by integer zoom, in most-recently-used order. */
  roadsByZoom: Map<number, GeoJSON.FeatureCollection>;
}>();

function basemapFor(dataset: OsmDataset, zoom: number): BasemapLayers {
  const key = dataset as unknown as object;
  let entry = basemapCache.get(key);
  if (!entry) {
    entry = {
      water: waterToGeoJSON(dataset),
      green: greenToGeoJSON(dataset),
      roadsByZoom: new Map(),
    };
    basemapCache.set(key, entry);
  }

  // Re-insert on hit so `Map`'s insertion order is least-recently-used first,
  // which is what the eviction below assumes.
  let roads = entry.roadsByZoom.get(zoom);
  if (roads !== undefined) {
    entry.roadsByZoom.delete(zoom);
  } else {
    roads = roadsToGeoJSON(dataset, zoom);
  }
  entry.roadsByZoom.set(zoom, roads);

  // Evict oldest first. The arriving zoom and the one just left are the pair
  // worth keeping, so `MAX_CACHED_ZOOMS - 1` others survive behind them.
  while (entry.roadsByZoom.size > MAX_CACHED_ZOOMS) {
    const oldest = entry.roadsByZoom.keys().next();
    if (oldest.done) break;
    entry.roadsByZoom.delete(oldest.value);
  }

  return { roads, water: entry.water, green: entry.green };
}
