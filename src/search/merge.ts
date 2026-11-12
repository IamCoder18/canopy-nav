/**
 * Cross-source scoring: making offline, online and saved hits comparable.
 *
 * The rows themselves — types, dedupe, highlighting — are `results.ts`, which
 * renders; this half only runs when a query is actually scored, so it loads
 * with the search engine (see the dynamic import in `App.tsx`) rather than with
 * the app. What makes hits comparable is that every source is scored by the
 * same matcher (`scoreName`/`scoreText` in `gaz.ts`) plus that source's own
 * importance signal and the shared `distanceBias`:
 *
 *   offline  match tier + gazetteer rank (20-100)
 *   online   match tier + Nominatim importance (0-120)
 *   saved    match tier + intent boost (+250)
 *
 * The saved boost is deliberate: a place the driver saved is what they mean
 * when its label matches, and it should beat a same-named POI across town.
 *
 * Run with: npx vitest run test/search-merge.spec.ts
 */

import type { LatLng } from '../geo';
import { distanceBias } from '../geo';
import { scoreText, type ParsedQuery } from './gaz';

export * from './results';

/**
 * Score an online (Nominatim) hit on the shared scale.
 *
 * Nominatim matched the query against its full index, including address
 * strings the app never sees, so when the *name* does not match the query the
 * hit still earns a floor rather than being dropped — but a floor low enough
 * that it cannot beat a real name match from anywhere.
 */
export function scoreOnlineHit(
  q: string | ParsedQuery,
  name: string,
  importance: number | undefined,
  pos: LatLng,
  near: LatLng,
): number {
  const base = scoreText(q, name) ?? 480;
  const imp = Math.min(120, (importance ?? 0.25) * 120);
  return base + imp - distanceBias(near, pos);
}

/**
 * Score a saved place (Home/Work). Null when the query does not touch its
 * label: a saved place is a strong signal, not a blanket one, and "coffee"
 * must not surface "Home" because the driver happens to have one.
 */
export function scoreSavedHit(
  q: string | ParsedQuery,
  label: string,
  pos: LatLng,
  near: LatLng,
): number | null {
  const base = scoreText(q, label);
  if (base == null) return null;
  return base + 250 - distanceBias(near, pos);
}
