import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { MapView } from './map/MapView';
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
  formatDistance, formatDuration, formatClock, lineLength,
  snapToPolyline, type LatLng,
} from './geo';
import { ink, type as T, DP, ICON } from './theme';
import { useLocation, type LocationMode } from './nav/location';
import RegionsScreen from './regions/RegionsScreen';
import {
  importRegionFile, localRegionId, localRegionName, regionLib, useRegions,
} from './regions/store';
import {
  ManeuverIcon, IconSearch, IconBack, IconClose, IconMute, IconSound, IconOverview,
  IconLayers, IconTraffic, IconSettings, IconHome, IconGoto, IconChevronRight,
  IconFile, IconLocate, IconCar,
} from './icons';

type Screen = 'home' | 'search' | 'preview' | 'navigating' | 'steps' | 'settings' | 'import' | 'regions';

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
  const [units, setUnits] = useState<'metric' | 'imperial'>('metric');
  // Valhalla expects km/miles; our formatters expect metric/imperial.
  const valhallaUnits: 'km' | 'miles' = units === 'imperial' ? 'miles' : 'km';

  // Real GPS on device, Geolocation API in a browser, simulated as a last resort.
  const { fix, mode: locationMode, error: locationError } = useLocation(true);
  const location = fix.pos;

  useEffect(() => watchConnectivity(setOnline), []);

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
        setScreen('preview');
        setFitNonce((n) => n + 1);
      } else {
        setRoute(null);
        setRouteError(e instanceof NoRouteError ? e.message : (e as Error).message);
        setScreen('preview');
      }
    } finally {
      setRouting(false);
    }
  }, [dataset, origin, location, provider, valhallaUnits, apiKey, endpoint, regions.length]);

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
    const totalM = lineLength(geometry);
    const remainingM = lineLength(geometry.slice(snap.index));

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
    return { snap, remainingM, totalM, steps, travelled: geometry.slice(0, snap.index + 1), idx };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, dataset, progressAlong, location]);

  /* ------------------------- simulation tick ---------------------- */

  const navActive = screen === 'navigating' && route !== null;

  useEffect(() => {
    if (!navActive) return;
    const id = setInterval(() => {
      setProgressAlong((p) => {
        if (!route) return p;
        // Advance in proportion to route duration, so a 5-minute and a
        // 2-hour trip both animate at a believable pace.
        const total = route.summary.time || 1;
        const next = p + 1 / total;
        return next >= 1 ? 0 : next;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [navActive, route, guidance, localGuidance]);

  /* ----------------------------- render --------------------------- */

  const banner = routeError ?? degraded[0] ?? null;

  return (
    <div className="app">
      <MapView
        dataset={dataset}
        useTiles={online}
        route={route?.geometry ?? null}
        travelled={guidance?.travelled ?? localGuidance?.travelled ?? null}
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
          onMute={() => setMuted((m) => !m)}
          onExit={() => { setScreen('home'); setProgressAlong(0); }}
          onOverview={() => setFitNonce((n) => n + 1)}
          onRecenter={() => setFocus({ center: location, zoom: 17 })}
          onSteps={() => setScreen('steps')}
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
          onClear={() => { setRoute(null); setDestination(null); setOrigin(null); }}
        />
      )}

      {screen === 'search' && (
        <SearchScreen
          dataset={dataset}
          online={online}
          location={location}
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
              Download an <code>.osm</code> extract (Geofabrik) or convert with
              <code> osmium cat region.osm.pbf -o region.osm</code>, then load it here.
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
  onMute: () => void;
  onExit: () => void;
  onOverview: () => void;
  onRecenter: () => void;
  onSteps: () => void;
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
        <button className="round-btn" onClick={props.onRecenter} aria-label="Recenter">
          <IconLocate size={ICON.primary} />
        </button>
        <button className="round-btn" onClick={props.onOverview} aria-label="Route overview">
          <IconOverview size={ICON.primary} />
        </button>
        <button className="round-btn" onClick={() => {}} aria-label="Traffic">
          <IconTraffic size={ICON.primary} />
        </button>
        <button className="round-btn" onClick={() => {}} aria-label="Layers">
          <IconLayers size={ICON.primary} />
        </button>
      </div>

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

function SearchScreen(props: {
  dataset: OsmDataset | null;
  online: boolean;
  location: LatLng;
  onPick: (pos: LatLng, label: string) => void;
  onBack: () => void;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<{ label: string; sub: string; pos: LatLng }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setResults([]); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      setBusy(true); setErr(null);
      // Offline gazetteer first — instant, no network.
      const local = props.dataset
        ? props.dataset.gaz
        : [];
      const localHits = local
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
  }, [q, props.dataset, props.online, props.location]);

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
        {!props.dataset && <div className="hint-card">No offline map loaded — import an .osm file for offline search.</div>}
        {busy && !results.length && <div style={{ ...T.body3, color: ink.secondary }}>Searching…</div>}
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
          <input type="file" accept=".osm,.xml" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) props.onFile(f); }} />
          <IconFile size={64} color={ink.secondary} />
          <div style={{ ...T.body1m, marginTop: DP.P3 }}>Choose or drop an .osm file</div>
          <div style={{ ...T.sub3, color: ink.secondary, marginTop: DP.P1, textAlign: 'center' }}>
            XML format. For .osm.pbf run:<br />
            <code>osmium cat region.osm.pbf -o region.osm</code>
          </div>
        </label>

        {props.progress && <ProgressCard progress={props.progress} />}
        {props.error && <div className="error-card">{props.error}</div>}
      </div>
    </div>
  );
}
