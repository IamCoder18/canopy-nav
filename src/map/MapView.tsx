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
import { destinationPoint, lookAheadMetres, type LatLng } from '../geo';
// The map's opening position is the app's no-fix position, not a hard-coded
// London. They used to disagree by 7,000 km, which meant that with no GPS the
// map showed one place, the position model used another, and routing asked for a
// trip between them. See `NO_FIX_POSITION`.
import { NO_FIX_POSITION } from '../nav/location';
import { buildStyle, navOverlays, offlineStyleSpec, NIGHT } from './style';
import { applyOverlays, type TrafficOverlay } from './overlays';
import type { OsmDataset } from '../osm/engine.worker';

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
  /** The driver's own reports, marked where they were made. */
  reportPoints?: LatLng[];
  onMapClick?: (p: LatLng) => void;
  onMapLongPress?: (p: LatLng) => void;
  /** Programmatic camera target; changes re-fit the map. */
  focus?: { center: LatLng; zoom: number; bearing?: number; pitch?: number } | null;
  /**
   * Where the camera should be while it is following the car.
   *
   * A tracking shot, not a description of one: every change animates the
   * camera to `center`/`bearing`/`pitch`, and the car is kept in the lower
   * third by *aiming ahead of it* — `lookAheadMetres` solves the look-ahead
   * against the live projection so the car holds its screen position while the
   * driver pinches. (`centerOffset`, Mapbox's marker-offset option, no longer
   * exists on MapLibre 5's `easeTo`.)
   *
   * Zoom is deliberately not part of it: pinch and the zoom buttons keep
   * working while following, the way they do in Google Maps. The follow
   * target carries only what the road dictates.
   *
   * `null` means the driver has the camera. Nothing here moves it without
   * being asked again — see `onUserCamera`.
   */
  follow?: { center: LatLng; bearing: number; pitch: number } | null;
  /**
   * The driver took the camera: a drag, a two-finger twist, a tilt.
   *
   * Reported rather than handled here, because "stop following" is a decision
   * about the trip, not about the map — `App` owns that state. Pinch-zoom is
   * deliberately *not* a takeover: zooming in on the road you are following is
   * what a driver does, and losing the camera for it would be the old bug
   * wearing a new hat.
   *
   * Programmatic moves (follow ticks, recentre, overview, the compass) carry
   * no `originalEvent`, so they never call this.
   */
  onUserCamera?: () => void;
  /** Bumping this re-fits to the route. */
  fitNonce?: number;
  /**
   * A one-shot camera command from the navigation controls.
   *
   * `nonce` is what makes it one-shot: the same command twice in a row is two
   * zooms, and a plain "current value" prop could not say so. The alternative —
   * exporting the MapLibre instance — would make every control a part-owner of
   * the map's internals, which is the coupling the `focus`/`fitNonce` pair
   * already avoids.
   *
   * `flat` is "end of trip": north-up and un-tilted, where the map *is* —
   * unlike `focus`, it moves no position and no zoom, so ending a trip never
   * yanks the view out from under a driver who has panned somewhere else.
   */
  viewCmd?: { kind: 'zoom-in' | 'zoom-out' | 'north' | 'flat'; nonce: number } | null;
  /**
   * The map's current rotation, in degrees clockwise from north.
   *
   * Reported so the compass control can show what north is pointing at rather
   * than assuming: the map is rotatable (drag-rotate and two-finger twist), and
   * a compass that always draws north-up lies the moment the driver rotates.
   */
  onBearing?: (deg: number) => void;
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
   * Fires on every boot with the style actually adopted, and is worth reporting
   * only when tiles were asked for and could not be fetched: a deliberate offline
   * session is the expected path, not a failure.
   *
   * This used to document a second `reason` parameter that the signature never had,
   * so a caller writing to the documented contract would pass one and have it
   * discarded. The single argument is what `App.tsx` receives.
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
  /** Live bearing reporter, same ref treatment as the tap handlers. */
  const bearingRef = useRef(props.onBearing);
  bearingRef.current = props.onBearing;
  /** Camera-takeover reporter, same ref treatment as the tap handlers. */
  const userCameraRef = useRef(props.onUserCamera);
  userCameraRef.current = props.onUserCamera;

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
      // The map tilts (up to 60°) and rotates, because a navigation camera that
      // cannot face forward is the top-down complaint by construction. Pitch is
      // driven by the follow camera during a trip and stays flat elsewhere;
      // `pitchWithRotate` keeps the two-finger gesture reading as one motion —
      // twist to turn, push to tilt — instead of two modes the driver has to
      // discover separately.
      style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': NIGHT.land } }] } as StyleSpecification,
      center: NO_FIX_POSITION,
      zoom: 12,
      // Attribution is not optional: the ODbL requires OSM credit to be
      // displayed, and the data here is OSM's in both the tile and the imported
      // case. The control collects the credit declared on every source, so the
      // tile provider's and ours end up in one legible place.
      attributionControl: { compact: false },
      dragRotate: true,
      pitchWithRotate: true,
      maxPitch: 60,
    });
    map.current = m;
    mapRef.current = m;

    m.on('click', (e) => clickRef.current?.([e.lngLat.lng, e.lngLat.lat]));
    let pressTimer: ReturnType<typeof setTimeout> | null = null;
    m.on('mousedown', (e) => {
      pressTimer = setTimeout(() => longPressRef.current?.([e.lngLat.lng, e.lngLat.lat]), 550);
    });
    m.on('mouseup', () => { if (pressTimer) clearTimeout(pressTimer); });

    /**
     * Handovers from the camera to the driver.
     *
     * `dragstart` is always a hand on the map. `rotatestart` and `pitchstart`
     * are not: the follow camera and the compass animate both, and a takeover
     * on those would mean the app's own camera moves disengaging the app's own
     * follow mode — the camera fighting itself. Animations carry no
     * `originalEvent`; gestures always do. That is the whole test.
     */
    const takeover = () => userCameraRef.current?.();
    m.on('dragstart', takeover);
    const gestureOnly = (e: { originalEvent?: unknown }) => {
      if (e.originalEvent) takeover();
    };
    m.on('rotatestart', gestureOnly);
    m.on('pitchstart', gestureOnly);

    // The compass control is driven by the map's real bearing, so it reports it.
    // `rotate` fires on every frame of a gesture; the consumer stores a number
    // and re-renders a small SVG, which is cheap enough not to warrant a rAF
    // throttle on top of MapLibre's own coalescing.
    const onRotate = () => bearingRef.current?.(m.getBearing());
    m.on('rotate', onRotate);

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
      m.off('rotate', onRotate);
      m.off('zoomend', onZoomEnd);
      m.off('dragstart', takeover);
      m.off('rotatestart', gestureOnly);
      m.off('pitchstart', gestureOnly);
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
  }, [props.route, props.travelled, props.traffic, props.origin, props.destination, props.location, props.maneuverPoints, props.reportPoints, props.dataset]);

  /* ---------------------------- camera ------------------------------- */
  useEffect(() => {
    const m = map.current;
    if (!m || !props.focus) return;
    // `bearing`/`pitch` are omitted unless the caller means them: an explicit
    // `undefined` would be read as "zero" by a camera that tests `in`, and every
    // pre-trip focus (region centre, route preview) means "keep the current
    // angle", not "face north and lie flat". The one caller that does mean it
    // is Exit navigation, which passes 0/0 to undo the trip's tilt.
    const angle =
      props.focus.bearing !== undefined || props.focus.pitch !== undefined
        ? { bearing: props.focus.bearing ?? 0, pitch: props.focus.pitch ?? 0 }
        : {};
    m.easeTo({ center: props.focus.center, zoom: props.focus.zoom, ...angle, duration: cameraDuration(400) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focus?.center?.[0], props.focus?.center?.[1], props.focus?.zoom, props.focus?.bearing, props.focus?.pitch]);

  /**
   * The follow camera: one animated move per new target, corrected once.
   *
   * Keyed on the target's fields, not its identity, so App can rebuild the
   * object every tick without re-running the move on unrelated renders — and
   * so the move runs exactly when the road, not the render, says so.
   *
   * `easing: (t) => t` is deliberate. This is a tracking shot that runs every
   * second; ease-in/out on each leg would make the map breathe — accelerate,
   * decelerate, pause, repeat — and the pause between legs is precisely the
   * stutter being fixed. Linear hands the motion on at constant velocity, so
   * consecutive legs read as one continuous glide.
   *
   * The camera aims *ahead* of the car (`lookAheadMetres`) so the car sits in
   * the lower third with the road filling the view — 16% of the viewport
   * height below centre, measured against the nav layouts at 892×412 and
   * 1280×720 where the banner stack owns the top third. The look-ahead is
   * solved against the map's own projection and scales with the live zoom, so
   * pinching changes how much road is visible without shoving the car off the
   * bottom of the screen.
   *
   * The settle pass exists because the aim is solved against the transform
   * *before* the move, and the move's own tilt changes the mapping — the
   * first tick of a trip is the wide-awake one. It re-checks where the car
   * actually landed and corrects once if it is more than 6px off. A drag
   * disengages following before its `moveend` arrives, so `cancelled` is
   * already set and the pass never fights the driver.
   */
  useEffect(() => {
    const m = map.current;
    const f = props.follow;
    if (!m || !f) return;
    let cancelled = false;
    let corrections = 0;
    const offY = (m.getContainer().clientHeight || 412) * 0.16;

    const centreNow = (): LatLng => [m.getCenter().lng, m.getCenter().lat];
    const move = () => {
      const centre = centreNow();
      const ahead = lookAheadMetres((p) => m.project(p), centre, f.center, f.bearing, offY);
      m.easeTo({
        center: destinationPoint(f.center, f.bearing, ahead),
        bearing: f.bearing,
        pitch: f.pitch,
        // Corrections are small and should feel like the camera settling, not
        // setting off again.
        duration: cameraDuration(corrections ? 400 : 900),
        easing: (t) => t,
      });
    };
    move();

    const settle = () => {
      if (cancelled || corrections >= 2) return;
      const err = m.project(f.center).y - (m.project(centreNow()).y + offY);
      if (Math.abs(err) <= 6) return;
      corrections += 1;
      move();
      m.once('moveend', settle);
    };
    m.once('moveend', settle);

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.follow?.center?.[0], props.follow?.center?.[1], props.follow?.bearing, props.follow?.pitch]);

  /**
   * One-shot camera commands from the navigation controls.
   *
   * Keyed on the nonce so the same command can fire twice; keyed on nothing
   * else so a re-render does not re-zoom. `zoomIn`/`zoomOut` are MapLibre's own
   * animated steps (1 zoom level), and `north` animates the bearing home.
   */
  useEffect(() => {
    const m = map.current;
    const cmd = props.viewCmd;
    if (!m || !cmd) return;
    if (cmd.kind === 'zoom-in') m.zoomIn({ duration: cameraDuration(220) });
    else if (cmd.kind === 'zoom-out') m.zoomOut({ duration: cameraDuration(220) });
    else if (cmd.kind === 'flat') m.easeTo({ bearing: 0, pitch: 0, duration: cameraDuration(400) });
    else m.easeTo({ bearing: 0, duration: cameraDuration(350) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.viewCmd?.nonce]);

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
    props.reportPoints?.length ? `${props.reportPoints.length} reported hazard${props.reportPoints.length === 1 ? '' : 's'} on the map` : null,
  ].filter(Boolean).join('. ');

  return (
    <div className="map-host" role="img" aria-label={described}>
      <div ref={container} className={props.className ?? 'map'} />
    </div>
  );
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
 * regardless of the setting. Every camera move now goes through
 * `cameraDuration`, so the setting is honoured in one place.
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

/**
 * Frame some points: one point is zoomed to, several are fitted.
 *
 * Module-private — this used to be exported with a comment claiming "the
 * overlay" used it, and no module did. An export nobody consumes is a public
 * promise nobody can keep.
 */
function fitPoints(m: MLMap, pts: LatLng[], padding = 72) {
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

/** Style used with no network: the night palette over our own .osm geometry. */
function offlineStyle(): StyleSpecification {
  // The shared navigation set, not a copy of it: the offline road layers
  // (`canopy-osm-casing` / `-minor` / `-roads`) are owned by `offlineStyleSpec`
  // because they need a zoom ramp that starts well below 10, and a second
  // definition of `canopy-osm-roads` in the overlay list would be a duplicate
  // layer id, which MapLibre rejects outright. `navOverlays()` is exactly the
  // overlay set without those layers — which is what the hand-written copy
  // here was trying, and starting, to be.
  return offlineStyleSpec(navOverlays());
}

export default MapView;
