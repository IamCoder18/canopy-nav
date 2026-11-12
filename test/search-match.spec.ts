/**
 * The search matcher: normalization, fuzzy tolerance, ranking tiers, the
 * token index, and the corrections.
 *
 * The suite this replaces tested four match cases on a fixture and called it
 * done; every failure mode below — the dropped letter, the abbreviation, the
 * house number, the cut-off tail of a popular query — passed that suite while
 * being broken in the app. The parity tests at the bottom exist because the
 * index is the one part that can silently disagree with the ranking: a result
 * that is rankable but unreachable is the same driver-visible bug as no
 * matcher at all.
 *
 * Run with: npx vitest run test/search-match.spec.ts
 */

import { describe, it, expect } from 'vitest';
import { fold, foldTokens, tokenForms } from '../src/search/text';
import { fuzzyTolerance, editDistance } from '../src/search/fuzzy';
import {
  parseQuery, scoreName, scoreText, scoreGazetteer, searchGazetteer,
  searchIndex, suggestName, type GazEntry,
} from '../src/search/gaz';

const NEAR: [number, number] = [-114.0719, 51.0447]; // Calgary

const entry = (
  name: string,
  rank = 50,
  extra: Partial<GazEntry> = {},
): GazEntry => ({
  name, rank, cat: 'place',
  lat: NEAR[1], lon: NEAR[0],
  ...extra,
});

describe('fold', () => {
  it('folds case, diacritics and punctuation to one comparison form', () => {
    expect(fold('Café — Drive-Thru & More')).toBe('cafe drive thru and more');
    expect(fold('  Zürich  ')).toBe('zurich');
    expect(fold('MÜNCHEN')).toBe('munchen');
  });

  it('deletes apostrophes rather than spacing them', () => {
    // "McDonald's" -> "mcdonald s" would split one word into two tokens and
    // make "mcdonalds" fail the every-token-must-match rule.
    expect(fold("McDonald's")).toBe('mcdonalds');
    expect(fold('Mcdonalds')).toBe('mcdonalds');
    expect(fold("Rock ‘n’ Roll")).toBe('rock n roll');
  });

  it('keeps numbers and non-Latin scripts', () => {
    expect(foldTokens('4 St W')).toEqual(['4', 'st', 'w']);
    expect(fold('大阪市')).toBe('大阪市');
  });

  it('leaves nothing behind but single spaces', () => {
    expect(fold('a,, b --- c')).toBe('a b c');
  });
});

describe('tokenForms', () => {
  it('expands street types and directions, both usable in matching', () => {
    expect(tokenForms('st')).toContain('street');
    expect(tokenForms('ave')).toContain('avenue');
    expect(tokenForms('n')).toContain('north');
    expect(tokenForms('street')).toEqual(['street']);
  });

  it('expands "st" to saint as well as street', () => {
    // "St" is "Saint" as often as "Street" ("St Albert", "St Mary Lake").
    // Resolving it would need to know which the name meant; matching both is
    // strictly better than making half of them unsearchable.
    expect(tokenForms('st')).toEqual(expect.arrayContaining(['street', 'saint']));
  });
});

describe('editDistance', () => {
  it('counts edits, including adjacent transpositions', () => {
    expect(editDistance('calgary', 'calgary')).toBe(0);
    expect(editDistance('calgry', 'calgary')).toBe(1); // one deletion
    expect(editDistance('calagry', 'calgary')).toBe(1); // one insertion
    expect(editDistance('calsary', 'calgary')).toBe(1); // one substitution
    expect(editDistance('calagry', 'calgary')).toBe(1);
    // OSA: an adjacent swap is one edit, not two
    expect(editDistance('musuem', 'museum')).toBe(1);
    expect(editDistance('calgary', 'vancouver')).toBeGreaterThan(3);
  });

  it('exceeds the bound rather than finishing, when it already knows', () => {
    expect(editDistance('calgary', 'vancouver', 2)).toBe(3);
  });

  it('gives short tokens no tolerance and long ones two edits', () => {
    expect(fuzzyTolerance(3)).toBe(0);
    expect(fuzzyTolerance(4)).toBe(1);
    expect(fuzzyTolerance(5)).toBe(1);
    expect(fuzzyTolerance(6)).toBe(2);
    expect(fuzzyTolerance(12)).toBe(2);
  });
});

