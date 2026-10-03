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
import { buildStyle, overlaySources } from './style';
import {
  greenToGeoJSON,
  lineToGeoJSON,
  pointsToGeoJSON,
  roadsToGeoJSON,
  waterToGeoJSON,
} from '../osm/engine';
import type { OsmDataset } from '../osm/engine.worker';

export interface MapViewProps {
  dataset: OsmDataset | null;
  useTiles: boolean;
  route: LatLng[] | null;
  /** Portion of the route already driven (drawn greyed out). */
  travelled: LatLng[] | null;
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

    m.on('click', (e) => props.onMapClick?.([e.lngLat.lng, e.lngLat.lat]));
    let pressTimer: ReturnType<typeof setTimeout> | null = null;
    m.on('mousedown', (e) => {
      pressTimer = setTimeout(() => props.onMapLongPress?.([e.lngLat.lng, e.lngLat.lat]), 550);
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
  }, [props.route, props.travelled, props.origin, props.destination, props.location, props.maneuverPoints, props.dataset]);

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
    set('canopy-osm-roads', roadsToGeoJSON(p.dataset));
    set('canopy-osm-water', waterToGeoJSON(p.dataset));
    set('canopy-osm-green', greenToGeoJSON(p.dataset));
  }

  set('canopy-route', lineToGeoJSON(p.route ?? []));
  set('canopy-route-travelled', lineToGeoJSON(p.travelled ?? []));
  set('canopy-maneuvers', pointsToGeoJSON(p.maneuverPoints));
  set('canopy-origin', pointsToGeoJSON(p.origin ? [p.origin] : []));
  set('canopy-destination', pointsToGeoJSON(p.destination ? [p.destination] : []));
  set('canopy-location', pointsToGeoJSON(p.location ? [p.location] : []));
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
  return {
    version: 8,
    glyphs: undefined,
    sources: overlaySources(),
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#F8F7F5' } },
      {
        id: 'canopy-osm-green', type: 'fill', source: 'canopy-osm-green',
        paint: { 'fill-color': ['match', ['get', 'class'], 'forest', '#A8D5A0', 'wood', '#A8D5A0', '#C5E8C0'], 'fill-opacity': 0.9 },
      },
      {
        id: 'canopy-osm-water', type: 'line', source: 'canopy-osm-water',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#AADAFF', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1, 14, 4, 18, 12] },
      },
      {
        id: 'canopy-osm-casing', type: 'line', source: 'canopy-osm',
        filter: ['==', ['geometry-type'], 'LineString'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#E3E0D8', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2.5, 14, 5, 18, 12] },
      },
      ...(overlaysLayerDefs()),
    ],
  };
}

/** Overlay layers for the offline style (no tile glyphs needed). */
function overlaysLayerDefs(): any[] {
  const W = ['interpolate', ['linear'], ['zoom'], 4, 4, 10, 8, 14, 16, 18, 26];
  return [
    { id: 'canopy-osm-roads', type: 'line', source: 'canopy-osm', filter: ['==', ['geometry-type'], 'LineString'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['match', ['get', 'class'], 'motorway', '#FFDFA6', 'trunk', '#FFDFA6', 'primary', '#FFE8A8', 'secondary', '#FFF3D0', '#FFFFFF'], 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 14, 3, 18, 8] } },
    { id: 'canopy-route-casing', type: 'line', source: 'canopy-route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#0B4FB0', 'line-width': W, 'line-opacity': 0.55 } },
    { id: 'canopy-route-travelled', type: 'line', source: 'canopy-route-travelled', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#9AA0A6', 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 3, 10, 6, 14, 12, 18, 20], 'line-opacity': 0.75 } },
    { id: 'canopy-route', type: 'line', source: 'canopy-route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#1A73E8', 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 3.5, 10, 6.5, 14, 13, 18, 22] } },
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
