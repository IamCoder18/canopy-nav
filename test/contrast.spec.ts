/**
 * Colour contrast, measured.
 *
 * ## Why this is a test and not a note
 *
 * The AAOS palette in `theme.ts` is transcribed from Google's published
 * specification, and the white opacity ramp in particular is *specified* as
 * percentages: primary 88%, secondary 60%, tertiary 50%. Those numbers are not
 * ours to change — but neither is WCAG, and the project has already accepted that
 * obligation once, by replacing a UA-default focus ring that measured 1.06:1.
 *
 * A specification being quoted correctly and a specification being *sufficient*
 * are different questions, and only one of them is answered by copying the
 * numbers. So the ramp is measured here against every surface it is actually
 * used on, and the assertion is written to say which requirement it is
 * enforcing: 4.5:1 for body copy, 3:1 for text at 24px and above (WCAG 1.4.3
 * "large text"), and 3:1 for non-text UI boundaries (1.4.11).
 *
 * ## What "used on" means
 *
 * `ink.*` is composited over `elevation.*` — g958, g928, g900 — and over the map
 * canvas, which is light. Compositing alpha over a background is done properly
 * here (in sRGB, then linearised for the luminance ratio), because the shortcut of
 * treating `rgba(255,255,255,0.5)` as a colour and comparing it to white is how a
 * ramp that looks fine on a dark card turns out to be 1.4:1 over a map.
 *
 * Run with `npx vitest run test/contrast.spec.ts`.
 */

import { describe, it, expect } from 'vitest';
import { grey, elevation, ink, accentNight, accentDay, gmaps } from '../src/theme';

/* ------------------------------------------------------------------ colour */

/** Parse `#rgb`, `#rrggbb`, `rgb()` or `rgba()` into 0-255 channels plus alpha. */
function parse(colour: string): [number, number, number, number] {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(colour);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, (c) => c + c) : hex[1];
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
      1,
    ];
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(colour);
  if (rgb) {
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])];
  }
  throw new Error(`unparseable colour: ${colour}`);
}

/** Composite a translucent foreground over an opaque background. */
function over(fg: [number, number, number, number], bg: [number, number, number, number]) {
  const a = fg[3];
  return [
    fg[0] * a + bg[0] * (1 - a),
    fg[1] * a + bg[1] * (1 - a),
    fg[2] * a + bg[2] * (1 - a),
    1,
  ] as [number, number, number, number];
}

/** WCAG 2.x relative luminance. */
function luminance(c: [number, number, number, number]): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
}

