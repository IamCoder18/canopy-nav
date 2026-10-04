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
}

/** Somewhere recognisable while there is no real fix. */
const FALLBACK: [number, number] = [-114.0719, 51.0447]; // Calgary, AB

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

  navigator.geolocation.watchPosition(
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

  return () => { cancelled = true; };
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
  });
  const onFix = useRef<(f: Fix) => void>(() => {});
  const onError = useRef<(e: string) => void>(() => {});

  onFix.current = (f) => setState((s) => ({ ...s, fix: f }));
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

      setState((s) => ({ ...s, mode: isNative ? 'device' : 'browser' }));

      // Safety net: if nothing arrives in 6s, keep simulating.
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

  return state;
}
