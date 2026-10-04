import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapView, type TrafficOverlay } from './map/MapView';
import type { BuildProgress } from './osm/engine';
import type { OsmDataset } from './osm/engine.worker';
import { searchPlaces, type Place } from './nav/geocode';
import {
  resolveRoute, isOnline, watchConnectivity, PROVIDERS, localToRoute,
  NoRouteError, type ProviderId,
} from './nav/providers';
import type { Route, ValhallaManeuver } from './nav/valhalla';
import { maneuverIcon, isMajorManeuver, type LegStep } from './nav/maneuver';
import {
  describeTraffic, routeWithTraffic, type TrafficLevel,
} from './nav/traffic';
import { offRouteThreshold, progressAlong as routeProgress } from './nav/offroute';
import {
  formatDistance, formatDuration, formatClock, haversine, lineLength,
  snapToPolyline, type LatLng,
} from './geo';
import { ink, type as T, DP, ICON } from './theme';
import { useLocation, type LocationMode } from './nav/location';
import RegionsScreen from './regions/RegionsScreen';
import {
  importRegionFile, localRegionId, localRegionName, regionLib, useRegions,
  restoreRegions,
} from './regions/store';
import { searchAll } from './osm/regions';
import {
  ManeuverIcon, IconSearch, IconBack, IconClose, IconMute, IconSound, IconOverview,
  IconLayers, IconTraffic, IconSettings, IconHome, IconGoto, IconChevronRight,
  IconFile, IconLocate, IconCar, IconRefresh,
} from './icons';

type Screen = 'home' | 'search' | 'preview' | 'navigating' | 'steps' | 'settings' | 'import' | 'regions';

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

/**
 * Where on the route a position sits, as a vertex index.
 *
 * `snapToPolyline` reports the index of the *segment* it projected onto, which
 * is what you want for "which leg am I on" but cannot express arrival: a
 * two-point route — what the offline engine returns for a straight hop along one
 * way — has a single segment, so its index is always 0 and the destination can
 * never be reached. With no segment to interpolate, fall back to whichever end
 * of the line the car is actually nearer.
 */
function snappedIndex(pt: LatLng, line: LatLng[], segmentIndex: number): number {
  const last = line.length - 1;
  if (last < 1) return 0;
  if (last > 1) return Math.min(segmentIndex, last);
  return haversine(pt, line[0]) <= haversine(pt, line[last]) ? 0 : last;
}

/* ------------------------------ App ------------------------------ */