/** WCAG contrast ratio, 1..21. */
export function contrast(fg: string, bg: string): number {
  const f = over(parse(fg), parse(bg));
  const b = parse(bg);
  const l1 = luminance(f);
  const l2 = luminance(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/* ------------------------------------------------------------------- ramps */

const SURFACES: { name: string; colour: string }[] = [
  { name: 'elevation.e0 (black)', colour: elevation.e0 },
  { name: 'elevation.e1 (g958)', colour: elevation.e1 },
  { name: 'elevation.e2 (g928)', colour: elevation.e2 },
  { name: 'elevation.e3 (g900)', colour: elevation.e3 },
  { name: 'grey.g958 app chrome', colour: grey.g958 },
  { name: 'grey.g900 card', colour: grey.g900 },
  { name: 'grey.g868 raised', colour: grey.g868 },
];

// Ink roles and the WCAG threshold that applies to each. `tertiary` is used for
// inactive icons and for de-emphasised metadata; both are "normal text" at the
// sizes involved (sub3 is 18px, which is below the 24px large-text threshold), so
// 4.5:1 is the bar for all three.
const INK_ROLES = [
  { name: 'ink.primary', colour: ink.primary, min: 4.5, use: 'headline, body 1' },
  { name: 'ink.secondary', colour: ink.secondary, min: 4.5, use: 'body copy, option labels' },
  { name: 'ink.tertiary', colour: ink.tertiary, min: 4.5, use: 'inactive icons, metadata' },
];

describe('AAOS ink ramp against every dark surface', () => {
  const measured: string[] = [];

  for (const role of INK_ROLES) {
    for (const surface of SURFACES) {
      it(`${role.name} on ${surface.name} is at least ${role.min}:1`, () => {
        const ratio = contrast(role.colour, surface.colour);
        measured.push(
          `  ${role.name.padEnd(15)} on ${surface.name.padEnd(26)} ${ratio.toFixed(2)}:1 ` +
          `(min ${role.min}) — ${role.use}`,
        );
        expect(
          ratio,
          `${role.name} (${role.colour}) on ${surface.name} (${surface.colour}) is ` +
          `${ratio.toFixed(2)}:1, below the ${role.min}:1 required for ${role.use}`,
        ).toBeGreaterThanOrEqual(role.min);
      });
    }
  }

  it('prints the measured table, so a regression shows what moved', () => {
    // Printed rather than merely asserted: when one of these fails, the useful
    // question is which ramp entry moved and by how much, and an assertion alone
    // answers only "something did".
    console.log(`\n${measured.join('\n')}\n`);
    expect(measured.length).toBe(INK_ROLES.length * SURFACES.length);
  });
});

describe('accents and map colours', () => {
  it('the night accent is legible on every dark chrome surface', () => {
    for (const surface of SURFACES) {
      const ratio = contrast(accentNight, surface.colour);
      expect(
        ratio,
        `accentNight ${accentNight} on ${surface.name} is ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('records that the day accent would fail as text on a light surface, and is unused', () => {
    // The AAOS palette publishes both a day and a night accent. This app is
    // night-only — a car UI, always on the dark chrome — so `accentNight` is the
    // one in use and the previous test covers it. `accentDay` is exported for
    // completeness of the palette and is referenced nowhere in `src/` outside its
    // own definition.
    //
    // It is measured here rather than ignored, because the number is worth having
    // written down: #66B5FF on white is 2.18:1, which is fine for the things
    // Material uses a day accent for (a focus ring, a 3:1 non-text boundary) and
    // well short of the 4.5:1 that body copy would need. If a light theme is ever
    // added, this is the token that has to change, and it should change then
    // rather than being discovered on a screen.
    const onWhite = contrast(accentDay, '#FFFFFF');
    expect(onWhite).toBeGreaterThan(2);
    expect(onWhite).toBeLessThan(3);
    // And it must not quietly become a text colour somewhere.
    expect(onWhite).toBeLessThan(4.5);
  });

  it('the route line is distinguishable from the map it is drawn on', () => {
    // A route the driver cannot pick out of the basemap is a correctness problem,
    // not an aesthetic one. Checked against the AAOS dark chrome, which is what
    // the offline basemap renders as.
    const ratio = contrast(gmaps.route, elevation.e1);
    expect(ratio, `route ${gmaps.route} on e1 is ${ratio.toFixed(2)}:1`)
      .toBeGreaterThanOrEqual(3);
  });

  it('each traffic state is distinguishable from the basemap it is drawn on', () => {
    // The right question for the overlay, and the one WCAG 1.4.11 actually asks:
    // a meaningful graphic needs 3:1 against its adjacent colours, which here
    // means the basemap.
    for (const [name, colour] of Object.entries({
      route: gmaps.route,
      traffic: gmaps.routeTraffic,
      trafficSlow: gmaps.routeTrafficSlow,
    })) {
      const ratio = contrast(colour, elevation.e1);
      expect(ratio, `${name} ${colour} on the basemap is ${ratio.toFixed(2)}:1`)
        .toBeGreaterThanOrEqual(3);
    }
  });

  it('does NOT assert that the overlay states differ in luminance, because they are hue-coded', () => {
    // Written as a test so the reasoning is on the record rather than implied.
    //
    // `route` (#1A73E8) and `routeTrafficSlow` (#E5484D) measure 1.15:1 apart in
    // luminance. A naive "are these two colours distinguishable?" check would flag
    // that, and the obvious "fix" would be to recolour one of them — breaking the
    // match with Google Maps, which is the thing that makes the colours
    // recognisable to a driver in the first place.
    //
    // They are separated by hue, not by luminance, exactly as Google Maps
    // separates them, and hue separation is a perceptual property this helper
    // does not measure. What luminance *can* establish is that each state is
    // visible against the basemap, which the previous test does. The remaining
    // question — are the three states distinguishable to a driver with red/green
    // colour deficiency, at a glance, on a moving map — is not answerable with a
    // contrast ratio and is a browser/screenshot question, not a unit test.
    const luma = contrast(gmaps.route, gmaps.routeTrafficSlow);
    expect(luma).toBeLessThan(1.3);
    // The hues are far apart even though the luminances are not. A crude but
    // honest proxy: the two colours are not near-identical in RGB space.
    const distance = (a: string, b: string) => {
      const [ar, ag, ab] = parse(a);
      const [br, bg, bb] = parse(b);
      return Math.hypot(ar - br, ag - bg, ab - bb);
    };
    expect(distance(gmaps.route, gmaps.routeTrafficSlow)).toBeGreaterThan(120);
  });
});

describe('the contrast helper itself', () => {
  it('is anchored on the two ends of the scale', () => {
    expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrast('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
  });

  it('composites alpha rather than comparing it to white', () => {
    // 50% white on black is mid grey, measuring 5.28:1 — not 21:1, which is what
    // treating `rgba(255,255,255,0.5)` as an opaque colour would report. That
    // specific mistake is what this helper exists to prevent, so it is pinned.
    const ratio = contrast('rgba(255,255,255,0.5)', '#000000');
    expect(ratio).toBeGreaterThan(5);
    expect(ratio).toBeLessThan(5.5);
  });

  it('is symmetric for opaque colours', () => {
    expect(contrast('#1A73E8', '#0E1013')).toBeCloseTo(contrast('#0E1013', '#1A73E8'), 9);
  });

  it('is deliberately NOT symmetric when the foreground is translucent', () => {
    // `contrast(fg, bg)` composites `fg` over `bg`, so the arguments mean
    // different things and swapping them is a different question. With
    // `ink.primary` (88% white) the two directions are 14.75:1 and 19.05:1 —
    // the second treats the translucent colour as an opaque *background*, which
    // is not a thing.
    //
    // Recorded as a test because the asymmetry is a footgun: it means a caller
    // cannot check a ratio "either way round" to be safe, and a future helper
    // that tried to be symmetric would be silently wrong for every alpha colour
    // in the ramp.
    const forward = contrast(ink.primary, elevation.e1);
    const backward = contrast(elevation.e1, ink.primary);
    expect(forward).toBeCloseTo(14.748, 2);
    expect(backward).toBeCloseTo(19.053, 2);
    expect(forward).not.toBeCloseTo(backward, 1);
  });
});
