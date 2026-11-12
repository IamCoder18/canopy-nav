/**
 * Gazetteer search: the offline half of the search experience.
 *
 * The engine this replaces was a linear scan with four match cases — exact,
 * prefix, substring, and one special case for "123 main" — and three defects
 * that a scan cannot help having:
 *
 *  - **No typo tolerance.** "calgry" found nothing. A driver on a keyboard
 *    that is being pressed while the car is moving does not produce clean
 *    input, and a destination picker that returns zero rows for one dropped
 *    letter is failing at its job.
 *  - **Order-dependent truncation.** The scan stopped scoring after 4000
 *    matches, so which results existed depended on gazetteer order, and a
 *    province extract (120k entries) silently lost the tail of every popular
 *    query. `searchAll` had the same shape at 6000.
 *  - **Two matchers.** `searchAll` (multi-region) lacked the "123 main"
 *    branch that `searchGazetteer` had, so address queries worked with one
 *    region loaded and degraded with two.
 *
 * So this module owns one matcher and one ranking used everywhere:
 *
 *  - a lazily-built **token index** per gazetteer array (a `WeakMap` cache, so
 *    a dataset is indexed once and the worker's copy and the restored copy are
 *    each indexed at most once). Candidate lookup is proportional to the size
 *    of the *matching* postings, not the size of the gazetteer, and no
 *    truncation order survives: every candidate is scored, then the top `limit`
 *    taken.
 *  - a tiered score: exact name > name prefix > phrase (tokens in order) >
 *    token matches > substring > fuzzy, with street-abbreviation equivalence
 *    ("st" = "Street" = "Saint") applied symmetrically and numeric tokens
 *    droppable, which is what makes "5 guys" find "Five Guys" and "123 main"
 *    find "Main St".
 *
 * The ranking constants were chosen so the tiers that existed before keep the
 * scores they had — exact 1000, prefix `800 - excess` — because those numbers
 * are load-bearing in the ordering drivers have already learned from the app
 * and in `test/regions.spec.ts`. New tiers slot in below.
 *
 * Run with `npx vitest run test/search-match.spec.ts`.
 */

import type { LatLng } from '../geo';
import { distanceBias, haversineM } from '../geo';
import { fold, foldTokens, tokenForms } from './text';
import { fuzzyTolerance, editDistance } from './fuzzy';

export interface GazEntry {
  name: string;
  lat: number;
  lon: number;
  cat: string;
  rank: number;
  /** street name this housenumber belongs to (house-number interpolation) */
  street?: string;
  house?: number;
  streetLat?: number;
  streetLon?: number;
}

/* ------------------------------ matching ---------------------------- */

/** A query token matched to one name token. `kind` 0 prefix, 1 substring, 2 fuzzy. */
interface TokMatch {
  kind: 0 | 1 | 2;
  /** Excess characters: 0 is a perfect token match. */
  cost: number;
  edits: number;
  /** Position of the matched token in the name. */
  pos: number;
}

/**
 * Best match between two folded tokens under abbreviation equivalence,
 * or null. Forms are compared pairwise so the *abbreviated* side may be
 * either the query ("main st" -> "Main Street") or the name
 * ("main street" -> "Main St").
 */
function matchPair(qf: string, nf: string): { kind: 0 | 1 | 2; cost: number; edits: number } | null {
  if (nf.startsWith(qf)) return { kind: 0, cost: nf.length - qf.length, edits: 0 };
  // The reverse direction is abbreviation *expansion* ("street" vs name "St"),
  // and is refused for one-letter name tokens: a bare "e" or "w" would
  // otherwise prefix-match any long query token and inject noise.
  if (nf.length >= 2 && qf.startsWith(nf)) return { kind: 0, cost: qf.length - nf.length, edits: 0 };
  if (qf.length >= 2 && nf.includes(qf)) return { kind: 1, cost: nf.length - qf.length, edits: 0 };
  const tol = fuzzyTolerance(qf.length);
  if (tol > 0 && Math.abs(nf.length - qf.length) <= tol) {
    const d = editDistance(qf, nf, tol);
    if (d <= tol) return { kind: 2, cost: 10 + d, edits: d };
  }
  return null;
}

