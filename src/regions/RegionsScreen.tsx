/**
 * Regions screen — browse the extract catalogue, import `.osm` files into the
 * region library, and preview routes that span more than one region.
 *
 * Reachability: home quick tile, Settings -> Offline maps.
 *
 * Format reality check: the catalogue lists Geofabrik `.osm.pbf` URLs because
 * that is what you actually download, but `engine.worker.ts` parses **XML**.
 * The URLs are shown as information; the import path is a file picker that
 * takes the `.osm` conversion, which the screen spells out.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  downloadRegion, checkRegionAvailable, clearCachedRegion,
  formatBytes, DownloadError, type DownloadProgress,
} from './download';
import { CATALOG, catalogByCountry, type CatalogEntry } from '../osm/regions';
import type { RouteResult } from '../osm/engine.worker';
import type { BuildProgress } from '../osm/engine';
import type { LatLng } from '../geo';
import { formatDistance, formatDuration } from '../geo';
import { ink, type as T, DP, ICON } from '../theme';
import {
  IconBack, IconClose, IconFile, IconLayers, IconCompass, IconLocate, IconChevronRight,
} from '../icons';
import {
  importRegionFile, localRegionId, localRegionName, regionLib, removeRegion, useRegions,
} from './store';

export interface RegionsScreenProps {
  units: 'metric' | 'imperial';
  location: LatLng | null;
  onBack: () => void;
  /** A region was parsed: let the app point the map at it. */
  onActivated: () => void;
  onMapFocus: (center: LatLng, zoom: number) => void;
  /** Send a cross-region route to the normal preview / navigation flow. */
  onPreviewRoute: (result: RouteResult, to: LatLng, label: string, via: string[]) => void;
}

/** Where the next chosen file should land, if no file has been picked yet. */
interface Pending {
  /** Catalogue id, or '' for an ad-hoc extract named after the file. */
  id: string;
  name: string;
  code: string;
}

type Outcome =
  | { error: string }
  | {
    a: { label: string; pos: LatLng };
    b: { label: string; pos: LatLng };
    result: RouteResult;
    regions: string[];
    stitched: boolean;
  };

