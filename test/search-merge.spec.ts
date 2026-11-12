/**
 * Cross-source ranking and result presentation.
 *
 * The sources used to be concatenated (offline first, online appended), so
 * this file's central claim — that the better match wins whatever server it
 * came from — is the behaviour change of the whole search pass, and the source
 * badge that makes it honest is checked alongside it.
 *
 * Run with: npx vitest run test/search-merge.spec.ts
 */

import { describe, it, expect } from 'vitest';
import {
  mergeHits, labelKey, scoreOnlineHit, scoreSavedHit, highlightRanges,
  type RankedHit,
} from '../src/search/merge';

const NEAR: [number, number] = [-114.0719, 51.0447]; // Calgary
const at = (dDeg: number): [number, number] => [NEAR[0] + dDeg, NEAR[1]];

const hit = (over: Partial<RankedHit>): RankedHit => ({
  label: 'Place', sub: 'place', pos: at(0), source: 'offline', score: 0,
  ...over,
});

describe('labelKey', () => {
  it('sees two spellings of a street as one name', () => {
    // "Memorial Dr" (gazetteer) and "Memorial Drive" (Nominatim) are one row
    // in a destination picker, not two.
    expect(labelKey('Memorial Dr')).toBe(labelKey('Memorial Drive'));
    expect(labelKey('MAIN STREET')).toBe(labelKey('Main St'));
    expect(labelKey('123 Main St')).toBe(labelKey('123 Main Street'));
  });

  it('keeps genuinely different names different', () => {
    expect(labelKey('Bow River')).not.toBe(labelKey('Bow River Pathway'));
    expect(labelKey('Calgary Tower')).not.toBe(labelKey('Calgary Tower West'));
  });
});

describe('mergeHits', () => {
  it('ranks by score across sources — the badge says where from, not where to', () => {
    const onlineExact = hit({
      label: 'Banff Springs Hotel', source: 'online', score: 900,
      sub: 'hotel, Banff',
    });
    const offlineWeak = hit({
      label: 'Banff Avenue Shopping', source: 'offline', score: 600,
    });
    const merged = mergeHits([offlineWeak], [onlineExact]);
    expect(merged.map((h) => h.label)).toEqual(['Banff Springs Hotel', 'Banff Avenue Shopping']);
    // provenance travels with the row
    expect(merged.map((h) => h.source)).toEqual(['online', 'offline']);
  });

  it('collapses the same name arriving from two sources', () => {
    const offline = hit({ label: 'Memorial Dr', source: 'offline', score: 800 });
    const online = hit({ label: 'Memorial Drive', source: 'online', score: 700 });
    const merged = mergeHits([offline], [online]);
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe('offline'); // the better-ranked one survives
  });

  it('collapses the multi-way street within one source', () => {
    // One entry per OSM element: a street split into three ways is three rows
    // of the same name unless deduped.
    const segs = [800, 790, 780].map((s) => hit({ label: 'Memorial Dr', score: s }));
    expect(mergeHits(segs)).toHaveLength(1);
  });

  it('collapses one place under two namings, across sources only', () => {
    // "Bow River" from the gazetteer and "Bow River, Calgary" from Nominatim
    // are one thing in two namings — dropped only across sources and only when
    // the positions agree, so two distinct POIs with distinct names survive.
    const a = hit({ label: 'Bow River', source: 'offline', score: 800, pos: at(0) });
    const b = hit({ label: 'Bow River, Calgary', source: 'online', score: 700, pos: at(0.0005) });
    expect(mergeHits([a], [b])).toHaveLength(1);

    const distinct = hit({ label: 'Bow River Pathway', source: 'online', score: 700, pos: at(0.5) });
    expect(mergeHits([a], [distinct])).toHaveLength(2);

    // same source: two differently-named rows are two rows
    const sameSource = hit({ label: 'Bow River, Calgary', source: 'offline', score: 700, pos: at(0) });
    expect(mergeHits([a, sameSource])).toHaveLength(2);
  });

  it('collapses a repeated name to its best-ranked row', () => {
    // By design (see `mergeHits`): "Safeway, Safeway, Safeway" is not a list of
    // three places to a driver picking one destination. The ranking decides
    // which copy is shown — the nearest, best match — and the rest are noise.
    const near = hit({ label: 'Safeway', source: 'offline', score: 800, pos: at(0) });
    const far = hit({ label: 'Safeway', source: 'offline', score: 700, pos: at(0.2) });
    expect(mergeHits([near, far])).toHaveLength(1);
    expect(mergeHits([near, far])[0].pos).toEqual(near.pos);
  });
});

