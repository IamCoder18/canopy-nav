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
}

const mapRef: { current: MLMap | null } = { current: null };

export function MapView(props: MapViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const ready = useRef(false);
  const styleMode = useRef<'tiles' | 'offline'>('tiles');

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

  useEffect(() => {
    if (!container.current || map.current) return;

    const m = new maplibregl.Map({
      container: container.current,
      // Google Maps' default pitch-free, top-down presentation.
      style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#F8F7F5' } }] } as StyleSpecification,
      center: [-0.1276, 51.5072],
      zoom: 12,
      attributionControl: false,
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

    return () => { m.remove(); map.current = null; mapRef.current = null; ready.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------- swap data source ------------------------ */
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    // Tiles only help when there is a network; offline always uses .osm geometry.
    const want: 'tiles' | 'offline' = props.useTiles ? 'tiles' : 'offline';
    if (styleMode.current === want && ready.current) return;

    let cancelled = false;
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
      if (cancelled || !map.current) return;
      const current = map.current;
      styleMode.current = mode;
      ready.current = false;
      current.setStyle(style);
      const onReady = () => {
        ready.current = true;
        applyOverlays(current, props);
      };
      current.once('styledata', onReady);
      current.once('idle', onReady);
    };
    void boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.useTiles]);

  /* --------------------------- overlays ------------------------------ */
  useEffect(() => {
    const m = map.current;
    if (!m || !ready.current) return;
    applyOverlays(m, props);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.route, props.travelled, props.traffic, props.origin, props.destination, props.location, props.maneuverPoints, props.dataset]);

  /* ---------------------------- camera ------------------------------- */
  useEffect(() => {
    const m = map.current;
    if (!m || !props.focus) return;
    m.easeTo({ center: props.focus.center, zoom: props.focus.zoom, duration: 400 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focus?.center?.[0], props.focus?.center?.[1], props.focus?.zoom]);

  useEffect(() => {
    const m = map.current;
    if (!m || !props.fitNonce) return;
    const pts = props.route?.length ? props.route : props.destination ? [props.destination] : null;
    if (pts?.length) fitPoints(m, pts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.fitNonce]);

  return <div ref={container} className={props.className ?? 'map'} />;
}

function applyOverlays(m: MLMap, p: MapViewProps) {
  // Sources only exist once a style has loaded; setData before that is a no-op.
  if (!m.getSource('canopy-route')) return;
  const set = (id: string, data: GeoJSON.FeatureCollection) => {
    const src = m.getSource(id) as maplibregl.GeoJSONSource | undefined;
    if (src && 'setData' in src) src.setData(data);
  };

  // Offline base layers only exist in the offline style.
  if (p.dataset) {
    // The current zoom decides how much road is worth sending. Rebuilding every
    // way in a provincial extract to draw sub-pixel lines is the expensive part,
    // and the GeoJSON is rebuilt on every position update otherwise.
    const zoom = Math.round(m.getZoom());
    set('canopy-osm-roads', roadsToGeoJSON(p.dataset, zoom));
    set('canopy-osm-water', waterToGeoJSON(p.dataset));
    set('canopy-osm-green', greenToGeoJSON(p.dataset));
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
    m.easeTo({ center: pts[0], zoom: 16, duration: 400 });
    return;
  }
  let w = 180, s = 90, e = -180, n = -90;
  for (const [x, y] of pts) {
    if (x < w) w = x; if (x > e) e = x;
    if (y < s) s = y; if (y > n) n = y;
  }
  m.fitBounds([[w, s], [e, n]], { padding, duration: 450, maxZoom: 17 });
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