export function RegionsScreen(props: RegionsScreenProps) {
  const regions = useRegions();
  const fileRef = useRef<HTMLInputElement>(null);
  const pending = useRef<Pending | null>(null);

  const [progress, setProgress] = useState<BuildProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [fromKey, setFromKey] = useState('');
  const [toKey, setToKey] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  /** Live download progress, distinct from the parser's BuildProgress. */
  const [dl, setDl] = useState<{ entry: CatalogEntry; progress: DownloadProgress } | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const [availability, setAvailability] = useState<Record<string, boolean>>({});
  /**
   * Why a catalogue row is unavailable, keyed by id.
   *
   * Kept as text rather than folded into the boolean because the reason is the
   * only useful thing on screen. It used to live in a `title` attribute, which is
   * a hover affordance — invisible on a touch device, so every row read
   * "Unavailable" with no explanation and nothing the user could act on.
   */
  const [unavailableReason, setUnavailableReason] = useState<Record<string, string>>({});

  const groups = catalogByCountry();

  /* ------------------------------ downloading ----------------------------- */

  const startDownload = async (entry: CatalogEntry) => {
    setError(null);
    setWarnings([]);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setDl({ entry, progress: { received: 0, total: null, fraction: null } });

    try {
      // Probe first so a dead or redirected URL is reported before spending
      // minutes on a download that cannot succeed.
      const probe = new AbortController();
      const probeTimer = setTimeout(() => probe.abort(), 15000);
      const avail = await checkRegionAvailable(entry, { signal: probe.signal });
      clearTimeout(probeTimer);
      if (!avail.ok) {
        throw new DownloadError(
          'http',
          `${entry.name} could not be reached (HTTP ${avail.status}). ` +
          'The catalogue URL may have moved, or this device may be offline.',
          avail.status,
        );
      }

      const res = await downloadRegion(entry, {
        onProgress: setDlProgress(entry),
        signal: ctrl.signal,
        expectedBytes: avail.bytes ?? undefined,
      });

      setWarnings(res.warnings);
      const ds = await importRegionFile({
        id: entry.id,
        name: entry.name,
        code: entry.id.toUpperCase(),
        file: res.file,
        onProgress: setProgress,
        onError: setError,
      });
      if (ds) {
        setError(null);
        props.onActivated();
      }
    } catch (e) {
      // Every failure path is surfaced with an actionable message; a download
      // that silently half-succeeded would be worse than one that reports.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      abortRef.current = null;
      setDl(null);
    }
  };

  const setDlProgress = (entry: CatalogEntry) => (p: DownloadProgress) =>
    setDl({ entry, progress: p });

  const cancelDownload = () => {
    abortRef.current?.abort();
  };

  /* --------------------------- availability probe ------------------------- */

  // A single catalogue can hold a dozen dead URLs; probe them lazily so the
  // screen can grey out what genuinely cannot be downloaded.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const ids = catalogByCountry().flatMap((g) => g.entries).map((e) => e.id);
      const results = await Promise.all(
        ids.map(async (id) => {
          const entry = catalogByCountry()
            .flatMap((g) => g.entries)
            .find((e) => e.id === id);
          return [id, await checkRegionAvailable(entry!)] as const;
        }),
      );
      if (cancelled) return;
      setAvailability(Object.fromEntries(results.map(([id, r]) => [id, r.ok])));
      setUnavailableReason(Object.fromEntries(
        results.filter(([, r]) => !r.ok && r.error).map(([id, r]) => [id, r.error as string]),
      ));
    })();
    return () => { cancelled = true; };
  }, []);

  /* ---------------------------- picking a file --------------------------- */

  const startPick = (entry?: CatalogEntry) => {
    pending.current = entry
      ? { id: entry.id, name: entry.name, code: entry.id.toUpperCase() }
      : { id: '', name: '', code: 'local' };
    fileRef.current?.click();
  };

  const onPicked = useCallback(async (file: File | undefined) => {
    if (!file) return;
    const p = pending.current ?? { id: '', name: '', code: 'local' };
    const ds = await importRegionFile({
      id: p.id || localRegionId(file),
      name: p.name || localRegionName(file),
      code: p.code,
      file,
      onProgress: setProgress,
      onError: setError,
    });
    if (ds) {
      setError(null);
      props.onActivated();
    }
  }, [props]);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so re-picking the same file fires again.
    e.target.value = '';
    void onPicked(file);
  };

  /* ------------------------- cross-region routing ----------------------- */

  const pointFor = (key: string): { label: string; pos: LatLng } | null => {
    if (key === 'gps') return props.location ? { label: 'Current position', pos: props.location } : null;
    const r = regions.find((x) => x.id === key);
    return r ? { label: r.name, pos: centroid(r.bbox) } : null;
  };

  // Keep the two ends pointed at something real as regions come and go.
  useEffect(() => {
    const valid = (k: string) => !!pointFor(k);
    if (!valid(fromKey)) setFromKey(props.location ? 'gps' : regions[0]?.id ?? '');
    if (!valid(toKey)) setToKey(regions.find((r) => r.id !== fromKey)?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regions, props.location, fromKey, toKey]);

  const preview = () => {
    const a = pointFor(fromKey);
    const b = pointFor(toKey);
    if (!a || !b) {
      setOutcome({ error: 'Choose a start and an end point.' });
      return;
    }
    try {
      const r = regionLib.route(a.pos, b.pos);
      if (!r) {
        setOutcome({ error: 'No connected road path between those points in the downloaded regions.' });
        return;
      }
      setOutcome({ a, b, result: r.result, regions: r.regions, stitched: r.stitched });
    } catch (err) {
      setOutcome({ error: (err as Error).message });
    }
  };

  const totalBytes = regions.reduce((s, r) => s + r.bytes, 0);

  return (
    <div className="search-root">
      <div className="top-app-bar">
        <button className="icon-btn" onClick={props.onBack} aria-label="Back"><IconBack size={ICON.primary} /></button>
        <div style={{ ...T.body1m, marginLeft: DP.P2 }}>Regions</div>
        <div className="spacer" />
        {/* Green only once something is actually loaded. */}
        <span className={`chip ${regions.length ? 'ok' : ''}`}>
          {regions.length} loaded{totalBytes > 0 ? ` · ${formatBytes(totalBytes)}` : ''}
        </span>
      </div>

      <input type="file" accept=".osm,.pbf,.xml,application/octet-stream" hidden ref={fileRef} onChange={onFileChange} />

      <div className="settings-body">
        {/* ---------------------- downloaded ---------------------- */}
        <div className="section-head" style={T.body3m}>Downloaded regions</div>

        {regions.length === 0 && (
          <div className="hint-card">
            <div style={T.body3m}>No regions loaded</div>
            <div style={{ ...T.body3, color: ink.secondary, margin: `${DP.P1}px 0 ${DP.P3}px` }}>
              Import an extract below to enable offline routing and search for that area.
            </div>
            <button className="pill-btn" onClick={() => startPick()}>Import .osm file</button>
          </div>
        )}

        {regions.map((r) => {
          const removing = confirmRemove === r.id;
          return (
            <div className="result-row" key={r.id}>
              <span className="result-icon ok"><IconLayers size={ICON.secondary} /></span>
              <span className="result-text">
                <span style={T.body3m}>{r.name}</span>
                <span style={{ ...T.body3, color: ink.secondary }}>
                  {r.counts.routable.toLocaleString()} routable ways · {r.gazetteerSize.toLocaleString()} places indexed
                </span>
                <span style={{ ...T.sub2, color: ink.tertiary }}>
                  Bounds {r.bbox.map((v) => v.toFixed(3)).join(', ')} · {formatBytes(r.bytes)} · {r.code}
                </span>
              </span>
              <span className="region-actions">
                <button
                  className="pill-btn ghost"
                  onClick={() => props.onMapFocus(centroid(r.bbox), zoomFor(r.bbox))}
                  aria-label={`Show ${r.name} on the map`}
                >
                  <IconLocate size={ICON.secondary} />
                </button>
                {removing ? (
                  <>
                    <button className="pill-btn danger" onClick={() => {
                      removeRegion(r.id);
                      // Also drop the cached extract; otherwise the device keeps
                      // a few hundred MB per province forever.
                      void clearCachedRegion(r.id).catch(() => {});
                      setConfirmRemove(null);
                      setOutcome(null);
                    }}>
                      Confirm
                    </button>
                    <button className="pill-btn ghost" onClick={() => setConfirmRemove(null)} aria-label="Cancel remove">
                      <IconClose size={ICON.secondary} />
                    </button>
                  </>
                ) : (
                  <button className="pill-btn danger" onClick={() => setConfirmRemove(r.id)}>Remove</button>
                )}
              </span>
            </div>
          );
        })}

        {/* --------------------- cross-region route --------------------- */}
        <div className="section-head" style={T.body3m}>Route across regions</div>
        <div className="hint-card">
          <div style={{ ...T.body3, color: ink.secondary, marginBottom: DP.P3 }}>
            With two or more regions downloaded the library routes on whichever region covers
            each end and stitches the legs at the boundary.
          </div>

          <div style={{ ...T.sub2, color: ink.secondary, marginBottom: DP.P1 }}>From</div>
          <div className="choice-row" style={{ marginBottom: DP.P3 }}>
            {props.location && (
              <Choice on={fromKey === 'gps'} onClick={() => setFromKey('gps')} icon={<IconLocate size={ICON.secondary} />}>
                Current position
              </Choice>
            )}
            {regions.map((r) => (
              <Choice key={r.id} on={fromKey === r.id} onClick={() => setFromKey(r.id)}>{r.name}</Choice>
            ))}
          </div>

          <div style={{ ...T.sub2, color: ink.secondary, marginBottom: DP.P1 }}>To</div>
          <div className="choice-row" style={{ marginBottom: DP.P3 }}>
            {props.location && (
              <Choice on={toKey === 'gps'} onClick={() => setToKey('gps')} icon={<IconLocate size={ICON.secondary} />}>
                Current position
              </Choice>
            )}
            {regions.map((r) => (
              <Choice key={r.id} on={toKey === r.id} onClick={() => setToKey(r.id)}>{r.name}</Choice>
            ))}
          </div>

          <div className="preview-actions">
            <button className="secondary-btn" onClick={() => { setOutcome(null); setError(null); }}>Clear</button>
            <button className="primary-btn" onClick={preview} disabled={regions.length === 0}>
              Preview route
            </button>
          </div>
        </div>

        {outcome && 'error' in outcome && <div className="error-card">{outcome.error}</div>}

        {outcome && !('error' in outcome) && (
          <div className="progress-card">
            <div style={T.body3m}>{outcome.a.label} → {outcome.b.label}</div>
            <div style={{ ...T.body3, color: ink.secondary, margin: `${DP.P1}px 0 ${DP.P2}px` }}>
              {formatDistance(outcome.result.metres, props.units)} · {formatDuration(outcome.result.time)}
            </div>
            <div style={{ ...T.body3, color: ink.secondary }}>
              {outcome.stitched
                ? `Stitched across ${outcome.regions.length} regions`
                : 'Single region, no stitching needed'}
            </div>
            <div style={{ ...T.sub2, color: ink.tertiary, margin: `${DP.P1}px 0 ${DP.P3}px` }}>
              Traversed: {outcome.regions.map((id) => regionLib.get(id)?.name ?? id).join(' → ')}
            </div>
            <div className="preview-actions">
              <button
                className="secondary-btn"
                onClick={() => {
                  const b = boundsOf(outcome.result.geometry);
                  props.onMapFocus(centroid(b), zoomFor(b));
                }}
              >
                Show on map
              </button>
              <button
                className="primary-btn"
                onClick={() => props.onPreviewRoute(
                  outcome.result, outcome.b.pos, outcome.b.label, outcome.regions,
                )}
              >
                Send to navigation
              </button>
            </div>
          </div>
        )}

        {/* -------------------------- catalogue -------------------------- */}
        <div className="section-head" style={T.body3m}>Catalogue</div>
        <div className="hint-card">
          <div style={{ ...T.body3, color: ink.secondary }}>
            Geofabrik publishes <code>.osm.pbf</code> (protobuf) extracts. Both that and
            plain <code>.osm</code> XML are read directly — download the extract, then
            Import to attach it to its province. To slice a smaller extract first:
          </div>
          <div style={{ ...T.body3, marginTop: DP.P3 }}>
            <code>osmium extract -b bbox -o region.osm.pbf region-latest.osm.pbf</code>
          </div>
        </div>

        {groups.map((g) => (
          <div key={g.country}>
            <div className="section-head" style={{ ...T.sub2, color: ink.secondary }}>{g.country}</div>
            {g.entries.map((e) => {
              const have = regionLib.get(e.id);
              // `parentId` is the containing extract, not the country: 'ca'
              // has no catalogue entry, so provinces don't say "sub-region".
              const parent = e.parentId ? CATALOG.find((x) => x.id === e.parentId) : undefined;
              return (
                <div className="result-row" key={e.id}>
                  <span className={`result-icon ${have ? 'ok' : ''}`}>
                    {have ? <IconLayers size={ICON.secondary} /> : <IconCompass size={ICON.secondary} />}
                  </span>
                  <span className="result-text">
                    <span style={T.body3m}>{e.name}</span>
                    <span style={{ ...T.body3, color: ink.secondary }}>
                      ≈ {e.approxMb.toLocaleString()} MB · {e.country}
                      {parent ? ` · part of ${parent.name}` : ''}
                    </span>
                    <span className="truncate" style={{ ...T.sub2, color: ink.tertiary }} title={e.pbfUrl}>{e.pbfUrl}</span>
                    {/* The reason, on screen. A `title` is unreachable on a
                        touch device, which is the only kind this app has. */}
                    {unavailableReason[e.id] && (
                      <span className="unavailable-reason">{unavailableReason[e.id]}</span>
                    )}
                  </span>
                  <span className="region-actions">
                    {have
                      ? <span className="chip ok">Downloaded</span>
                      : null}
                    <button
                      className="pill-btn"
                      disabled={dl?.entry.id === e.id || availability[e.id] === false}
                      title={availability[e.id] === false
                        ? (unavailableReason[e.id] ?? 'This download URL could not be reached')
                        : `Download ${e.name} (${formatBytes(e.approxMb * 1024 * 1024)})`}
                      onClick={() => void startDownload(e)}
                    >
                      {dl?.entry.id === e.id
                        ? 'Downloading…'
                        : availability[e.id] === false
                          ? 'Unavailable'
                          : 'Download'}
                      {have ? 'Replace' : 'Import'}
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        ))}

        <div className="section-head" style={T.body3m}>Other extracts</div>
        <button className="pill-btn" onClick={() => startPick()} style={{ alignSelf: 'flex-start' }}>
          <IconFile size={ICON.secondary} />
          <span style={{ marginLeft: DP.P1 }}>Import any .osm file</span>
          <IconChevronRight size={ICON.secondary} />
        </button>

        {/* Download progress. An indeterminate total is shown as an explicit
            "size unknown" rather than a fake 0%, which would read as stalled. */}
        {dl && (
          <div className="progress-card" style={{ marginTop: DP.P3 }}>
            <div style={T.body3m}>Downloading {dl.entry.name}</div>
            <div className="bar">
              <div
                className={dl.progress.fraction === null ? 'fill anim' : 'fill'}
                style={dl.progress.fraction === null ? undefined : { width: `${Math.round(dl.progress.fraction * 100)}%` }}
              />
            </div>
            <div style={{ ...T.sub3, color: ink.secondary }}>
              {formatBytes(dl.progress.received)}
              {dl.progress.total !== null ? ` of ${formatBytes(dl.progress.total)}` : ' (size unknown)'}
              {dl.progress.fraction !== null ? ` · ${Math.round(dl.progress.fraction * 100)}%` : ''}
            </div>
            <button className="pill-btn" onClick={cancelDownload}>Cancel</button>
          </div>
        )}

        {progress && (
          <div className="progress-card" style={{ marginTop: DP.P3 }}>
            <div style={T.body3m}>{progress.stage}</div>
            <div className="bar"><div className="fill" style={{ width: `${Math.round(progress.pct * 100)}%` }} /></div>
            <div style={{ ...T.sub3, color: ink.secondary }}>{Math.round(progress.pct * 100)}%</div>
          </div>
        )}

        {warnings.length > 0 && (
          <div className="hint-card" style={{ marginTop: DP.P3 }}>
            {warnings.map((w, i) => (
              <div key={i} style={{ ...T.sub3, color: ink.secondary }}>{w}</div>
            ))}
          </div>
        )}

        {error && <div className="error-card" style={{ marginTop: DP.P3 }}>{error}</div>}
      </div>
    </div>
  );
}

/* ------------------------------ bits -------------------------------- */

function Choice(props: { on: boolean; onClick: () => void; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <button className={`choice ${props.on ? 'on' : ''}`} onClick={props.onClick}>
      {props.icon}
      {props.children}
    </button>
  );
}

function centroid(b: [number, number, number, number]): LatLng {
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
}

// `formatBytes` comes from ./download so the download progress and the manage
// list cannot drift apart.

/** Web-Mercator zoom that fits a bbox with a little breathing room. */
function zoomFor(b: [number, number, number, number]): number {
  const midLat = (b[1] + b[3]) / 2;
  const w = Math.max(1e-6, (b[2] - b[0]) * Math.cos((midLat * Math.PI) / 180));
  const h = Math.max(1e-6, b[3] - b[1]);
  const z = Math.log2(360 / Math.max(w, h)) - 1;
  return Math.max(2, Math.min(16, Math.round(z)));
}

/** Bounding box of a polyline. */
function boundsOf(pts: LatLng[]): [number, number, number, number] {
  let w = 180, s = 90, e = -180, n = -90;
  for (const [x, y] of pts) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return [w, s, e, n];
}

export default RegionsScreen;