describe('scoreName tiers', () => {
  const q = (s: string) => parseQuery(s)!;
  const score = (query: string, name: string) =>
    scoreName(q(query), fold(name), foldTokens(name));

  it('ranks exact > prefix > phrase > token > substring > fuzzy', () => {
    const exact = score('banff', 'Banff')!;
    const prefix = score('banff', 'Banff Springs')!;
    const phrase = score('springs hotel', 'Banff Springs Hotel')!;
    const token = score('springs', 'Banff Springs Road')!;
    const substring = score('anff', 'Banff Springs Road')!;
    const fuzzy = score('banfg', 'Banff')!;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(phrase);
    expect(phrase).toBeGreaterThan(token);
    expect(token).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(fuzzy);
    expect(fuzzy).toBeGreaterThan(0);
  });

  it('keeps the pre-fuzzy score identities for exact and prefix', () => {
    // These two constants are load-bearing: they are the ordering drivers have
    // already learned from the app, and `test/regions.spec.ts` mirrors them.
    expect(score('banff', 'Banff')).toBe(1000);
    expect(score('banff', 'Banff Springs')).toBe(800 - (13 - 5));
  });

  it('tolerates a dropped letter', () => {
    expect(score('calgry', 'Calgary')).not.toBeNull();
    expect(score('calgry', 'Calgary')).toBeLessThan(score('calgary', 'Calgary')!);
  });

  it('tolerates a transposition', () => {
    expect(score('musuem', 'Museum')).not.toBeNull();
  });

  it('refuses short-token fuzz: "gas" is not "bar"', () => {
    expect(score('gas', 'Bar')).toBeNull();
  });

  it('matches every query token, not some', () => {
    expect(score('banff calgary', 'Banff')).toBeNull();
    expect(score('banff springs', 'Banff Springs Hotel')).not.toBeNull();
    expect(score('springs banff', 'Banff Springs Hotel')).not.toBeNull();
  });

  it('ranks query order above word order', () => {
    const inOrder = score('banff springs', 'Banff Springs Hotel')!;
    const reversed = score('springs banff', 'Banff Springs Hotel')!;
    expect(inOrder).toBeGreaterThan(reversed);
  });

  it('does not fuzzy-match nonsense', () => {
    expect(score('zzzzqqq', 'Calgary')).toBeNull();
    expect(searchGazetteer([entry('Calgary')], 'zzzzqqq')).toEqual([]);
  });
});

describe('abbreviations', () => {
  const gaz = [
    entry('Main Street', 30),
    entry('4 Street W', 30),
    entry('Saint Albert Trail', 50),
    entry('Avenue Road', 30),
  ];

  it('matches "main st" to "Main Street" — the abbreviated side may be either', () => {
    expect(searchGazetteer(gaz, 'main st')[0].name).toBe('Main Street');
    expect(searchGazetteer(gaz, 'main street')[0].name).toBe('Main Street');
  });

  it('matches a direction abbreviation in the name', () => {
    expect(searchGazetteer(gaz, '4 st w')[0].name).toBe('4 Street W');
    expect(searchGazetteer(gaz, '4 street west')[0].name).toBe('4 Street W');
  });

  it('matches "st" as "Saint" too', () => {
    expect(searchGazetteer(gaz, 'st albert')[0].name).toBe('Saint Albert Trail');
    expect(searchGazetteer(gaz, 'saint albert')[0].name).toBe('Saint Albert Trail');
  });

  it('matches through either side of an abbreviation', () => {
    expect(searchGazetteer(gaz, 'ave rd').map((e) => e.name)).toContain('Avenue Road');
    expect(searchGazetteer(gaz, 'av road').map((e) => e.name)).toContain('Avenue Road');
    expect(searchGazetteer(gaz, 'avenue rd').map((e) => e.name)).toContain('Avenue Road');
    expect(searchGazetteer(gaz, 'avenue road').map((e) => e.name)).toContain('Avenue Road');
  });
});

describe('house numbers', () => {
  const gaz = [
    entry('Main Street', 30, { street: 'Main Street' }),
    entry('Main Street 123', 40, { street: 'Main Street', house: 123 }),
    entry('Main Street 250', 20, { street: 'Main Street', house: 250 }),
    entry('West Side Diner', 50),
    entry('Five Guys', 70),
    entry('Route 66 Diner', 70),
  ];

  it('puts the exact address first for "123 main"', () => {
    const hits = searchGazetteer(gaz, '123 main');
    expect(hits[0].name).toBe('Main Street 123');
    // the street itself is still reachable from the same query
    expect(hits.map((e) => e.name)).toContain('Main Street');
  });

  it('reads the number wherever it sits in the query', () => {
    expect(searchGazetteer(gaz, 'main 123')[0].name).toBe('Main Street 123');
  });

  it('does not boost the right number on the wrong street', () => {
    const hits = searchGazetteer(gaz, '123 west side');
    expect(hits.some((e) => e.name === 'Main Street 123')).toBe(false);
  });

  it('finds "Five Guys" for "5 guys" — a number the name spells out', () => {
    // The dropped-numeric-token rule: the number is usually a house number the
    // name does not carry. It costs 60, so a name that really contains the
    // number still wins — which is what "route 66" checks.
    const hits = searchGazetteer(gaz, '5 guys');
    expect(hits[0].name).toBe('Five Guys');
    const sixtySix = searchGazetteer(gaz, 'route 66');
    expect(sixtySix[0].name).toBe('Route 66 Diner');
  });
});