function matchForms(qfs: string[], nfs: string[]): { kind: 0 | 1 | 2; cost: number; edits: number } | null {
  let best: { kind: 0 | 1 | 2; cost: number; edits: number } | null = null;
  for (const qf of qfs) {
    for (const nf of nfs) {
      const m = matchPair(qf, nf);
      if (m && (!best || m.cost < best.cost || (m.cost === best.cost && m.kind < best.kind))) best = m;
    }
  }
  return best;
}

/** Best name token for one query token, preferring cheaper then earlier. */
function bestTokenMatch(qt: string, toks: string[]): TokMatch | null {
  const qf = tokenForms(qt);
  let best: TokMatch | null = null;
  for (let k = 0; k < toks.length; k++) {
    const m = matchForms(qf, tokenForms(toks[k]));
    if (m && (!best || m.cost < best.cost || (m.cost === best.cost && k < best.pos))) {
      best = { ...m, pos: k };
    }
  }
  return best;
}

/** A parsed query: the folded form and its tokens. */
export interface ParsedQuery {
  norm: string;
  toks: string[];
}

export function parseQuery(q: string): ParsedQuery | null {
  const norm = fold(q);
  if (!norm) return null;
  return { norm, toks: norm.split(' ') };
}

const isNumeric = (t: string) => /^\d+$/.test(t);

/**
 * Score one name against a parsed query, or null when it does not match.
 *
 * This is the *match* score only — no rank, no distance — so the same tiers
 * can be reused for Nominatim hits and saved-place labels in `merge.ts`.
 */
export function scoreName(q: ParsedQuery, norm: string, toks: string[]): number | null {
  if (norm === q.norm) return 1000;
  if (norm.startsWith(q.norm)) return 800 - (norm.length - q.norm.length);

  // Token tiers. Every non-numeric query token must land on some name token;
  // an unmatched *numeric* token is droppable when the rest matched, because
  // the number is usually a house number the name does not carry ("5 guys"
  // -> "Five Guys", "123 main" -> "Main St"). Dropping costs 60, so a name
  // that really contains the number still wins.
  const ms: TokMatch[] = [];
  let dropped = 0;
  for (const qt of q.toks) {
    const m = bestTokenMatch(qt, toks);
    if (m) ms.push(m);
    else if (isNumeric(qt) && q.toks.length >= 2) dropped += 60;
    else return null;
  }
  if (!ms.length) return null;

  // In query order (that is what `inOrder` measures) but positioned in name
  // order for the spread penalty — "123 main" lands as [pos 2, pos 0], and the
  // old span arithmetic on query order produced a *negative* gap there.
  const posSorted = ms.map((m) => m.pos).sort((a, b) => a - b);
  const startPos = posSorted[0];
  const endPos = posSorted[posSorted.length - 1];
  const span = endPos - startPos - (ms.length - 1);
  let cost = 0;
  let edits = 0;
  let anyFuzzy = false;
  for (const m of ms) {
    cost += m.cost;
    edits += m.edits;
    if (m.kind === 2) anyFuzzy = true;
  }

  // In query order and adjacent in the name: "banff springs" -> "Banff
  // Springs Hotel" is a phrase, "springs banff" is not.
  const inOrder = ms.every((m, i) => i === 0 || m.pos > ms[i - 1].pos);
  const phrase = allZero(ms) && inOrder && span === 0;
  const gaps = 15 * startPos + 15 * span;

  let s: number;
  if (phrase && (ms.length >= 2 || startPos === 0)) s = 700 - 3 * cost - 10 * startPos;
  else if (allZero(ms)) s = 620 - 4 * cost - gaps;
  else if (!anyFuzzy) s = 500 - 3 * cost - gaps;
  else s = 440 - 25 * edits - 3 * cost - gaps;

  return s - dropped;
}

