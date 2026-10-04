/**
 * Engine selection and readiness.
 *
 * `providers.ts` decides *how* a route is fetched. This module decides *which*
 * engine the driver wants, whether the app is allowed to substitute one, and how
 * ready each engine is right now.
 *
 * Two controls, deliberately orthogonal:
 *
 *   - `preferred` — which engine answers first.
 *   - `allowFallback` — whether another engine may answer instead.
 *
 * They are separate because "I want Valhalla" and "let me have the offline engine
 * if Valhalla is down" are genuinely different requests, and collapsing them into
 * one radio button is what made the old UI unable to say what it was doing. With
 * both pinned, a route either comes from the named engine or fails — which is
 * what you want when you are testing that engine, or paying for it.
 *
 * Import direction is one-way (this module imports `providers.ts`, never the
 * reverse) so the routing core stays free of selection policy.
 */

import {
  PROVIDERS,
  isOnline,
  probeProvider,
  type Provider,
  type ProviderId,
} from './providers';

export type { EngineAttempt, AttemptOutcome } from './providers';
import type { EngineAttempt } from './providers';

/** An engine, or "whichever online engine is reachable". */
export type EngineId = ProviderId | 'any-online';

export const ANY_ONLINE = 'any-online' as const;

export const ANY_ONLINE_LABEL = 'Any online engine';

export interface EngineSelection {
  preferred: EngineId;
  /**
   * When false the plan is exactly `preferred` and a failure is fatal.
   *
   * On by default: the local engine is the safety net that keeps a trip alive
   * when a tunnel eats the signal, and losing guidance is worse than routing
   * from a different engine than the one on screen.
   */
  allowFallback: boolean;
}

/**
 * Offline-first, but reachable.
 *
 * `local` first so an imported province keeps answering with the engine it was
 * built for, with the online engines behind it for the routes the extract does
 * not cover. This is strictly more capable than the previous fixed behaviour,
 * which was local-only with no fallback at all.
 */
export const DEFAULT_SELECTION: EngineSelection = { preferred: 'local', allowFallback: true };

export function isOnlineEngine(id: EngineId): boolean {
  if (id === ANY_ONLINE) return true;
  return PROVIDERS.find((p) => p.id === id)?.online ?? false;
}

/**
 * Turn a selection into the ordered plan `resolveRoute` will walk.
 *
 * `any-online` expands to every online engine in registry order rather than to
 * one, so "any" means genuinely any and the trace shows which one answered.
 */
export function planRoute(
  selection: EngineSelection,
  _state: { endpoint?: string; apiKey?: string } = {},
): ProviderId[] {
  const remote = PROVIDERS.filter((p) => p.online).map((p) => p.id);
  const head: ProviderId[] = selection.preferred === ANY_ONLINE ? remote : [selection.preferred];
  if (!selection.allowFallback) return head;
  const tail: ProviderId[] = selection.preferred === 'local' ? remote : ['local'];
  return [...head, ...tail.filter((id) => !head.includes(id))];
}

/* --------------------------- readiness --------------------------- */

export interface EngineStatus {
  id: EngineId;
  label: string;
  subtitle: string;
  online: boolean;
  /** Usable right now, without needing a round-trip. */
  ready: boolean;
  /**
   * Why it is not ready, in the driver's terms.
   *
   * Never a bare "unavailable": "no network", "API key required" and "no offline
   * map loaded" are three different problems with three different fixes, and
   * collapsing them into one word is what makes a settings screen useless.
   */
  reason: string | null;
  /** The concrete engine that would serve `any-online`, when one can be named. */
  resolved: ProviderId | null;
}

