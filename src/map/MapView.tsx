/**
 * Map view: MapLibre GL, styled to imitate Google Maps.
 *
 * Two data modes:
 *  - `tiles`  : online vector tiles (OpenFreeMap), best cartography
 *  - `offline`: roads/water/green drawn from the imported .osm dataset
 *
 * Navigation overlays (route, destination pin, location puck) exist in both
 * modes and follow Google's visual conventions.
 */

import { useEffect, useRef } from 'react';
import maplibregl, { type Map as MLMap, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { LatLng } from '../geo';
import type { TrafficLevel } from '../nav/traffic';
// The map's opening position is the app's no-fix position, not a hard-coded
// London. They used to disagree by 7,000 km, which meant that with no GPS the
// map showed one place, the position model used another, and routing asked for a
// trip between them. See `NO_FIX_POSITION`.
import { NO_FIX_POSITION } from '../nav/location';
import { buildStyle, trafficLayers, offlineStyleSpec, ROUTE_LINE_WIDTH } from './style';
import {
  greenToGeoJSON,
  lineToGeoJSON,
  pointsToGeoJSON,
  roadsToGeoJSON,
  waterToGeoJSON,
} from '../osm/engine';
import type { OsmDataset } from '../osm/engine.worker';

/** One stretch of the route, coloured by the congestion the provider reported. */
export interface TrafficOverlay {
  level: TrafficLevel;
  /** The road coordinates this level applies to. */
  path: LatLng[];
}

export interface MapViewProps {
  dataset: OsmDataset | null;
  useTiles: boolean;
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
  onMapClick?: (p: LatLng) => void;
  onMapLongPress?: (p: LatLng) => void;
  /** Programmatic camera target; changes re-fit the map. */
  focus?: { center: LatLng; zoom: number } | null;
  /** Bumping this re-fits to the route. */
  fitNonce?: number;
  className?: string;
  /**
   * Called when the basemap's actual source changes.
   *
   * Reported because a tile-host failure used to substitute the offline style
   * silently: the map kept working and nothing on screen said the basemap had
   * changed source. Harmless to the driver, but it means the picture behind the
   * route is no longer what the app claims it is — and this app's rule is that
   * nothing implies data it does not have.
   *
   * `reason` is non-null only when tiles were asked for and could not be
   * fetched, which is the case worth reporting: a deliberate offline session is
   * the expected path, not a failure.
   */
  onBasemapChange?: (source: 'tiles' | 'offline') => void;
}

const mapRef: { current: MLMap | null } = { current: null };

export function MapView(props: MapViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const ready = useRef(false);
  const styleMode = useRef<'tiles' | 'offline'>('tiles');

  /**
   * The basemap callback, held in a ref for the same reason as the tap handlers
   * above: this effect must not depend on prop identity, or a caller that
   * re-creates its callback would re-boot the style on every render.
   */
  const onBasemapRef = useRef(props.onBasemapChange);
  useEffect(() => { onBasemapRef.current = props.onBasemapChange; }, [props.onBasemapChange]);

  /* ------------------------- initialise map ------------------------- */

  /**
   * Current map-tap handlers, held in refs.
   *
   * The registration effect below runs once with `[]`, so its closures would
   * capture the *mount-time* props forever — a trap for anyone who later passes a
   * handler, since the function arrives after mount and would never be seen. The
   * refs keep the registration one-shot while the callbacks stay live. Declared
   * out here rather than inside the effect: hooks called in an effect body are not
   * hooks, and doing that crashes the whole app with a blank screen.
   */
  const clickRef = useRef(props.onMapClick);
  const longPressRef = useRef(props.onMapLongPress);
  clickRef.current = props.onMapClick;
  longPressRef.current = props.onMapLongPress;

  /**
   * Current overlay props, for the same reason — and for one more.
   *
   * The style-boot effect below is keyed on `[props.useTiles]`, so `props` inside
   * `boot()` is frozen at the render that started the boot. `buildStyle()` is a
   * network round-trip, and the overlays it applies on `styledata` therefore
   * carried whatever was true when the boot *began*.
   *
   * The window is real: it opens on launch and again on every tile/offline
   * transition, which the app performs by itself when connectivity changes. A
   * route chosen inside it produced no line, no destination pin and no origin
   * marker — and nothing errored, because the overlays effect had already run
   * and bailed on `ready.current === false`, so no prop had changed to make it
   * run again. `cancelled` guarded the *style* race; nothing guarded the *prop*
   * race.
   */
  const overlayProps = useRef(props);
  overlayProps.current = props;

  useEffect(() => {
    if (!container.current || map.current) return;

    const m = new maplibregl.Map({
      container: container.current,
      // Google Maps' default pitch-free, top-down presentation.
      style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#F8F7F5' } }] } as StyleSpecification,
      center: NO_FIX_POSITION,
      zoom: 12,
      // Attribution is not optional: the ODbL requires OSM credit to be
      // displayed, and the data here is OSM's in both the tile and the imported
      // case. The control collects the credit declared on every source, so the
      // tile provider's and ours end up in one legible place.
      attributionControl: { compact: false },
      dragRotate: false,
      pitchWithRotate: false,
      touchZoomRotate: false,
      maxPitch: 0,
    });
    m.touchZoomRotate.disableRotation();
    map.current = m;
    mapRef.current = m;

    m.on('click', (e) => clickRef.current?.([e.lngLat.lng, e.lngLat.lat]));
    let pressTimer: ReturnType<typeof setTimeout> | null = null;
    m.on('mousedown', (e) => {
      pressTimer = setTimeout(() => longPressRef.current?.([e.lngLat.lng, e.lngLat.lat]), 550);
    });
    m.on('mouseup', () => { if (pressTimer) clearTimeout(pressTimer); });

    // The offline basemap's detail level is a function of zoom (`roadsToGeoJSON`
    // is called with the zoom to decide which roads are worth sending), but
    // nothing re-applied the overlays when the zoom changed — they were only
    // refreshed as a side effect of a GPS fix. On the offline style that meant
    // zooming in drew no new roads until the next position tick, and at a
    // standstill — where `maximumAge: 0` means fixes keep arriving, so at most a
    // second — the map visibly refused to gain detail.
    //
    // `zoomend` rather than `move` so a pinch does not re-serialise the
    // province once per frame; the overlay effect below already covers every
    // prop change, and this covers the one that is not a prop.
    const onZoomEnd = () => {
      if (!ready.current) return;
      applyOverlays(m, overlayProps.current);
    };
    m.on('zoomend', onZoomEnd);

    return () => {
      // `m.remove()` detaches the map's own listeners but leaves a pending
      // press timer armed, which would then call into refs of a component that
      // is already gone.
      if (pressTimer) clearTimeout(pressTimer);
      m.off('zoomend', onZoomEnd);
      m.remove();
      map.current = null;
      mapRef.current = null;
      ready.current = false;
    };
  }, []);

  /* ------------------------- swap data source ------------------------ */
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    // Tiles only help when there is a network; offline always uses .osm geometry.
    const want: 'tiles' | 'offline' = props.useTiles ? 'tiles' : 'offline';
    if (styleMode.current === want && ready.current) return;

    // Captured now, not after the await. The map instance is created once by the
    // effect above, and that effect's cleanup nulls `map.current` before this
    // one runs — so reading it in the cleanup would find null and skip the
    // listener removal it exists to do.
    const current = map.current;
    if (!current) return;

    let cancelled = false;
    /** Removers for the `once` handlers this effect has attached so far. */
    const listeners: Array<() => void> = [];
    const boot = async () => {
      let style: StyleSpecification;
      let mode: 'tiles' | 'offline' = want;
      if (want === 'tiles') {
        try {
          style = await buildStyle();
        } catch (err) {
          console.warn('Tile style unavailable, using offline style', err);
          style = offlineStyle();
          mode = 'offline';
        }
      } else {
        style = offlineStyle();
      }
      // `buildStyle()` is a network round-trip. If the user loses connectivity
      // and regains it while it is in flight, or toggles the mode twice, two
      // boots race and the loser used to land last: `styleMode.current` would
      // then claim a mode the style does not match, and the guard at the top of
      // this effect would skip the update that would have fixed it.
      if (cancelled) return;
      // Reported after the cancellation check, so an abandoned boot does not
      // announce a source the map never adopted.
      onBasemapRef.current?.(mode);
      styleMode.current = mode;
      ready.current = false;
      current.setStyle(style);
      const onReady = () => {
        ready.current = true;
        applyOverlays(current, overlayProps.current);
      };
      current.once('styledata', onReady);
      current.once('idle', onReady);
      listeners.push(
        () => {
          current.off('styledata', onReady);
          current.off('idle', onReady);
        },
      );
    };
    void boot();

    return () => {
      // Without this, `cancelled` could never become true and the two `once`
      // handlers above outlived a removed map.
      cancelled = true;
      for (const off of listeners.splice(0)) off();
    };
    // The suppressions this effect used to need are gone: `onReady` now reads
    // `overlayProps.current` rather than closing over `props`, so the only prop
    // this effect depends on is the one it is keyed on.
  }, [props.useTiles]);

  /* --------------------------- overlays ------------------------------ */
  useEffect(() => {
    const m = map.current;
    if (!m || !ready.current) return;
    // Reads the ref, not the closure: a prop can change inside the window where
    // the style is booting, and this effect has already bailed by then. The
    // `styledata`/`idle` handler on that boot reads the same ref, so both paths
    // see the same props whichever order things happen in.
    applyOverlays(m, overlayProps.current);
    // The dependency list is spelled out rather than `[props]` on purpose: the
    // overlays are the expensive part of a render, and `props` is a fresh object
    // on every one of App's 1 Hz re-renders, so depending on it would
    // re-serialise the province every second whether or not anything visible
    // had changed. These are the values `applyOverlays` actually reads.
  }, [props.route, props.travelled, props.traffic, props.origin, props.destination, props.location, props.maneuverPoints, props.dataset]);

  /* ---------------------------- camera ------------------------------- */
  useEffect(() => {
    const m = map.current;
    if (!m || !props.focus) return;
    m.easeTo({ center: props.focus.center, zoom: props.focus.zoom, duration: cameraDuration(400) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focus?.center?.[0], props.focus?.center?.[1], props.focus?.zoom]);

  useEffect(() => {
    const m = map.current;
    if (!m || !props.fitNonce) return;
    const pts = props.route?.length ? props.route : props.destination ? [props.destination] : null;
    if (pts?.length) fitPoints(m, pts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.fitNonce]);

  /**
   * The map lives inside a wrapper the library never touches.
   *
   * MapLibre adds `.maplibregl-map { position: relative }` to whatever element
   * it is constructed with, and its stylesheet is a *separate lazily-loaded*
   * chunk. `.map { position: absolute; inset: 0 }` ties with it on specificity,
   * so which one won depended on stylesheet order — and once the map was split
   * into its own chunk, its CSS always arrived second and always won. The map
   * container measured 0px tall, the canvas fell back to its default 412x300,
   * and nothing rendered at all.
   *
   * Fixing it by raising specificity would work today and break silently again
   * the next time MapLibre adds a class or a second matching rule. Sizing a
   * wrapper we own, which the library has no opinion about, cannot be reordered
   * out from under us.
   */
  /*
   * The map, as something assistive technology can name.
   *
   * MapLibre's canvas is focusable — which is good, because a keyboard user can
   * pan it — but it arrived here unnamed, so it was the *first tab stop on every
   * screen*, before the app bar that is visually at the top, announcing an
   * unnamed graphic. There was also no text alternative for what it displays: the
   * route, the destination pin, the traffic tint and the maneuver dots are all
   * conveyed visually and nowhere else.
   *
   * `role="img"` with a name composed from live state is the honest description
   * of a canvas — it conveys information and is not itself operable markup. The
   * name says what the map is *showing*, which is the information a sighted
   * driver gets for free, so it is composed rather than written once:
   *
   *     Map. Route to Elbow St. Offline basemap. No traffic data.
   *
   * A route, the basemap's actual source, and the traffic state are the three
   * facts a driver cannot get any other way.
   */
  const described = [
    'Map',
    props.destination ? `Route to ${props.destination.join(', ')}` : null,
    props.useTiles ? 'Online basemap' : 'Offline basemap, drawn from your imported extract',
    props.traffic && props.traffic.length ? 'Traffic overlay shown' : null,
  ].filter(Boolean).join('. ');

  return (
    <div className="map-host" role="img" aria-label={described}>
      <div ref={container} className={props.className ?? 'map'} />
    </div>
  );
}

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
 */
const basemapCache = new WeakMap<object, {
  zoom: number;
  roads: GeoJSON.FeatureCollection;
  water: GeoJSON.FeatureCollection;
  green: GeoJSON.FeatureCollection;
}>();

function basemapFor(dataset: OsmDataset, zoom: number) {
  const hit = basemapCache.get(dataset as unknown as object);
  if (hit && hit.zoom === zoom) return hit;
  const built = {
    zoom,
    roads: roadsToGeoJSON(dataset, zoom),
    water: waterToGeoJSON(dataset),
    green: greenToGeoJSON(dataset),
  };
  basemapCache.set(dataset as unknown as object, built);
  return built;
}

/**
 * Whether the driver asked for reduced motion.
 *
 * Read live rather than captured once: the preference can change while the app
 * is open, and a WebView that reports `false` before the system setting has
 * propagated should start honouring it the moment it does.
 *
 * MapLibre's camera animations are configured in JS, not CSS, so the
 * `prefers-reduced-motion` rule in `styles.css` cannot reach them. That rule's
 * comment says as much and points here — but nothing here implemented it, so
 * every recentre, overview, fit-route and fit-region move animated for 400–450 ms
 * regardless of the setting. `fitPoints` is exported and used by the overlay, so
 * it reads the same value.
 */
function reducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    // A WebView with no `matchMedia` at all: animate, as before.
    return false;
  }
}

