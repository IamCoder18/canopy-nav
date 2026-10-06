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
  downloadRegion, checkRegionAvailable,
  formatBytes, DownloadError, type DownloadProgress, type Availability,
} from './download';
import { CATALOG, catalogByCountry, type CatalogEntry, type Region } from '../osm/regions';
import type { RouteResult } from '../osm/engine.worker';
import type { BuildProgress } from '../osm/engine';
import type { LatLng } from '../geo';
import { formatDistance, formatDuration } from '../geo';
import { ink, type as T, DP, ICON } from '../theme';
import { focusQuietly } from '../App';
import {
  IconBack, IconClose, IconFile, IconLayers, IconCompass, IconLocate, IconChevronRight,
  IconTrash, IconWarning, IconCheck,
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
  /**
   * A removal that worked. Not an error and not a warning, but worth saying:
   * the driver freed a few hundred megabytes and the screen should acknowledge
   * it, because the alternative — the row simply vanishing — reads as a bug.
   */
  | { removed: string }
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

  /**
   * Focus follows the confirmation, and comes back from it.
   *
   * The confirm state *replaced* the Remove button, which unmounted the element
   * that had focus — so it fell to `<body>` and Confirm and Cancel sat a few rows
   * further down. A keyboard user who activated Remove then had to tab through
   * the rest of the catalogue to reach them, and the next control they reached
   * was a Download button, which starts a 380 MB transfer. A destructive
   * confirmation that dumps you into an unrelated control is the worst kind.
   *
   * So: the Remove button stays mounted and is hidden instead, focus moves to
   * Confirm, and cancelling returns focus to the Remove button it came from.
   * `aria-expanded` carries the state to assistive technology without a second
   * live region.
   */
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const removeRef = useRef<HTMLButtonElement | null>(null);
  /** True only on the render where the confirmation first appears. */
  const confirmOpened = useRef(false);

  useEffect(() => {
    if (confirmRemove) {
      if (!confirmOpened.current) {
        confirmOpened.current = true;
        focusQuietly(confirmRef.current);
      }
    } else if (confirmOpened.current) {
      confirmOpened.current = false;
      focusQuietly(removeRef.current);
    }
  }, [confirmRemove]);
  const [fromKey, setFromKey] = useState('');
  const [toKey, setToKey] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  /** Live download progress, distinct from the parser's BuildProgress. */
  const [dl, setDl] = useState<{ entry: CatalogEntry; progress: DownloadProgress } | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  /**
   * Live download handles, keyed by region id.
   *
   * This was one `abortRef` for the whole screen, which meant a second download
   * overwrote the first's handle: the first became uncancellable, and the progress
   * row — one `dl` value for the screen — flickered between the two as each
   * reported progress into it. Two downloads could also be started at all, which
   * on a metered automotive connection is 380 MB and 1.4 GB at once with one
   * Cancel button between them.
   *
   * A `Map` rather than a single ref, so each download owns its own cancellation
   * and a stale one's `finally` cannot clear the other's row.
   */
  const downloads = useRef(new Map<string, AbortController>());
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
    // One at a time, deliberately. The screen shows a single progress row and a
    // single Cancel control, so a second concurrent download would have nowhere to
    // report and no way to be stopped; a second Download tap therefore replaces the
    // first rather than racing it.
    downloads.current.get(entry.id)?.abort();
    const ctrl = new AbortController();
    downloads.current.set(entry.id, ctrl);
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
        onProgress: setDlProgress(entry, ctrl),
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
        onActivated();
      }
      // Cleared here as well as in `onPicked`, because this path sets it too and
      // a download that *fails* must not leave "100%" on screen either.
      setProgress(null);
    } catch (e) {
      // Every failure path is surfaced with an actionable message; a download
      // that silently half-succeeded would be worse than one that reports.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      // Only release the row if *this* download still owns it. Clearing
      // unconditionally is how a slow first download wiped the progress of the one
      // the driver was actually watching.
      if (downloads.current.get(entry.id) === ctrl) {
        downloads.current.delete(entry.id);
        setDl(null);
      }
    }
  };

  /**
   * Progress from a download, discarded once it is not the one on screen.
   *
   * The check is against the handle rather than the id, so a download that has
   * been superseded cannot overwrite the row belonging to its replacement.
   */
  const setDlProgress = (entry: CatalogEntry, ctrl: AbortController) => (p: DownloadProgress) =>
    setDl((cur) => (downloads.current.get(entry.id) === ctrl ? { entry, progress: p } : cur));

  /* ------------------------------- removal ------------------------------- */

  /**
   * Remove a region and report what happened to its bytes.
   *
   * Both halves can fail independently and both used to be silent. The in-memory
   * region goes immediately — that part always worked — while the stored extract
   * was deleted with `.catch(() => {})`, so a refused IndexedDB write left a few
   * hundred megabytes on the device, the byte counter already decremented, and
   * no message anywhere. `deleteRegion` builds exactly the sentence that would
   * have explained it and the catch threw it away.
   *
   * Now the two outcomes are reported separately, because they mean different
   * things: a successful removal, or a removal whose file is still there.
   */
  const doRemove = async (r: Region) => {
    setError(null);
    setOutcome(null);
    setConfirmRemove(null);
    const problem = await removeRegion(r.id);
    if (problem) {
      setOutcome({ error: `${r.name} was removed from the app, but ${problem}` });
      return;
    }
    setOutcome({ removed: r.name });
  };

  /**
   * Cancel the download on screen.
   *
   * Aborts by the row's region id, not "whatever handle was last stored", so the
   * control always cancels the thing the driver can see.
   */
  const cancelDownload = () => {
    if (!dl) return;
    downloads.current.get(dl.entry.id)?.abort();
  };

  /**
   * A download that is still running must not outlive this screen.
   *
   * `RegionsScreen` is mounted only while the screen is `regions`, and the
   * cancel button was the only thing that called `abort`. Leaving the screen
   * mid-download therefore left a 380 MB – 1.4 GB transfer running with nothing
   * consuming it: `onProgress` kept firing `setDl` on an unmounted component,
   * every chunk kept accumulating in memory, and if it happened to finish, the
   * import ran anyway and changed the module-level region library under a live
   * `App`. On a metered automotive connection that is the difference between
   * cancelling and not.
   */
  useEffect(() => () => {
    // Every download, not just the last one started.
    for (const ctrl of downloads.current.values()) ctrl.abort();
    downloads.current.clear();
  }, []);

  /* --------------------------- availability probe ------------------------- */

  // A single catalogue can hold a dozen dead URLs; probe them so the screen can
  // grey out what genuinely cannot be downloaded.
  //
  // The comment here used to say "lazily", and it was not: this was one
  // `Promise.all` over the *entire* catalogue — every province and state — fired
  // on every mount, with no `AbortController` and no deadline, while
  // `startDownload` fifteen lines above correctly arms a 15 s timeout. So
  // opening the screen issued dozens of parallel requests and then waited on the
  // browser's own network stack, with no Download button enabled and no
  // explanation of why for as long as that took. On a metered automotive
  // connection that is not free.
  //
  // Now: four at a time, each with a 10 s deadline, the effect cancelled on
  // unmount, and the rows show "Checking…" rather than nothing at all.
  const [probing, setProbing] = useState(true);
  useEffect(() => {
    let cancelled = false;
    const CONCURRENCY = 4;
    const PROBE_TIMEOUT_MS = 10_000;
    void (async () => {
      const entries = catalogByCountry().flatMap((g) => g.entries);
      const results: Array<readonly [string, Awaited<ReturnType<typeof checkRegionAvailable>>]> = [];
      // A simple worker pool rather than a batched chunk: a slow probe holds one
      // slot, not the whole batch behind it.
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, entries.length) }, async () => {
          while (!cancelled) {
            const i = next++;
            if (i >= entries.length) return;
            const entry = entries[i];
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
            try {
              results.push([entry.id, await checkRegionAvailable(entry, { signal: ctrl.signal })]);
            } catch {
              // A probe that timed out is simply "not available", which is what
              // the row will say — with the reason, from `unavailableReason`.
              results.push([entry.id, {
                ok: false, status: 0, bytes: null, resumable: false,
                etag: null, modified: null, error: 'No response in 10 s',
              } satisfies Availability]);
            } finally {
              clearTimeout(timer);
            }
          }
        }),
      );
      if (cancelled) return;
      setAvailability(Object.fromEntries(results.map(([id, r]) => [id, r.ok])));
      setUnavailableReason(Object.fromEntries(
        results.filter(([, r]) => !r.ok && r.error).map(([id, r]) => [id, r.error as string]),
      ));
      setProbing(false);
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

  /**
   * The prop that ends this screen, held once.
   *
   * `props` is a new object on every `App` render — and App re-renders at 1 Hz
   * while navigating — so a `useCallback` that depends on `props` has a new
   * identity every render and memoises nothing. Reading the one function off it
   * makes the dependency list honest.
   */
  const onActivated = props.onActivated;

  const onPicked = useCallback(async (file: File | undefined) => {
    if (!file) return;
    const p = pending.current ?? { id: '', name: '', code: 'local' };
    try {
      const ds = await importRegionFile({
        id: p.id || localRegionId(file),
        name: p.name || localRegionName(file),
        code: p.code,
        file,
        onProgress: setProgress,
        onError: setError,
        // Regions is the *primary* import surface — the catalogue lives here — so
        // it must carry the same caveats `App`'s own picker does. A quota
        // failure is the one case a driver can act on, and omitting these made it
        // invisible exactly where they are most likely to hit it.
        onWarn: (msg: string | null) => {
          if (msg) setWarnings((w) => (w.includes(msg) ? w : [...w, msg]));
        },
        onPersistError: (msg: string | null) => {
          if (msg) setWarnings((w) => (w.includes(msg) ? w : [...w, msg]));
        },
      });
      if (ds) {
        setError(null);
        onActivated();
      }
    } finally {
      // Clear the pinned card.
      //
      // This `progress` is `RegionsScreen`'s own state, not the one `App` owns,
      // so `props.onActivated()` does not clear it. It therefore stayed pinned at
      // "Parse complete — 100%" for the rest of the screen's life, on top of the
      // region list, telling the driver something was still running when nothing
      // was. Cleared in `finally` so the failure path gets it too.
      setProgress(null);
    }
    // Destructured rather than read off `props`: `props` is a fresh object on
    // every `App` render — and App re-renders at 1 Hz while navigating — so
    // depending on it makes this `useCallback` have a new identity every render
    // and memoise nothing, while costing a closure allocation each time.
  }, [onActivated]);

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
        <h1 className="screen-title" style={{ ...T.body1m, marginLeft: DP.P2 }}>Regions</h1>
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
                {/*
                  The confirming state says what is about to happen and to what.
                  A row that swaps "Remove" for "Confirm" alone is a dialog with
                  no dialog: the region name is absent, and with several regions
                  on screen the destructive action is unbounded. This is the point
                  at which a driver should be told they are about to free a few
                  hundred megabytes.

                  It is a `role="group"` with a label rather than an
                  `alertdialog`, and that is a correction: `alertdialog` carries an
                  implicit `aria-live="assertive"` and implies modality, and this
                  is an inline pair of buttons that was never modal. Claiming both
                  told a screen reader something untrue about the interaction.

                  The Remove button stays mounted throughout — see the note on
                  `confirmRemove` above — so cancelling has something to return
                  focus to. It is hidden with `aria-hidden` rather than
                  unmounted, which is what put focus on `<body>`.
                */}
                <button
                  ref={removeRef}
                  className="pill-btn danger"
                  aria-label={`Remove ${r.name}, ${formatBytes(r.bytes)}`}
                  aria-expanded={removing}
                  aria-hidden={removing || undefined}
                  tabIndex={removing ? -1 : 0}
                  onClick={() => setConfirmRemove(r.id)}
                  hidden={removing}
                >
                  <IconTrash size={ICON.secondary} />
                  Remove
                </button>
                {removing && (
                  <>
                    <span className="remove-confirm" role="group" aria-label={`Confirm removing ${r.name}`}>
                      <span className="remove-question">
                        <IconWarning size={ICON.secondary} />
                        <span>Remove {r.name}?</span>
                      </span>
                      <span className="remove-detail">
                        Frees {formatBytes(r.bytes)} of downloads
                      </span>
                    </span>
                    <button
                      ref={confirmRef}
                      className="pill-btn danger"
                      aria-label={`Confirm removing ${r.name}, freeing ${formatBytes(r.bytes)}`}
                      onClick={() => void doRemove(r)}
                    >
                      Confirm
                    </button>
                    <button
                      className="pill-btn ghost"
                      onClick={() => setConfirmRemove(null)}
                      aria-label={`Cancel removing ${r.name}`}
                    >
                      <IconClose size={ICON.secondary} />
                    </button>
                  </>
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
            {/*
              `aria-disabled` with the reason in the accessible name, rather than
              `disabled` with nothing.

              This button was disabled whenever nothing was downloaded, and said
              nothing about why. A driver who has just opened this screen sees two
              inert-looking controls with no explanation, and no way to find one:
              a `disabled` control is not focusable, so neither the tooltip nor a
              sibling hint could ever reach them. The reason is now part of the
              name, which is the only text a screen-reader user gets.
            */}
            <button
              className="primary-btn"
              onClick={() => { if (regions.length) preview(); }}
              aria-disabled={regions.length === 0}
              aria-label={
                regions.length === 0
                  ? 'Preview route — unavailable, download a region first'
                  : 'Preview route across the downloaded regions'
              }
            >
              Preview route
            </button>
          </div>
        </div>

        {/*
          Both messages are announced. The error card here was a plain `<div>`
          with no `role`, so a failed cross-region preview — after a synchronous
          A* over a merged graph — was silent for anyone using assistive
          technology, while the *same* failure on the Import screen was announced.
          Two implementations of one message with two different accessibility
          stories.
        */}
        {outcome && 'error' in outcome && <div className="error-card" role="alert">{outcome.error}</div>}

        {outcome && 'removed' in outcome && (
          <div className="result-panel ok" role="status">
            <IconCheck size={ICON.secondary} />
            <span>{outcome.removed} removed and its downloads freed.</span>
          </div>
        )}

        {outcome && !('error' in outcome) && !('removed' in outcome) && (
          /*
            An in-flow panel, not `.progress-card`.
            `.progress-card` is `position: fixed` — correct for transient progress
            that must float over a scrolling list, wrong for a *result*. This used
            to be one of them, so after computing a cross-region route the
            distance, the "Merged across 2 regions" line and the **Send to
            navigation** button were pinned to the bottom of the viewport and
            followed the driver around the catalogue. The `marginTop` passed here
            did nothing at all, because margins do not apply to a fixed box.
          */
          <div className="result-panel" role="status">
            <div className="result-panel-head">
              <IconCompass size={ICON.secondary} />
              <span style={T.body3m}>{outcome.a.label} → {outcome.b.label}</span>
            </div>
            <div style={{ ...T.body3, color: ink.secondary, margin: `${DP.P1}px 0 ${DP.P2}px` }}>
              {formatDistance(outcome.result.metres, props.units)} · {formatDuration(outcome.result.time)}
            </div>
            <div style={{ ...T.body3, color: ink.secondary }}>
              {outcome.regions.length > 1
                ? `Merged across ${outcome.regions.length} regions`
                : 'Single region'}
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
                      aria-disabled={dl?.entry.id === e.id || availability[e.id] === false || probing}
                      title={availability[e.id] === false
                        ? (unavailableReason[e.id] ?? 'This download URL could not be reached')
                        : `Download ${e.name} (${formatBytes(e.approxMb * 1024 * 1024)})`}
                      /* The two actions were two adjacent expressions with no
                         whitespace, so the name read as ONE word: the audit
                         measured "UnavailableImport" / "DownloadReplace". And a
                         disabled button must say WHY, since its hover title never
                         reaches a car driver. */
                      aria-label={
                        dl?.entry.id === e.id ? 'Downloading' : availability[e.id] === false
                          ? `Unavailable — ${unavailableReason[e.id] ?? 'This download URL could not be reached'}`
                          : probing ? `Checking whether the ${e.name} download is reachable`
                            : have ? `Replace the ${e.name} map` : `Download the ${e.name} map`
                      }
                      onClick={() => { if (dl?.entry.id !== e.id && availability[e.id] !== false && !probing) void startDownload(e); }}
                    >
                      {dl?.entry.id === e.id
                        ? 'Downloading…'
                        : availability[e.id] === false
                          ? 'Unavailable'
                          : /* A row whose reachability is not yet known says so.
                               The alternative — a live Download button that may
                               turn out to be pointing at a dead URL — is a
                               button that lies for the length of the probe. */
                          probing ? 'Checking…' : have ? 'Replace' : 'Download'}
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
            "size unknown" rather than a fake 0%, which would read as stalled.

            A real `progressbar`, and the same split `ProgressCard` uses in
            `App.tsx`: the *number* is the bar's value — queryable, never
            announced — and the live region carries only the operation's name,
            which changes a handful of times per download.

            Both cards on this screen previously had no role at all, so the one
            surface where a driver spends minutes watching a 380 MB transfer
            reported nothing to anyone not looking at it. And putting the byte
            count in a live region would be worse than silence, because the
            downloader reports on every stream chunk: that is the firehose this
            split exists to avoid.

            An indeterminate total omits `aria-valuenow` altogether — the role
            requires it to reflect a known value, and the "size unknown" line
            already says so in words. */}
        {dl && (
          <div className="progress-card" style={{ marginTop: DP.P3 }}>
            <div className="progress-stage" role="status" aria-live="polite" aria-atomic="true">
              Downloading {dl.entry.name}
            </div>
            <div
              className="bar"
              role="progressbar"
              aria-label={`Downloading ${dl.entry.name}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={dl.progress.fraction === null ? undefined : Math.round(dl.progress.fraction * 100)}
              aria-valuetext={
                dl.progress.total !== null
                  ? `${formatBytes(dl.progress.received)} of ${formatBytes(dl.progress.total)}`
                  : `${formatBytes(dl.progress.received)} downloaded, total size unknown`
              }
            >
              <div
                className={dl.progress.fraction === null ? 'fill anim' : 'fill'}
                style={dl.progress.fraction === null ? undefined : { width: `${Math.round(dl.progress.fraction * 100)}%` }}
              />
            </div>
            <div className="progress-pct">
              {formatBytes(dl.progress.received)}
              {dl.progress.total !== null ? ` of ${formatBytes(dl.progress.total)}` : ' (size unknown)'}
              {dl.progress.fraction !== null ? ` · ${Math.round(dl.progress.fraction * 100)}%` : ''}
            </div>
            <button className="pill-btn" onClick={cancelDownload}>Cancel</button>
          </div>
        )}

        {progress && (
          <div className="progress-card" style={{ marginTop: DP.P3 }}>
            <div className="progress-stage" role="status" aria-live="polite" aria-atomic="true">
              {progress.stage}
            </div>
            <div
              className="bar"
              role="progressbar"
              aria-label="Building the offline map"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress.pct * 100)}
              aria-valuetext={`${Math.round(progress.pct * 100)} percent — ${progress.stage}`}
            >
              <div className="fill" style={{ width: `${Math.round(progress.pct * 100)}%` }} />
            </div>
            <div className="progress-pct" aria-hidden="true">{Math.round(progress.pct * 100)}%</div>
          </div>
        )}

        {/*
          Both of these were silent.

          The file's own comment below, on `outcome.error`, explains why an error
          card needs a `role` — and then these two, which are the messages a driver
          actually waits on, were left without one. So a failed 380 MB download
          produced no announcement and no visible error *role*, and the
          quota-exhausted warning that `importRegionFile` goes out of its way to
          build — "Imported, but it could not be saved for next time… It will be
          gone when you close the app" — was inaudible on the one screen where a
          region is imported.

          `role="alert"` on the error (assertive: the thing they asked for did not
          happen), `role="status"` on the warnings (polite: it did, with caveats).
        */}
        {warnings.length > 0 && (
          <div className="hint-card warn" role="status" style={{ marginTop: DP.P3 }}>
            {warnings.map((w, i) => (
              <div key={i} style={{ ...T.sub3 }}>{w}</div>
            ))}
          </div>
        )}

        {error && (
          <div className="error-card" role="alert" style={{ marginTop: DP.P3 }}>{error}</div>
        )}
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