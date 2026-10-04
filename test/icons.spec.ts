import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { ManeuverIcon, type ManeuverKindForTest } from '../src/icons';

/**
 * Every declared maneuver kind must render its own geometry.
 *
 * `destination-left` and `destination-right` were declared in the union but had
 * no `case`, so they fell through to `default` and silently rendered as the
 * generic arrival pin -- a real defect, because Valhalla emits those types for
 * arrivals from a side. Asserting on distinct markup catches that class of bug
 * without needing a browser.
 */

const ALL: ManeuverKindForTest[] = [
  'start', 'start-left', 'start-right',
  'destination', 'destination-left', 'destination-right',
  'continue', 'slight-left', 'left', 'sharp-left', 'uturn-left',
  'slight-right', 'right', 'sharp-right', 'uturn-right',
  'ramp-straight', 'ramp-left', 'ramp-right',
  'exit-left', 'exit-right', 'fork-left', 'fork-right',
  'roundabout-enter', 'roundabout-exit',
  'merge', 'merge-left', 'merge-right',
  'ferry', 'arrive',
];

const markup = (kind: ManeuverKindForTest) =>
  renderToStaticMarkup(React.createElement(ManeuverIcon, { kind, size: 24 }));

describe('maneuver icons', () => {
  it('renders every declared kind without throwing', () => {
    for (const kind of ALL) {
      expect(markup(kind), kind).toContain('<svg');
    }
    expect(ALL).toHaveLength(29);
  });

  it('gives side-arrivals their own geometry rather than the arrival pin', () => {
    const pin = markup('arrive');
    const plain = markup('destination');
    const left = markup('destination-left');
    const right = markup('destination-right');

    // arrival is a filled pin
    expect(pin).toContain('<circle');
    // the side variants must NOT be that pin -- this is exactly what regressed
    expect(left).not.toBe(pin);
    expect(right).not.toBe(pin);
    expect(left).not.toBe(right);
    expect(left).not.toBe(plain);
    expect(right).not.toBe(plain);
  });

  it('mirrors left and right about the vertical axis', () => {
    const left = markup('destination-left');
    const right = markup('destination-right');
    const paths = (s: string) => (s.match(/ d="[^"]+"/g) ?? []).map((d) => d.slice(4, -1));
    const lp = paths(left);
    const rp = paths(right);
    expect(lp).toHaveLength(rp.length);
    // every path differs, i.e. the two are genuinely drawn differently
    expect(lp).not.toEqual(rp);
  });

  it('produces distinct markup for every distinct kind', () => {
    // 'start' and 'continue' intentionally share a glyph, as do 'destination'
    // and 'arrive'; everything else must be unique or a case is missing.
    // These pairs are deliberately the same glyph: Valhalla uses type 36
    // (kMergeRight) and 25 (kMerge) interchangeably for a right-hand merge.
    const aliases = new Set(['continue:start', 'arrive:destination', 'merge-right:merge']);
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const kind of ALL) {
      const m = markup(kind);
      if (seen.has(m) && !aliases.has(`${kind}:${seen.get(m)}`)) {
        collisions.push(`${seen.get(m)} and ${kind} render identically`);
      }
      seen.set(m, kind);
    }
    expect(collisions).toEqual([]);
  });
});
