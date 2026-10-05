import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapView, type TrafficOverlay } from './map/MapView';
import type { BuildProgress } from './osm/engine';
import type { OsmDataset } from './osm/engine.worker';
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
  formatDistance, formatDuration, formatClock, haversine, lineLength,
  snapToPolyline, type LatLng,
} from './geo';
import { ink, accentNight, applyThemeTokens, type as T, DP, ICON } from './theme';
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

type Screen = 'home' | 'search' | 'preview' | 'navigating' | 'steps' | 'settings' | 'import' | 'regions' | 'engines';

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
  /**
   * Which engine answers, and whether another may answer instead.
   *
   * Two controls rather than one radio group, because "I want Valhalla" and "let
   * me have the offline engine if Valhalla is down" are different requests. See
   * `nav/engines.ts`.
   */
  const [selection, setSelection] = useState<EngineSelection>(DEFAULT_SELECTION);
  const [apiKey, setApiKey] = useState('');
  const [endpoint, setEndpoint] = useState('');

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
  const { fix, mode: locationMode, error: locationError, stale: fixStale } = useLocation(true);
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
        setProgressAlong(0);
        resetTraffic({ from, to: dest.pos });
        setScreen('preview');
        setFitNonce((n) => n + 1);
      } else {
        setRoute(null);
        setRouteError(e instanceof NoRouteError ? e.message : (e as Error).message);
        resetTraffic(null);
        setScreen('preview');
        // Clear the trace: leaving the previous route's provenance on screen
        // would attribute a failure to whichever engine served the last success.
        setProvenance(null);
      }
    } finally {
      setRouting(false);
    }
  }, [dataset, origin, location, enginePlan, selection.allowFallback, valhallaUnits, apiKey, endpoint, regions.length, resetTraffic]);

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
    // Where the car actually is on the line, which is what the dimmed portion and
    // the remaining distance both hang off.
    const here = snappedIndex(location, geometry, snap.index);
    const totalM = lineLength(geometry);
    const remainingM = lineLength(geometry.slice(here));

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
        setProgressAlong(0);
        resetTraffic({ from: origin, to: destination.pos });
        setFitNonce((n) => n + 1);
      } catch (e) {
        reason = e instanceof NoRouteError ? e.message : (e as Error).message;
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

  /**
 * One banner, most urgent first.
 *
 * A reroute notice outranks a stale degradation note: if the driver has just
 * gone off-route, why the last request mentioned a missing API key is history.
 */
const banner = rerouteNotice ?? routeError ?? degraded[0] ?? null;

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
          provenance={provenance}
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
          onBack={() => setScreen('home')}
          onImport={() => setScreen('import')}
          onRegions={() => setScreen('regions')}
          onEngines={() => setScreen('engines')}
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
          onBack={() => setScreen('settings')}
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
  provenance: RouteProvenance | null;
  locationMode: LocationMode;
  locationError: string | null;
  progress: BuildProgress | null;
  error: string | null;
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
          <QuickTile label="Home" icon={<IconHome size={ICON.primary} />} onClick={() => p.onRoute([-0.1276, 51.5072], 'Home')} />
          <QuickTile label="Work" icon={<IconGoto size={ICON.primary} />} onClick={() => p.onRoute([-0.142, 51.5], 'Work')} />
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
                  {p.route.summary ? `${formatDuration(p.route.summary.time)} · ${formatDistance(p.route.summary.length, 'metric')}` : ''}
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
  const title = [engineTitle, locationError ? `${gps} - ${locationError}` : gps].join('\n');
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

  /** True once the driver has passed the last turn, i.e. is arriving. */
  const arriving = !nextManeuver && !localTurn && remainingM > 0;
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
            {nextManeuver?.instruction
              ?? localTurn?.title
              ?? (arriving ? 'Arriving at your destination' : 'Continue')}
          </div>
        </div>
      </div>

      {props.rerouteNotice && (
        <div className="offroute-banner" role="status" aria-live="polite">
          {props.rerouteNotice}
        </div>
      )}

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

  return (
    <div className="search-root">
      <div className="top-app-bar">
        <button className="icon-btn" onClick={props.onBack} aria-label="Back"><IconBack size={ICON.primary} /></button>
        <div style={{ ...T.body1m, marginLeft: DP.P2 }}>Engines</div>
      </div>

      <div className="settings-body">
        <div className="section-head" style={T.body3m}>Route with</div>
        {statuses.map((s) => (
          <button
            key={s.id}
            className={`provider-row ${chosen === s.id ? 'selected' : ''}`}
            onClick={() => props.setSelection({ ...props.selection, preferred: s.id })}
            aria-pressed={chosen === s.id}
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

        <div className="section-head" style={T.body3m}>If it cannot route</div>
        <div className="seg">
          <button
            className={props.selection.allowFallback ? 'on' : ''}
            onClick={() => props.setSelection({ ...props.selection, allowFallback: true })}
          >
            Use another engine
          </button>
          <button
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
            <input value={props.apiKey} onChange={(e) => props.setApiKey(e.target.value)} placeholder="sk-…" />
          </label>
        )}
        {(chosen === 'valhalla-custom' || chosen === ANY_ONLINE) && (
          <label className="field">
            <span style={{ ...T.sub2, color: ink.secondary }}>Custom endpoint</span>
            <input value={props.endpoint} onChange={(e) => props.setEndpoint(e.target.value)} placeholder="http://192.168.1.10:8002" />
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
  onBack: () => void; onImport: () => void; onRegions: () => void;
  onEngines: () => void;
}) {
  const serving = props.provenance
    ? describeProvenance(props.provenance.used, props.provenance.fellBack)
    : null;
  return (
    <div className="search-root">
      <div className="top-app-bar">
        <button className="icon-btn" onClick={props.onBack} aria-label="Back"><IconBack size={ICON.primary} /></button>
        <div style={{ ...T.body1m, marginLeft: DP.P2 }}>Settings</div>
      </div>

      <div className="settings-body">
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
