/**
 * The result row, and how rows from many sources become one list.
 *
 * Split out from `merge.ts` because this half is *presentation* — it runs while
 * the results render — while the scoring half (`merge.ts`) is only needed once
 * someone searches and loads with the search engine. Keeping the seam here is
 * what keeps the matcher out of the app's entry bundle.
 *
 * The rule the merge enforces: one ranked list, sources interleaved by
 * relevance, with `source` carried on every row and rendered as a badge. Order
 * no longer encodes provenance, so the badge is what tells the driver why row
 * one is above row two — the driver's explicit decision for this design
 * ("unified relevance, but it needs to be clear what the source is").
 *
 * Run with: npx vitest run test/search-merge.spec.ts
 */

import type { LatLng } from '../geo';
import { haversineM } from '../geo';
import { foldTokens, tokenForms } from './text';

/** Where a result came from. Rendered as the row's badge. */
export type HitSource = 'offline' | 'online' | 'saved';

export interface RankedHit {
  /** Stable OSM identity for real service entries; don't collapse every
   * same-named city/POI into one global label. Raw way dedupe stays legacy. */
  identity?: string;
  typeIcon?: 'city' | 'street' | 'address' | 'poi' | 'area' | 'water';
  label: string;
  sub: string;
  pos: LatLng;
  source: HitSource;
  score: number;
}

/**
 * The canonical form of a label, for duplicate detection.
 *
 * "Memorial Dr" and "Memorial Drive" are the same name written two ways, and
 * the abbreviation table already knows that — so dedupe keys on the expanded
 * form of each token rather than the literal text.
 */
export function labelKey(label: string): string {
  const toks = foldTokens(label);
  return toks.map((t) => {
    const forms = tokenForms(t);
    return forms.length > 1 ? forms[1] : t;
  }).join(' ');
}

/**
 * Merge result groups into one ranked list, removing duplicates.
 *
 * Two duplications exist across sources and they need different keys:
 *
 *  - **Same name.** The gazetteer indexes one entry per OSM element, so a
 *    street split into several ways appears three times; Nominatim indexes the
 *    same data, so the same place arrives from both. Keyed on the canonical
 *    label — keying on position leaves the multi-way street case intact,
 *    because the segments genuinely have different coordinates.
 *  - **Same place, different names.** "Bow River" from the gazetteer and
 *    "Bow River, Calgary" from Nominatim are one thing in two namings. Only
 *    dropped across *different* sources and only when one name extends the
 *    other and the positions agree (within 120 m) — two distinct POIs with
 *    genuinely different names stay distinct.
 */
export function mergeHits(...groups: RankedHit[][]): RankedHit[] {
  const all = groups.flat().sort((a, b) => b.score - a.score);
  const kept: RankedHit[] = [];
  const byKey = new Set<string>();
  for (const h of all) {
    const key = labelKey(h.label);
    const identity = `${key}\0${h.identity ?? ''}`;
    if (byKey.has(identity)) continue;
    let shadowed = false;
    for (const k of kept) {
      if (k.source === h.source) continue;
      if (haversineM(k.pos[0], k.pos[1], h.pos[0], h.pos[1]) > 120) continue;
      const kk = labelKey(k.label);
      if (kk === key || kk.startsWith(`${key} `) || key.startsWith(`${kk} `)) {
        shadowed = true;
        break;
      }
    }
    if (shadowed) continue;
    byKey.add(identity);
    kept.push(h);
  }
  return kept;
}

/**
 * Where the matched part of a label is, for highlighting.
 *
 * Returned as ranges over the *original* string — matching is done on the
 * folded copy but the row shows the real name, and folding can change lengths
 * ("ﬁ" folds to "fi"), so ranges are located by search and only ever *add*
 * emphasis: a token that cannot be found in the original simply is not
 * highlighted.
 *
 * Occurrences must start at a word boundary, matching how the ranking matches
 * (token prefixes, not arbitrary substrings), so "st" emphasises the "St" of
 * "Main St" and the "Saint" of "Saint Mary" — the same abbreviation
 * equivalence the ranking applies — and never a stray "st" inside "Restaurant".
 * A fuzzy-matched name (query "calgry", name "Calgary") highlights the
 * agreeing prefix rather than nothing.
 */
export function highlightRanges(label: string, query: string): [number, number][] {
  const toks = foldTokens(query).filter((t) => t.length >= 2);
  const lower = label.toLowerCase();
  const atWord = (i: number) => i === 0 || !/[\p{L}\p{N}]/u.test(label[i - 1]);
  const occurrences = (needle: string): [number, number][] => {
    const out: [number, number][] = [];
    for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + 1)) {
      if (atWord(at)) out.push([at, at + needle.length]);
    }
    return out;
  };
  const ranges: [number, number][] = [];
  for (const t of toks) {
    // Longest agreeing needle first: full expansions before the raw token
    // before a fuzzy prefix, so "st" on "Saint Mary" highlights "Saint" and on
    // "Main Street" highlights the whole "Street".
    const needles = [...tokenForms(t).slice(1), t];
    for (let n = t.length - 1; n >= 2; n--) needles.push(t.slice(0, n));
    for (const needle of needles) {
      const occ = occurrences(needle);
      if (occ.length) {
        ranges.push(...occ);
        break;
      }
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}