describe('index', () => {
  it('builds once per gazetteer array and reuses it', () => {
    const gaz = [entry('Calgary')];
    expect(searchIndex(gaz)).toBe(searchIndex(gaz));
    expect(searchIndex(gaz)).not.toBe(searchIndex([entry('Calgary')]));
  });

  it('indexes every name token, folded', () => {
    const idx = searchIndex([entry('Café du Monde')]);
    expect(idx.vocab).toEqual(['cafe', 'du', 'monde']);
    expect(idx.post.get('cafe')).toEqual([0]);
  });

  it('finds everything the brute-force matcher finds, in the same order', () => {
    // The parity property: candidate generation (the index) must be a superset
    // of what the matcher accepts, and the two must agree on order. A gap here
    // is a result that ranks fine when reached but is never reached — invisible
    // to any test of `scoreName`.
    //
    // One rank for every entry and every entry at the same point, so that rank
    // and distance cannot reorder anything: what is under test is the matcher
    // and the index, not the ranking addends.
    const rnd = mulberry32(42);
    const words = ['banff', 'calgary', 'memorial', 'springs', 'trail', 'avenue', 'cafe', 'museum', 'park', 'river', 'bow', 'elbow', 'st', 'north', 'central'];
    const gaz: GazEntry[] = [];
    for (let i = 0; i < 3000; i++) {
      const n = 1 + Math.floor(rnd() * 3);
      const name = Array.from({ length: n }, () => words[Math.floor(rnd() * words.length)])
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join(' ');
      gaz.push(entry(name, 50));
    }
    const tieBreak = (a: { e: GazEntry; i: number }, b: { e: GazEntry; i: number }) =>
      a.e.name < b.e.name ? -1 : a.e.name > b.e.name ? 1 : a.i - b.i;
    for (const query of ['banff', 'banff sp', 'memorial tr', 'cafe', 'centrl', 'park river', 'st', 'saint', 'bow el', 'musuem', '66 12', 'park 12']) {
      const found = scoreGazetteer(gaz, query, NEAR, 50).map((h) => h.entry);
      // brute force: score every entry with the same matcher
      const pq = parseQuery(query)!;
      const brute = gaz
        .map((e, i) => ({ e, i, s: scoreName(pq, fold(e.name), foldTokens(e.name)) }))
        .filter((x) => x.s != null)
        .sort((a, b) => (b.s as number) - (a.s as number) || tieBreak(a, b))
        .slice(0, 50)
        .map((x) => x.e);
      expect(found.length).toBe(brute.length);
      for (let i = 0; i < Math.min(10, brute.length); i++) {
        expect(found[i].name).toBe(brute[i].name);
      }
    }
  });

  it('returns the best matches regardless of where they sit in the gazetteer', () => {
    // The old scan stopped scoring after 4000 matches, so which results
    // *existed* depended on gazetteer order: a popular query silently lost
    // every entry past the cap.
    const gaz: GazEntry[] = [];
    for (let i = 0; i < 6000; i++) gaz.push(entry(`Test Shop ${i}`, 30));
    gaz.push(entry('Test Shop Prime', 100)); // last, and the best match
    const hits = searchGazetteer(gaz, 'test shop', NEAR, 5);
    expect(hits[0].name).toBe('Test Shop Prime');
    expect(hits).toHaveLength(5);
  });

  it('orders ties deterministically', () => {
    const gaz = [entry('Same', 50), entry('Same', 50), entry('Same', 50)];
    const order = () => searchGazetteer(gaz, 'same', NEAR, 3).map((e) => gaz.indexOf(e));
    // A result list that reshuffles on re-render for no reason reads as a
    // glitch; equal scores must come back in gazetteer order, every time.
    expect(order()).toEqual([0, 1, 2]);
    expect(order()).toEqual([0, 1, 2]);
  });
});

describe('scoreText (other sources)', () => {
  it('scores a saved label or online name on the same tiers', () => {
    expect(scoreText('home', 'Home')).toBe(1000);
    expect(scoreText('hom', 'Home')).not.toBeNull();
    expect(scoreText('coffee', 'Home')).toBeNull();
    expect(scoreText('cafe', 'Café du Monde')).not.toBeNull();
  });

  it('is null for an empty query', () => {
    expect(scoreText('', 'Home')).toBeNull();
    expect(parseQuery('   ')).toBeNull();
  });
});

describe('suggestName', () => {
  const gaz = [entry('Calgary', 100), entry('Banff Springs', 90), entry('Edmonton', 100)];

  it('offers the close name when the query missed', () => {
    expect(suggestName(gaz, 'calgry')).toBe('Calgary');
    expect(suggestName(gaz, 'banff sprngs')).toBe('Banff Springs');
  });

  it('offers nothing for a query that is not close to anything', () => {
    expect(suggestName(gaz, 'zzzzqqqq')).toBeNull();
    expect(suggestName(gaz, 'ab')).toBeNull();
  });
});

/** Deterministic PRNG, so the parity fuzz is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