/** `duration: 0` is a jump. That is the point. */
const cameraDuration = (ms: number) => (reducedMotion() ? 0 : ms);

function applyOverlays(m: MLMap, p: MapViewProps) {
  // Sources only exist once a style has loaded; setData before that is a no-op.
  if (!m.getSource('canopy-route')) return;
  const set = (id: string, data: GeoJSON.FeatureCollection) => {
    const src = m.getSource(id) as maplibregl.GeoJSONSource | undefined;
    if (src && 'setData' in src) src.setData(data);
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
    set('canopy-osm', layers.roads);
    set('canopy-osm-water', layers.water);
    set('canopy-osm-green', layers.green);
  }

  set('canopy-route', lineToGeoJSON(p.route ?? []));
  set('canopy-route-travelled', lineToGeoJSON(p.travelled ?? []));
  set('canopy-route-traffic', trafficToGeoJSON(p.traffic ?? []));
  set('canopy-maneuvers', pointsToGeoJSON(p.maneuverPoints));
  set('canopy-origin', pointsToGeoJSON(p.origin ? [p.origin] : []));
  set('canopy-destination', pointsToGeoJSON(p.destination ? [p.destination] : []));
  set('canopy-location', pointsToGeoJSON(p.location ? [p.location] : []));
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

export function fitPoints(m: MLMap, pts: LatLng[], padding = 72) {
  if (pts.length === 1) {
    m.easeTo({ center: pts[0], zoom: 16, duration: cameraDuration(400) });
    return;
  }
  let w = 180, s = 90, e = -180, n = -90;
  for (const [x, y] of pts) {
    if (x < w) w = x; if (x > e) e = x;
    if (y < s) s = y; if (y > n) n = y;
  }
  m.fitBounds([[w, s], [e, n]], { padding, duration: cameraDuration(450), maxZoom: 17 });
}

/** Style used with no network: Google palette, our own .osm geometry. */
function offlineStyle(): StyleSpecification {
  return offlineStyleSpec(overlaysLayerDefs());
}

/** Overlay layers for the offline style (no tile glyphs needed). */
function overlaysLayerDefs(): any[] {
  const W = ['interpolate', ['linear'], ['zoom'], 4, 4, 10, 8, 14, 16, 18, 26];
  return [
    // The offline road layers are NOT here. `offlineStyle` owns
    // `canopy-osm-casing` / `-minor` / `-roads` because they need a zoom ramp
    // that starts well below 10; a second definition of `canopy-osm-roads` in
    // this list would be a duplicate layer id, which MapLibre rejects outright.
    { id: 'canopy-route-casing', type: 'line', source: 'canopy-route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#0B4FB0', 'line-width': W, 'line-opacity': 0.55 } },
    { id: 'canopy-route', type: 'line', source: 'canopy-route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#1A73E8', 'line-width': ROUTE_LINE_WIDTH } },
    // Traffic tint above the route for the same reason as in the online style: it
    // recolours the route stripe rather than hiding underneath it.
    ...trafficLayers(),
    // ...and the dimmed portion on top of both, which is the only way it is visible.
    { id: 'canopy-route-travelled', type: 'line', source: 'canopy-route-travelled', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#9AA0A6', 'line-width': ROUTE_LINE_WIDTH, 'line-opacity': 0.75 } },
    { id: 'canopy-maneuver-markers', type: 'circle', source: 'canopy-maneuvers', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 4, 14, 7, 18, 10], 'circle-color': '#FFFFFF', 'circle-stroke-color': '#1A73E8', 'circle-stroke-width': 2.5 } },
    { id: 'canopy-origin-halo', type: 'circle', source: 'canopy-origin', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 9, 14, 16, 18, 24], 'circle-color': '#1A73E8', 'circle-opacity': 0.18 } },
    { id: 'canopy-origin', type: 'circle', source: 'canopy-origin', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 4.5, 14, 7.5, 18, 11], 'circle-color': '#FFFFFF', 'circle-stroke-color': '#1A73E8', 'circle-stroke-width': 3 } },
    { id: 'canopy-destination-shadow', type: 'circle', source: 'canopy-destination', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 6, 14, 10, 18, 14], 'circle-color': '#000000', 'circle-opacity': 0.2, 'circle-translate': [0, 2] } },
    { id: 'canopy-destination', type: 'circle', source: 'canopy-destination', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 5, 14, 8.5, 18, 12], 'circle-color': '#EA4335', 'circle-stroke-color': '#FFFFFF', 'circle-stroke-width': 2.5 } },
    { id: 'canopy-destination-inner', type: 'circle', source: 'canopy-destination', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 1.8, 14, 3.2, 18, 4.6], 'circle-color': '#FFFFFF' } },
    { id: 'canopy-location-accuracy', type: 'circle', source: 'canopy-location', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 12, 14, 40, 18, 90], 'circle-color': '#1A73E8', 'circle-opacity': 0.12 } },
    { id: 'canopy-location', type: 'circle', source: 'canopy-location', paint: { 'circle-radius': 7, 'circle-color': '#1A73E8', 'circle-stroke-width': 3, 'circle-stroke-color': '#FFFFFF' } },
  ];
}

export default MapView;
