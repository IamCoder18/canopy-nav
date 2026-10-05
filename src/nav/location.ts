/**
 * Location source.
 *
 * On device this wraps `@capacitor/geolocation` and emits a fix stream. In a
 * browser it falls back to the Geolocation API, and if that is unavailable or
 * denied it degrades to a simulated position so the UI stays usable for
 * development rather than breaking.
 *
 * The hook contract is identical in every mode, so callers never branch.
 */

import { useEffect, useRef, useState } from 'react';

export interface Fix {
  /** [lon, lat] */
  pos: [number, number];
  /** metres per second */
  speed: number;
  /** degrees from north */
  heading: number;
  /** horizontal accuracy in metres */
  accuracy: number;
  /** epoch ms */
  ts: number;
}

export type LocationMode = 'device' | 'browser' | 'simulated';

export interface LocationState {
  fix: Fix;
  mode: LocationMode;
  error: string | null;
  /**
   * No position has arrived for `STALE_AFTER_MS`.
   *
   * Distinct from `error`: the watch is still open and nothing has gone wrong as
   * far as the API is concerned, but the fix in hand is not current. Acting on it
   * as though it were is how a frozen position turns into a reroute every 30 s.
   */
  stale: boolean;
}

/**
 * Where the app thinks you are when it does not know.
 *
 * ## Why this is exported, and why it is the *only* placeholder
 *
 * Three files each had their own idea of "somewhere to point the map":
 * `MapView` opened on London `[-0.1276, 51.5072]`, the Home and Work launcher
 * tiles routed to London, and this module's no-fix position was Calgary.
 *
 * With no GPS — denied permission, a cold lock indoors, or a browser build,
 * which is where most of this app is verified — those disagree by 7,000 km.
 * The map showed London, search results drawn from a London extract were ranked
 * against Calgary, and "Route" asked Valhalla for Calgary → London, which came
 * back `Path distance exceeds the max distance limit: 1500000 meters.` That last
 * one looked like an upstream server limit and was, in the end, this bug.
 *
 * A navigation app that does not know where it is must at least be
 * *internally* consistent about where it thinks it is. So there is one
 * exported constant and the map opens on it.
 *
 * Calgary is the choice because the region catalogue is Canadian provinces and
 * US states (`osm/regions.ts`) — an offline extract of Alberta is the most
 * likely thing to be loaded, and the most likely thing this placeholder should
 * be inside.
 */
export const NO_FIX_POSITION: [number, number] = [-114.0719, 51.0447]; // Calgary, AB

/** Somewhere recognisable while there is no real fix. */
const FALLBACK = NO_FIX_POSITION;

/**
 * Age at which a fix is treated as not current.
 *
 * Comfortably longer than the app's 1 s fallback tick and the 6 s confirmation
 * window, so a fix that is merely infrequent on a head unit is not flagged, and
 * short enough to catch a genuine loss of signal promptly.
 */
export const STALE_AFTER_MS = 20_000;

function simulatedFix(): Fix {
  return { pos: FALLBACK, speed: 0, heading: 0, accuracy: 12, ts: Date.now() };
}

/**
 * Location on a real device.
 *
 * Uses the WebView's own `navigator.geolocation` rather than the Capacitor
 * geolocation plugin. The plugin's native object is a Proxy whose returned
 * value is awaited by the bridge, and awaiting it calls `then()` on the plugin
 * itself, which fails on device with
 * `Geolocation.then() is not implemented on android`. The Web Geolocation API
 * is backed by the same platform LocationManager inside a WebView, returns a
 * real Promise, supports the error callback we need, and is the exact code path
 * the browser build already exercises -- so device and desktop now share one
 * implementation instead of two that can silently diverge.
 */
function watchDevice(onFix: (f: Fix) => void, onError: (e: string) => void): () => void {
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
    onError('Geolocation unsupported on this device');
    return () => {};
  }
  let cancelled = false;

  /*
   * The watch id is captured, so the watch can actually be stopped.
   *
   * `cancelled = true` only stops the *callback* firing — the platform location
   * provider stays active, the GNSS receiver stays hot, and `watchPosition` keeps
   * running at ~1 Hz into a closure nobody can reach, for the life of the WebView.
   * On a car head unit that is a measurable battery drain, and it is the reason
   * `useLocation` takes an `enabled` flag that nothing currently takes advantage
   * of: a caller who passes `false` on non-navigation screens expects the GPS to
   * be released, and it is not.
   *
   * In a browser dev session a StrictMode double-mount also opened two watches and
   * cleaned up one.
   */
  const watchId = navigator.geolocation.watchPosition(
    (pos) => {
      if (cancelled) return;
      onFix({
        pos: [pos.coords.longitude, pos.coords.latitude],
        speed: pos.coords.speed ?? 0,
        heading: pos.coords.heading ?? 0,
        accuracy: pos.coords.accuracy ?? 0,
        ts: pos.timestamp,
      });
    },
    (err) => {
      if (cancelled) return;
      onError(err.message || 'Location permission denied');
    },
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
  );

  return () => {
    cancelled = true;
    navigator.geolocation.clearWatch(watchId);
  };
}

