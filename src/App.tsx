import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TrafficOverlay } from './map/MapView';
import type { BuildProgress } from './osm/engine';
import type { OsmDataset } from './osm/engine.worker';
import { searchGazetteer } from './osm/engine.worker';
import { searchPlaces, type Place } from './nav/geocode';
import {
  resolveRoute, isOnline, watchConnectivity, PROVIDERS, localToRoute,
  NoRouteError, type ProviderId, type EngineAttempt,
} from './nav/providers';
import {
  DEFAULT_SELECTION, planRoute, engineStatuses, probeEngine, describeProvenance,
  describeAttempt, hasManeuvers, ANY_ONLINE, ANY_ONLINE_LABEL,
  type EngineSelection, type EngineId, type EngineProbe,
} from './nav/engines';
import type { Route, ValhallaManeuver } from './nav/valhalla';
import { maneuverIcon, isMajorManeuver, type LegStep } from './nav/maneuver';
import {
  describeTraffic, routeWithTraffic, type TrafficLevel,
} from './nav/traffic';
import { offRouteThreshold, progressAlong as routeProgress } from './nav/offroute';
import {
  observeFix, beginReroute, finishReroute, resetReroute, rerouteBanner,
  createRerouteState, type RerouteState,
} from './nav/reroute';
import {
  formatDistance, formatDuration, formatClock, lineLength,
  snapToPolyline, vertexAt, type LatLng,
} from './geo';
import { placeOnRoute, startPosition, type RoutePosition } from './nav/progress';
import { ink, accentNight, applyThemeTokens, type as T, DP, ICON } from './theme';
import { useLocation, type LocationMode } from './nav/location';
import {
  readSelection, writeSelection, readUnits, writeUnits,
  readApiKey, writeApiKey, readEndpoint, writeEndpoint, validateEndpoint,
  readPlaces, writePlace, type PlaceSlot, type SavedPlace,
} from './settings';
import { describeError } from './errors';
import { isVoiceAvailable, speak, cancelSpeech, voiceKey } from './nav/voice';
import {
  importRegionFile, localRegionId, localRegionName, regionLib, useRegions,
  restoreRegions,
} from './regions/store';
import { searchAll } from './osm/regions';
import {
  ManeuverIcon, IconSearch, IconBack, IconClose, IconMute, IconSound, IconOverview,
  IconLayers, IconTraffic, IconSettings, IconHome, IconGoto, IconChevronRight,
  IconFile, IconLocate, IconCar, IconRefresh,
  IconInfo, IconPin,
} from './icons';

const ENGINE_IDS: readonly string[] = [...PROVIDERS.map((p) => p.id as string), 'any-online'];

/* --------------------------- deferred views --------------------------- */

/**
 * MapLibre and the region manager are the two heaviest things the app can load,
 * and neither is needed to render the first frame. MapLibre alone was most of
 * the 1.4 MB entry chunk; the region manager drags in the streaming downloader,
 * the IndexedDB cache and the download catalogue.
 *
 * Both are `lazy` so they are fetched on first use instead of at startup. The
 * map is behind a `Suspense` boundary that paints the same background colour the
 * canvas would, so the swap is invisible rather than a flash of grey.
 *
 * The default exports already exist on both modules, so no interop shim.
 */
const MapView = lazy(() => import('./map/MapView'));
const RegionsScreen = lazy(() => import('./regions/RegionsScreen'));

type Screen = 'home' | 'search' | 'preview' | 'navigating' | 'steps' | 'settings' | 'import' | 'regions' | 'engines';

/**
 * Where Escape goes from each screen.
 *
 * Unwinding one level is what a back affordance means. Anything absent returns
 * to `home`, which is the right answer for a screen that *is* the top level.
 * `navigating` is deliberately absent: Escape must not end a trip, because
 * ending a navigation is a decision with consequences, not a dismissal.
 */
const BACK_FROM: Partial<Record<Screen, Screen>> = {
  search: 'home',
  preview: 'home',
  steps: 'navigating',
  settings: 'home',
  import: 'home',
  regions: 'home',
  engines: 'settings',
};

/**
 * Screen names for the landmark label.
 *
 * Every screen had no heading and no landmark, so navigating by either found
 * nothing. Naming the current screen means "jump to main" also answers "where am
 * I", which is the question a user of assistive technology is actually asking.
 */
const SCREEN_NAMES: Record<Screen, string> = {
  home: 'Home',
  search: 'Search',
  preview: 'Route preview',
  navigating: 'Navigating',
  steps: 'Turn list',
  settings: 'Settings',
  import: 'Import a map',
  regions: 'Regions',
  engines: 'Routing engines',
};

/**
 * Moves focus to an element without letting the browser scroll to it.
 *
 * `focus()` scrolls by default, which on a `position: fixed` layout means the
 * whole viewport jumps — and on the navigation screen, whose entire UI is
 * absolutely positioned over the map, a stray scroll is disorienting rather than
 * helpful. `preventScroll` is not universally supported on older Android
 * WebViews, so the position is restored afterwards rather than trusted.
 */
export function focusQuietly(el: HTMLElement | null | undefined) {
  if (!el) return;
  const x = window.scrollX;
  const y = window.scrollY;
  try {
    el.focus({ preventScroll: true });
  } catch {
    el.focus();
  }
  window.scrollTo(x, y);
}

/* ---------------------------- engines ---------------------------- */

/**
 * Who answered the current route, and what happened to every other engine.
 *
 * Held as state rather than derived from the selection because the selection is
 * a preference and this is a record of an event. They coincide only when nothing
 * failed, and the whole point of tracking them separately is the case where they
 * do not.
 */
interface RouteProvenance {
  used: ProviderId;
  fellBack: boolean;
  attempts: EngineAttempt[];
  /**
   * Wall-clock for the whole request, engine time included.
   *
   * `when` is a fact about when this was recorded, not a clock the UI reads, so
   * it is not a `Date` — a `Date` in state invites rendering it.
   */
  totalMs: number;
  when: number;
}

/* --------------------------- map layers --------------------------- */

/**
 * The map layers this app can honestly draw.
 *
 * Satellite/terrain is deliberately absent: no imagery source is configured
 * anywhere in the codebase, and a grey rectangle labelled "Satellite" would be
 * worse than offering nothing. If an imagery source is ever wired up it belongs
 * in this list.
 */
type LayerId = 'default' | 'traffic';

interface LayerOption {
  id: LayerId;
  label: string;
  /** One honest line about what this layer can and cannot do right now. */
  detail: string;
  available: boolean;
}

/**
 * What the routing provider told us about traffic, or why it told us nothing.
 *
 * This is a report of a query, never a guess: `status: 'ready'` only exists
 * when `routeWithTraffic` came back with `live` or `estimated` confidence.
 */
interface TrafficVerdict {
  status: 'idle' | 'probing' | 'ready' | 'unavailable';
  confidence?: 'live' | 'estimated';
  secondsSaved: number;
  /** The provider's own wording for the verdict, used verbatim in the UI. */
  note?: string;
  /** Why there is no traffic data. Empty when there is. */
  reason: string;
}

const NO_TRAFFIC: TrafficVerdict = { status: 'idle', secondsSaved: 0, reason: '' };

/**
 * Congestion along a route, measured from the provider's own numbers.
 *
 * Every Valhalla maneuver reports the length and the travel time of the road
 * ahead of it, so `time / length` is the speed the provider actually predicted
 * for that stretch — with live traffic loaded, that prediction is what the
 * congestion did to the ETA. Bins are relative to the route's own median
 * speed: a stretch covered at 60% of the typical pace for this trip is slow,
 * whatever that road's speed limit happens to be. Absolute thresholds would be
 * arbitrary; this only says "slower than the rest of this trip".
 *
 * Two rules keep it from inventing congestion:
 *  - a maneuver with no time or no length contributes nothing at all;
 *  - this is only ever called for a route the provider proved it had traffic
 *    for. `estimateTraffic()` bins a geometry by point spacing and labels every
 *    stretch `unknown`, so painting from it would be drawing fiction.
 */
function congestionSpans(route: Route): TrafficOverlay[] {
  const geometry = route.geometry;
  const last = geometry.length - 1;
  if (last < 1) return [];

  const measured: { i0: number; i1: number; mps: number }[] = [];
  // Valhalla reports maneuver and summary lengths in the requested units, so a
  // km route hands back kilometres. Getting this wrong would not show up as a
  // visible bug — the bins are relative — but the numbers would be fiction.
  const unitToMetres = route.units === 'miles' ? 1609.344 : 1000;
  for (const m of route.maneuvers) {
    const i0 = Math.max(0, Math.min(m.begin_shape_index, last));
    const i1 = Math.max(0, Math.min(m.end_shape_index, last));
    if (i1 <= i0 || !(m.time > 0)) continue;
    // Prefer the provider's length; fall back to the real geometry only when it
    // omitted one, and require a positive time either way.
    const metres = m.length > 0 ? m.length * unitToMetres : lineLength(geometry.slice(i0, i1 + 1));
    if (!(metres > 0)) continue;
    measured.push({ i0, i1, mps: metres / m.time });
  }
  if (!measured.length) return [];

  const sorted = measured.map((m) => m.mps).sort((a, b) => a - b);
  const median = sorted[Math.floor((sorted.length - 1) / 2)] || 0;
  if (!(median > 0)) return [];

  const bin = (mps: number): TrafficLevel => {
    const ratio = mps / median;
    return ratio < 0.6 ? 'dense' : ratio < 0.85 ? 'slow' : 'free';
  };

  // Chop each stretch into chunks so the tint follows the road rather than
  // cutting the corners as one long chord, without a feature per vertex.
  const CHUNK = 8;
  const spans: TrafficOverlay[] = [];
  for (const m of measured) {
    const level = bin(m.mps);
    // A stretch reported as free-flow keeps the normal blue route: painting it
    // green would claim a clear road we were never actually told about.
    if (level === 'free') continue;
    for (let i = m.i0; i < m.i1; i += CHUNK) {
      const j = Math.min(m.i1, i + CHUNK);
      const path = geometry.slice(i, j + 1);
      if (path.length > 1) spans.push({ level, path });
    }
  }
  return spans;
}

/* ------------------------------ App ------------------------------ */

export default function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [online, setOnline] = useState(isOnline());
  /**
   * Which engine answers, and whether another may answer instead.
   *
   * Two controls rather than one radio group, because "I want Valhalla" and "let
   * me have the offline engine if Valhalla is down" are different requests. See
   * `nav/engines.ts`.
   */