const allZero = (ms: TokMatch[]) => ms.every((m) => m.kind === 0);

/**
 * Score arbitrary text (a Nominatim name, a saved label) against a query.
 * The entry-free half of `scoreName`, for cross-source ranking.
 */
export function scoreText(q: string | ParsedQuery, text: string): number | null {
  const query = typeof q === 'string' ? parseQuery(q) : q;
  if (!query) return null;
  const norm = fold(text);
  return scoreName(query, norm, norm ? norm.split(' ') : []);
}

/** The house-number side: `123 main` should find the address `Main Street 123`. */
function houseBoost(e: GazEntry, q: ParsedQuery, toks: string[]): number | null {
  if (e.house == null) return null;
  for (let i = 0; i < q.toks.length; i++) {
    if (!isNumeric(q.toks[i]) || Number(q.toks[i]) !== e.house) continue;
    const rest = q.toks.filter((_, j) => j !== i);
    if (!rest.length) return 900;
    // The street part must fit this entry's street; the right number on the
    // wrong street is the wrong address and gets no boost at all.
    const target = e.street ? foldTokens(e.street) : toks;
    let cost = 0;
    for (const rt of rest) {
      const m = bestTokenMatch(rt, target);
      if (!m || m.kind > 1) return null;
      cost += m.cost;
    }
    return 930 - 2 * cost;
  }
  return null;
}

/* ------------------------------- index ------------------------------ */

export interface SearchIndex {
  gaz: readonly GazEntry[];
  /** Folded full name per entry, parallel to `gaz`. */
  norm: string[];
  /** Folded name tokens per entry, parallel to `gaz`. */
  toks: string[][];
  /** Sorted unique tokens. */
  vocab: string[];
  /** Token -> entry indices, ascending. */
  post: Map<string, number[]>;
}

/**
 * One index per gazetteer array, built on first use and kept for the life of
 * the array.
 *
 * The `WeakMap` key is the array identity on purpose: a dataset is immutable
 * once built, and the arrays that arrive from the worker, from IndexedDB and
 * from a merged region are all distinct — each is indexed exactly once and
 * released when the dataset is.
 */
const INDEX_CACHE = new WeakMap<object, SearchIndex>();

export function searchIndex(gaz: readonly GazEntry[]): SearchIndex {
  const hit = INDEX_CACHE.get(gaz);
  if (hit) return hit;

  const norm: string[] = new Array(gaz.length);
  const toks: string[][] = new Array(gaz.length);
  const post = new Map<string, number[]>();
  for (let i = 0; i < gaz.length; i++) {
    const n = fold(gaz[i].name);
    norm[i] = n;
    const t = n ? n.split(' ') : [];
    toks[i] = t;
    for (const w of new Set(t)) {
      let list = post.get(w);
      if (!list) {
        list = [];
        post.set(w, list);
      }
      list.push(i);
    }
  }
  const idx: SearchIndex = { gaz, norm, toks, vocab: [...post.keys()].sort(), post };
  INDEX_CACHE.set(gaz, idx);
  return idx;
}

/**
 * Entry ids whose name could match `qt` — a superset of what `scoreName` will
 * accept for that token, generated from the vocabulary rather than the
 * gazetteer. Uses the *same* token matcher as scoring, so candidate
 * generation cannot disagree with ranking (the failure mode where a result is
 * rankable but unreachable).
 */
function candidatesFor(idx: SearchIndex, qt: string, out: Set<number>): void {
  const qf = tokenForms(qt);
  for (const vt of idx.vocab) {
    if (!matchForms(qf, tokenForms(vt))) continue;
    for (const id of idx.post.get(vt)!) out.add(id);
  }
}

export interface ScoredHit<T extends GazEntry = GazEntry> {
  entry: T;
  score: number;
}

/**
 * Search a gazetteer, best first.
 *
 * The result is the top `limit` of *every* matching entry — the truncation
 * that used to happen mid-scan (and therefore at a gazetteer-order-dependent
 * place) is gone; the only cap that remains is on what is displayed.
 */