/**
 * Subscribe to position updates.
 *
 * @param enabled when false the hook does nothing, so callers can avoid
 *   holding the GPS awake on screens that do not need it.
 */
export function useLocation(enabled = true): LocationState {
  const [state, setState] = useState<LocationState>({
    fix: simulatedFix(),
    mode: 'simulated',
    error: null,
    stale: false,
  });
  const onFix = useRef<(f: Fix) => void>(() => {});
  const onError = useRef<(e: string) => void>(() => {});
  /**
   * Whether this is the native shell, captured so `onFix` can label a fix
   * without re-reading the environment on every position.
   */
  const nativeRef = useRef(false);

  /**
   * A fresh fix clears the error and the staleness together: the position is
   * current again, so neither condition applies.
   *
   * It also *restores the mode*. This was the defect: the 6 s safety net below
   * downgrades the mode to `simulated`, and nothing ever put it back, so a
   * first fix arriving after six seconds — a cold GNSS lock in a garage, the
   * common case, not a corner case — left the UI permanently claiming
   * "Simulated GPS" while streaming real positions. A fix delivered by the
   * watcher is by definition real, so the mode follows the fix.
   */
  onFix.current = (f) =>
    setState((s) => ({
      ...s,
      fix: f,
      stale: false,
      mode: nativeRef.current ? 'device' : 'browser',
      // The "no fix yet" message stops being true the moment one arrives.
      error: s.error === 'No location fix yet' ? null : s.error,
    }));
  onError.current = (e) => setState((s) => ({ ...s, error: e }));

  useEffect(() => {
    if (!enabled) return;
    let cleanup: (() => void) | null = null;
    let cancelled = false;

    void (async () => {
      const isNative =
        typeof window !== 'undefined' &&
        ((window as any).Capacitor?.isNativePlatform?.() ?? false);

      const onF = (f: Fix) => onFix.current(f);
      const onE = (e: string) => onError.current(e);

      // Both paths are the Web Geolocation API now, so the choice is only about
      // how the resulting fix is *labelled* in the UI.
      const stop = watchDevice(onF, onE);
      if (cancelled) stop();
      else cleanup = stop;

      nativeRef.current = isNative;
      setState((s) => ({ ...s, mode: isNative ? 'device' : 'browser' }));

      // Safety net: if nothing arrives in 6s, keep simulating. This is a
      // one-way downgrade on purpose — a later real fix restores the mode in
      // `onFix`, so a slow lock recovers instead of being mislabelled forever.
      const timer = setTimeout(() => {
        setState((s) => (s.fix.ts === 0 || Date.now() - s.fix.ts > 6000
          ? { ...s, mode: 'simulated', error: s.error ?? 'No location fix yet' }
          : s));
      }, 6000);
      return () => clearTimeout(timer);
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [enabled]);

  /**
   * Mark the fix stale once no new position has arrived for `STALE_AFTER_MS`.
   *
   * A `watchPosition` that stops delivering — a tunnel, a revoked permission,
   * cold GNSS — leaves `pos` frozen at its last value while the app keeps
   * consuming it as though it were live. Downstream that matters most for
   * rerouting: the deviation from a frozen fix never changes, so it re-confirms
   * after every settle window and the app issues a request every 30 s forever.
   * (Measured before the reroute guard existed: 20 requests in ten minutes.)
   *
   * Consumers can check `stale` and refuse to act on a position they know is not
   * current. The fix itself is deliberately *not* moved or cleared — a stale
   * position is still the last known good one, and dropping it would put the car
   * at the origin.
   */
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => {
      setState((s) => {
        const age = Date.now() - s.fix.ts;
        if (s.fix.ts === 0 || age <= STALE_AFTER_MS) {
          return s.stale ? { ...s, stale: false } : s;
        }
        return s.stale ? s : { ...s, stale: true };
      });
    }, 1_000);
    return () => clearInterval(id);
  }, [enabled]);

  return state;
}