describe('scoreOnlineHit', () => {
  it('scores an online name on the same tiers, plus importance', () => {
    const strong = scoreOnlineHit('banff', 'Banff', 0.9, at(0), NEAR);
    const weak = scoreOnlineHit('banff', 'Banff', 0.2, at(0), NEAR);
    expect(strong).toBeGreaterThan(weak);
  });

  it('gives a name Nominatim matched on other fields a floor, not a rank', () => {
    // Nominatim answers against display names and addresses the app never sees,
    // so a hit whose *name* does not match must still appear — below any real
    // name match, because that is what a name match means.
    const nameMatch = scoreOnlineHit('museum', 'Museum', 1, at(0), NEAR);
    const fieldMatch = scoreOnlineHit('museum', 'Exhibit Hall', 1, at(0), NEAR);
    expect(fieldMatch).toBeLessThan(nameMatch);
    expect(fieldMatch).toBeGreaterThan(0);
  });

  it('applies the same distance bias as offline ranking', () => {
    const near = scoreOnlineHit('museum', 'Museum', 0.5, at(0), NEAR);
    const far = scoreOnlineHit('museum', 'Museum', 0.5, at(1), NEAR);
    expect(near - far).toBeCloseTo(120, 6); // the gentle term caps at 120
  });

  it('does not let a name match across the continent beat the street down the road', () => {
    // The regression the browser gates caught: with a flat distance cap, an
    // exact name match 7,503 km away ("Elbow, Howard County, Texas", importance
    // behind it) outranked "Elbow St" at 340 m — so the e2e harness tapped the
    // first row and routed to Texas, and preview, screens and textscale all
    // failed downstream. Distance must be able to outweigh a name tier at
    // absurd distances without drowning a landmark a driver means to drive to.
    const texas = hit({
      label: 'Elbow', sub: 'Howard County, Texas', source: 'online',
      pos: [-95.5, 32.2],
      score: scoreOnlineHit('Elbow', 'Elbow', 0.5, [-95.5, 32.2], NEAR),
    });
    const local = hit({
      label: 'Elbow St', sub: 'street', source: 'offline',
      pos: at(0.003),
      score: 800 - 3 + 30, // name-prefix tier + street rank, ~340 m
    });
    expect(mergeHits([local], [texas])[0].label).toBe('Elbow St');
  });
});

describe('scoreSavedHit', () => {
  it('boosts a saved place the driver means over a same-named POI', () => {
    const saved = scoreSavedHit('home', 'Home', at(0), NEAR);
    const poi = scoreOnlineHit('home', 'Home Hardware', 1, at(0), NEAR);
    expect(saved).toBeGreaterThan(poi);
  });

  it('is absent entirely when the query does not touch the label', () => {
    // A saved place is a strong signal, not a blanket one.
    expect(scoreSavedHit('coffee', 'Home', at(0), NEAR)).toBeNull();
  });
});

describe('highlightRanges', () => {
  it('marks the matched part of the label', () => {
    expect(highlightRanges('Banff Springs', 'banff')).toEqual([[0, 5]]);
    expect(highlightRanges('Mount Banff Road', 'banff')).toEqual([[6, 11]]);
    expect(highlightRanges('Calgary Tower', 'calgary tower')).toEqual([[0, 7], [8, 13]]);
    // every occurrence of the typed word, not only the first
    expect(highlightRanges('Banff Banff', 'banff')).toEqual([[0, 5], [6, 11]]);
  });

  it('only matches at word boundaries', () => {
    // The ranking matches token prefixes; highlighting arbitrary substrings
    // would emphasise letters the ranking had nothing to do with.
    expect(highlightRanges('Restaurant', 'st')).toEqual([]);
    expect(highlightRanges('Main St', 'st')).toEqual([[5, 7]]);
  });

  it('highlights through abbreviations, the way the ranking matches', () => {
    // "st" is "street" and "saint": the mark lands on the word the matcher
    // used, whole, rather than the two typed letters inside it.
    expect(highlightRanges('Saint Mary Lake', 'st')).toEqual([[0, 5]]);
    expect(highlightRanges('Main Street', 'st')).toEqual([[5, 11]]);
    expect(highlightRanges('Main St', 'street')).toEqual([[5, 7]]);
  });

  it('marks the agreeing prefix of a typo', () => {
    expect(highlightRanges('Calgary', 'calgry')).toEqual([[0, 4]]);
  });

  it('merges overlapping marks and leaves the rest of the label intact', () => {
    // two query tokens agreeing on one word: one mark, not two stacked
    expect(highlightRanges('Banff Springs', 'banff banff')).toEqual([[0, 5]]);
    expect(highlightRanges('Bow River Bow', 'bow river')).toEqual([[0, 3], [4, 9], [10, 13]]);
    expect(highlightRanges('Bow River Pathway', 'bow river')).toEqual([[0, 3], [4, 9]]);
  });

  it('marks nothing when nothing matched', () => {
    expect(highlightRanges('Calgary', 'zzzz')).toEqual([]);
  });
});
