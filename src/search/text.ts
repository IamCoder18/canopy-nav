/**
 * Text normalization for search: the fold every source agrees on, and the
 * abbreviation classes street names need.
 *
 * This module exists because the previous matcher compared one folded string
 * against another with `===`, `startsWith` and `includes`, which is exact in a
 * way drivers are not: "Main St" missed "Main Street", "cafe" missed "Café",
 * and "123 Main" only found "Main St" through a special case the multi-region
 * search never got. Every one of those is a *typing* difference, not a meaning
 * difference, and a destination picker that fails on them is failing on the
 * input it was designed for.
 *
 * The fuzzy half (edit distance) is `fuzzy.ts`, which loads with the matcher;
 * this half is needed to render highlighted rows and stays with the app.
 *
 * Run with `npx vitest run test/search-match.spec.ts`.
 */

/**
 * Fold a string to its comparison form: lowercase, diacritics stripped,
 * punctuation collapsed to spaces, `&` spoken as "and".
 *
 * "Café — Drive-Thru & More" -> "cafe drive thru and more".
 *
 * Apostrophes are *deleted* rather than spaced, so "McDonald's" and
 * "Mcdonalds" fold to the same token; a space there would split one word into
 * two and make the shorter query fail the "every token must match" rule.
 * NFKD then stripping combining marks is what folds "é" to "e" while leaving
 * scripts that do not decompose (the fold is not anglophone-only).
 */
export function fold(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['\u2019\u02bc]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Fold, then split on the spaces `fold` guarantees are single. */
export function foldTokens(s: string): string[] {
  const f = fold(s);
  return f ? f.split(' ') : [];
}

/**
 * Street-type and direction abbreviations, as *equivalence classes*.
 *
 * Matching is symmetric through `tokenForms`: a query token and a name token
 * match when any of their forms match, so "st" <-> "street", "ave" <-> "Avenue"
 * and "n" <-> "North" work in both directions and in either case.
 *
 * `st` is deliberately ambiguous — "St" is "Saint" as often as "Street"
 * ("St Albert", "St Mary Lake") — so it expands to both. Resolving the
 * ambiguity would need to know which the *name* meant, and the cost of being
 * wrong ("St Albert" unsearchable) dwarfs the cost of matching both.
 */
const EXPANSIONS: Record<string, string[]> = {
  st: ['street', 'saint'],
  str: ['street'], strt: ['street'],
  ave: ['avenue'], av: ['avenue'],
  rd: ['road'],
  dr: ['drive'],
  blvd: ['boulevard'], boul: ['boulevard'],
  hwy: ['highway'],
  expy: ['expressway'],
  pkwy: ['parkway'], pky: ['parkway'],
  ln: ['lane'],
  ct: ['court'],
  pl: ['place'],
  sq: ['square'],
  ter: ['terrace'], terr: ['terrace'],
  trl: ['trail'],
  cir: ['circle'],
  ctr: ['center'],
  plz: ['plaza'],
  hbr: ['harbor'],
  mt: ['mount'],
  ft: ['fort'],
  n: ['north'], s: ['south'], e: ['east'], w: ['west'],
  ne: ['northeast'], nw: ['northwest'], se: ['southeast'], sw: ['southwest'],
  intl: ['international'],
};

/**
 * Every form a folded token can be written in, itself first.
 *
 * The first expansion is the canonical key used by `results.ts` to see that
 * "Memorial Dr" and "Memorial Drive" are the same label. Results are cached
 * because this is called once per vocabulary token per keystroke, and the
 * cache is bounded by the vocabulary itself.
 */
const FORMS = new Map<string, string[]>();
export function tokenForms(tok: string): string[] {
  let f = FORMS.get(tok);
  if (!f) {
    const exp = EXPANSIONS[tok];
    f = exp ? [tok, ...exp] : [tok];
    FORMS.set(tok, f);
  }
  return f;
}