const [selection, setSelection] = useState<EngineSelection>(() => {
    const saved = readSelection(ENGINE_IDS);
    return {
      preferred: (ENGINE_IDS.includes(saved.engine) ? saved.engine : DEFAULT_SELECTION.preferred) as EngineId,
      allowFallback: saved.fallback !== 'strict',
    };
  });
  const [apiKey, setApiKey] = useState(() => readApiKey());
  const [endpoint, setEndpoint] = useState(() => readEndpoint());

  /** The ordered engine plan implied by the current selection. */
  const enginePlan = useMemo(
    () => planRoute(selection, { endpoint, apiKey }),
    [selection, endpoint, apiKey],
  );
  /**
   * Who actually answered the current route, and what became of every other
   * engine on the plan.
   *
   * Recorded as a fact rather than read back off the selection, because the two
   * genuinely differ whenever a fallback fires — and the fallback engine has
   * different capabilities, so labelling a locally-computed route with a hosted
   * provider's name would imply turn-by-turn that is not there.
   */
  const [provenance, setProvenance] = useState<RouteProvenance | null>(null);

  const [dataset, setDataset] = useState<OsmDataset | null>(null);
  const [progress, setProgress] = useState<BuildProgress | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  /**
   * Non-fatal import complaints, shown separately from `importError`.
   *
   * Distinct because they mean different things: an error means nothing was
   * changed, a warning means the import succeeded and something about it is
   * worth knowing. Rendering them with the same card would teach users to ignore
   * the card that means "your map is gone".
   */
  const [importWarn, setImportWarn] = useState<string | null>(null);
  // Subscribes to the library, so every screen re-renders when a region lands.
  const regions = useRegions();

  const [destination, setDestination] = useState<{ pos: LatLng; label: string } | null>(null);
  const [origin, setOrigin] = useState<LatLng | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [routing, setRouting] = useState(false);
  const [degraded, setDegraded] = useState<string[]>([]);

  const [progressAlong, setProgressAlong] = useState(0);
  const [focus, setFocus] = useState<{ center: LatLng; zoom: number } | null>(null);
  const [fitNonce, setFitNonce] = useState(0);
  const [muted, setMuted] = useState(false);
  // A character typed on a hardware keyboard before the search screen mounted.
  const [pendingInitialQuery, setPendingInitialQuery] = useState('');
  const [units, setUnits] = useState<'metric' | 'imperial'>(() => readUnits());

  /**
   * The driver's own Home and Work.
   *
   * Read through `readPlaces`, which validates: this is durable untrusted state,
   * and a coordinate that is not a coordinate reads back as a destination in the
   * ocean. See the note on `SavedPlace`.
   */
  const [places, setPlaces] = useState<Partial<Record<PlaceSlot, SavedPlace>>>(() => readPlaces());

  /**
   * Which slot the next picked destination should be saved to, or `null`.
   *
   * Set by tapping an unset launcher tile; consumed by the preview screen, whose
   * "Set as Home"/"Set as Work" button then writes here and clears it. Kept as
   * state rather than a ref because it has to survive the screen change.
   */
  const [placePending, setPlacePending] = useState<PlaceSlot | null>(null);

  const savePlace = useCallback((slot: PlaceSlot, value: SavedPlace) => {
    const problem = writePlace(slot, value);
    if (problem) { setSettingsNotice(problem); return; }
    setPlaces(readPlaces());
    setPlacePending(null);
  }, []);

  /**
   * Surfaced only when storage actually refused something.
   *
   * Cleared on the next successful write, so a private-window warning does not
   * become permanent.
   */
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);

  /**
   * Persist every settings change.
   *
   * One effect rather than four so the writes are visible in one place, and a
   * storage failure is reported once through the existing banner rather than
   * swallowed per-setting.
   */
  useEffect(() => {
    const problems = [
      writeSelection({
        engine: selection.preferred,
        fallback: selection.allowFallback ? 'fallback' : 'strict',
      }),
      writeUnits(units),
      writeApiKey(apiKey),
      writeEndpoint(endpoint),
    ].filter((p): p is string => p !== null);
    setSettingsNotice(problems.length ? problems[0] : null);
  }, [selection.preferred, selection.allowFallback, units, apiKey, endpoint]);
  // Valhalla expects km/miles; our formatters expect metric/imperial.
  const valhallaUnits: 'km' | 'miles' = units === 'imperial' ? 'miles' : 'km';

  // Real GPS on device, Geolocation API in a browser, simulated as a last resort.
  const { fix, mode: locationMode, error: locationError, stale: fixStale } = useLocation(true);
  const location = fix.pos;

  /* ----------------------- focus and announcement ---------------------- */

  /**
   * Where focus goes when the screen changes, and where it came back to.
   *
   * ## What was wrong
   *
   * There was exactly one `focus()` call in the whole app and it only ever
   * targeted the search field. Everything else changed screens by swapping React
   * state, which **unmounts the control that was just activated**. Focus then
   * fell to `<body>` — so the next Tab restarted from the top of the document.
   *
   * On the Regions screen that means tabbing through roughly sixty catalogue rows
   * to get back to where you were. And because a letter keypress while a button
   * is focused opened search, pressing `s` after tapping "Settings" both lost your
   * place *and* navigated away. On a head unit driven by a rotary controller or a
   * switch, losing focus is losing the app.
   *
   * So a screen change now does two things: it announces where the user has
   * arrived, and it puts focus on that screen's own heading so subsequent arrow
   * and Tab keys continue from the new content rather than from the document.
   */
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  /**
   * The element focused before the last screen change, so `Back` returns to it.
   *
   * Keyed by screen name rather than held as a single value: returning to the
   * launcher from Settings should return to the card that was pressed, but
   * returning to Search from the preview should return to the result list.
   */
  const returnFocus = useRef<{ screen: Screen; el: HTMLElement | null } | null>(null);

  /** Navigates to a screen, remembering where focus came from. */
  const go = useCallback((next: Screen) => {
    returnFocus.current = {
      screen: screenRef.current,
      el: (document.activeElement as HTMLElement | null) ?? null,
    };
    setScreen(next);
  }, []);

  const previousScreen = useRef<Screen | null>(null);
  useEffect(() => {
    if (previousScreen.current === screen) return;
    previousScreen.current = screen;

    /*
     * Focus the heading only if nothing has legitimately claimed it.
     *
     * The first version of this moved focus to the heading unconditionally, which
     * is right for Settings, Engines, Regions and the turn list — screens whose
     * only focusable element is a Back button — and wrong for Search, whose whole
     * purpose is the field: it has `autoFocus`, and the app's own `/` and
     * letter-keyboard shortcuts focus it explicitly. Steering focus to a
     * visually hidden heading meant that arriving at Search by tapping "Where
     * to?" put the caret nowhere, and typing did nothing until the driver found
     * the field with a pointer.
     *
     * So the rule is "the heading is the fallback", not "the heading wins". A
     * screen that knows better takes focus during its own commit, and this does
     * not take it away.
     */
    if (mounted.current && document.activeElement === document.body) {
      focusQuietly(headingRef.current);
    }

    // `document.title` is read by assistive technology as the window name and is
    // what a switch user or a screen-reader user gets from a task switcher. It
    // was the static string "Canopy Nav" for the life of the process, so nine
    // screens were nine identical entries.
    document.title = `${SCREEN_NAMES[screen]} · Canopy Nav`;
  }, [screen]);

  /* ------------------------ layers and traffic ------------------------ */

  const [layer, setLayer] = useState<LayerId>('default');
  const [layersOpen, setLayersOpen] = useState(false);
  /**
   * Mirror of `layersOpen` for the keydown handler.
   *
   * The handler is registered once on mount with `[]` deps so it does not churn
   * a listener on every render, which means it cannot close over the state
   * value. A ref keeps it current without re-subscribing.
   */
  const layersOpenRef = useRef(false);
  useEffect(() => { layersOpenRef.current = layersOpen; }, [layersOpen]);
  // Same reason: the key handler is registered once, so it needs the current
  // screen to know whether a bare letter is a shortcut into search or a
  // keystroke for whatever is already focused there.
  const screenRef = useRef<Screen>('home');
  useEffect(() => { screenRef.current = screen; }, [screen]);
  /** Whether the app has painted once, so first-paint is not announced. */
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; }, []);
  const [traffic, setTraffic] = useState<TrafficVerdict>(NO_TRAFFIC);
  // The pair a traffic query re-asks about: a route's ends, captured when the
  // route was computed, since the driver has moved since then.
  const [routeEnds, setRouteEnds] = useState<{ from: LatLng; to: LatLng } | null>(null);
  // Bumped whenever a verdict is invalidated, so a probe that resolves late
  // cannot resurrect it.
  const trafficProbe = useRef(0);

  /** A new route invalidates the previous route's traffic verdict with it. */
  const resetTraffic = useCallback((ends: { from: LatLng; to: LatLng } | null) => {
    trafficProbe.current += 1;
    setTraffic(NO_TRAFFIC);
    setRouteEnds(ends);
    setLayer('default');
    setLayersOpen(false);
  }, []);

  /**
   * Ask the routing provider whether it has anything real to say about traffic.
   *
   * `routeWithTraffic` returns its own confidence verdict, so this never has to
   * guess: `none` (or no answer, no online provider, no signal) leaves the
   * traffic layer unavailable and its toggle disabled, rather than tinting the
   * route with congestion nobody reported.
   */
  const probeTraffic = useCallback(async () => {
    const r = route;
    if (!r) return;
    const seq = ++trafficProbe.current;

    if (!online) {
      setTraffic({ status: 'unavailable', secondsSaved: 0, reason: describeTraffic(null, false) });
      return;
    }
    if (r.engine !== 'valhalla') {
      setTraffic({
        status: 'unavailable',
        secondsSaved: 0,
        reason: 'This route came from the offline map, which carries no live traffic',
      });
      return;
    }
    const ends = routeEnds ?? { from: origin ?? location, to: destination?.pos ?? r.geometry[0] };
    // Traffic needs a real online engine. Use the one that actually served the
    // route rather than the top of the plan: the route's geometry came from
    // somewhere specific, and asking a different server about it would attribute
    // one engine's congestion to another's route.
    const serving = provenance?.used;
    const prov = serving ? PROVIDERS.find((p) => p.id === serving) : null;
    const target = serving === 'valhalla-custom' ? endpoint : prov?.endpoint ?? '';
    if (!prov?.online || !target) {
      setTraffic({
        status: 'unavailable',
        secondsSaved: 0,
        reason: 'Traffic needs an online routing provider; none is available',
      });
      return;
    }

    setTraffic({ status: 'probing', secondsSaved: 0, reason: 'Checking the routing provider for traffic data' });
    const res = await routeWithTraffic(ends.from, ends.to, {
      endpoint: target,
      units: valhallaUnits,
      headers: serving === 'valhalla-simplerouting' && apiKey
        ? { Authorization: `Bearer ${apiKey}` }
        : undefined,
      offline: false,
    });
    // An answer that lands after the verdict was invalidated describes a road
    // the driver is no longer on.
    if (seq !== trafficProbe.current) return;

    if (!res || res.confidence === 'none') {
      setTraffic({ status: 'unavailable', secondsSaved: 0, reason: describeTraffic(res, true) });
      return;
    }
    setTraffic({
      status: 'ready',
      confidence: res.confidence,
      secondsSaved: res.secondsSaved,
      note: res.note ?? describeTraffic(res, true),
      reason: '',
    });
  }, [route, routeEnds, online, provenance?.used, endpoint, apiKey, valhallaUnits, origin, location, destination]);

  /** The traffic overlay only ever exists when the provider proved data. */
  const trafficReady = traffic.status === 'ready';

  /**
   * True when the verdict is real but can no longer be refreshed.
   *
   * Losing signal does not retract what the provider already told us about this
   * route, so the overlay stays up — but it is labelled as last-known, because
   * traffic an hour ago is not traffic now.
   */
  const trafficStale = trafficReady && !online;

  /** Why there is no traffic overlay, in the driver's own words. */
  const trafficReason = useMemo(() => {
    if (!online) return describeTraffic(null, false);
    if (route && route.engine !== 'valhalla') {
      return 'This route came from the offline map, which carries no live traffic';
    }
    if (traffic.status === 'probing') return 'Checking the routing provider for traffic data';
    if (traffic.status === 'ready') return traffic.note ?? describeTraffic(null, true);
    if (traffic.status === 'unavailable') return traffic.reason || describeTraffic(null, true);
    return 'Live traffic has not been checked yet';
  }, [online, route, traffic]);

  /** The verdict as a driver should read it, including whether it is current. */
  const trafficDetail = useMemo(() => {
    if (traffic.status === 'probing') return 'Checking the routing provider…';
    if (!trafficReady) return trafficReason;
    const how = traffic.confidence === 'live' ? 'Live data' : 'Estimated data';
    // The provider's own saving, in its own units. The panel needs one line, so
    // it gets the number; the status line under the buttons keeps the sentence.
    const saved = traffic.secondsSaved >= 60
      ? `saves about ${Math.max(1, Math.round(traffic.secondsSaved / 60))} min`
      : traffic.note ?? 'a faster route was picked';
    const short = `${how} · ${saved}`;
    return trafficStale ? `${short} · no signal to refresh` : short;
  }, [traffic, trafficReady, trafficStale, trafficReason]);

  /** Layers we can genuinely offer, with the reason for anything missing. */
  const layers = useMemo<LayerOption[]>(() => [
    {
      id: 'default',
      label: 'Default',
      detail: online ? 'Online map tiles' : 'Your offline .osm map',
      available: true,
    },
    {
      id: 'traffic',
      label: 'Traffic',
      detail: trafficDetail,
      available: trafficReady,
    },
  ], [online, trafficDetail, trafficReady]);

  /** What is on the map right now, spelled out where the driver can read it. */
  const layerName = layer === 'traffic' ? 'Traffic' : 'Default';

  const trafficSpans = useMemo<TrafficOverlay[]>(
    () => (layer === 'traffic' && trafficReady && route ? congestionSpans(route) : []),
    [layer, trafficReady, route],
  );


  useEffect(() => watchConnectivity(setOnline), []);

  // Publish the structural design tokens as CSS custom properties, so
  // `styles.css` reads its app-bar and grid-cell dimensions from `theme.ts`
  // instead of repeating the literals.
  useEffect(() => {
    applyThemeTokens();
  }, []);

  // Losing traffic (signal dropped, provider changed) must not leave the map
  // claiming a layer it can no longer draw.
  useEffect(() => {
    if (layer === 'traffic' && !trafficReady) setLayer('default');
  }, [layer, trafficReady]);

  // Opening the layers panel is the driver asking what the map can show, which
  // is the moment worth spending a provider request on.
  useEffect(() => {
    if (!layersOpen || traffic.status !== 'idle') return;
    void probeTraffic();
  }, [layersOpen, traffic.status, probeTraffic]);

  // Leaving a screen drops any query in flight along with its verdict.
  useEffect(() => {
    if (screen === 'navigating') return;
    trafficProbe.current += 1;
    setTraffic(NO_TRAFFIC);
    setLayersOpen(false);
  }, [screen]);

  /* ----------------------- keyboard shortcuts ----------------------- */
  // A head unit may have a hardware keyboard or voice input, and Android Auto
  // convention is that typing anywhere jumps to search. Without this the search
  // field has to be tapped first, which is exactly the wrong thing to make a
  // driver do.
  //
  // Two rules govern the order, and both were learned from a browser audit:
  //
  //  - **Named keys are matched before the alnum catch-all.** `m` is mute. The
  //    catch-all matched it first, so the documented mute shortcut opened the
  //    search screen seeded with "m" and never reached its own branch.
  //  - **Escape means "go back one level", not "go home".** It unconditionally
  //    set the screen to `home`, so pressing it dismissed the layers sheet by
  //    destroying the navigation underneath it, and left the engines screen by
  //    discarding an API key mid-typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');

      // A modified key is not ours.
      //
      // The bare-letter shortcuts below `preventDefault()` unconditionally, so
      // `Ctrl+M` toggled *this app's* mute instead of the platform's, and
      // `Ctrl+S` / `Cmd+S` discarded whatever the driver had typed and dumped
      // them on the search screen seeded with "s". `Ctrl+F` did the same with an
      // "f".
      //
      // This is also WCAG 2.1 SC 2.1.4 (Character Key Shortcuts), which requires
      // a single-character shortcut to be disableable or remappable — and in
      // practice it breaks switch users, whose assistive technology drives
      // single letters and whose every modifier-less shortcut this handler
      // intercepted.
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // Holding a key down must not repeat the action. Auto-repeat on a held `m`
      // toggled mute several times a second, so the visible result depended on
      // how long the key was held.
      if (e.repeat) return;

      // Escape unwinds one level at a time. A sheet first (it is an overlay on
      // top of whatever opened it), then the screen stack, and home only when
      // there is nowhere further back to go.
      if (e.key === 'Escape') {
        e.preventDefault();
        if (typing) {
          // Escape inside a field is the platform's "dismiss" gesture. Taking it
          // as navigation threw away whatever the user had typed.
          el?.blur();
          return;
        }
        setLayersOpen(false);
        if (layersOpenRef.current) return;
        // The same `go`, so Escape gets the focus handling every other
        // transition has, rather than being the one path that loses it.
        const target = (() => {
          const s = screenRef.current;
          // Ending a trip is a decision with consequences, not a dismissal, so
          // Escape deliberately does nothing here. There is an explicit Exit
          // control for it, and the exit path asks.
          if (s === 'navigating') return null;
          return BACK_FROM[s] ?? 'home';
        })();
        if (target) go(target);
        return;
      }

      // Typing guard first, and it is load-bearing rather than defensive.
      //
      // This branch used to sit *above* the guard with a comment defending it
      // ("works while typing too: muting is a thing a driver does mid-search").
      // It `preventDefault()`s unconditionally, so every `m` was swallowed
      // before it reached the field: the search box, the Simplerouting API
      // key and the custom Valhalla endpoint all silently refused the letter.
      // "Museum", "Memorial Dr" and `valhalla.mylab.net` are all untypable.
      // A driver cannot search for a place with an `m` in the name, which is a
      // total failure of the app's one primary input, introduced by a comment
      // arguing for the behaviour.
      if (typing) return;

      // Mute. Bare `m` is only safe once nothing is focused on a text field;
      // above that point the guard above has already returned.
      if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        setMuted((m) => !m);
        return;
      }

      if (e.key === '/') {
        // preventDefault stops Chrome's own quick-find from also consuming it,
        // and no seed character is set so "/" is not typed into the field.
        e.preventDefault();
        setPendingInitialQuery('');
        go('search');
        requestAnimationFrame(() => {
          document.querySelector<HTMLInputElement>('.inline-search input')?.focus();
        });
      } else if (e.key.length === 1 && /^[a-z0-9]$/i.test(e.key)) {
        // Only seed a query when this is a shortcut *into* search. On the
        // search screen itself a bare letter belongs to whatever is focused:
        // typing "coffee" then tapping a result row (which moves focus off the
        // field) and pressing `s` used to replace the whole query with `s`.
        if (screenRef.current === 'search') return;
        e.preventDefault();
        go('search');
        setPendingInitialQuery(e.key);
        requestAnimationFrame(() => {
          document.querySelector<HTMLInputElement>('.inline-search input')?.focus();
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // `go` has `[]` deps of its own, so it is referentially stable and listing it
    // documents the dependency without re-registering the listener.
  }, [go]);

  /* ------------------- restore cached regions on start ------------------- */
  // Parsing a province takes tens of seconds, so previously imported regions
  // are cached as parsed datasets. Rehydrate them so the app is usable
  // immediately rather than empty until the user re-imports.
  const [restoring, setRestoring] = useState(true);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const restored = await restoreRegions();
      if (cancelled || !restored.length) { if (!cancelled) setRestoring(false); return; }
      // Pick an active dataset: whichever cached region covers the driver best.
      const best = regionLib.bestFor(location) ?? restored[restored.length - 1];
      setDataset(best.dataset);
      setFocus({ center: [(best.bbox[0] + best.bbox[2]) / 2, (best.bbox[1] + best.bbox[3]) / 2], zoom: 13 });
      setFitNonce((n) => n + 1);
      setRestoring(false);
    })();
    return () => { cancelled = true; };
    // Intentionally runs once on mount; location is not yet known here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* -------------------------- OSM import -------------------------- */

  /**
   * Parse an extract and hand back its dataset.
   *
   * Every import goes through the region library, whatever screen started it:
   * the library owns one worker per region, so the map/search screens keep
   * working against `dataset` while `regions` holds the full set.
   */
  const build = useCallback(async (file: File, id: string, name: string, code: string) => {
    setImportError(null);
    setImportWarn(null);
    const ds = await importRegionFile({
      id, name, code, file,
      onProgress: setProgress,
      onError: setImportError,
      onWarn: setImportWarn,
      /*
       * The import worked; only the *cache* did not. Reporting this is what the
       * callback exists for, and it was passed by nobody in the repo — so a
       * device that ran out of room silently lost the region on next launch
       * while the UI said "1 loaded". Quota is precisely the case the driver
       * needs to hear about, because it is the one they can act on.
       */
      onPersistError: (m) => setImportWarn(
        m
          ? `Imported, but it could not be saved for next time: ${m}. It will be gone when you close the app.`
          : null,
      ),
    });
    if (!ds) return null;
    setDataset(ds);
    setOrigin(null);
    setRoute(null);
    setDestination(null);
    setFocus({ center: [(ds.bbox[0] + ds.bbox[2]) / 2, (ds.bbox[1] + ds.bbox[3]) / 2], zoom: 13 });
    setFitNonce((n) => n + 1);
    return ds;
  }, []);

  const onFile = useCallback(async (file: File) => {
    const ds = await build(file, localRegionId(file), localRegionName(file), 'local');
    if (ds) go('home');
  }, [build, go]);

  /* ---------------------------- routing --------------------------- */

  const doRoute = useCallback(async (dest: { pos: LatLng; label: string }) => {
    setDestination(dest);
    setRouteError(null);
    setRouting(true);
    setDegraded([]);
    const from = origin ?? location;
    const t0 = Date.now();
    try {
      const outcome = await resolveRoute(
        {
          from,
          to: dest.pos,
          // `provider` is only the head of the plan; it is kept in the request so
          // the shape stays valid for callers that predate plans.
          provider: enginePlan[0] ?? 'local',
          plan: enginePlan,
          strict: !selection.allowFallback,
          units: valhallaUnits,
          avoid: [],
        },
        dataset,
        { apiKey, endpoint },
      );
      setRoute(outcome.route);
      setDegraded(outcome.degraded.map((d) => `${d.provider}: ${d.reason}`));
      setProvenance({
        used: outcome.used,
        fellBack: outcome.fellBack,
        attempts: outcome.attempts,
        totalMs: Date.now() - t0,
        when: Date.now(),
      });
      beginRouteProgress(outcome.route.geometry);
      resetTraffic({ from, to: dest.pos });
      go('preview');
      setFitNonce((n) => n + 1);
    } catch (e) {
      // Single-dataset routing can't span extracts. With several regions
      // downloaded the library merges them and routes across the seam.
      const multi = regions.length > 1 ? regionLib.route(from, dest.pos) : null;
      if (multi) {
        const next = localToRoute(multi.result, valhallaUnits);
        setRoute(next);
        setDegraded([`Region library: ${multi.regions.map((id) => regionLib.get(id)?.name ?? id).join(' → ')}`]);
        // This route came from the region library, not from any engine on the
        // plan, so it needs a trace of its own. Without this the status pill
        // would keep naming whichever engine last answered a *different* route.
        setProvenance({
          used: 'local',
          fellBack: true,
          attempts: [
            ...enginePlan.map((engine) => ({
              engine,
              label: PROVIDERS.find((p) => p.id === engine)?.label ?? engine,
              online: PROVIDERS.find((p) => p.id === engine)?.online ?? false,
              outcome: 'failed' as const,
              reason: 'Could not route this pair alone',
              ms: null,
            })),
            {
              engine: 'local' as ProviderId,
              label: 'Region library',
              online: false,
              outcome: 'served' as const,
              reason: null,
              ms: Date.now() - t0,
            },
          ],
          totalMs: Date.now() - t0,
          when: Date.now(),
        });
        beginRouteProgress(next.geometry);
        resetTraffic({ from, to: dest.pos });
        go('preview');
        setFitNonce((n) => n + 1);
      } else {
        setRoute(null);
        // `route()` is nullable for three unrelated reasons — no region covers
        // the pair, no path exists, or the merge did not fit in memory — and the
        // caller cannot tell them apart from the null. Only the third is
        // actionable, so it is the one the library records: telling a driver
        // "no route" when the truth is "this device cannot compute this route"
        // is how a reachable destination becomes an unreachable one.
        //
        // `(e as Error).message` was here, and it throws *inside the catch block*
        // when the rejection value is a string, a bare object, or null — which
        // `fetch` does produce. The throw escapes the catch, so the `finally`
        // never runs, `routing` stays `true` forever, the preview spins
        // indefinitely, and the only trace is one unhandled rejection that the
        // error boundary logs. `describeError` is the coercion already used in
        // `regions/store.ts` for exactly this reason.
        setRouteError(regionLib.lastRefusal ?? describeError(e));
        resetTraffic(null);
        go('preview');
        // Clear the trace: leaving the previous route's provenance on screen
        // would attribute a failure to whichever engine served the last success.
        setProvenance(null);
      }
    } finally {
      setRouting(false);
    }
  }, [dataset, origin, location, enginePlan, selection.allowFallback, valhallaUnits, apiKey, endpoint, regions.length, resetTraffic, go]);

  /* ------------------------- guidance model ----------------------- */

  /**
   * How far along the route the car is, in metres, monotonic.
   *
   * Declared *before* the guidance memos on purpose. A `useMemo` callback runs
   * during render, so anything it closes over has to be initialised by then — a
   * ref declared further down is in its temporal dead zone and throws
   * "Cannot access before initialization", which the error boundary turns into a
   * recovery card. 747 unit tests did not see it, because none of them render
   * `App`; only the browser suite could, and it did.
   *
   * It is a ref rather than state because it is updated on every GPS fix (about
   * 1 Hz) and nothing else needs to re-render from it: the readouts derive from
   * `progressAlong`, which is state and already re-renders on the same fixes.
   * The policy lives in `nav/progress.ts` so the three properties it guarantees
   * are testable without React.
   */
  const routePos = useRef<RoutePosition>({ along: 0, remaining: 0, deviation: 0, onRoute: true });

  /**
   * Start progress over — for a new route, or when leaving navigation.
   *
   * Declared with the ref, above every memo, for the same reason: a helper a memo
   * closes over has to exist by the time render reaches it.
   *
   * The placement in metres has to be cleared *with* the fraction, not instead of
   * it. Metres measured along the previous route would immediately clamp the new
   * route's progress to wherever the old trip ended, and because the clamp is
   * monotonic that is unrecoverable for the rest of the drive: the new ETA would
   * open reading a distance belonging to a road the driver is not on, and would
   * never come down. Resetting the fraction alone would have reintroduced exactly
   * the bug this ref exists to remove.
   */
  const beginRouteProgress = (geometry: LatLng[]) => {
    setProgressAlong(0);
    routePos.current = startPosition(geometry);
  };

  /**
   * Start progress over — for a new route, or when leaving navigation.
   *
   * The placement in metres has to be cleared *with* the fraction, not instead of
   * it. Metres measured along the previous route would immediately clamp the new
   * route's progress to wherever the old trip ended, and because the clamp is
   * monotonic that is unrecoverable for the rest of the drive: the new ETA would
   * open reading a distance belonging to a road the driver is not on, and would
   * never come down. Resetting the fraction alone would have reintroduced
   * exactly the bug this ref exists to remove.
   */
  const guidance = useMemo(() => {
    if (!route || route.engine === 'osm-local') return null;
    const geometry = route.geometry;
    if (geometry.length < 2) return null;
    const legs = route.maneuvers;
    const totalM = lineLength(geometry);

    // Which maneuver are we past?
    const travelled = geometry.slice(0, Math.max(2, Math.floor(progressAlong * (geometry.length - 1)) + 1));
    const remaining = geometry.slice(Math.max(0, travelled.length - 1));
    const remainingM = lineLength(remaining);

    let activeIdx = 0;
    for (let i = 0; i < legs.length; i++) {
      if (progressAlong >= legs[i].begin_shape_index / (geometry.length - 1)) activeIdx = i;
    }
    const active = legs[activeIdx];
    const next = legs.slice(activeIdx + 1).find((m) => m.type !== 4) ?? active;

    /**
     * Distance from where the driver is to the point the next turn happens.
     *
     * This has to be measured along the road, because the alternative is wrong in
     * a way that is hard to spot: a shape-index *ratio* between two maneuvers
     * carries no distance information, so scaling `remainingM` by it produces a
     * number that shrinks with the remaining trip rather than with the length of
     * the next leg. On a 20-minute route that rendered "10 min" as the distance
     * to a turn two streets away, and the imminent-turn dimming (below 40 m)
     * never fired at all.
     */
    const distToNext = (() => {
      // `remaining` begins at the last point already driven, which is where the
      // driver effectively is.
      const here = travelled.length - 1;
      const leg = geometry.slice(here, Math.max(here, next.begin_shape_index) + 1);
      return lineLength(leg);
    })();

    const steps: LegStep[] = legs.map((m) => ({
      icon: maneuverIcon(m.type),
      major: isMajorManeuver(m.type),
      title: m.instruction,
      distanceLabel: formatDistance(
        lineLength(geometry.slice(m.begin_shape_index, m.end_shape_index + 1)), units),
      distanceMeters: lineLength(geometry.slice(m.begin_shape_index, m.end_shape_index + 1)),
      shapeIndex: m.begin_shape_index,
      shield: m.sign?.exit_number_elements?.map((e) => e.text).join('') || undefined,
      roundaboutExits: m.roundabout_exit_count,
    }));

    return { active, next, distToNext, remainingM, totalM, steps, travelled };
  }, [route, progressAlong, units]);

  /* --------------------- local-engine guidance -------------------- */

  const localGuidance = useMemo(() => {
    if (!route || route.engine !== 'osm-local' || !dataset) return null;
    const geometry = route.geometry;
    if (geometry.length < 2) return null;
    const idx = Math.floor(progressAlong * (geometry.length - 1));
    const snap = snapToPolyline(location, geometry);
    const totalM = lineLength(geometry);
    /**
     * Where the car is, from the *monotonic* placement rather than a fresh
     * projection of this fix.
     *
     * This used to be `snappedIndex(location, geometry, snap.index)` — the
     * closest segment of the whole line to the current fix, with no memory of
     * where the car already was. That is the single change behind the ETA bar
     * flipping between `0 m` and `670 m` on a 36 m move, and behind it reading
     * `0 m` while the driver was 900 m off course: on a route that runs beside
     * itself the nearest point can be *behind* the car, and a fix too far off
     * the line to place the driver snapped to wherever on the line it happened
     * to land — sometimes the end. `routePos` is only ever advanced by fixes
     * inside the off-route threshold, and never moves backwards; see
     * `nav/progress.ts`, whose properties are asserted in `test/progress.spec.ts`.
     */
    const pos = routePos.current;
    const here = vertexAt(geometry, pos.along);
    const remainingM = pos.remaining;

    /**
     * Derive turn instructions from bearing change at each vertex.
     *
     * The offline engine produces no maneuvers, so this is what the maneuver
     * banner has to work from. It previously computed the steps and then only
     * ever used them on the Steps screen: the banner itself showed a literal
     * "0 m" and "Continue" for the whole trip, because it read `guidance` (null
     * for `osm-local`) and touched `localGuidance` only for the remaining
     * distance. Since the offline engine is the *default*, that made the largest
     * number on the navigation screen meaningless for most users.
     */
    const steps: LegStep[] = [];
    for (let i = 8; i < geometry.length - 8; i += 8) {
      const inB = bearingBetween(geometry[i - 8], geometry[i]);
      const outB = bearingBetween(geometry[i], geometry[i + 8]);
      let turn = outB - inB;
      while (turn > 180) turn -= 360;
      while (turn < -180) turn += 360;
      const kind = turnKind(turn);
      if (!kind) continue;
      const legM = lineLength(geometry.slice(i, i + 9));
      steps.push({
        icon: kind, major: Math.abs(turn) > 120,
        title: `${kind.replace('-', ' ')} onto unnamed road`,
        // A real distance, so the Steps screen is not a column of bare names.
        distanceLabel: formatDistance(legM, units), distanceMeters: legM, shapeIndex: i,
      });
    }

    // The next turn ahead of the driver, and how far along the line to it.
    const nextIdx = steps.findIndex((s) => s.shapeIndex > here);
    const nextStep = nextIdx === -1 ? null : steps[nextIdx];
    const distToNext = nextStep
      ? lineLength(geometry.slice(here, nextStep.shapeIndex + 1))
      : 0;

    return {
      snap, remainingM, totalM, steps, idx,
      nextStep, distToNext,
      // The dimmed "already driven" portion is derived from the same
      // placement as the ETA, so the drawn line and the number can no longer
      // disagree about where the car is.
      travelled: geometry.slice(0, here + 1),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, dataset, progressAlong, location]);

  /* -------------------- position-driven progress -------------------- */

  const navActive = screen === 'navigating' && route !== null;

  /**
   * Advance "already driven" from where the car actually is.
   *
   * A timer can only guess at this; the GPS knows. Each fix is projected onto
   * the route (`snapToPolyline`) and turned into a fraction of the way along it
   * (`progressAlong`), so the dimmed part of the line tracks the driver instead
   * of the clock. Two guards keep that honest:
   *
   *  - a projection that lands further from the line than `offRouteThreshold`
   *    allows is ignored, because past that point "closest point on the route" is
   *    a guess. That is also what rejects the simulated fallback position, which
   *    sits thousands of kilometres from any route;
   *  - progress never moves backwards, because you cannot un-drive a road, and
   *    GPS jitter would otherwise flicker the grey line.
   */
  const positionDrives = useRef(false);
  const rerouteState = useRef<RerouteState>(createRerouteState());
  const [rerouteNotice, setRerouteNotice] = useState<string | null>(null);

  /**
   * Feed each fix to the reroute policy.
   *
   * The policy is a pure function (`observeFix`), so all the judgement about
   * when *not* to act lives in `nav/reroute.ts` where it can be tested. This
   * effect only supplies the fix and does what the policy asks.
   *
   * The critical property is what happens on a trigger: `route` is deliberately
   * not cleared. The old line and its guidance stay on screen for the whole
   * request, so a driver who is lost is never also left without directions. A
   * failed attempt restores nothing because nothing was removed.
   */
  useEffect(() => {
    if (!navActive || !route) {
      rerouteState.current = resetReroute();
      setRerouteNotice(null);
      return;
    }
    const geometry = route.geometry;
    // A stale position is not evidence of a deviation. `watchPosition` keeps its
    // last value when signal drops, so without this a frozen fix re-confirms
    // after every settle window and the app requests a new route every 30 s for
    // as long as the driver is stuck. The reroute guard also checks progress
    // (see `madeProgress`); this is the cheaper, earlier signal.
    const { state, trigger, origin } = fixStale
      ? { state: rerouteState.current, trigger: false, origin: null }
      : observeFix(
          rerouteState.current,
          geometry,
          location,
          fix.speed,
          Date.now(),
          // Needed by the stale-position guard: a reroute that does not move the
          // driver nearer the destination is evidence of a frozen fix, not of a
          // driver who is lost, and must not issue a request.
          destination?.pos,
        );
    rerouteState.current = state;
    setRerouteNotice(rerouteBanner(state, geometry, units));

    if (!trigger || !origin || !destination) return;
    rerouteState.current = beginReroute(state);
    setRerouteNotice('Off route — finding a new way');

    void (async () => {
      let ok = false;
      let reason: string | undefined;
      try {
        const outcome = await resolveRoute(
          {
            from: origin,
            to: destination.pos,
            provider: enginePlan[0] ?? 'local',
            plan: enginePlan,
            strict: !selection.allowFallback,
            units: valhallaUnits,
            avoid: [],
          },
          dataset,
          { apiKey, endpoint },
        );
        ok = true;
        // Only now is the old route replaced, and it is replaced wholesale so
        // guidance, steps and ETA all come from the engine that answered.
        setRoute(outcome.route);
        setProvenance({
          used: outcome.used,
          fellBack: outcome.fellBack,
          attempts: outcome.attempts,
          totalMs: 0,
          when: Date.now(),
        });
        beginRouteProgress(outcome.route.geometry);
        resetTraffic({ from: origin, to: destination.pos });
        setFitNonce((n) => n + 1);
      } catch (e) {
        // `describeError`, not `(e as Error).message`: a rejection value that is
        // not an `Error` makes that expression `undefined` — or a `TypeError`
        // thrown from inside the catch block, which skips the cleanup below.
        reason = e instanceof NoRouteError ? e.message : describeError(e);
      } finally {
        rerouteState.current = finishReroute(
          rerouteState.current, ok, Date.now(), reason, origin,
        );
        setRerouteNotice(
          rerouteBanner(rerouteState.current, geometry, units),
        );
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navActive, route, location]);

  useEffect(() => {
    if (!navActive || !route) return;
    const geometry = route.geometry;
    if (geometry.length < 2) {
      positionDrives.current = false;
      return;
    }
    const snap = snapToPolyline(location, geometry);
    if (snap.dist > offRouteThreshold(fix.speed)) {
      positionDrives.current = false;
      return;
    }
    positionDrives.current = true;
    /**
     * Advance the placement, then progress from *it*.
     *
     * Progress used to be clamped independently of the ETA, so the two could
     * disagree: progress was monotonic but the remaining distance was not,
     * because the ETA re-projected each fix from scratch. Deriving progress from
     * the same monotonic placement is what makes the drawn line, the distance to
     * the next turn and the remaining distance agree with each other.
     */
    routePos.current = placeOnRoute(geometry, location, routePos.current, offRouteThreshold(fix.speed));
    setProgressAlong((prev) => Math.max(prev, routeProgress(geometry, vertexAt(geometry, routePos.current.along))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navActive, route, location]);

  /**
   * Fallback tick, for when there is no usable position.
   *
   * It stays off while a fix is placing the car on the route: a car waiting at a
   * junction must not watch its route crawl forward, and a moving one is already
   * being tracked from its own position.
   */
  useEffect(() => {
    if (!navActive || !route) return;
    const id = setInterval(() => {
      if (positionDrives.current) return;
      setProgressAlong((p) => {
        // Advance in proportion to route duration, so a 5-minute and a
        // 2-hour trip both animate at a believable pace.
        const total = route.summary.time || 1;
        const next = p + 1 / total;
        return next >= 1 ? 0 : next;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [navActive, route]);

  /* ----------------------------- render --------------------------- */

  /**
 * One banner, most urgent first.
 *
 * A reroute notice outranks a stale degradation note: if the driver has just
 * gone off-route, why the last request mentioned a missing API key is history.
 *
 * `degraded` used to be folded into this same string as `routeError`, so a
 * *successful* fallback route rendered an engine warning inside the red error
 * card — on the preview screen, directly above the Start button, which is the
 * worst possible place to imply a trip is not viable when it very much is. A
 * fallback is the *expected* path here: the offline engine is the default and
 * Valhalla is the fallback, so this fired on most routes. It is now its own
 * value and takes its own tone at each consumer.
 */
const banner = rerouteNotice ?? routeError ?? null;

  /**
   * Where each turn happens, as map points.
   *
   * Memoised on the route, and filtered to finite, in-range coordinates.
   *
   * Two defects in one expression that used to be inline in the JSX:
   *
   *   - it was a fresh array on every render, and `MapView`'s overlay effect
   *     lists it as a dependency, so App's 1 Hz re-render re-ran `applyOverlays`
   *     every second — which, with a dataset loaded, meant re-serialising the
   *     entire provincial road network to GeoJSON once a second.
   *   - `route.geometry[Math.min(m.begin_shape_index, geometry.length - 1)]` is
   *     `undefined` when `begin_shape_index` is absent or non-numeric (NaN), or
   *     when the geometry is empty (`-1`), and an undefined coordinate became
   *     `{ type: 'Point', coordinates: undefined }` handed to `setData`. A
   *     malformed response from an engine produced an invalid FeatureCollection
   *     on every render instead of no markers.
   */
  const maneuverPoints = useMemo<LatLng[]>(() => {
    if (route?.engine !== 'valhalla' || route.geometry.length === 0) return [];
    const out: LatLng[] = [];
    for (const m of route.maneuvers) {
      const i = m.begin_shape_index;
      if (!Number.isFinite(i)) continue;
      const pt = route.geometry[Math.min(Math.max(0, i), route.geometry.length - 1)];
      if (pt && Number.isFinite(pt[0]) && Number.isFinite(pt[1])) out.push(pt);
    }
    return out;
  }, [route]);

  return (
    /*
      Landmarks.

      The document had no `main` and no headings at all, so a screen-reader user
      navigating by landmark or by heading found nothing on any of the nine
      screens. `aria-label` on the main region names the current screen, which
      makes "jump to main" tell you where you are as well as getting you there.
    */
    <main className="app" aria-label={`Canopy Nav — ${SCREEN_NAMES[screen]}`}>
      {/*
        "You have arrived on <screen>", mounted once for the life of the app.

        ## Why it lives here and not in each screen

        A live region has to exist *before* the text inside it changes. NVDA,
        JAWS and TalkBack all commonly discard content that is inserted into a
        live region in the same commit that creates the region — which is exactly
        what per-screen regions do, since each screen's component mounts together
        with its first message. The navigation announcements in particular were
        created *with* "In 240 m, turn right" already inside, so the first
        instruction of the trip — the one the driver needed to hear to leave the
        parking lot — was never announced at all. It only started working from the
        second maneuver, when the text changed.

        Mounted once, above every screen, only the text changes. That is the model
        the specification describes, and it is the only arrangement that works.

        `aria-atomic` so a screen name with a count in it is read whole.
      */}
      <div
        className="visually-hidden"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {mounted.current ? `Now on ${SCREEN_NAMES[screen]}` : ''}
      </div>

      <Suspense fallback={null}>
      <MapView
        dataset={dataset}
        useTiles={online}
        route={route?.geometry ?? null}
        travelled={guidance?.travelled ?? localGuidance?.travelled ?? null}
        traffic={trafficSpans}
        origin={origin ?? location}
        destination={destination?.pos ?? null}
        location={location}
        maneuverPoints={maneuverPoints}
        focus={focus}
        fitNonce={fitNonce}
      />
      </Suspense>

      {screen === 'navigating' && route && (
        <NavOverlay
          headingRef={headingRef}
          route={route}
          guidance={guidance}
          localGuidance={localGuidance}
          rerouteNotice={rerouteNotice}
          location={location}
          progressAlong={progressAlong}
          units={units}
          muted={muted}
          online={online}
          degraded={degraded.length > 0}
          locationMode={locationMode}
          layer={layer}
          layerName={layerName}
          layers={layers}
          layersOpen={layersOpen}
          traffic={traffic}
          trafficOn={layer === 'traffic'}
          trafficReady={trafficReady}
          trafficStale={trafficStale}
          trafficReason={trafficReason}
          onMute={() => setMuted((m) => !m)}
          onExit={() => { go('home'); beginRouteProgress(route.geometry); }}
          onOverview={() => setFitNonce((n) => n + 1)}
          onRecenter={() => setFocus({ center: location, zoom: 17 })}
          onSteps={() => go('steps')}
          onToggleTraffic={() =>
            setLayer((l) => (l === 'traffic' && trafficReady ? 'default' : 'traffic'))}
          onToggleLayers={() => setLayersOpen((o) => !o)}
          onPickLayer={(id) => {
            setLayer(id);
            setLayersOpen(false);
          }}
          onCloseLayers={() => setLayersOpen(false)}
          onCheckTraffic={() => { void probeTraffic(); }}
        />
      )}

      {screen === 'preview' && (
        <PreviewCard
          route={route}
          destination={destination}
          units={units}
          routing={routing}
          error={banner}
          degraded={degraded[0] ?? null}
          headingRef={headingRef}
          places={places}
          onSetPlace={(slot) => {
            if (!destination) return;
            savePlace(slot, { pos: destination.pos, label: destination.label });
            setImportWarn(`Saved "${destination.label}" as ${slot === 'home' ? 'Home' : 'Work'}.`);
          }}
          onGo={() => go('navigating')}
          onBack={() => go('home')}
          onProvider={() => go('settings')}
        />
      )}

      {screen === 'home' && (
        <HomeScreen
          restoring={restoring}
          dataset={dataset}
          regionCount={regions.length}
          online={online}
          provenance={provenance}
          locationMode={locationMode}
          locationError={locationError}
          progress={progress}
          error={importError}
          warn={importWarn}
          degraded={degraded[0] ?? null}
          onDismissError={() => setImportError(null)}
          onDismissWarn={() => setImportWarn(null)}
          route={route}
          onImport={() => go('import')}
          onImportFile={onFile}
          onRegions={() => go('regions')}
          onSearch={() => go('search')}
          onContinue={() => route && go('navigating')}
          onSettings={() => go('settings')}
          onRoute={(pos, label) => doRoute({ pos, label })}
          places={places}
          headingRef={headingRef}
          onPickPlace={(slot) => {
            // Tapping an unset tile opens search with the slot named, so the
            // driver knows what picking a result is *for*.
            setPlacePending(slot);
            setPendingInitialQuery('');
            go('search');
            requestAnimationFrame(() => {
              document.querySelector<HTMLInputElement>('.inline-search input')?.focus();
            });
          }}
          onSetPlace={(slot) => {
            if (!destination) return;
            savePlace(slot, { pos: destination.pos, label: destination.label });
            setImportWarn(`Saved "${destination.label}" as ${slot === 'home' ? 'Home' : 'Work'}.`);
          }}
          onClear={() => { setRoute(null); setDestination(null); setOrigin(null); resetTraffic(null); }}
          destination={destination}
          units={units}
        />
      )}

      {screen === 'search' && (
        <SearchScreen
          dataset={dataset}
          regions={regions}
          online={online}
          location={location}
          initialQuery={pendingInitialQuery}
          headingRef={headingRef}
          onInitialQueryConsumed={() => setPendingInitialQuery('')}
          pickHint={placePending ? `Saved as ${placePending === 'home' ? 'Home' : 'Work'} once you pick a destination` : null}
          onPick={(pos, label) => {
            // Choosing a destination while a slot is pending saves it, so the
            // unset tile becomes set in the one flow a driver already knows.
            if (placePending) {
              savePlace(placePending, { pos, label });
              setImportWarn(`Saved "${label}" as ${placePending === 'home' ? 'Home' : 'Work'}.`);
              go('home');
              return;
            }
            go('home');
            doRoute({ pos, label });
          }}
          onBack={() => { setPlacePending(null); go('home'); }}
        />
      )}

      {screen === 'steps' && (
        <StepsScreen
          steps={guidance?.steps ?? localGuidance?.steps ?? []}
          headingRef={headingRef}
          onBack={() => go('navigating')}
          inferred={!guidance && !!localGuidance}
          engineLabel={provenance ? describeProvenance(provenance.used, provenance.fellBack) : null}
          destination={destination}
        />
      )}

      {screen === 'settings' && (
        <SettingsScreen
          selection={selection}
          setSelection={setSelection}
          online={online}
          dataset={dataset}
          regionCount={regions.length}
          apiKey={apiKey}
          setApiKey={setApiKey}
          endpoint={endpoint}
          setEndpoint={setEndpoint}
          units={units}
          setUnits={setUnits}
          provenance={provenance}
          storageNotice={settingsNotice}
          headingRef={headingRef}
          onBack={() => go('home')}
          onImport={() => go('import')}
          onRegions={() => go('regions')}
          onEngines={() => go('engines')}
        />
      )}

      {screen === 'engines' && (
        <EnginesScreen
          selection={selection}
          setSelection={setSelection}
          online={online}
          hasMap={dataset !== null || regions.length > 0}
          apiKey={apiKey}
          setApiKey={setApiKey}
          endpoint={endpoint}
          setEndpoint={setEndpoint}
          provenance={provenance}
          headingRef={headingRef}
          onBack={() => go('settings')}
        />
      )}

      {screen === 'import' && (
        <ImportScreen
          progress={progress}
          error={importError}
          warn={importWarn}
          headingRef={headingRef}
          onDismissError={() => setImportError(null)}
          onDismissWarn={() => setImportWarn(null)}
          onFile={onFile}
          onBack={() => go('home')}
        />
      )}

      {screen === 'regions' && (
        <Suspense fallback={null}>
        <RegionsScreen
          units={units}
          location={location}
          onBack={() => go('home')}
          onActivated={() => { setImportError(null); setProgress(null); }}
          onMapFocus={(center, zoom) => setFocus({ center, zoom })}
          onPreviewRoute={(result, to, label, via) => {
            setDestination({ pos: to, label });
            const next = localToRoute(result, valhallaUnits);
            setRoute(next);
            setRouteError(null);
            setDegraded([`Region library: ${via.map((id) => regionLib.get(id)?.name ?? id).join(' → ')}`]);
            beginRouteProgress(next.geometry);
            resetTraffic({ from: location, to });
            go('preview');
            setFitNonce((n) => n + 1);
          }}
        />
        </Suspense>
      )}
    </main>
  );
}

/* ---------------------- bearing / turn helpers --------------------- */

function bearingBetween(a: LatLng, b: LatLng): number {
  const toRad = Math.PI / 180;
  const lon1 = a[0] * toRad, lat1 = a[1] * toRad;
  const lon2 = b[0] * toRad, lat2 = b[1] * toRad;
  const y = Math.sin(lon2 - lon1) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

function turnKind(delta: number): LegStep['icon'] | null {
  const d = Math.abs(delta);
  if (d < 18) return null;
  if (d < 45) return delta > 0 ? 'slight-right' : 'slight-left';
  if (d < 115) return delta > 0 ? 'right' : 'left';
  if (d < 150) return delta > 0 ? 'sharp-right' : 'sharp-left';
  return delta > 0 ? 'uturn-right' : 'uturn-left';
}

/* ---------------------------- HomeScreen ---------------------------- */

interface HomeProps {
  /** True while previously saved regions are rehydrated from storage. */
  restoring: boolean;
  dataset: OsmDataset | null;
  regionCount: number;
  online: boolean;
  provenance: RouteProvenance | null;
  locationMode: LocationMode;
  locationError: string | null;
  progress: BuildProgress | null;
  /**
   * Saved Home and Work, or `undefined` where the driver has not set one.
   *
   * These tiles used to point at two fixed coordinates in the English Channel.
   * A tile labelled "Home" that navigates somewhere nobody lives is worse than
   * no tile: it reads as a broken feature rather than as an unset one, and on an
   * offline extract it produced a plausible-looking "No route found" for a trip
   * to nowhere.
   */
  places: Partial<Record<PlaceSlot, SavedPlace>>;
  /** This screen's heading, focused on arrival. */
  headingRef?: React.Ref<HTMLHeadingElement>;
  onPickPlace: (slot: PlaceSlot) => void;
  onSetPlace: (slot: PlaceSlot) => void;
  error: string | null;
  /** Non-fatal: the import succeeded, with a caveat worth reading. */
  warn?: string | null;
  /** The last route came from a fallback engine, and this names which. */
  degraded?: string | null;
  onDismissError?: () => void;
  onDismissWarn?: () => void;
  route: Route | null;
  onImport: () => void;
  /**
   * Import straight from a drop or file choice on this screen.
   *
   * Unused before: `ImportScreen` has its own picker, so the two routes to the
   * same work both existed. Rather than leave a dead prop, the home screen now
   * accepts a dropped file directly -- a drag onto the home screen is the most
   * natural gesture available there, and it needs no navigation.
   */
  onImportFile: (f: File) => void;
  onRegions: () => void;
  onSearch: () => void;
  onContinue: () => void;
  onSettings: () => void;
  onRoute: (pos: LatLng, label: string) => void;
  onClear: () => void;
  /** Named so the launcher can say where resuming would take you. */
  destination?: { pos: LatLng; label: string } | null;
  /** The user's unit choice, so this screen does not hard-code one. */
  units: 'metric' | 'imperial';
}

function HomeScreen(p: HomeProps) {
  // Drop an .osm straight onto the home screen. `dragover` must be prevented or
  // the browser navigates to the file instead of handing it over.
  const [dropping, setDropping] = useState(false);
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropping(false);
    const f = e.dataTransfer.files?.[0];
    if (f) p.onImportFile(f);
  };

  return (
    <div
      className={`home-root ${dropping ? 'dropping' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDropping(true); }}
      onDragLeave={(e) => {
        // Only clear when the pointer actually left the subtree, or moving over
        // a child flickers the highlight off.
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false);
      }}
      onDrop={onDrop}
    >
      {p.restoring && (
        <div className="restoring-bar" role="status">
          <span style={T.sub3}>Restoring saved maps…</span>
        </div>
      )}
      <div className="top-app-bar">
        <div className="brand">
          <IconCar size={40} />
          <div className="brand-text">
            {/* The document had no heading on any screen, so a screen-reader user
                navigating by heading found nothing to move between. This is the
                launcher's `<h1>`; the other screens use their own app-bar title.
                `aria-level` is not needed — a real `<h1>` is the point. */}
            <h1 ref={p.headingRef} tabIndex={-1} className="brand-title" style={T.body3m}>
              {/*
                "Canopy Nav" needs 151px at body3; at 412px the bar can spare
                about 127 once the car glyph, the gaps, the status pill and the
                76dp settings button have their share — so it ellipsised to
                "Canopy …" and the pill to "Onl…". Two truncated labels on the
                app's first screen, neither saying anything.

                The wordmark's short form is the fix. Real brands have one, and it
                costs nothing: a single `<h1>` whose tail is hidden at narrow
                widths, so the accessible name is "Canopy" exactly when the
                pixels say "Canopy". Two spans of the full name would have put it
                in the accessibility tree twice.
              */}
              Canopy<span className="brand-tail"> Nav</span>
            </h1>
            {/*
              The map summary, hidden below 600px. It is a duplicate of the first
              card on this screen, and at 412px it and the status pill and the
              settings button left the app's own name 92px — which rendered as
              "Can…" above "No m…". See the narrow-screen block at the end of
              `styles.css`.
            */}
            <div className="brand-summary" style={{ ...T.sub3, color: ink.secondary }}>
              {p.dataset
                // Pluralised on the count, not assumed. It read "1 routable ways"
                // for a single-way extract, which is the sort of small wrongness
                // that makes a status line stop being believed.
                ? `${p.dataset.counts.routable.toLocaleString()} routable way${p.dataset.counts.routable === 1 ? '' : 's'} · ${p.regionCount} region${p.regionCount === 1 ? '' : 's'}`
                : 'No map loaded'}
            </div>
          </div>
        </div>
        <div className="spacer" />
        <StatusPill
          online={p.online}
          provenance={p.provenance}
          locationMode={p.locationMode}
          locationError={p.locationError}
        />
        <button className="icon-btn" onClick={p.onSettings} aria-label="Settings">
          <IconSettings size={ICON.primary} />
        </button>
      </div>

      <div className="home-search" role="search">
        <button className="search-field" onClick={p.onSearch}>
          <IconSearch size={ICON.primary} color={ink.secondary} />
          <span style={{ ...T.body1, color: ink.secondary }}>Where to?</span>
        </button>

        <div className="quick-grid">
          <QuickTile label="Search" icon={<IconSearch size={ICON.primary} />} onClick={p.onSearch} />
          {/*
            Home and Work route to the driver's own saved destination, or ask
            for one. Long-press is not discoverable and there is no room for a
            second control on a 76dp tile, so the tile routes when it can and
            *says* when it cannot: the hint is on the tile, the accessible name
            repeats it, and the tap opens search with the slot named.
          */}
          <QuickTile
            label={p.places.home?.label ?? 'Home'}
            icon={<IconHome size={ICON.primary} />}
            hint={p.places.home ? undefined : 'Not set'}
            onClick={() => {
              const home = p.places.home;
              if (home) p.onRoute(home.pos, home.label);
              else p.onPickPlace('home');
            }}
          />
          <QuickTile
            label={p.places.work?.label ?? 'Work'}
            icon={<IconGoto size={ICON.primary} />}
            hint={p.places.work ? undefined : 'Not set'}
            onClick={() => {
              const work = p.places.work;
              if (work) p.onRoute(work.pos, work.label);
              else p.onPickPlace('work');
            }}
          />
          <QuickTile label="Regions" icon={<IconLayers size={ICON.primary} />} onClick={p.onRegions} />
          {/* Label stays short: five tiles share the row at head-unit widths and
              "Import .osm" truncates. The hint card below names the format. */}
          <QuickTile label="Import" icon={<IconFile size={ICON.primary} />} onClick={p.onImport} />
        </div>

        {p.route && (
          // A row of two, not a single button: "Continue" navigates, "Clear"
          // discards. Wrapping a button inside a button is invalid, and the
          // alternative — clearing elsewhere — meant a destination, once set,
          // could never be dropped for the life of the session.
          <div className="continue-row">
            <button className="continue-card" onClick={p.onContinue}>
              <div className="continue-left">
                <div style={T.body3m}>Continue navigation</div>
                <div style={{ ...T.sub3, color: ink.secondary }}>
                  {/*
                    The destination first, then the duration and distance.

                    It used to lead with a duration and hard-code `'metric'`, so a
                    user who had chosen imperial units saw "102 km" here and "63 mi"
                    in the navigation screen at the same moment. And "Continue
                    navigation" with no destination is not actionable — resuming a
                    trip to somewhere unnamed is how you end up in the wrong city.
                  */}
                  {p.destination?.label ?? 'a saved route'}
                  {p.route.summary
                    ? ` · ${formatDuration(p.route.summary.time)} · ${formatDistance(p.route.summary.length, p.units)}`
                    : ''}
                </div>
              </div>
              <IconChevronRight size={ICON.primary} />
            </button>
            <button
              className="secondary-btn"
              onClick={p.onClear}
              aria-label="Clear the current route and destination"
            >
              Clear route
            </button>
          </div>
        )}

        {p.progress && <ProgressCard progress={p.progress} />}
        {p.error && (
          <ImportMessage
            tone="error"
            message={p.error}
            onDismiss={() => p.onDismissError?.()}
          />
        )}
        {p.warn && (
          <ImportMessage
            tone="warn"
            message={p.warn}
            onDismiss={() => p.onDismissWarn?.()}
          />
        )}
        {/*
          * The route came from a fallback engine. Not an error — a warning — and
          * it says which engine answered rather than only that one did not,
          * because "your route exists" and "your route came from somewhere else"
          * are different facts and the driver may only care that it works.
        */}
        {p.degraded && !p.error && (
          <ImportMessage
            tone="warn"
            message={p.degraded}
            onDismiss={() => p.onDismissWarn?.()}
          />
        )}
        {/*
          * A location problem, in full.
          *
          * This was only ever reported by the app bar's status pill, which at
          * 412px had ~140px to hold "Online" and "User denied Geolocation" at
          * once — so it rendered as `O Use…`. Two half-words, neither of which
          * says anything, and the one fact the driver needs ("your position is
          * not real") was the part that got cut.
          *
          * A full-width card can hold the whole sentence, and it is dismissible,
          * which the pill is not. Below 600px the pill drops this line entirely —
          * see the narrow-screen block at the end of `styles.css` — so if the card
          * did not exist the information would be gone rather than truncated.
          */}
        {p.locationError && (
          <div className="hint-card warn location-card" role="status">
            <IconInfo size={ICON.secondary} />
            <div>
              <div style={T.body3m}>Position unavailable</div>
              <div style={{ ...T.sub3, marginTop: 2 }}>
                {p.locationError}. Routing will start from the map's centre until
                a real position arrives.
              </div>
            </div>
          </div>
        )}
        {!p.dataset && !p.progress && (
          <div className="hint-card">
            <div style={{ ...T.body3m, marginBottom: DP.P1 }}>Import a map to route offline</div>
            <div style={{ ...T.sub3, color: ink.secondary, marginBottom: DP.P3 }}>
              Download an extract from Geofabrik —
              <code>.osm.pbf</code> directly, or convert with
              <code> osmium cat region.osm.pbf -o region.osm</code>.
            </div>
            <button className="text-btn" onClick={p.onImport}>Import .osm file</button>
          </div>
        )}
      </div>
      {dropping && (
        <div className="drop-hint" role="status">
          <div style={T.body1m}>Drop the .osm extract to import it</div>
        </div>
      )}
    </div>
  );
}

function StatusPill({
  online,
  provenance,
  locationMode,
  locationError,
}: {
  online: boolean;
  provenance: RouteProvenance | null;
  locationMode: LocationMode;
  locationError: string | null;
}) {
  /**
   * Name the engine that answered, not the one that was selected.
   *
   * These differ whenever a fallback fires, and the difference is not cosmetic:
   * the offline engine produces no maneuvers, so labelling its route with a
   * hosted provider's name implies turn-by-turn that is not there. When there is
   * no route yet there is nothing to attribute, so connectivity is reported
   * instead — which is the honest thing to say at that moment.
   */
  const label = provenance
    ? describeProvenance(provenance.used, provenance.fellBack)
    : online
      ? 'Online'
      : 'Offline';
  const gps = locationMode === 'device' ? 'GPS'
    : locationMode === 'browser' ? 'Browser GPS'
    : 'Simulated GPS';
  const engineTitle = provenance
    ? `${label} · ${provenance.totalMs} ms${provenance.fellBack ? ' · another engine answered' : ''}`
    : online
      ? 'No route yet — engine unproven'
      : 'No route yet — no network';

  /**
   * The dot is connectivity and nothing else, so it says so out loud.
   *
   * It used to sit, unexplained, immediately left of the engine name — so after
   * an offline-engine route the user saw a green "connected" dot beside the
   * word "Offline" and no way to tell which the colour referred to.
   */
  const dotLabel = online ? 'Connected' : 'No network';

  /**
   * A location failure replaces the GPS mode rather than hiding in `title`.
   *
   * The reason the position is wrong is the most actionable thing this pill can
   * say, and a head unit has no hover, so a `title` is a message nobody reads.
   */
  const gpsText = locationError ?? gps;
  return (
    <div className={`status-pill ${online ? 'on' : 'off'}`} title={`${engineTitle}\n${dotLabel} · ${gpsText}`}>
      <span className="dot" role="img" aria-label={dotLabel} />
      <span className="pill-label" style={T.sub3}>{label}</span>
      <span className={`pill-gps ${locationError ? 'bad' : ''}`} style={{ ...T.sub3, color: ink.secondary }}>
        {gpsText}
      </span>
    </div>
  );
}

/**
 * A launcher tile.
 *
 * `hint` marks a tile that is present but not yet usable, and it changes the
 * tile's *meaning* rather than just its appearance: the tile stops looking
 * finished. A tile that is silently inert is read as broken, whereas one that
 * admits it is unset is read as a thing to do — so the hint is drawn on the tile
 * and repeated in the accessible name, which is the only thing a screen reader
 * gets.
 */
function QuickTile({
  label,
  icon,
  onClick,
  hint,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  hint?: string;
}) {
  return (
    <button
      className={`quick-tile ${hint ? 'unset' : ''}`}
      onClick={onClick}
      aria-label={hint ? `${label} — ${hint}` : label}
    >
      <span className="quick-icon">{icon}</span>
      {/*
        Label and hint in ONE element, not two siblings.
        `.quick-tile > span:last-child` carries the AAOS single-line truncate —
        `white-space: nowrap` plus `text-overflow: ellipsis` — so adding a hint
        as a third child moved that rule onto the hint, and the *label* silently
        lost its truncation while the hint inherited it. Worse, at two-up phone
        width a row layout left 85px beside the icon and clipped "Search" to
        "S…", "Regions" to "R…" and "Import" to "I…".
        One text element, two lines, one set of rules.
      */}
      <span className="quick-label">
        {label}
        {hint && <span className="quick-hint">{hint}</span>}
      </span>
    </button>
  );
}

/**
 * A long-running import, and what a driver hears while it runs.
 *
 * ## The two things this gets wrong if done naively
 *
 * **It would be a firehose.** The parser emits `onProgress` from every segment
 * callback and the downloader reports on every stream chunk, so a provincial
 * extract produces thousands of these — several per second. Inside
 * `aria-live="polite"` that is an unbroken queue of "1%. 2%. 2%. 3%…" for the
 * minutes the import takes, which is unusable *and* hides the stage changes,
 * which are the only part worth hearing. So the percentage is exposed as a
 * `progressbar`'s value (queryable, never announced) and the live region carries
 * the **stage** alone, which changes a handful of times per import.
 *
 * **It would be created with its content.** This card mounts already containing
 * "Parsing", so the first thing a screen reader is told about the import is
 * silently dropped by most engines. `announceAfterMount` delays the first render
 * by a frame so the region exists empty and is filled afterwards — the same
 * trick the navigation announcements use, and for the same reason.
 */
function ProgressCard({ progress }: { progress: BuildProgress }) {
  const pct = Math.round(progress.pct * 100);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div className="progress-card">
      <div className="progress-stage" role="status" aria-live="polite" aria-atomic="true">
        {ready ? progress.stage : ''}
      </div>
      <div
        className="bar"
        role="progressbar"
        aria-label="Importing map"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={`${pct} percent — ${progress.stage}`}
      >
        <div className="fill" style={{ width: `${pct}%` }} />
      </div>
      {/* Not in a live region: the number is the progressbar's value, and reading
          it aloud is what made the region a firehose. */}
      <div className="progress-pct" aria-hidden="true">{pct}%</div>
    </div>
  );
}

/**
 * An import message the user can see, read and dismiss.
 *
 * The card it replaces had no dismiss, no ARIA role and no live region, and it
 * stayed on the launcher until the *next* import started — so a failure the user
 * had already understood stayed on screen indefinitely, and a screen reader
 * never learned it had happened at all.
 *
 * `role="alert"` for the error (assertive: the thing they asked for did not
 * happen) and `role="status"` for the warning (polite: it did, with a caveat).
 */
function ImportMessage({
  tone, message, onDismiss,
}: {
  tone: 'error' | 'warn';
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div
      className={`error-card ${tone}`}
      role={tone === 'error' ? 'alert' : 'status'}
      style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', gap: DP.P2 }}
    >
      {tone === 'warn' && <IconInfo size={ICON.secondary} />}
      <span style={{ flex: '1 1 auto', minWidth: 0 }}>{message}</span>
      <button
        type="button"
        className="msg-dismiss"
        onClick={onDismiss}
        aria-label={tone === 'error' ? 'Dismiss this error' : 'Dismiss this message'}
      >
        <IconClose size={ICON.tertiary} />
      </button>
    </div>
  );
}

/* ---------------------------- NavOverlay ---------------------------- */

function NavOverlay(props: {
  /** The screen's heading, focused on arrival so Tab continues from the banner. */
  headingRef?: React.Ref<HTMLHeadingElement>;
  route: Route;
  guidance: GuidanceModel | null;
  localGuidance: LocalGuidanceModel | null;
  location: LatLng;
  progressAlong: number;
  units: 'metric' | 'imperial';
  muted: boolean;
  online: boolean;
  degraded: boolean;
  /**
   * Live reroute status, e.g. "122 m off the route" or "finding a new way".
   *
   * Rendered on the navigation screen rather than only in the settings area
   * because it is the one message a driver must see *while* driving. A banner
   * that only exists on a screen they have to navigate away from is not a
   * warning.
   */
  rerouteNotice: string | null;
  locationMode: LocationMode;
  layer: LayerId;
  layerName: string;
  layers: LayerOption[];
  layersOpen: boolean;
  traffic: TrafficVerdict;
  trafficOn: boolean;
  trafficReady: boolean;
  trafficStale: boolean;
  trafficReason: string;
  onMute: () => void;
  onExit: () => void;
  onOverview: () => void;
  onRecenter: () => void;
  onSteps: () => void;
  onToggleTraffic: () => void;
  onToggleLayers: () => void;
  onPickLayer: (id: LayerId) => void;
  onCloseLayers: () => void;
  onCheckTraffic: () => void;
}) {
  const { route, units, muted, online, degraded } = props;
  const g = props.guidance;
  const lg = props.localGuidance;

  /**
   * The route's own length, in metres, computed once per route.
   *
   * This was `lineLength(route.geometry)` inline in the remaining-time
   * expression, and `NavOverlay` re-renders on every GPS fix. `lineLength` sums
   * `haversine` over every segment, so a provincial geometry meant tens of
   * thousands of `sin`/`cos` pairs per second on the main thread, spent
   * computing a *ratio* whose denominator only changes when the route does.
   */
  const totalLineM = useMemo(() => lineLength(route.geometry), [route]);

  /**
 * The banner's next turn, whichever engine produced it.
 *
 * The offline engine emits no maneuvers, so for an `.osm` route this comes from
 * the bearing-derived `localGuidance` instead. Falling through to it is what
 * stops the largest number on this screen reading "0 m" for an entire offline
 * trip — which it did, because the offline engine is the default.
 */
  const distToTurn = g ? g.distToNext : (lg?.distToNext ?? 0);
  const nextManeuver = g ? g.next : null;
  const localTurn = g ? null : (lg?.nextStep ?? null);

  const icon: LegStep['icon'] = nextManeuver
    ? maneuverIcon(nextManeuver.type)
    : localTurn
      ? localTurn.icon
      : 'continue';
  const major = nextManeuver
    ? isMajorManeuver(nextManeuver.type)
    : (localTurn?.major ?? false);

  const remainingM = g?.remainingM ?? lg?.remainingM ?? 0;

  /**
   * True once the driver has arrived, or is close enough to say so.
   *
   * This used to be `!nextManeuver && !localTurn && remainingM > 0` — "there is
   * no next maneuver". `next` is built as
   * `legs.slice(i + 1).find(...) ?? active`, so the `?? active` makes it
   * non-null *by construction* and the condition was never true for any
   * Valhalla route. Two things silently never happened as a result:
   *
   *   - the spoken "You have arrived at your destination" (the destination
   *     maneuver is type 4, which `isMajorManeuver` excludes), and
   *   - the `role="status"` announcement added specifically to carry arrival.
   *
   * The live region existed, the code was written, and the log said arrival was
   * announced. It was not, and no test would have said otherwise because the
   * *shape* of the check was right and its *inputs* were unreachable.
   *
   * Arrival is a property of the trip's progress, not of a maneuver's absence,
   * so it is derived from progress. The threshold is the same ~30 m Google Maps
   * uses for the last instruction, and `ARRIVED_FRACTION` covers the case where
   * the geometry has run out but the summary still claims kilometres.
   */
  const ARRIVAL_M = 30;
  const ARRIVED_FRACTION = 0.995;
  const arriving =
    props.progressAlong >= ARRIVED_FRACTION || (nextManeuver?.type === 4 && distToTurn <= ARRIVAL_M);

  const remainingSec = remainingM > 0 ? (route.summary.time || 0) * (remainingM / Math.max(1, totalLineM)) : 0;

  // Google Maps dims the instruction once you're within ~30 m.
  const imminent = distToTurn < 40;
  // The true distance. This was `Math.min(distToTurn, 9999)`, which pinned the
  // number at "10 km" / "6 mi" and *said it out loud* — "In 10 km, turn right" —
  // for every leg of a rural route longer than that. A capped distance is not a
  // conservative distance; it is a different, wrong number presented as the
  // real one, and this one is spoken to a driver mid-turn. `formatDistance`
  // already switches to kilometres and miles, and both read correctly at 40 km.
  const laneDist = distToTurn;

  // The traffic control's label carries its state *and* its reason: a driver
  // reaching for it must learn from the label alone what it will do.
  const trafficLabel = props.trafficReady
    ? `${props.trafficOn ? 'Hide' : 'Show'} the traffic overlay (${props.traffic.confidence === 'live' ? 'live' : 'estimated'} data${props.trafficStale ? ', last known — no signal to refresh' : ''})`
    : `Traffic unavailable — ${props.trafficReason}`;

  // One honest sentence about the map as it stands, under the buttons that change it.
  const statusDetail = props.trafficOn
    ? (props.trafficStale ? `${props.traffic.note ?? ''} · no signal to refresh` : props.traffic.note ?? '')
    : !props.trafficReady
      ? 'No traffic data'
      : props.locationMode === 'simulated'
        ? 'Simulated GPS'
        : '';

  /**
   * The banner's instruction, resolved from whichever source is driving.
   *
   * Hoisted out of the markup because both the visible banner and the spoken
   * announcement need it, and deriving it twice is how they drift.
   */
  const instructionText = nextManeuver?.instruction
    ?? localTurn?.title
    ?? (arriving ? 'Arriving at your destination' : 'Continue');

  /**
   * Whether the platform can speak at all.
   *
   * Computed once per mount rather than per render: `speechSynthesis` does not
   * appear mid-session, and reading it on every position tick is pointless work
   * several times a second.
   */
  const voiceAvailable = useMemo(() => isVoiceAvailable(), []);

  /**
   * Speak the guidance as it changes.
   *
   * `voiceKey` buckets the distance, so the position updates that arrive several
   * times a second are silent and only a genuine new step is spoken. Unmounting
   * cancels anything in flight — otherwise leaving the screen mid-sentence leaves
   * the WebView talking over the home screen.
   */
  useEffect(() => {
    if (muted || !voiceAvailable || !instructionText) return;
    // Every *change of instruction* is spoken, not only major maneuvers.
    //
    // This was `if (!major && !arriving) return;`, so a "slight right", a
    // "continue" or a "take the ramp" was painted across the banner at 32dp and
    // produced silence. A driver who cannot see the banner — or who has the
    // volume down and is listening, which is the entire point of the feature —
    // got no information at the exact moment the instruction changed.
    //
    // `voiceKey` buckets the distance, so the several position updates per
    // second that would otherwise re-announce the same turn stay silent; only a
    // genuine new step speaks. `imminent` steps interrupt (`assertive`) because
    // the driver is about to act; everything else waits its turn.
    speak({
      text: arriving
        ? 'You have arrived at your destination.'
        : `In ${formatDistance(laneDist, units)}, ${instructionText}`,
      key: voiceKey(instructionText, laneDist, units),
      priority: arriving || imminent ? 'assertive' : 'polite',
    });
    return () => { /* keep speaking across re-render; cancel only on unmute */ };
  }, [muted, voiceAvailable, instructionText, laneDist, units, arriving, imminent]);

  /* Stop talking the moment guidance is torn down or unmuted. */
  useEffect(() => {
    if (muted) cancelSpeech();
  }, [muted]);

  useEffect(() => () => cancelSpeech(), []);

  /**
   * What a screen reader is told about the trip.
   *
   * ## The distance is in here, and that is deliberate — but it is bucketed
   *
   * The comment this replaces claimed "putting the remaining distance in here
   * would rewrite the region several times a second", which was false: the
   * distance was in the template on the very next line. `formatDistance` snaps to
   * 5 m under 20 m and 10 m under 1 km, so at 50 km/h this region was rewritten
   * roughly every 0.7 s through the approach — with `aria-atomic="true"` on a
   * polite region, which queues rather than replaces. A driver using assistive
   * technology got "In 340 metres, turn right. In 330 metres, turn right. In 320
   * metres…" without end, and because the queue is never drained the *next*
   * maneuver was announced late or not at all.
   *
   * So the distance stays — a turn instruction without a distance is not an
   * instruction — and is bucketed to the same 50 m / 0.2 mi step `voiceKey`
   * already uses for speech. The banner's own text is not bucketed, because a
   * sighted driver *does* want the count, and the two audiences are reading
   * different channels.
   */
  const announceDist =
    units === 'metric' ? Math.round(laneDist / 50) * 50 : Math.round(laneDist / 322) * 322;
  const announcement = arriving
    ? 'You have arrived at your destination.'
    : instructionText
      ? `In ${formatDistance(announceDist, units)}, ${instructionText.toLowerCase()}`
      : '';

  /**
   * Whether the live region has outlived its own mount.
   *
   * One frame of delay, for the reason in the JSX: a live region created together
   * with its first content is not reliably announced, so the region exists empty
   * and fills in afterwards. This is the smallest change that makes the first
   * instruction of a trip audible — the one the driver needed to hear to leave
   * the parking lot — without hoisting the region out of a component that only
   * exists while navigating.
   */
  const [announcementReady, setAnnouncementReady] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setAnnouncementReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div className="nav-root">
      {/*
        The screen's heading.

        Visually hidden because the maneuver banner is 120px of icon and display3
        type — a word above it would be noise. It exists so heading navigation
        lands on this screen and so focus has somewhere to move when the driver
        taps Start, which is the transition with the most at stake: without it
        focus fell to `<body>` and the next Tab walked the whole navigation screen
        from the top.
      */}
      <h1 ref={props.headingRef} tabIndex={-1} className="visually-hidden">Navigating</h1>
      {/*
        Announcements for the navigation screen.

        A live region nothing ever writes to is not a live region. The reroute
        banner has its own `role="status"`, but arrival never did — measured as
        zero DOM mutations across 56 seconds of navigation, so the event a driver
        most needs to hear was silent to anyone not watching the screen.

        ## The two defects this region has to get right

        **It must exist before its text changes.** `NavOverlay` mounts only while
        the screen is `navigating`, so this region was created *with* "In 240 m,
        turn right" already inside it — and NVDA, JAWS and TalkBack all commonly
        discard content inserted into a live region in the same commit that
        creates the region. The first instruction of every trip, the one needed
        to leave the parking lot, was therefore never announced. It only started
        working from the second maneuver. The screen-name region in `App` is
        mounted once for the life of the process and only its *text* changes;
        this one cannot be, because `NavOverlay` is conditional. What it can do is
        render empty on mount and fill in on the next commit, which is the
        smallest change that makes the first announcement real.

        **It must not rewrite on every distance bucket.** `voiceKey` buckets
        speech to 50 m; this region had no bucket, so a driver using assistive
        technology heard "In 340 metres, turn right. In 330 metres, turn right."
        queued without end through the whole approach — and because the queue is
        never cleared, the *next* maneuver was announced late or not at all. The
        distance is bucketed below, using the same thresholds as speech.
      */}
      <div
        className="visually-hidden"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcementReady ? announcement : ''}
      </div>
      {/* ETA bar — Android Auto's top strip */}
      <div className="eta-bar">
        {/*
          The duration leads and never shrinks: it is the number a driver reads
          first. The arrival clock is the one item dropped on a narrow screen,
          because it is the same information expressed less directly, and losing
          it costs less than losing "7 min".
        */}
        <div className="eta-block">
          <div className="eta-value" style={T.body1m}>{formatDuration(remainingSec)}</div>
          <div className="eta-label clock" style={T.sub3}>{formatClock(new Date(Date.now() + remainingSec * 1000))}</div>
        </div>
        <div className="eta-sep clock-sep" />
        <div className="eta-block">
          <div className="eta-value" style={T.body1m}>{formatDistance(remainingM, units)}</div>
          <div className="eta-label" style={T.sub3}>to destination</div>
        </div>
        <div className="spacer" />
        {!online && <div className="offline-chip">No signal</div>}
        {online && degraded && <div className="offline-chip warn">Local route</div>}
        {/*
          The voice control, and it now controls something.

          It previously toggled a boolean whose only consumers were the icon and
          this label, so a driver tapped it, heard no change, and concluded voice
          prompts were off — a lie with a safe-looking answer. It now drives real
          spoken guidance (`nav/voice`).

          Where the WebView has no speech engine at all the control stays
          *visible but disabled*, with the reason in its accessible name. Hiding
          it was the first attempt and it is the worse answer: a missing control
          reads as a missing feature, while a disabled one explains itself.
        */}
        <button
          className="icon-btn on-dark"
          onClick={() => { if (voiceAvailable) props.onMute(); }}
          // `aria-disabled`, not `disabled`. The whole reason this control exists
          // in its unavailable form is so it "explains itself" — but a `disabled`
          // button is removed from the tab order, so the explanation in its
          // accessible name could never be reached. It had to stay focusable to
          // do the one job it was designed for.
          aria-disabled={!voiceAvailable}
          aria-label={!voiceAvailable
            ? 'Voice guidance unavailable on this device'
            : muted ? 'Unmute voice guidance' : 'Mute voice guidance'}
          aria-pressed={voiceAvailable ? muted : undefined}
          title={!voiceAvailable ? 'Voice guidance unavailable on this device' : undefined}
        >
          {muted || !voiceAvailable ? <IconMute size={ICON.primary} /> : <IconSound size={ICON.primary} />}
        </button>
        <button className="icon-btn on-dark" onClick={props.onExit} aria-label="Exit navigation">
          <IconClose size={ICON.primary} />
        </button>
      </div>

      {/*
        The banner stack.

        The maneuver card and the off-route notice were two independent absolutely
        positioned boxes, the second placed at
        `app-bar + inset-top + 24px + 168px` — 168 being a hand-copied
        duplicate of the maneuver tile's height plus its padding. So the two cards
        abutted with **zero** gap, which reads as a rendering mistake rather than
        as two cards, and any future change to the tile's size silently pushed the
        notice up underneath the card instead of moving it.

        A flex column with a real spacing token makes the gap intrinsic: whatever
        the maneuver card's height becomes, the notice stays one `P1` below it.
        Order matters — the instruction is the more urgent of the two, so it comes
        first in the column and the notice follows.
      */}
      <div className="banner-stack">
      {/* Maneuver banner — the big card Google Maps shows before each turn */}
      <div className="maneuver-banner">
        <div className={`maneuver-icon ${major || arriving ? 'major' : ''}`}>
          <ManeuverIcon kind={arriving ? 'arrive' : icon} size={88} />
        </div>
        <div className="maneuver-text">
          {/*
            The distance block is hidden on arrival rather than shown as "0 m".
            At the end of a route `distToTurn` is 0, so the largest text in the
            app sat at `0 m` in display3 next to the arrival copy — a number that
            is not a distance and answers nothing. The arrival state has its own
            meaningful content; the distance block has nothing left to add.
          */}
          {!arriving && (
            <div className="maneuver-dist" style={T.display3}>{formatDistance(laneDist, units)}</div>
          )}
          {!arriving && nextManeuver?.sign?.exit_number_elements?.length ? (
            <div className="shield">{nextManeuver.sign.exit_number_elements.map((e) => e.text).join('')}</div>
          ) : null}
          <div className={`maneuver-instr ${imminent && !arriving ? 'is-imminent' : ''}`} style={T.body1}>
            {arriving ? 'You have arrived' : instructionText}
          </div>
        </div>
      </div>

      {props.rerouteNotice && (
        <div className="offroute-banner" role="status" aria-live="polite">
          {props.rerouteNotice}
        </div>
      )}
      </div>

      {/* Right-hand control stack */}
      <div className="nav-controls">
        <button className="round-btn" onClick={props.onRecenter} aria-label="Recenter on my position">
          <IconLocate size={ICON.primary} />
        </button>
        <button className="round-btn" onClick={props.onOverview} aria-label="Route overview">
          <IconOverview size={ICON.primary} />
        </button>
        {/* Traffic is a toggle: it looks pressed while the overlay is up, and is
            visibly disabled — not merely inert — when no provider data backs it. */}
        <button
          className={`round-btn ${props.trafficOn ? 'on' : ''}`}
          onClick={() => { if (props.trafficReady) props.onToggleTraffic(); }}
          // `aria-disabled` so the reason stays reachable: `trafficLabel` carries
          // the actual cause ("no traffic provider responded", "last known — no
          // signal to refresh"), and a `disabled` control cannot be focused, so
          // the one piece of information this row exists to give was unreachable.
          aria-disabled={!props.trafficReady}
          aria-pressed={props.trafficOn}
          aria-label={trafficLabel}
          title={trafficLabel}
        >
          <IconTraffic size={ICON.primary} />
        </button>
        <button
          className={`round-btn ${props.layersOpen ? 'on' : ''}`}
          onClick={props.onToggleLayers}
          aria-expanded={props.layersOpen}
          aria-label={`Map layers — ${props.layerName}`}
        >
          <IconLayers size={ICON.primary} />
        </button>

        {/* Current layer name, so the map is never showing something unnamed.
            Hidden while the panel is open: the panel names every layer, and two
            copies of the same sentence on a phone-sized screen is noise. */}
        {!props.layersOpen && (
          <div className="nav-status" role="status">
            <span style={T.body3m}>{props.layerName}</span>
            {statusDetail && (
              <span style={{ ...T.body3, color: ink.secondary }}>{statusDetail}</span>
            )}
          </div>
        )}
      </div>

      {props.layersOpen && (
        <NavPanel
          layer={props.layer}
          options={props.layers}
          onPick={props.onPickLayer}
          onClose={props.onCloseLayers}
          onCheckTraffic={props.onCheckTraffic}
          checking={props.traffic.status === 'probing'}
          canCheckTraffic={props.route.engine === 'valhalla' && props.traffic.status !== 'probing'}
        />
      )}

      {/* Bottom bar */}
      <div className="nav-bottom">
        <button className="nav-bottom-btn" onClick={props.onSteps}>
          <ManeuverIcon kind="continue" size={ICON.secondary} />
          <span style={T.body3}>Steps</span>
        </button>
        <button className="nav-bottom-btn" onClick={props.onExit}>
          <IconClose size={ICON.secondary} />
          <span style={T.body3}>Exit</span>
        </button>
        <button className="nav-bottom-btn" onClick={props.onOverview}>
          <IconOverview size={ICON.secondary} />
          <span style={T.body3}>Overview</span>
        </button>
      </div>
    </div>
  );
}

/** Valhalla-backed guidance: real maneuvers, instructions and road shields. */
export interface GuidanceModel {
  active: ValhallaManeuver;
  next: ValhallaManeuver;
  distToNext: number;
  remainingM: number;
  totalM: number;
  steps: LegStep[];
  travelled: LatLng[];
}

/** Offline-graph guidance: turn shapes inferred from bearing changes. */
export interface LocalGuidanceModel {
  snap: { index: number; dist: number; point: LatLng };
  remainingM: number;
  totalM: number;
  steps: LegStep[];
  travelled: LatLng[];
  idx: number;
  /**
   * The turn ahead of the driver, and how far along the line to it.
   *
   * Present so the maneuver banner has something real to show on an offline
   * route. `null` at the end of the route, which is correct: there is no next
   * turn, and "arriving" is what the banner should say.
   */
  nextStep: LegStep | null;
  distToNext: number;
}

/* ----------------------------- NavPanel ---------------------------- */

/**
 * The layers the map can be showing.
 *
 * Every option states what it is doing and, when it cannot be used, exactly
 * why — a greyed-out row with a reason is the honest alternative to a toggle
 * that silently does nothing, or to an option that lies about what it draws.
 */
function NavPanel(props: {
  layer: LayerId;
  options: LayerOption[];
  onPick: (id: LayerId) => void;
  onClose: () => void;
  onCheckTraffic: () => void;
  checking: boolean;
  canCheckTraffic: boolean;
}) {
  // Only on the mount that follows the sheet being opened, so a re-render does
  // not yank focus back to the top of the list mid-interaction.
  const sheetHadFocus = useRef(false);
  return (
    <div
      className="nav-panel"
      role="dialog"
      aria-modal="true"
      aria-label="Map layers"
      ref={(el) => {
        // Focus enters the sheet so the arrow keys below have somewhere to start,
        // and so Escape's dismissal is heard by the sheet rather than by whatever
        // was focused behind it. Previously the trigger kept focus, which meant
        // the sheet was never announced as a dialog and Tab walked out of it into
        // the map canvas on the next stop.
        if (el && !sheetHadFocus.current) {
          sheetHadFocus.current = true;
          focusQuietly(el);
        }
      }}
    >
      <div className="panel-head">
        <h2 className="panel-title" style={T.body3m}>Map layers</h2>
        {/* Re-asking is a header action, not a row: it keeps the panel short
            enough to clear the maneuver banner on a head unit. */}
        {props.canCheckTraffic && (
          <button
            className="icon-btn"
            onClick={props.onCheckTraffic}
            disabled={props.checking}
            aria-label="Ask the routing provider for traffic data again"
          >
            <IconRefresh size={ICON.secondary} />
          </button>
        )}
        <button className="icon-btn" onClick={props.onClose} aria-label="Close map layers">
          <IconClose size={ICON.secondary} />
        </button>
      </div>

      <div className="layer-list" role="radiogroup" aria-label="Map layer">
        {props.options.map((o) => (
          /*
            A radio, not a toggle button.

            The layer list is mutually exclusive — "Default" and "Traffic" are
            alternatives, not switches — and it was exposed as five independent
            `aria-pressed` toggles, which tells a screen-reader user that any
            combination is available and that arrow keys do nothing. The Engines
            screen already got this right with `role="radiogroup"`; this is the
            same problem, on a different screen, in the same codebase.

            `aria-disabled` rather than `disabled`. `disabled` removes a control
            from the tab order and from the focus path, so the sentence explaining
            *why* an option is unavailable — the thing the row was written to
            communicate — is unreachable by keyboard and inaudible to assistive
            technology. `aria-disabled` keeps it focusable and describable while
            the click is refused, which is the behaviour the row's copy promises.
          */
          <button
            key={o.id}
            role="radio"
            aria-checked={o.id === props.layer}
            className={`layer-row ${o.id === props.layer ? 'on' : ''} ${o.available ? '' : 'unavailable'}`}
            onClick={() => { if (o.available) props.onPick(o.id); }}
            aria-disabled={!o.available}
            aria-label={`${o.label} map layer. ${o.detail}`}
          >
            <span className="layer-text">
              <span style={T.body3m}>{o.label}</span>
              <span style={{ ...T.body3, color: o.available ? ink.secondary : ink.tertiary }}>
                {o.detail}
              </span>
            </span>
            <span aria-hidden="true" className={`radio ${o.id === props.layer ? 'on' : ''}`} />
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------- PreviewCard --------------------------- */

function PreviewCard(props: {
  route: Route | null;
  destination: { label: string } | null;
  units: 'metric' | 'imperial';
  routing: boolean;
  error: string | null;
  /**
   * The route worked, but something along the way did not — a preferred engine
   * was unavailable and a fallback answered.
   *
   * This is *not* an error and must never be drawn as one. It used to be folded
   * into the same `error` state as a real failure, so every fallback route —
   * which is the common case, because the offline engine is the default and
   * Valhalla is the fallback — put a red card directly above the **Start**
   * button. The codebase already draws this distinction correctly on the import
   * screen (`ImportMessage` has a `tone`), and `PreviewCard` threw it away.
   */
  degraded?: string | null;
  /** Offers to save this destination as a Home/Work slot. */
  places?: Partial<Record<PlaceSlot, SavedPlace>>;
  onSetPlace?: (slot: PlaceSlot) => void;
  headingRef?: React.Ref<HTMLHeadingElement>;
  onGo: () => void;
  onBack: () => void;
  onProvider: () => void;
}) {
  const { route, units, routing, error, degraded } = props;
  return (
    <div
      className="preview-root"
      role="dialog"
      aria-modal="true"
      aria-label="Route preview"
      aria-busy={routing}
    >
      {/*
        `aria-modal` was missing. Without it a dialog is advisory: assistive
        technology is free to treat the rest of the page as available, and it is —
        the launcher underneath is still mounted and still in the tab order, so
        Tab walked straight out of the preview and into the home screen's five
        tiles behind it. `aria-modal` is what makes the *intent* explicit; the
        inertness behind it is real because only one screen is rendered at a time.

        The heading is visually hidden because the preview card already says what
        the route is — this exists so heading navigation lands somewhere and so
        focus has an element to move to, since the card's only other control is
        the floating Back.
      */}
      <h1 ref={props.headingRef} tabIndex={-1} className="visually-hidden">Route preview</h1>
      <button className="floating-back" onClick={props.onBack} aria-label="Back">
        <IconBack size={ICON.primary} />
      </button>

      <div className="preview-card">
        {routing && (
          <div
            className="bar"
            role="progressbar"
            aria-label="Calculating route"
            aria-busy="true"
          >
            <div className="fill anim" />
          </div>
        )}
        {/*
          * `role="alert"` on the failure so it is announced, `role="status"` on
          * the fallback so it is announced without interrupting — a warning the
          * driver can still act on should not cut across whatever is being read.
        */}
        {error && <div className="error-card" role="alert">{error}</div>}
        {!error && degraded && (
          <div className="error-card warn" role="status">
            <span className="warn-dot" aria-hidden="true" />
            <span>{degraded}</span>
          </div>
        )}

        {route && (
          <>
            <div className="preview-dest" style={T.body1m}>{props.destination?.label ?? 'Destination'}</div>
            <div className="preview-rows" role="status">
              <PreviewRow label="Time" value={formatDuration(route.summary.time)} icon={<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>} />
              <PreviewRow label="Distance" value={formatDistance(route.summary.length, units)} />
              <PreviewRow label="Engine" value={route.engine === 'valhalla' ? 'Valhalla' : 'Offline .osm'} />
            </div>
            {/*
              * Saving a place is a secondary action, so it sits *below* the
              * primary pair rather than competing with it — and it only appears
              * where it means something: a route has a destination, and the
              * destination is not already that slot.
            */}
            {props.onSetPlace && (
              <div className="save-places">
                {!props.places?.home && (
                  <button className="text-btn" onClick={() => props.onSetPlace?.('home')}>
                    <IconHome size={ICON.secondary} />
                    Set as Home
                  </button>
                )}
                {!props.places?.work && (
                  <button className="text-btn" onClick={() => props.onSetPlace?.('work')}>
                    <IconGoto size={ICON.secondary} />
                    Set as Work
                  </button>
                )}
              </div>
            )}
            <div className="preview-actions">
              <button className="secondary-btn" onClick={props.onProvider}>Options</button>
              <button className="primary-btn" onClick={props.onGo}>Start</button>
            </div>
          </>
        )}
        {!route && !routing && !error && <div style={T.body3}>Choose a destination.</div>}
      </div>
    </div>
  );
}

/**
 * A label/value row on the preview card.
 *
 * `icon` was declared here and passed by a caller, but never destructured and so
 * never rendered -- the glyph the caller paid for was silently dropped. Now it
 * renders, and it is optional, so the rows that pass nothing are unaffected.
 */
function PreviewRow({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="preview-row">
      {icon ? <span className="preview-row-icon">{icon}</span> : null}
      <span style={{ ...T.body3, color: ink.secondary }}>{label}</span>
      <span style={T.body3m}>{value}</span>
    </div>
  );
}

/* ---------------------------- SearchScreen -------------------------- */

/** Categories to offer, derived from what the downloaded map actually contains. */
function categoriesFor(regions: ReturnType<typeof useRegions>, dataset: OsmDataset | null) {
  const counts = new Map<string, number>();
  const gaz = regions.length ? regions.flatMap((r) => r.dataset.gaz) : (dataset?.gaz ?? []);
  for (const g of gaz) {
    if (g.cat === 'street' || g.cat === 'address' || g.cat === 'place') continue;
    counts.set(g.cat, (counts.get(g.cat) ?? 0) + 1);
  }
  const label: Record<string, string> = {
    amenity: 'Amenities', shop: 'Shops', tourism: 'Attractions', leisure: 'Leisure',
    office: 'Offices', healthcare: 'Healthcare', historic: 'Historic', craft: 'Craft',
  };
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([cat, n]) => ({ key: cat, label: label[cat] ?? cat, count: n }));
}

/* ---------------------------- search hits --------------------------- */

/**
 * One search result, and where it came from.
 *
 * `source` is shown on the row. Offline hits are built from the imported OSM
 * data and cost nothing and no privacy; an online hit has been round-tripped
 * through a third-party server. Rendering both identically made that invisible,
 * which matters most to a user who believed they were offline.
 */
interface SearchHit {
  label: string;
  sub: string;
  pos: LatLng;
  source: 'offline' | 'online';
}

/** Metres from `a` to `b`, good enough for ordering a result list. */
function distanceFrom(a: LatLng, b: LatLng): number {
  const dLat = (a[1] - b[1]) * 111320;
  const dLon = (a[0] - b[0]) * 111320 * Math.cos((b[1] * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

/**
 * Collapse duplicates within a result list, keeping the best-ranked row per name.
 *
 * Two separate duplications were happening. The gazetteer indexes one entry per
 * OSM *element*, so a street split into several ways produced "Memorial Dr" three
 * times; and Nominatim indexes the same data, so a place could arrive from both
 * offline and online.
 *
 * Keyed on the name, not the position. Keying on position leaves the multi-way
 * street case intact — the three segments are genuinely different coordinates —
 * and the user still sees "Memorial Dr, Memorial Dr, Memorial Dr", which is not
 * a list of three places. For a destination picker the first, best-ranked match
 * for a name is the one someone means; the rest are noise. Position still breaks
 * ties, because the ranking above already folds in distance.
 */
function dedupeHits(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const h of hits) {
    const key = h.label.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

function SearchScreen(props: {
  dataset: OsmDataset | null;
  regions: ReturnType<typeof useRegions>;
  /** Seed query from a hardware keyboard shortcut. */
  initialQuery?: string;
  onInitialQueryConsumed?: () => void;
  online: boolean;
  location: LatLng;
  /**
   * What picking a result will *do*, when it is not the usual thing.
   *
   * Arriving here from an unset Home or Work tile means the next result becomes
   * a saved place rather than a route. That is a different action with different
   * consequences, and it has to be said before the tap — the alternative is a
   * driver who saves their home and is then surprised not to be routed there.
   */
  pickHint?: string | null;
  /** This screen's heading, so a screen change can move focus onto it. */
  headingRef?: React.Ref<HTMLHeadingElement>;
  onPick: (pos: LatLng, label: string) => void;
  onBack: () => void;
}) {
  const categories = useMemo(
    () => categoriesFor(props.regions, props.dataset),
    [props.regions, props.dataset],
  );
  const [q, setQ] = useState(props.initialQuery ?? '');
  // Adopt a keyboard-seeded query whenever the screen is reopened.
  //
  // `onInitialQueryConsumed` is read through a ref rather than listed as a
  // dependency. `App` passes it as an inline arrow, so it is a new function on
  // every one of App's 1 Hz re-renders; as a dependency it re-ran this effect
  // every second, calling `setQ` with the value already in the box. React
  // bails out of an identical `setState`, so it never looped — but the effect
  // was doing nothing except re-queuing itself, which is exactly the shape that
  // becomes a real bug the moment the body grows a line.
  const consumedRef = useRef(props.onInitialQueryConsumed);
  consumedRef.current = props.onInitialQueryConsumed;
  const { initialQuery } = props;

  /**
   * Where the driver is, as a *stable* dependency.
   *
   * `props.location` is a fresh `[lon, lat]` array on every GPS fix — about
   * once a second, and with `maximumAge: 0` even while stationary. It was a
   * dependency of the search effect below, so every fix ran that effect's
   * cleanup, which is `clearTimeout(t)`, and re-armed the 250 ms debounce.
   *
   * The visible result: a search that re-armed roughly every second while
   * searching, so up to a second of every keystroke was discarded, "Searching…"
   * flickered back on, and the in-flight Nominatim request was repeatedly
   * cancelled and restarted. Results were also re-sorted against a moving
   * reference point mid-list.
   *
   * Rounding to three decimals is ~110 m at the equator — finer than the search
   * result ranking cares about, and coarse enough that GPS jitter under a
   * stopped car does not re-arm anything. The value itself is read from a ref so
   * the ranking uses the real current position rather than the rounded one.
   */
  const locationRef = useRef(props.location);
  locationRef.current = props.location;
  const locationKey = `${props.location[0].toFixed(3)},${props.location[1].toFixed(3)}`;
  useEffect(() => {
    if (initialQuery) {
      setQ(initialQuery);
      consumedRef.current?.();
    }
  }, [initialQuery]);
  // A category chip filters the gazetteer by tag category. It is deliberately
  // not a text query: searching the literal word "city" matches no place names.
  const [cat, setCat] = useState<string | null>(null);
  const [results, setResults] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /**
   * The term that was actually searched for, as opposed to what is in the box.
   *
   * The empty state needs the difference: with only `q` to go on, typing a
   * single character would claim "no matches for 'c'" before a search had run
   * at all.
   */
  const [searchedTerm, setSearchedTerm] = useState('');

  /** Enter picks the top result, which is what every other map app does. */
  const onSubmitFirstResult = () => {
    const top = results[0];
    if (top) props.onPick(top.pos, top.label);
  };

  useEffect(() => {
    // Category browse: every entry with that tag, nearest first.
    if (cat) {
      const gaz = props.regions.length
        ? props.regions.flatMap((r) => r.dataset.gaz)
        : (props.dataset?.gaz ?? []);
      const near = props.location;
      const hits = gaz
        .filter((g) => g.cat === cat)
        .map((g) => ({
          label: g.name,
          sub: g.cat,
          pos: [g.lon, g.lat] as LatLng,
          source: 'offline' as const,
        }))
        .sort((a, b) => distanceFrom(a.pos, near) - distanceFrom(b.pos, near))
        .slice(0, 20);
      setResults(dedupeHits(hits).slice(0, 20));
      setBusy(false);
      return;
    }
    const term = q.trim();
    // Every early return below has to clear `busy`. It used to return without
    // doing so, so backing out of a query mid-flight — "Ca" then "C" — left the
    // screen saying "Searching…" with no results and no way out but typing a new
    // two-character query.
    if (term.length < 2) { setResults([]); setBusy(false); setErr(null); setSearchedTerm(''); return; }
    let cancelled = false;
    const here = locationRef.current;
    const t = setTimeout(async () => {
      setBusy(true); setErr(null);
      setSearchedTerm(term);

      // Offline gazetteer first — instant, no network.
      // With more than one region loaded, search every gazetteer and label the
      // result with its region, otherwise a hit in the "other" province looks
      // identical to one underfoot.
      const multi = props.regions.length > 1;
      const localHits: SearchHit[] = multi
        ? searchAll(regionLib, term, here, 20).map((h) => ({
            label: h.entry.name,
            sub: h.regionName === 'Local map' ? h.entry.cat : `${h.entry.cat} · ${h.regionName}`,
            pos: [h.entry.lon, h.entry.lat] as LatLng,
            source: 'offline' as const,
          }))
        : searchGazetteer(props.dataset?.gaz ?? [], term, here, 12).map((g) => ({
            label: g.name, sub: g.cat, pos: [g.lon, g.lat] as LatLng, source: 'offline' as const,
          }));
      if (!cancelled) setResults(dedupeHits(localHits));

      // Enrich with Nominatim when there's a network.
      if (props.online) {
        try {
          const places = await searchPlaces(term, { near: here, limit: 8 });
          if (!cancelled) {
            setResults((prev) => {
              const extra = places.map((p: Place) => ({
                label: p.name,
                sub: p.displayName.split(',').slice(1, 3).join(',').trim(),
                pos: [p.lon, p.lat] as LatLng,
                source: 'online' as const,
              }));
              // Deduped on position as well as label: the gazetteer and
              // Nominatim both index the same OSM data, so "Memorial Dr"
              // arrived three times from offline alone and "Bow River" eight
              // times from online.
              return dedupeHits([...prev, ...extra]).slice(0, 14);
            });
          }
        } catch (e) {
          if (!cancelled) setErr('Online search unavailable — showing offline results only.');
        }
      }
      if (!cancelled) setBusy(false);
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
    // `props.location` is intentionally NOT a dependency and `locationKey` is
    // its stand-in; the body reads the live value from `locationRef`. Adding
    // `props.location` here is exactly the bug this note exists to prevent — see
    // `locationKey` above — and `test/search-debounce.spec.ts` fails if the raw
    // array comes back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, cat, props.dataset, props.online, locationKey, props.regions, locationRef]);

  return (
    <div className="search-root">
      <div className="top-app-bar">
        <button className="icon-btn" onClick={props.onBack} aria-label="Back"><IconBack size={ICON.primary} /></button>
        {/*
          * The screen's heading.

          * The app bar here held a back button and the search field and nothing
          * else, so navigating by heading skipped this screen entirely — and the
          * field carries `autoFocus`, which meant focus arrived somewhere the
          * user had not chosen. It is `visually-hidden` because a visible
          * "Search" above a search box is noise; it is still the name of the
          * screen, the first thing heading navigation lands on, and what focus
          * moves to.
        */}
        <h1 ref={props.headingRef} tabIndex={-1} className="visually-hidden">Search</h1>
        {/*
         * A real form, so Enter submits. It was a div, which made Enter a
         * complete no-op: typing a full street name and pressing the keyboard's
         * search key did nothing at all.
         */}
        <form
          className="inline-search"
          role="search"
          onSubmit={(e) => { e.preventDefault(); onSubmitFirstResult(); }}
        >
          <IconSearch size={ICON.secondary} color={ink.secondary} />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search places, streets, addresses"
            aria-label="Search places, streets and addresses"
            enterKeyHint="search"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            style={{ ...T.body1, background: 'transparent', border: 'none', outline: 'none', color: ink.primary }}
          />
          {q && (
            <button
              type="button"
              className="search-clear"
              onClick={() => { setQ(''); setResults([]); setBusy(false); }}
              aria-label="Clear search"
            >
              <IconClose size={ICON.secondary} />
            </button>
          )}
        </form>
      </div>

      <div className="search-results">
        {err && <div className="hint-card" role="status">{err}</div>}
        {props.pickHint && (
          <div className="hint-card pick-hint" role="status">
            <IconInfo size={ICON.secondary} />
            <span>{props.pickHint}</span>
          </div>
        )}
        {!props.regions.length && (
          <div className="hint-card">No offline map loaded — import an .osm file for offline search.</div>
        )}
        {props.regions.length > 1 && (
          <div className="hint-card">
            Searching {props.regions.length} downloaded regions. Results show which region each is in.
          </div>
        )}
        {cat && (
          <div className="result-row">
            <span className="result-text">
              <span style={T.body3m}>Browsing {cat}</span>
              <span style={{ ...T.sub3, color: ink.secondary }}>{results.length} nearby</span>
            </span>
            <button className="chip" onClick={() => setCat(null)}>Clear</button>
          </div>
        )}
        {/*
         * The three states have to be told apart, or the screen is lying:
         * still searching, searched and found nothing, and not searching at all.
         * Previously only the first rendered, so ten of twenty-four query shapes
         * — a typo, a house number, a category word — produced a completely blank
         * black screen indistinguishable from a hang.
         */}
        <div aria-live="polite" aria-busy={busy}>
          {busy && !results.length && !cat && (
            <div style={{ ...T.body3, color: ink.secondary }} role="status">Searching…</div>
          )}
          {!busy && !results.length && !cat && searchedTerm && (
            <div className="empty-state" role="status">
              <div style={T.body3m}>No matches for “{searchedTerm}”</div>
              <div style={{ ...T.sub3, color: ink.secondary, marginTop: DP.P1 }}>
                {props.regions.length || props.dataset
                  ? 'Try fewer words, a street name without the house number, or a nearby category.'
                  : 'Search needs an imported .osm map. Import one to search offline.'}
              </div>
            </div>
          )}
        </div>
        {results.map((r, i) => (
          <button key={`${r.source}-${r.label}-${i}`} className="result-row" onClick={() => props.onPick(r.pos, r.label)}>
            <span className="result-icon"><IconGoto size={ICON.secondary} /></span>
            <span className="result-text">
              <span style={T.body3m}>{r.label}</span>
              <span style={{ ...T.sub3, color: ink.secondary }}>{r.sub}</span>
            </span>
            {/*
             * Where the row came from. An online hit has been sent to a
             * third-party geocoder, which is not true of a local one, and the
             * two used to be indistinguishable.
             */}
            <span className={`source-tag ${r.source}`}>{r.source === 'online' ? 'Online' : 'Offline'}</span>
            <IconChevronRight size={ICON.secondary} color={ink.tertiary} />
          </button>
        ))}
        {!q && !cat && categories.length > 0 && (
          <>
            <div className="section-head" style={{ ...T.body3m, marginTop: DP.P4 }}>Browse</div>
            <div className="chip-row">
              {categories.map((c) => (
                <button key={c.key} className="chip" onClick={() => { setCat(cat === c.key ? null : c.key); setQ(''); }}>
                  {c.label}
                  <span style={{ ...T.sub3, color: ink.secondary, marginLeft: 8 }}>{c.count}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {!q && (
          <div className="hint-card" style={{ marginTop: DP.P4 }}>
            <div style={T.body3m}>Try</div>
            <div style={{ ...T.sub3, color: ink.secondary, marginTop: DP.P1 }}>
              street names, “123 Main St”, park or shop names
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------------------- StepsScreen --------------------------- */

function StepsScreen({
  steps, onBack, inferred, engineLabel, destination, headingRef,
}: {
  steps: LegStep[];
  onBack: () => void;
  /**
   * True when these steps were inferred from bearing changes rather than
   * supplied by a routing engine. That is a materially weaker instruction set,
   * and the list says so rather than presenting it as authoritative.
   */
  inferred?: boolean;
  /** The engine that produced the route, for the same reason. */
  engineLabel?: string | null;
  /** Names the final row, which is the one a driver scans for. */
  destination?: { label: string } | null;
  /** This screen's heading, focused on arrival. */
  headingRef?: React.Ref<HTMLHeadingElement>;
}) {
  return (
    <div className="search-root">
      <div className="top-app-bar">
        <button className="icon-btn" onClick={onBack} aria-label="Back"><IconBack size={ICON.primary} /></button>
        <h1 ref={headingRef} tabIndex={-1} className="screen-title" style={{ ...T.body1m, marginLeft: DP.P2 }}>Route steps</h1>
      </div>
      <div className="search-results">
        {/*
          The empty-state copy used to say "Import an .osm file or use a Valhalla
          provider" — advice for a user who had just imported a map and was
          navigating with the offline engine. The reason it is empty is the
          *engine*, not a missing map, so that is what it now says.
        */}
        {steps.length === 0 && (
          <div className="hint-card">
            <div style={T.body3m}>No turn-by-turn instructions for this route</div>
            <div style={{ ...T.sub3, color: ink.secondary, marginTop: DP.P1 }}>
              {engineLabel
                ? `${engineLabel} answered this route but does not supply turn-by-turn guidance.`
                : 'The engine that answered this route does not supply turn-by-turn guidance.'}{' '}
              Choose a Valhalla engine in Settings → Routing → Engines for detailed instructions.
              The distance and ETA remain available on the navigation screen.
            </div>
          </div>
        )}
        {/*
          Inferred guidance is labelled. Comparing an offline route against
          Valhalla over the same origin and destination found three of seven real
          maneuvers missed, one invented, and one direction reversed — so an
          unlabelled list of inferred turns reads as authoritative when it is
          guesswork. `aria-live` is deliberately absent: the list does not change
          while it is open.
        */}
        {steps.length > 0 && inferred && (
          <div className="hint-card warn" role="note">
            <div style={T.body3m}>Estimated from the road shape</div>
            <div style={{ ...T.sub3, color: ink.secondary, marginTop: DP.P1 }}>
              {engineLabel
                ? `${engineLabel} does not supply turn-by-turn guidance, so these steps are inferred from where the road bends. `
                : 'These steps are inferred from where the road bends rather than from real instructions. '}
              Treat them as a rough guide, not as directions.
            </div>
          </div>
        )}
        {steps.map((s, i) => (
          <div key={i} className="result-row">
            <span className="result-icon"><ManeuverIcon kind={s.icon} size={ICON.secondary} /></span>
            <span className="result-text">
              <span style={T.body3m}>{s.title}</span>
              <span style={{ ...T.sub3, color: ink.secondary }}>
                {s.shield ? `Exit ${s.shield} · ` : ''}{s.distanceLabel}
              </span>
            </span>
          </div>
        ))}
        {/*
          * The trip's end, as a row.
          *
          * Every other list of directions in the world ends with "You have
          * arrived" — Google Maps, Apple Maps, every paper route card. This one
          * stopped at the last turn, so the list gave no way to confirm where
          * the trip was *going*, only how to drive the part before it. The
          * destination is already known here (`props` below), so the last row is
          * free and it is the row a driver scans for.
        */}
        {destination && steps.length > 0 && (
          <div className="result-row arrival-row">
            <span className="result-icon"><IconPin size={ICON.secondary} /></span>
            <span className="result-text">
              <span style={T.body3m}>Arrive at {destination.label}</span>
              <span style={{ ...T.sub3, color: ink.secondary }}>Destination</span>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/* --------------------------- EnginesScreen -------------------------- */

/**
 * The engine control and trace surface.
 *
 * Two jobs, deliberately on one screen. Choosing an engine is a setting, but the
 * consequence of that choice — which engine actually answered the last route, and
 * what became of the others — is a fact about a past event, and a driver
 * debugging "why was this route slow" needs both without navigating between them.
 */
function EnginesScreen(props: {
  selection: EngineSelection;
  setSelection: (s: EngineSelection) => void;
  online: boolean;
  hasMap: boolean;
  apiKey: string; setApiKey: (v: string) => void;
  endpoint: string; setEndpoint: (v: string) => void;
  provenance: RouteProvenance | null;
  /** This screen's heading, focused on arrival. */
  headingRef?: React.Ref<HTMLHeadingElement>;
  onBack: () => void;
}) {
  const statuses = engineStatuses(
    { endpoint: props.endpoint, apiKey: props.apiKey },
    props.hasMap,
  );
  const [probes, setProbes] = useState<Record<string, EngineProbe>>({});
  const [probing, setProbing] = useState<string | null>(null);

  const test = async (id: EngineId) => {
    setProbing(id);
    // Probes are deliberately not cached: a stale "reachable" is worse than no
    // answer at all when the question is "is it up right now".
    const r = await probeEngine(id, { endpoint: props.endpoint, apiKey: props.apiKey }, props.hasMap);
    setProbes((p) => ({ ...p, [id]: r }));
    setProbing(null);
  };

  const chosen = props.selection.preferred;
  const servedNow = props.provenance?.used;
  /** `null` when the address is fine, or empty, or not the one being edited. */
  const endpointProblem =
    chosen === 'valhalla-custom' || chosen === ANY_ONLINE ? validateEndpoint(props.endpoint) : null;

  return (
    <div className="search-root">
      <div className="top-app-bar">
        <button className="icon-btn" onClick={props.onBack} aria-label="Back"><IconBack size={ICON.primary} /></button>
        <h1 ref={props.headingRef} tabIndex={-1} className="screen-title" style={{ ...T.body1m, marginLeft: DP.P2 }}>Engines</h1>
      </div>

      <div className="settings-body">
        <div className="section-head" style={T.body3m}>Route with</div>
        {/* A single-select list, exposed as such. It rendered buttons with a radio
            circle drawn in CSS and state carried in `aria-pressed`, so a screen
            reader heard a row of independent toggle-buttons rather than a group of
            mutually exclusive options. */}
        <div role="radiogroup" aria-label="Route with">
        {statuses.map((s) => (
          <button
            key={s.id}
            role="radio"
            className={`provider-row ${chosen === s.id ? 'selected' : ''}`}
            // An engine that cannot route must not be selectable. It was fully
            // live — `disabled=false`, `cursor:pointer`, full opacity — so a row
            // reading "Unavailable — no offline map loaded" could still be chosen
            // and then fail every request. The activation is refused.
            //
            // `aria-disabled`, not `disabled`. `disabled` would also solve that,
            // and then throw away the row's whole purpose: it removes the control
            // from the tab order, so the sentence explaining *why* the engine is
            // unavailable — the only thing the row has to say — becomes
            // unreachable by keyboard and inaudible to assistive technology. The
            // screen read as "here are some engines, pick one", with the chosen
            // one impossible to explore.
            aria-disabled={!s.ready}
            aria-checked={chosen === s.id}
            onClick={() => {
              if (!s.ready) return;
              props.setSelection({ ...props.selection, preferred: s.id });
            }}
          >
            <span className="result-icon">
              {s.online ? <IconTraffic size={ICON.secondary} /> : <IconFile size={ICON.secondary} />}
            </span>
            <span className="result-text">
              <span style={T.body3m}>{s.label}</span>
              {/* State the verdict explicitly rather than leaving it to be
                  inferred from the subtitle. "Ready" and the reason it is not are
                  the two things a driver needs before choosing, and a subtitle
                  that merely describes the engine answers neither. */}
              <span style={{ ...T.sub3, color: s.ready ? accentNight : '#E8A0A0' }}>
                {s.ready ? `Ready — ${s.subtitle}` : `Unavailable — ${s.reason}`}
              </span>
              {servedNow === s.id && props.provenance && (
                <span style={{ ...T.sub3, color: accentNight }}>served the current route</span>
              )}
            </span>
            <span className={`radio ${chosen === s.id ? 'on' : ''}`} />
          </button>
        ))}
        </div>

        <div className="section-head" style={T.body3m}>If it cannot route</div>
        <div className="seg" role="radiogroup" aria-label="If it cannot route">
          <button
            role="radio"
            aria-checked={props.selection.allowFallback}
            className={props.selection.allowFallback ? 'on' : ''}
            onClick={() => props.setSelection({ ...props.selection, allowFallback: true })}
          >
            Use another engine
          </button>
          <button
            role="radio"
            aria-checked={!props.selection.allowFallback}
            className={!props.selection.allowFallback ? 'on' : ''}
            onClick={() => props.setSelection({ ...props.selection, allowFallback: false })}
          >
            Fail instead
          </button>
        </div>
        <div className="hint-card" style={{ marginTop: DP.P2 }}>
          <div style={{ ...T.sub3, color: ink.secondary }}>
            {props.selection.allowFallback
              ? 'Engines are tried in order and the first one that can route wins. The route is labelled with whichever engine actually answered.'
              : 'Only the engine above may answer. If it cannot route, the request fails instead of quietly using another one.'}
          </div>
        </div>

        {(chosen === 'valhalla-simplerouting' || chosen === ANY_ONLINE) && (
          <label className="field">
            <span style={{ ...T.sub2, color: ink.secondary }}>API key (Simplerouting.io)</span>
            {/*
              Masked. It was `type="text"`, so the secret sat in the DOM in plain
              sight — readable in a screenshot, in a screen share, and by anything
              inspecting the page. `autocomplete="off"` keeps it out of the
              browser's saved-password list, which is not what this is.
            */}
            <input
              type="password"
              value={props.apiKey}
              onChange={(e) => props.setApiKey(e.target.value)}
              placeholder="sk-…"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              aria-label="API key for Simplerouting.io"
            />
            <span style={{ ...T.sub3, color: ink.tertiary }}>
              Stored on this device only. It is sent to Simplerouting.io and nowhere else.
            </span>
          </label>
        )}
        {(chosen === 'valhalla-custom' || chosen === ANY_ONLINE) && (
          <label className="field">
            <span style={{ ...T.sub2, color: ink.secondary }}>Custom endpoint</span>
            <input
              value={props.endpoint}
              onChange={(e) => props.setEndpoint(e.target.value)}
              placeholder="http://192.168.1.10:8002"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              inputMode="url"
              aria-label="Custom Valhalla endpoint URL"
              aria-invalid={endpointProblem ? true : undefined}
              aria-describedby={endpointProblem ? 'endpoint-error' : undefined}
            />
            {endpointProblem && (
              <span id="endpoint-error" role="alert" style={{ ...T.sub3, color: '#F28B82' }}>
                {endpointProblem}
              </span>
            )}
          </label>
        )}

        <div className="section-head" style={T.body3m}>Last route request</div>
        {props.provenance ? (
          <div className="hint-card">
            <div style={T.body3m}>
              Answered by {describeProvenance(props.provenance.used, props.provenance.fellBack)}
            </div>
            <div style={{ ...T.sub3, color: ink.secondary, marginBottom: DP.P2 }}>
              {props.provenance.totalMs} ms total ·{' '}
              {hasManeuvers(props.provenance.used)
                ? 'turn-by-turn available'
                : 'no turn-by-turn from this engine'}
            </div>
            {props.provenance.attempts.map((a) => (
              <div key={a.engine} style={{ ...T.sub3, color: ink.secondary, marginBottom: DP.P1 / 2 }}>
                <span
                  style={{
                    color: a.outcome === 'served'
                      ? accentNight
                      : a.outcome === 'not-tried'
                        ? ink.secondary
                        : '#E8A0A0',
                  }}
                >
                  {describeAttempt(a)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="hint-card">
            <div style={{ ...T.sub3, color: ink.secondary }}>
              No route requested yet, so no engine has proven itself.
            </div>
          </div>
        )}

        <div className="section-head" style={T.body3m}>Test engines</div>
        {statuses.map((s) => (
          <div key={s.id} className="region-actions" style={{ marginBottom: DP.P2 }}>
            <span style={{ ...T.sub3, color: ink.secondary, flex: 1 }}>
              {s.label}
              {probes[s.id] ? ` — ${probes[s.id].detail}` : ''}
            </span>
            <button
              className="text-btn"
              onClick={() => test(s.id)}
              disabled={probing === s.id}
            >
              {probing === s.id ? 'Testing…' : 'Test'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* --------------------------- SettingsScreen ------------------------- */

function SettingsScreen(props: {
  selection: EngineSelection; setSelection: (s: EngineSelection) => void;
  online: boolean;
  dataset: OsmDataset | null;
  regionCount: number;
  apiKey: string; setApiKey: (v: string) => void;
  endpoint: string; setEndpoint: (v: string) => void;
  units: 'metric' | 'imperial'; setUnits: (u: 'metric' | 'imperial') => void;
  provenance: RouteProvenance | null;
  /** Set when the browser refused to persist a setting. */
  storageNotice?: string | null;
  onBack: () => void; onImport: () => void; onRegions: () => void;
  onEngines: () => void;
  /** This screen's heading, focused on arrival. */
  headingRef?: React.Ref<HTMLHeadingElement>;
}) {
  const serving = props.provenance
    ? describeProvenance(props.provenance.used, props.provenance.fellBack)
    : null;
  return (
    <div className="search-root">
      <div className="top-app-bar">
        <button className="icon-btn" onClick={props.onBack} aria-label="Back"><IconBack size={ICON.primary} /></button>
        <h1 ref={props.headingRef} tabIndex={-1} className="screen-title" style={{ ...T.body1m, marginLeft: DP.P2 }}>Settings</h1>
      </div>

      <div className="settings-body">
        {props.storageNotice && (
          // Only rendered when storage actually refused. A permanent warning
          // about settings not persisting would be noise in the normal case,
          // and a silent one would be a lie in the private-window case.
          <div className="hint-card warn" role="status">{props.storageNotice}</div>
        )}
        <div className="section-head" style={T.body3m}>Routing</div>
        <button className="hint-card" onClick={props.onEngines} style={{ textAlign: 'left', width: '100%' }}>
          <div style={T.body3m}>
            {props.selection.preferred === ANY_ONLINE
              ? ANY_ONLINE_LABEL
              : PROVIDERS.find((p) => p.id === props.selection.preferred)?.label ?? 'Engine'}
          </div>
          <div style={{ ...T.sub3, color: ink.secondary, marginTop: DP.P1 }}>
            {serving
              ? `Last route answered by ${serving}`
              : 'No route requested yet — choose an engine'}
          </div>
          <div style={{ ...T.sub3, color: ink.secondary }}>
            {props.selection.allowFallback
              ? 'May substitute another engine if this one cannot route'
              : 'Fails rather than substituting'}
          </div>
        </button>

        <div className="section-head" style={T.body3m}>Units</div>
        <div className="seg">
          <button className={props.units === 'metric' ? 'on' : ''} onClick={() => props.setUnits('metric')}>Metric</button>
          <button className={props.units === 'imperial' ? 'on' : ''} onClick={() => props.setUnits('imperial')}>Imperial</button>
        </div>

        <div className="section-head" style={T.body3m}>Offline map</div>
        <div className="hint-card">
          <div style={T.body3m}>
            {props.dataset ? `${props.dataset.counts.ways.toLocaleString()} ways, ${props.dataset.gaz.length.toLocaleString()} places indexed` : 'No map loaded'}
          </div>
          <div style={{ ...T.sub3, color: ink.secondary, margin: `${DP.P1}px 0 ${DP.P3}px` }}>
            {props.dataset
              ? `Bounds ${props.dataset.bbox.map((v) => v.toFixed(3)).join(', ')}`
              : 'Import a .osm extract to enable offline routing and search.'}
          </div>
          <div className="region-actions">
            <button className="text-btn" onClick={props.onImport}>Import .osm</button>
            <button className="pill-btn" onClick={props.onRegions}>
              Regions ({props.regionCount})
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------- ImportScreen -------------------------- */

function ImportScreen(props: {
  progress: BuildProgress | null;
  error: string | null;
  /** Non-fatal: the import succeeded, with a caveat worth reading. */
  warn?: string | null;
  onDismissError?: () => void;
  onDismissWarn?: () => void;
  onFile: (f: File) => void;
  onBack: () => void;
  /** This screen's heading, focused on arrival. */
  headingRef?: React.Ref<HTMLHeadingElement>;
}) {
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div className="search-root">
      <div className="top-app-bar">
        <button className="icon-btn" onClick={props.onBack} aria-label="Back"><IconBack size={ICON.primary} /></button>
        <h1 ref={props.headingRef} tabIndex={-1} className="screen-title" style={{ ...T.body1m, marginLeft: DP.P2 }}>Import .osm</h1>
      </div>

      <div className="settings-body">
        {/*
          The picker is a real button, not a styled `<label>` wrapped around a
          `hidden` input.

          A `hidden` input is removed from the accessibility tree entirely, so
          the whole dropzone exposed *zero* controls: tab order ran from the four
          attribution links to Back to the map canvas with no way to open a file
          dialog at all. A visually-hidden input driven by a real button is
          operable by keyboard, announced with a name, and still styled as the
          large drop target.

          The button carries the drop handlers too, so both gestures land on one
          element rather than two overlapping ones.
        */}
        <button
          type="button"
          className={`dropzone ${dragging ? 'over' : ''}`}
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const f = e.dataTransfer.files[0];
            if (f) props.onFile(f);
          }}
        >
          <IconFile size={64} color={ink.secondary} />
          <span style={{ ...T.body1m, marginTop: DP.P3 }}>Choose or drop an .osm file</span>
          <span style={{ ...T.sub3, color: ink.secondary, marginTop: DP.P1, textAlign: 'center' }}>
            Accepts <code>.osm</code> (XML) and <code>.osm.pbf</code> (protobuf),<br />
            which is what Geofabrik publishes. Smaller extracts can be converted
            with <code>osmium cat region.osm.pbf -o region.osm</code>.
          </span>
        </button>
        {/* Present for the programmatic `.click()` above and for automation;
            taken out of the layout and out of the tab order so the visible
            button is the only stop. */}
        <input
          ref={fileRef}
          type="file"
          accept=".osm,.pbf,.xml,application/octet-stream"
          className="visually-hidden-input"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) props.onFile(f); }}
        />

        {props.progress && <ProgressCard progress={props.progress} />}
        {props.error && (
          <ImportMessage tone="error" message={props.error} onDismiss={() => props.onDismissError?.()} />
        )}
        {props.warn && (
          <ImportMessage tone="warn" message={props.warn} onDismiss={() => props.onDismissWarn?.()} />
        )}
      </div>
    </div>
  );
}