function statusFor(
  id: EngineId,
  provider: Provider | undefined,
  state: { endpoint?: string; apiKey?: string },
  offlineMap: boolean,
): EngineStatus {
  const label = id === ANY_ONLINE ? ANY_ONLINE_LABEL : provider?.label ?? id;
  const subtitle =
    id === ANY_ONLINE
      ? 'Try every hosted engine in turn, then the offline map.'
      : provider?.subtitle ?? '';
  const online = id === ANY_ONLINE ? true : provider?.online ?? false;
  const base = { id, label, subtitle, online, resolved: provider?.id ?? null };

  if (id === ANY_ONLINE) {
    if (!isOnline()) return { ...base, ready: false, reason: 'No network connection' };
    const usable = PROVIDERS.filter(
      (p) => p.online && (p.id === 'valhalla-custom' ? !!state.endpoint : true) && (!p.requiresKey || !!state.apiKey),
    );
    return usable.length
      ? { ...base, ready: true, reason: null, resolved: usable[0].id }
      : { ...base, ready: false, reason: 'No hosted engine is configured' };
  }

  if (!provider) return { ...base, ready: false, reason: 'Unknown engine' };

  if (provider.online) {
    if (!isOnline()) return { ...base, ready: false, reason: 'No network connection' };
    const endpoint = provider.id === 'valhalla-custom' ? state.endpoint : provider.endpoint;
    if (!endpoint) return { ...base, ready: false, reason: 'No endpoint configured' };
    if (provider.requiresKey && !state.apiKey) return { ...base, ready: false, reason: 'API key required' };
    return { ...base, ready: true, reason: null };
  }

  return offlineMap
    ? { ...base, ready: true, reason: null }
    : { ...base, ready: false, reason: 'No offline map loaded' };
}

/** Readiness of every selectable engine, in registry order. */
export function engineStatuses(
  state: { endpoint?: string; apiKey?: string } = {},
  offlineMap = false,
): EngineStatus[] {
  return [ANY_ONLINE, ...PROVIDERS.map((p) => p.id)].map((id) =>
    statusFor(id, id === ANY_ONLINE ? undefined : PROVIDERS.find((p) => p.id === id), state, offlineMap),
  );
}

export interface EngineProbe {
  ok: boolean;
  /** One line: version and latency when it worked, the reason when it did not. */
  detail: string;
  ms: number | null;
}

/**
 * Actually contact an engine and report what happened.
 *
 * Separate from readiness on purpose: readiness is a local judgement that can be
 * wrong (a host can be configured and down), and only a real request settles it.
 * Nothing here is cached, because a stale "reachable" is worse than no answer.
 */
export async function probeEngine(
  id: EngineId,
  state: { endpoint?: string; apiKey?: string },
  offlineMap: boolean,
): Promise<EngineProbe> {
  if (id === ANY_ONLINE) {
    const t0 = Date.now();
    for (const p of PROVIDERS.filter((x) => x.online)) {
      const r = await probeProvider(p, state);
      if (r.ok) return { ok: true, detail: `${p.label} — ${r.detail}`, ms: Date.now() - t0 };
    }
    return { ok: false, detail: 'No hosted engine answered', ms: Date.now() - t0 };
  }
  const provider = PROVIDERS.find((p) => p.id === id);
  if (!provider) return { ok: false, detail: 'Unknown engine', ms: null };
  if (!provider.online) {
    return offlineMap
      ? { ok: true, detail: 'Offline map loaded', ms: null }
      : { ok: false, detail: 'No offline map loaded', ms: null };
  }
  const t0 = Date.now();
  const r = await probeProvider(provider, state);
  return { ok: r.ok, detail: r.detail, ms: r.ok ? Date.now() - t0 : null };
}

/* --------------------------- provenance --------------------------- */

/**
 * One line describing who actually answered, phrased for a driver.
 *
 * The distinction that matters: the *selected* engine is a preference, the
 * *serving* engine is a fact. Reporting the preference as though it were the fact
 * is how an app ends up labelling a locally-computed route with a hosted
 * provider's name — and the local engine has no maneuvers, so the turn-by-turn
 * the label implies is simply not there.
 */
export function describeProvenance(used: ProviderId, fellBack: boolean): string {
  const label = PROVIDERS.find((p) => p.id === used)?.label ?? used;
  return fellBack ? `${label} (fallback)` : label;
}

/** Whether the serving engine can produce real instructions, not just a line. */
export function hasManeuvers(used: ProviderId): boolean {
  return PROVIDERS.find((p) => p.id === used)?.online ?? false;
}

/** Compact one-liner per trace row, for the engine panel and the nav banner. */
export function describeAttempt(a: EngineAttempt): string {
  switch (a.outcome) {
    case 'served':
      return `${a.label} answered in ${a.ms ?? 0} ms`;
    case 'skipped':
      return `${a.label} skipped — ${a.reason}`;
    case 'failed':
      return `${a.label} failed — ${a.reason}`;
    default:
      return `${a.label} not tried`;
  }
}