export default function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [online, setOnline] = useState(isOnline());
  const [provider, setProvider] = useState<ProviderId>('local');
  const [apiKey, setApiKey] = useState('');
  const [endpoint, setEndpoint] = useState('');

  const [dataset, setDataset] = useState<OsmDataset | null>(null);
  const [progress, setProgress] = useState<BuildProgress | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
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
  const [units, setUnits] = useState<'metric' | 'imperial'>('metric');
  // Valhalla expects km/miles; our formatters expect metric/imperial.
  const valhallaUnits: 'km' | 'miles' = units === 'imperial' ? 'miles' : 'km';

  // Real GPS on device, Geolocation API in a browser, simulated as a last resort.
  const { fix, mode: locationMode, error: locationError } = useLocation(true);
  const location = fix.pos;

  /* ------------------------ layers and traffic ------------------------ */

  const [layer, setLayer] = useState<LayerId>('default');
  const [layersOpen, setLayersOpen] = useState(false);
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
    const prov = PROVIDERS.find((p) => p.id === provider);
    const target = provider === 'valhalla-custom' ? endpoint : prov?.endpoint ?? '';
    if (!prov?.online || !target) {
      setTraffic({
        status: 'unavailable',
        secondsSaved: 0,
        reason: 'Traffic needs an online routing provider; none is selected',
      });
      return;
    }

    setTraffic({ status: 'probing', secondsSaved: 0, reason: 'Checking the routing provider for traffic data' });
    const res = await routeWithTraffic(ends.from, ends.to, {
      endpoint: target,
      units: valhallaUnits,
      headers: provider === 'valhalla-simplerouting' && apiKey
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
  }, [route, routeEnds, online, provider, endpoint, apiKey, valhallaUnits, origin, location, destination]);

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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');

      // Escape and mute work even from inside the search field; every other
      // shortcut is suppressed while typing so it cannot fight the query.
      if (e.key === 'Escape') {
        setScreen('home');
        return;
      }
      if (typing) return;

      if (e.key === '/') {
        // preventDefault stops Chrome's own quick-find from also consuming it,
        // and no seed character is set so "/" is not typed into the field.
        e.preventDefault();
        setPendingInitialQuery('');
        setScreen('search');
        requestAnimationFrame(() => {
          document.querySelector<HTMLInputElement>('.inline-search input')?.focus();
        });
      } else if (e.key.length === 1 && /^[a-z0-9]$/i.test(e.key)) {
        e.preventDefault();
        setScreen('search');
        setPendingInitialQuery(e.key);
        requestAnimationFrame(() => {
          document.querySelector<HTMLInputElement>('.inline-search input')?.focus();
        });
      } else if (e.key === 'm' || e.key === 'M') {
        setMuted((m) => !m);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
    const ds = await importRegionFile({
      id, name, code, file,
      onProgress: setProgress,
      onError: setImportError,
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
    if (ds) setScreen('home');
  }, [build]);

  /* ---------------------------- routing --------------------------- */

  const doRoute = useCallback(async (dest: { pos: LatLng; label: string }) => {
    setDestination(dest);
    setRouteError(null);
    setRouting(true);
    setDegraded([]);
    const from = origin ?? location;
    try {
      const outcome = await resolveRoute(
        { from, to: dest.pos, provider, units: valhallaUnits, avoid: [] },
        dataset,
        { apiKey, endpoint },
      );
      setRoute(outcome.route);
      setDegraded(outcome.degraded.map((d) => `${d.provider}: ${d.reason}`));
      setProgressAlong(0);
      resetTraffic({ from, to: dest.pos });
      setScreen('preview');
      setFitNonce((n) => n + 1);
    } catch (e) {
      // Single-dataset routing can't span extracts. With several regions
      // downloaded the library picks the region for each end and stitches.
      const multi = regions.length > 1 ? regionLib.route(from, dest.pos) : null;
      if (multi) {
        setRoute(localToRoute(multi.result, valhallaUnits));
        setDegraded([`Region library: ${multi.regions.map((id) => regionLib.get(id)?.name ?? id).join(' → ')}`]);
        setProgressAlong(0);
        resetTraffic({ from, to: dest.pos });
        setScreen('preview');
        setFitNonce((n) => n + 1);
      } else {
        setRoute(null);
        setRouteError(e instanceof NoRouteError ? e.message : (e as Error).message);
        resetTraffic(null);
        setScreen('preview');
      }
    } finally {
      setRouting(false);
    }
  }, [dataset, origin, location, provider, valhallaUnits, apiKey, endpoint, regions.length, resetTraffic]);

  /* ------------------------- guidance model ----------------------- */

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

    const distToNext = (() => {
      const frac = (next.begin_shape_index - active.begin_shape_index) /
        Math.max(1, next.end_shape_index - active.begin_shape_index);
      return Math.max(0, remainingM - remainingM * frac);
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
    // Where the car actually is on the line, which is what the dimmed portion and
    // the remaining distance both hang off.
    const here = snappedIndex(location, geometry, snap.index);
    const totalM = lineLength(geometry);
    const remainingM = lineLength(geometry.slice(here));

    // Derive turn instructions from bearing change at each vertex.
    const steps: LegStep[] = [];
    for (let i = 8; i < geometry.length - 8; i += 8) {
      const inB = bearingBetween(geometry[i - 8], geometry[i]);
      const outB = bearingBetween(geometry[i], geometry[i + 8]);
      let turn = outB - inB;
      while (turn > 180) turn -= 360;
      while (turn < -180) turn += 360;
      const kind = turnKind(turn);
      if (!kind) continue;
      steps.push({
        icon: kind, major: Math.abs(turn) > 120,
        title: `${kind.replace('-', ' ')} onto unnamed road`,
        distanceLabel: '', distanceMeters: 0, shapeIndex: i,
      });
    }
    return { snap, remainingM, totalM, steps, travelled: geometry.slice(0, here + 1), idx };
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
    setProgressAlong((prev) => Math.max(prev, routeProgress(geometry, snappedIndex(location, geometry, snap.index))));
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

  const banner = routeError ?? degraded[0] ?? null;

  return (
    <div className="app">
      <MapView
        dataset={dataset}
        useTiles={online}
        route={route?.geometry ?? null}
        travelled={guidance?.travelled ?? localGuidance?.travelled ?? null}
        traffic={trafficSpans}
        origin={origin ?? location}
        destination={destination?.pos ?? null}
        location={location}
        maneuverPoints={
          route?.engine === 'valhalla'
            ? route.maneuvers.map((m) => route.geometry[Math.min(m.begin_shape_index, route.geometry.length - 1)])
            : []
        }
        focus={focus}
        fitNonce={fitNonce}
      />

      {screen === 'navigating' && route && (
        <NavOverlay
          route={route}
          guidance={guidance}
          localGuidance={localGuidance}
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
          onExit={() => { setScreen('home'); setProgressAlong(0); }}
          onOverview={() => setFitNonce((n) => n + 1)}
          onRecenter={() => setFocus({ center: location, zoom: 17 })}
          onSteps={() => setScreen('steps')}
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
          onGo={() => setScreen('navigating')}
          onBack={() => setScreen('home')}
          onProvider={() => setScreen('settings')}
        />
      )}

      {screen === 'home' && (
        <HomeScreen
          restoring={restoring}
          dataset={dataset}
          regionCount={regions.length}
          online={online}
          provider={provider}
          locationMode={locationMode}
          locationError={locationError}
          progress={progress}
          error={importError}
          route={route}
          onImport={() => setScreen('import')}
          onImportFile={onFile}
          onRegions={() => setScreen('regions')}
          onSearch={() => setScreen('search')}
          onContinue={() => route && setScreen('navigating')}
          onSettings={() => setScreen('settings')}
          onRoute={(pos, label) => doRoute({ pos, label })}
          onClear={() => { setRoute(null); setDestination(null); setOrigin(null); resetTraffic(null); }}
        />
      )}

      {screen === 'search' && (
        <SearchScreen
          dataset={dataset}
          regions={regions}
          online={online}
          location={location}
          initialQuery={pendingInitialQuery}
          onInitialQueryConsumed={() => setPendingInitialQuery('')}
          onPick={(pos, label) => { setScreen('home'); doRoute({ pos, label }); }}
          onBack={() => setScreen('home')}
        />
      )}

      {screen === 'steps' && (
        <StepsScreen
          steps={guidance?.steps ?? localGuidance?.steps ?? []}
          onBack={() => setScreen('navigating')}
        />
      )}

      {screen === 'settings' && (
        <SettingsScreen
          provider={provider}
          setProvider={setProvider}
          online={online}
          dataset={dataset}
          regionCount={regions.length}
          apiKey={apiKey}
          setApiKey={setApiKey}
          endpoint={endpoint}
          setEndpoint={setEndpoint}
          units={units}
          setUnits={setUnits}
          onBack={() => setScreen('home')}
          onImport={() => setScreen('import')}
          onRegions={() => setScreen('regions')}
        />
      )}

      {screen === 'import' && (
        <ImportScreen
          progress={progress}
          error={importError}
          onFile={onFile}
          onBack={() => setScreen('home')}
        />
      )}

      {screen === 'regions' && (
        <RegionsScreen
          units={units}
          location={location}
          onBack={() => setScreen('home')}
          onActivated={() => { setImportError(null); setProgress(null); }}
          onMapFocus={(center, zoom) => setFocus({ center, zoom })}
          onPreviewRoute={(result, to, label, via) => {
            setDestination({ pos: to, label });
            setRoute(localToRoute(result, valhallaUnits));
            setRouteError(null);
            setDegraded([`Region library: ${via.map((id) => regionLib.get(id)?.name ?? id).join(' → ')}`]);
            setProgressAlong(0);
            resetTraffic({ from: location, to });
            setScreen('preview');
            setFitNonce((n) => n + 1);
          }}
        />
      )}
    </div>
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
  provider: ProviderId;
  locationMode: LocationMode;
  locationError: string | null;
  progress: BuildProgress | null;
  error: string | null;
  route: Route | null;
  onImport: () => void;
  onImportFile: (f: File) => void;
  onRegions: () => void;
  onSearch: () => void;
  onContinue: () => void;
  onSettings: () => void;
  onRoute: (pos: LatLng, label: string) => void;
  onClear: () => void;
}

function HomeScreen(p: HomeProps) {
  return (
    <>
      {p.restoring && (
        <div className="restoring-bar" role="status">
          <span style={T.sub3}>Restoring saved maps…</span>
        </div>
      )}
      <div className="top-app-bar">
        <div className="brand">
          <IconCar size={40} />
          <div className="brand-text">
            <div style={T.body3m}>Canopy Nav</div>
            <div style={{ ...T.sub3, color: ink.secondary }}>
              {p.dataset
                ? `${p.dataset.counts.routable.toLocaleString()} routable ways · ${p.regionCount} region${p.regionCount === 1 ? '' : 's'}`
                : 'No map loaded'}
            </div>
          </div>
        </div>
        <div className="spacer" />
        <StatusPill
          online={p.online}
          provider={p.provider}
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
          <QuickTile label="Home" icon={<IconHome size={ICON.primary} />} onClick={() => p.onRoute([-0.1276, 51.5072], 'Home')} />
          <QuickTile label="Work" icon={<IconGoto size={ICON.primary} />} onClick={() => p.onRoute([-0.142, 51.5], 'Work')} />
          <QuickTile label="Regions" icon={<IconLayers size={ICON.primary} />} onClick={p.onRegions} />
          {/* Label stays short: five tiles share the row at head-unit widths and
              "Import .osm" truncates. The hint card below names the format. */}
          <QuickTile label="Import" icon={<IconFile size={ICON.primary} />} onClick={p.onImport} />
        </div>

        {p.route && (
          <button className="continue-card" onClick={p.onContinue}>
            <div className="continue-left">
              <div style={T.body3m}>Continue navigation</div>
              <div style={{ ...T.sub3, color: ink.secondary }}>
                {p.route.summary ? `${formatDuration(p.route.summary.time)} · ${formatDistance(p.route.summary.length, 'metric')}` : ''}
              </div>
            </div>
            <IconChevronRight size={ICON.primary} />
          </button>
        )}

        {p.progress && <ProgressCard progress={p.progress} />}
        {p.error && <div className="error-card">{p.error}</div>}
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
    </>
  );
}

function StatusPill({
  online,
  provider,
  locationMode,
  locationError,
}: {
  online: boolean;
  provider: ProviderId;
  locationMode: LocationMode;
  locationError: string | null;
}) {
  const label = online ? PROVIDERS.find((x) => x.id === provider)?.label ?? 'Online' : 'Offline';
  const gps = locationMode === 'device' ? 'GPS'
    : locationMode === 'browser' ? 'Browser GPS'
    : 'Simulated GPS';
  const title = locationError ? `${gps} - ${locationError}` : gps;
  return (
    <div
      className={`status-pill ${online ? 'on' : 'off'}`}
      title={title}
      style={{ gap: 16 }}
    >
      <span className="dot" />
      <span style={T.sub3}>{label}</span>
      <span style={{ ...T.sub3, color: 'rgba(255,255,255,0.5)' }}>{gps}</span>
    </div>
  );
}

function QuickTile({ label, icon, onClick }: { label: string; icon: React.ReactNode; onClick: () => void }) {
  return (
    <button className="quick-tile" onClick={onClick}>
      <span className="quick-icon">{icon}</span>
      <span style={{ ...T.body3, textAlign: 'center' }}>{label}</span>
    </button>
  );
}

function ProgressCard({ progress }: { progress: BuildProgress }) {
  return (
    <div className="progress-card">
      <div style={T.body3m}>{progress.stage}</div>
      <div className="bar"><div className="fill" style={{ width: `${Math.round(progress.pct * 100)}%` }} /></div>
      <div style={{ ...T.sub3, color: ink.secondary }}>{Math.round(progress.pct * 100)}%</div>
    </div>
  );
}

/* ---------------------------- NavOverlay ---------------------------- */

function NavOverlay(props: {
  route: Route;
  guidance: GuidanceModel | null;
  localGuidance: LocalGuidanceModel | null;
  location: LatLng;
  progressAlong: number;
  units: 'metric' | 'imperial';
  muted: boolean;
  online: boolean;
  degraded: boolean;
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

  const distToTurn = g ? g.distToNext : 0;
  const nextManeuver = g ? g.next : null;
  const icon: LegStep['icon'] = nextManeuver ? maneuverIcon(nextManeuver.type) : 'continue';
  const major = nextManeuver ? isMajorManeuver(nextManeuver.type) : false;

  const remainingM = g?.remainingM ?? lg?.remainingM ?? 0;
  const remainingSec = remainingM > 0 ? (route.summary.time || 0) * (remainingM / Math.max(1, lineLength(route.geometry))) : 0;

  // Google Maps dims the instruction once you're within ~30 m.
  const imminent = distToTurn < 40;
  const laneDist = imminent ? distToTurn : Math.min(distToTurn, 9999);

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

  return (
    <div className="nav-root">
      {/* ETA bar — Android Auto's top strip */}
      <div className="eta-bar">
        <div className="eta-block">
          <div className="eta-value" style={T.body1m}>{formatDuration(remainingSec)}</div>
          <div className="eta-label" style={T.sub3}>{formatClock(new Date(Date.now() + remainingSec * 1000))}</div>
        </div>
        <div className="eta-sep" />
        <div className="eta-block">
          <div className="eta-value" style={T.body1m}>{formatDistance(remainingM, units)}</div>
          <div className="eta-label" style={T.sub3}>to destination</div>
        </div>
        <div className="spacer" />
        {!online && <div className="offline-chip">No signal</div>}
        {online && degraded && <div className="offline-chip warn">Local route</div>}
        <button className="icon-btn on-dark" onClick={props.onMute} aria-label={muted ? 'Unmute' : 'Mute'}>
          {muted ? <IconMute size={ICON.primary} /> : <IconSound size={ICON.primary} />}
        </button>
        <button className="icon-btn on-dark" onClick={props.onExit} aria-label="Exit navigation">
          <IconClose size={ICON.primary} />
        </button>
      </div>

      {/* Maneuver banner — the big card Google Maps shows before each turn */}
      <div className="maneuver-banner">
        <div className={`maneuver-icon ${major ? 'major' : ''}`}>
          <ManeuverIcon kind={icon} size={88} />
        </div>
        <div className="maneuver-text">
          <div className="maneuver-dist" style={T.display3}>{formatDistance(laneDist, units)}</div>
          {nextManeuver?.sign?.exit_number_elements?.length ? (
            <div className="shield">{nextManeuver.sign.exit_number_elements.map((e) => e.text).join('')}</div>
          ) : null}
          <div className="maneuver-instr" style={T.body1}>
            {nextManeuver?.instruction ?? 'Continue'}
          </div>
        </div>
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
          onClick={props.onToggleTraffic}
          disabled={!props.trafficReady}
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
  return (
    <div className="nav-panel" role="dialog" aria-label="Map layers">
      <div className="panel-head">
        <span style={T.body3m}>Map layers</span>
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

      <div className="layer-list">
        {props.options.map((o) => (
          <button
            key={o.id}
            className={`layer-row ${o.id === props.layer ? 'on' : ''}`}
            onClick={() => props.onPick(o.id)}
            disabled={!o.available}
            aria-pressed={o.id === props.layer}
            aria-label={`${o.label} map layer. ${o.detail}`}
          >
            <span className="layer-text">
              <span style={T.body3m}>{o.label}</span>
              <span style={{ ...T.body3, color: o.available ? ink.secondary : ink.tertiary }}>
                {o.detail}
              </span>
            </span>
            <span className={`radio ${o.id === props.layer ? 'on' : ''}`} />
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
  onGo: () => void;
  onBack: () => void;
  onProvider: () => void;
}) {
  const { route, units, routing, error } = props;
  return (
    <div className="preview-root">
      <button className="floating-back" onClick={props.onBack} aria-label="Back">
        <IconBack size={ICON.primary} />
      </button>

      <div className="preview-card">
        {routing && <div className="bar"><div className="fill anim" /></div>}
        {error && <div className="error-card">{error}</div>}

        {route && (
          <>
            <div className="preview-dest" style={T.body1m}>{props.destination?.label ?? 'Destination'}</div>
            <div className="preview-rows">
              <PreviewRow label="Time" value={formatDuration(route.summary.time)} icon={<span>⏱</span>} />
              <PreviewRow label="Distance" value={formatDistance(route.summary.length, units)} />
              <PreviewRow label="Engine" value={route.engine === 'valhalla' ? 'Valhalla' : 'Offline .osm'} />
            </div>
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

function PreviewRow({ label, value }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="preview-row">
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

function SearchScreen(props: {
  dataset: OsmDataset | null;
  regions: ReturnType<typeof useRegions>;
  /** Seed query from a hardware keyboard shortcut. */
  initialQuery?: string;
  onInitialQueryConsumed?: () => void;
  online: boolean;
  location: LatLng;
  onPick: (pos: LatLng, label: string) => void;
  onBack: () => void;
}) {
  const categories = useMemo(
    () => categoriesFor(props.regions, props.dataset),
    [props.regions, props.dataset],
  );
  const [q, setQ] = useState(props.initialQuery ?? '');
  // Adopt a keyboard-seeded query whenever the screen is reopened.
  useEffect(() => {
    if (props.initialQuery) {
      setQ(props.initialQuery);
      props.onInitialQueryConsumed?.();
    }
  }, [props.initialQuery, props.onInitialQueryConsumed]);
  // A category chip filters the gazetteer by tag category. It is deliberately
  // not a text query: searching the literal word "city" matches no place names.
  const [cat, setCat] = useState<string | null>(null);
  const [results, setResults] = useState<{ label: string; sub: string; pos: LatLng }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
          d: Math.hypot((g.lat - near[1]) * 111320, (g.lon - near[0]) * 111320 * Math.cos(near[1] * Math.PI / 180)),
        }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 20);
      setResults(hits);
      setBusy(false);
      return;
    }
    const term = q.trim();
    if (term.length < 2) { setResults([]); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      setBusy(true); setErr(null);

      // Offline gazetteer first — instant, no network.
      // With more than one region loaded, search every gazetteer and label the
      // result with its region, otherwise a hit in the "other" province looks
      // identical to one underfoot.
      const multi = props.regions.length > 1;
      const localHits = multi
        ? searchAll(regionLib, term, props.location, 20).map((h) => ({
            label: h.entry.name,
            sub: h.regionName === 'Local map' ? h.entry.cat : `${h.entry.cat} · ${h.regionName}`,
            pos: [h.entry.lon, h.entry.lat] as LatLng,
          }))
        : (props.dataset?.gaz ?? [])
            .filter((g) => g.name.toLowerCase().includes(term.toLowerCase()))
            .slice(0, 8)
            .map((g) => ({ label: g.name, sub: g.cat, pos: [g.lon, g.lat] as LatLng }));
      if (!cancelled) setResults(localHits);

      // Enrich with Nominatim when there's a network.
      if (props.online) {
        try {
          const places = await searchPlaces(term, { near: props.location, limit: 8 });
          if (!cancelled) {
            setResults((prev) => {
              const seen = new Set(prev.map((p) => p.label));
              const extra = places.map((p: Place) => ({
                label: p.name, sub: p.displayName.split(',').slice(1, 3).join(',').trim(), pos: [p.lon, p.lat] as LatLng,
              })).filter((p) => !seen.has(p.label));
              return [...prev, ...extra].slice(0, 14);
            });
          }
        } catch (e) {
          if (!cancelled) setErr('Online search unavailable — showing offline results only.');
        }
      }
      if (!cancelled) setBusy(false);
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q, cat, props.dataset, props.online, props.location, props.regions]);

  return (
    <div className="search-root">
      <div className="top-app-bar">
        <button className="icon-btn" onClick={props.onBack} aria-label="Back"><IconBack size={ICON.primary} /></button>
        <div className="inline-search">
          <IconSearch size={ICON.secondary} color={ink.secondary} />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search places, streets, addresses"
            style={{ ...T.body1, background: 'transparent', border: 'none', outline: 'none', color: ink.primary, width: '100%' }}
          />
          {q && <button className="icon-btn" onClick={() => setQ('')}><IconClose size={ICON.secondary} /></button>}
        </div>
      </div>

      <div className="search-results">
        {err && <div className="hint-card">{err}</div>}
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
        {busy && !results.length && !cat && <div style={{ ...T.body3, color: ink.secondary }}>Searching…</div>}
        {results.map((r, i) => (
          <button key={i} className="result-row" onClick={() => props.onPick(r.pos, r.label)}>
            <span className="result-icon"><IconGoto size={ICON.secondary} /></span>
            <span className="result-text">
              <span style={T.body3m}>{r.label}</span>
              <span style={{ ...T.sub3, color: ink.secondary }}>{r.sub}</span>
            </span>
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
                  <span style={{ ...T.sub3, color: 'rgba(255,255,255,0.5)', marginLeft: 8 }}>{c.count}</span>
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

function StepsScreen({ steps, onBack }: { steps: LegStep[]; onBack: () => void }) {
  return (
    <div className="search-root">
      <div className="top-app-bar">
        <button className="icon-btn" onClick={onBack} aria-label="Back"><IconBack size={ICON.primary} /></button>
        <div style={{ ...T.body1m, marginLeft: DP.P2 }}>Route steps</div>
      </div>
      <div className="search-results">
        {steps.length === 0 && <div className="hint-card">No turn-by-turn steps. Import an .osm file or use a Valhalla provider for detailed instructions.</div>}
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
      </div>
    </div>
  );
}

/* --------------------------- SettingsScreen ------------------------- */

function SettingsScreen(props: {
  provider: ProviderId; setProvider: (p: ProviderId) => void;
  online: boolean;
  dataset: OsmDataset | null;
  regionCount: number;
  apiKey: string; setApiKey: (v: string) => void;
  endpoint: string; setEndpoint: (v: string) => void;
  units: 'metric' | 'imperial'; setUnits: (u: 'metric' | 'imperial') => void;
  onBack: () => void; onImport: () => void; onRegions: () => void;
}) {
  return (
    <div className="search-root">
      <div className="top-app-bar">
        <button className="icon-btn" onClick={props.onBack} aria-label="Back"><IconBack size={ICON.primary} /></button>
        <div style={{ ...T.body1m, marginLeft: DP.P2 }}>Settings</div>
      </div>

      <div className="settings-body">
        <div className="section-head" style={T.body3m}>Routing provider</div>
        {PROVIDERS.map((prov) => (
          <button
            key={prov.id}
            className={`provider-row ${props.provider === prov.id ? 'selected' : ''}`}
            onClick={() => props.setProvider(prov.id)}
          >
            <span className="result-icon">
              {prov.online ? <IconTraffic size={ICON.secondary} /> : <IconFile size={ICON.secondary} />}
            </span>
            <span className="result-text">
              <span style={T.body3m}>{prov.label}</span>
              <span style={{ ...T.sub3, color: ink.secondary }}>{prov.subtitle}</span>
            </span>
            <span className={`radio ${props.provider === prov.id ? 'on' : ''}`} />
          </button>
        ))}

        {props.provider === 'valhalla-simplerouting' && (
          <label className="field">
            <span style={{ ...T.sub2, color: ink.secondary }}>API key</span>
            <input value={props.apiKey} onChange={(e) => props.setApiKey(e.target.value)} placeholder="sk-…" />
          </label>
        )}
        {props.provider === 'valhalla-custom' && (
          <label className="field">
            <span style={{ ...T.sub2, color: ink.secondary }}>Endpoint</span>
            <input value={props.endpoint} onChange={(e) => props.setEndpoint(e.target.value)} placeholder="http://192.168.1.10:8002" />
          </label>
        )}

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
  onFile: (f: File) => void;
  onBack: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  return (
    <div className="search-root">
      <div className="top-app-bar">
        <button className="icon-btn" onClick={props.onBack} aria-label="Back"><IconBack size={ICON.primary} /></button>
        <div style={{ ...T.body1m, marginLeft: DP.P2 }}>Import .osm</div>
      </div>

      <div className="settings-body">
        <label
          className={`dropzone ${dragging ? 'over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) props.onFile(f); }}
        >
          <input type="file" accept=".osm,.pbf,.xml,application/octet-stream" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) props.onFile(f); }} />
          <IconFile size={64} color={ink.secondary} />
          <div style={{ ...T.body1m, marginTop: DP.P3 }}>Choose or drop an .osm file</div>
          <div style={{ ...T.sub3, color: ink.secondary, marginTop: DP.P1, textAlign: 'center' }}>
            Accepts <code>.osm</code> (XML) and <code>.osm.pbf</code> (protobuf),<br />
            which is what Geofabrik publishes. Smaller extracts can be converted
            with <code>osmium cat region.osm.pbf -o region.osm</code>.
          </div>
        </label>

        {props.progress && <ProgressCard progress={props.progress} />}
        {props.error && <div className="error-card">{props.error}</div>}
      </div>
    </div>
  );
}