export function scoreGazetteer<T extends GazEntry>(
  gaz: readonly T[],
  q: string,
  near?: LatLng,
  limit = 12,
): ScoredHit<T>[] {
  const query = parseQuery(q);
  if (!query) return [];
  const idx = searchIndex(gaz);

  // Candidate tokens: every query token must match some name token, except
  // numeric ones (house numbers, "4 St W") which `scoreName` may drop.
  const required = query.toks.filter((t) => !isNumeric(t));
  let candidates: Set<number> | null = null;
  if (required.length) {
    // Every non-numeric token must land, so the candidate set is the
    // intersection of the per-token sets.
    for (const qt of required) {
      const got = new Set<number>();
      candidatesFor(idx, qt, got);
      if (candidates === null) candidates = got;
      else for (const id of candidates) if (!got.has(id)) candidates.delete(id);
      if (!candidates.size) return [];
    }
  } else {
    // All-numeric query ("66 12"): each token may match *or be dropped* by the
    // matcher, so the candidate set is the union — intersecting here would hide
    // exactly the entries the matcher legally drops a token into.
    candidates = new Set<number>();
    for (const qt of query.toks) candidatesFor(idx, qt, candidates);
    if (!candidates.size) return [];
  }
  if (candidates === null) return [];

  const scored: ScoredHit<T>[] = [];
  for (const i of candidates) {
    const e = gaz[i];
    let s = scoreName(query, idx.norm[i], idx.toks[i]);
    const boost = houseBoost(e, query, idx.toks[i]);
    if (boost != null) s = Math.max(s ?? 0, boost);
    if (s == null) continue;
    // Rank first, then the distance bias: the order is part of the score's
    // arithmetic identity, and `test/regions.spec.ts` mirrors it to the ulp.
    s += e.rank;
    if (near) s -= distanceBias(near, [e.lon, e.lat]);
    scored.push({ entry: e, score: s });
  }
  // Deterministic order for equal scores: a result list that reshuffles on
  // re-render for no reason reads as a glitch.
  scored.sort((a, b) => b.score - a.score || (a.entry.name < b.entry.name ? -1 : a.entry.name > b.entry.name ? 1 : 0));
  return scored.slice(0, limit);
}

/** The plain form: entries only, best first. */
export function searchGazetteer(
  gaz: readonly GazEntry[],
  q: string,
  near?: LatLng,
  limit = 12,
): GazEntry[] {
  return scoreGazetteer(gaz, q, near, limit).map((h) => h.entry);
}

/**
 * "Did you mean …?" for a query that matched nothing.
 *
 * Only called on the zero-result path, where one scan is affordable and the
 * alternative — a blank screen and no suggestion — is what it used to be. A
 * name is offered only when it is genuinely close (bounded edit distance on
 * the whole name), so this cannot become a second, worse search.
 */
export function suggestName(gaz: readonly GazEntry[], q: string, near?: LatLng): string | null {
  const query = parseQuery(q);
  if (!query || query.norm.length < 3) return null;
  const idx = searchIndex(gaz);
  const tol = fuzzyTolerance(query.norm.length) + (query.norm.length >= 8 ? 1 : 0);
  let best: { name: string; d: number; rank: number; dist: number } | null = null;
  for (let i = 0; i < idx.norm.length; i++) {
    const n = idx.norm[i];
    if (Math.abs(n.length - query.norm.length) > tol) continue;
    const d = editDistance(query.norm, n, tol);
    if (d > tol) continue;
    const e = idx.gaz[i];
    const dist = near ? haversineM(near[0], near[1], e.lon, e.lat) : 0;
    if (!best || d < best.d || (d === best.d && e.rank > best.rank) ||
        (d === best.d && e.rank === best.rank && dist < best.dist)) {
      best = { name: e.name, d, rank: e.rank, dist };
    }
  }
  return best?.name ?? null;
}
