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

async function loadCapacitorGeolocation() {
  try {
    const mod = await import('@capacitor/geolocation');
    return mod.Geolocation;
  } catch {
    return null;
  }
}

async function watchDevice(onFix: (f: Fix) => void, onError: (e: string) => void): Promise<() => void> {
  const Geolocation = await loadCapacitorGeolocation();
  if (!Geolocation) {
    onError('Capacitor geolocation unavailable');
    return () => {};
  }

  let cancelled = false;
  let watchId: string | null = null;

  // Capacitor's watchPosition has no error callback, so a denied permission
  // would simply never fire. Probe once up front to surface the real reason.
  Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 10000 })
    .then((position) => {
      if (cancelled) return;
      const pos = position?.coords;
      if (pos) {
        onFix({
          pos: [pos.longitude, pos.latitude],
          speed: pos.speed ?? 0,
          heading: pos.heading ?? 0,
          accuracy: pos.accuracy ?? 0,
          ts: position!.timestamp,
        });
      }
    })
    .catch((err: Error) => {
      if (cancelled) return;
      onError(err?.message || 'Location permission denied');
    });

  Geolocation.watchPosition(
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    (position) => {
      if (cancelled) return;
      const pos = position?.coords;
      if (!pos) return;
      onFix({
        pos: [pos.longitude, pos.latitude],
        speed: pos.speed ?? 0,
        heading: pos.heading ?? 0,
        accuracy: pos.accuracy ?? 0,
        ts: position!.timestamp,
      });
    },
  )
    .then((id) => {
      watchId = id;
      if (cancelled && id) void Geolocation.clearWatch({ id });
    }).catch(() => {});

  return () => {
    cancelled = true;
    if (watchId) void Geolocation.clearWatch({ id: watchId });
  };
}

function watchBrowser(onFix: (f: Fix) => void, onError: (e: string) => void): () => void {
  if (!('geolocation' in navigator)) {
    onError('Geolocation unsupported in this browser');
    return () => {};
  }
  const id = navigator.geolocation.watchPosition(
    (pos) => {
      onFix({
        pos: [pos.coords.longitude, pos.coords.latitude],
        speed: pos.coords.speed ?? 0,
        heading: pos.coords.heading ?? 0,
        accuracy: pos.coords.accuracy ?? 0,
        ts: pos.timestamp,
      });
    },
    (err) => onError(err.message || 'Location permission denied'),
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
  );
  return () => navigator.geolocation.clearWatch(id);
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

      const stop = isNative ? await watchDevice(onF, onE) : watchBrowser(onF, onE);
      if (cancelled) stop();
      else cleanup = stop;

      setState((s) => ({
        ...s,
        mode: isNative ? 'device' : 'browser',
        // If no fix arrives promptly, fall back to simulation so the UI still runs.
        error: s.error,
      }));

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
