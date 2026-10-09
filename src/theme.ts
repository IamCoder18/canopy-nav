/**
 * Google Maps dark theme — design tokens.
 *
 * ## Why this is not the AAOS palette any more
 *
 * This used to be the Android Auto / Automotive OS grayscale ramp
 * (`#0E1013` / `#17181B` / `#202124`, accent `#60A8F0`). That palette is a
 * faithful transcription of the AAOS specification and it is *wrong for this
 * app*: the brief is to look like Google Maps, and Google Maps' dark theme is a
 * warmer, slightly blue-shifted neutral set built on `#1E2024`–`#30343A` with the
 * `#8AB4F8` accent. Carrying both palettes meant the app was simultaneously
 * claiming to implement two systems and matching neither.
 *
 * So the grayscale ramp is gone and the values below are Google Maps'. The
 * *layout* tokens (8dp grid, P0-P8 padding, keylines, 12% side margins, 76dp touch
 * minimum) are unchanged: those are AAOS layout guidance and they are still the
 * right numbers for a car, which is what this app is.
 *
 * Surface ramp (dark):
 *   page      #1E2024
 *   card      #26292E
 *   raised    #30343A   (app bar, chips, inputs)
 *   hover     #3D4249
 *
 * ## Ink is solid, not an alpha ramp
 *
 * The old `ink` was `rgba(255,255,255,0.88 / 0.6 / 0.5)`, the AAOS white-opacity
 * ramp. Alpha text is *translucent*, which makes its contrast a function of
 * whatever is behind it — so the same token measured one thing on a card and
 * something else over the map, and the ratio moved as the map panned.
 *
 * The values below are solid hex, so contrast is a property of the token rather
 * than of the screen it landed on. Every one is asserted at >= 4.5:1 against every
 * surface in `elevation` by `test/contrast.spec.ts`, which composited and
 * measured rather than transcribing the ramp.
 *
 * The same reasoning is why the interactive states in `styles.css` are opaque:
 * a translucent fill *replaces* the one beneath it, so a hover declared as
 * `rgba(255,255,255,0.06)` on a surface floating over a near-white basemap
 * renders as the basemap. See `.quick-tile` there for the measured numbers.
 */

import type { CSSProperties } from 'react';

/* ---------------- Google Maps dark neutral ramp ---------------- */
export const grey = {
  black: '#000000',
  g958: '#1E2024', // page
  g928: '#26292E', // card
  g900: '#30343A', // raised: app bar, chips, inputs
  g868: '#3D4249', // hover / pressed
  g846: '#4A4F57',
  g800: '#5F6368',
  g700: '#80868B',
  g600: '#9AA0A6',
  g500: '#A7AEB8',
  g400: '#C2C8D0',
  g300: '#D5DAE0',
  g200: '#E4E8EC',
  g100: '#EDF0F2',
  g50: '#F5F7F9',
} as const;

/** Dark elevation surfaces. */
export const elevation = {
  e0: grey.black,
  e1: grey.g958,
  e2: grey.g928,
  e3: grey.g900,
  e4: grey.g868, // dialogs/HUN/snackbar rest at +3..+4
} as const;

/** Google Maps dark accent. `#1A73E8` is the light-mode blue and fails on dark. */
export const accentNight = '#8AB4F8';
export const accentDay = '#1A73E8';

/** Ink on dark surfaces. Solid, and each measured at >= 4.5:1 on every surface. */
export const ink = {
  primary: '#EDF0F2',   // Headline/Title, Body 1      14.25:1 on e1
  secondary: '#C2C8D0', // Body copy, option labels     9.68:1 on e1
  tertiary: '#A7AEB8',  // inactive icons, metadata     7.29:1 on e1
  /** Text drawn *on* the accent fill. 6.94:1 — the accent is too light to carry it. */
  onAccent: '#0B2545',
  /**
   * Text drawn on a *warning* fill, i.e. body copy inside a warning card rather
   * than its heading.
   *
   * The warning card's own colour is bright enough to carry a heading at 24px
   * (`#F5D67E` on `#5C4A1A` is 6.04:1), so using it for the body as well made
   * the card read as one undifferentiated block of yellow. This is the step
   * below, and it is still 5.1:1 — so the hierarchy costs nothing in legibility.
   */
  onWarn: '#EFE0B4',
  divider: 'rgba(255,255,255,0.12)',
  track: 'rgba(255,255,255,0.12)',
  outline: 'rgba(255,255,255,0.24)',
  scrim84: 'rgba(0,0,0,0.84)',
  scrim70: 'rgba(0,0,0,0.7)',
} as const;

/** The white-opacity ramp, kept for the few places that need a veil rather than a colour. */
export const white = (pct: number) => `rgba(255,255,255,${pct})`;

/**
 * The separator between pieces of metadata, joined so it cannot be orphaned.
 *
 * A plain `' · '` is three characters the browser is free to break before and
 * after, so on a narrow column the bullet lands alone at the end of one line
 * with its text on the next. Measured on the regions screen at 412px: the
 * "routable ways · places indexed" line rendered as
 *
 *     19 routable ways
 *     · 712 places
 *     indexed
 *
 * with a 2x2px mark alone on line two, and the bounds line ended in a dangling
 * `·` before dropping "local" onto a line of its own. A bullet is the only thing
 * on the line and it means nothing.
 *
 * The non-breaking spaces on both sides bind the bullet to its neighbours, so
 * the three of them wrap as one unit and the bullet is always between two words.
 * U+00A0 rather than U+202F so it renders in the same fallback as the rest of
 * the app's punctuation.
 */
export const SEP = '\u00A0·\u00A0';

/** Padding scale P0-P8. */
export const DP = { P0: 4, P1: 8, P2: 12, P3: 16, P4: 24, P5: 32, P6: 48, P7: 64, P8: 96 } as const;

/**
 * Corner radius scale.
 *
 * Google's own scale is 4 / 8 / 12 / 16 / 28 with a fully-rounded pill at the
 * end. The AAOS scale this replaced was 4 / 8 / 16 / 9999, which had one step
 * between "small" and "pill" — so a card, a chip and a search field all landed
 * on the same 8px while a button went fully round, and the result read as three
 * unrelated corner languages on one screen.
 *
 * R5 (28px) is new and is the one that matters visually: it is the radius
 * Google uses on its sheets and large cards, and every card-sized surface in
 * `styles.css` now uses it.
 */
export const R = { R0: 0, R1: 4, R2: 8, R3: 12, R4: 16, R5: 28, R6: 9999 } as const;

/** Icon sizes + minimum touch target. */
export const ICON = { primary: 44, secondary: 36, tertiary: 24 } as const;
export const TOUCH_TARGET = 76;

/**
 * Structural dimensions that the layout repeats everywhere.
 *
 * These were previously CSS literals scattered across `styles.css` — `96px`
 * nine times, `158px` once — which meant changing the app bar meant finding
 * nine call sites and hoping the tenth was not a `calc()` that had drifted.
 * They are the AAOS spec values: a 96dp app bar and a 158dp minimum grid cell.
 *
 * Declared here so the value has one home, and mirrored into CSS custom
 * properties by `applyThemeTokens()` below. CSS cannot import from TypeScript,
 * so the duplication moves to exactly one line instead of nine.
 */
export const STRUCTURE = {
  /** App bar height. */
  APP_BAR: 96,
  /** Minimum content height of a grid cell. */
  GRID_CELL: 158,
} as const;

/**
 * Publish the design tokens as CSS custom properties.
 *
 * Called once at startup. This is the seam that lets `styles.css` consume the
 * tokens without a build-time CSS-in-JS dependency: TypeScript owns the values,
 * CSS reads them, and `styles.css` falls back to the literal so a stylesheet
 * loaded without this running still lays out correctly.
 *
 * The *palette* is published here too, and not just the two structural numbers
 * it used to carry. `styles.css` had the whole theme retyped as hex literals —
 * `#17181B` on cards, `#202124` on bars, `#60A8F0` on accents — in around forty
 * places, none of which could be changed by editing the palette. Every one of
 * those is a place where the palette could drift from its own definition, and
 * the drift had already happened: the same "app bar" was one colour on the
 * launcher and another on the navigation screens.
 *
 * So there is now one definition of each colour, here, and CSS asks for it by
 * name. `styles.css` still carries the literal in each `var()` fallback, so a
 * stylesheet that loads without this running still paints the intended theme
 * rather than falling back to the browser's defaults.
 */
export function applyThemeTokens(root: HTMLElement | undefined = globalThis.document?.documentElement): void {
  if (!root) return;

  for (const [name, value] of Object.entries(STRUCTURE)) {
    root.style.setProperty(`--${name.toLowerCase().replace(/_/g, '-')}`, `${value}px`);
  }

  const surfaces: Record<string, string> = {
    'surface-page': elevation.e1,
    'surface-card': elevation.e2,
    'surface-raised': elevation.e3,
    'surface-hover': elevation.e4,
  };
  for (const [name, value] of Object.entries(surfaces)) {
    root.style.setProperty(`--${name}`, value);
  }

  for (const [name, value] of Object.entries(ink)) {
    // camelCase -> kebab-case, so `onAccent` publishes as `--ink-on-accent`
    // rather than `--ink-onaccent`. The CSS side names it the kebab form, and a
    // token that is published under a name nothing reads is worse than one that
    // is never published: it looks like it works.
    const kebab = name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
    root.style.setProperty(`--ink-${kebab}`, value);
  }

  root.style.setProperty('--accent', accentNight);

  // Google Maps' elevation, as a pair of shadows. Every card-sized surface in
  // the app now uses one of these rather than the AAOS `0 2px 2px` tile shadow,
  // which on a surface this large reads as a hard outline rather than a lift.
  root.style.setProperty('--shadow-1', '0 1px 2px rgba(0,0,0,0.32), 0 1px 3px rgba(0,0,0,0.24)');
  root.style.setProperty('--shadow-2', '0 2px 6px rgba(0,0,0,0.36), 0 4px 16px rgba(0,0,0,0.28)');
  root.style.setProperty('--shadow-3', '0 6px 16px rgba(0,0,0,0.44), 0 12px 32px rgba(0,0,0,0.32)');

  /*
   * The radius scale, published under the names `styles.css` uses.
   *
   * `R` is keyed `R1..R6` because that is how the scale is written down, but the
   * CSS wants `--r-xs`/`--r-sm`/`--r-md`/`--r-lg`/`--r-xl`/`--r-pill` — names
   * that say what the radius is *for*. Publishing `Object.keys(R)` verbatim gave
   * `--r-r1`, which no stylesheet reads, so the radius scale was defined twice
   * and only one of the two definitions was live. The mapping is written out
   * here rather than derived, because it is a naming decision and not a
   * mechanical transform.
   */
  const radiusNames: Partial<Record<keyof typeof R, string>> = {
    R1: 'xs',
    R2: 'sm',
    R3: 'md',
    R4: 'lg',
    R5: 'xl',
    R6: 'pill',
  };
  // `R0` is deliberately absent: a zero radius is what an element has when nothing
  // overrides it, so publishing it would create a token that reads "no rounding"
  // and is never asked for. The scale starts at the first radius that means
  // something.
  for (const [key, alias] of Object.entries(radiusNames) as [keyof typeof R, string][]) {
    root.style.setProperty(`--r-${alias}`, `${R[key]}px`);
  }
}

/**
 * A single entry of the type scale.
 *
 * ## Why `lineHeight` is a multiplier, not a px length
 *
 * It was a `${number}px` string, and the comment above it explained why that was
 * deliberate: React copies a *number* into `line-height` verbatim, a bare number in
 * CSS is a multiplier rather than a length, and `line-height: 32` on a 24px font
 * would produce a 768px line box. Typing it as `${number}px` made the mistake a
 * compile error. That reasoning is correct and the conclusion was wrong, because it
 * only considered the mistake and not the cost.
 *
 * The cost is that **a px line-height does not scale with its font**. Android's font
 * scale multiplies text; a length stays the length it was. So at 175% a 32dp heading
 * with Google's 40dp line box has 56dp of glyphs in a 40dp line, and every line of
 * text is drawn closer together than the letters need — measured, 12px of overflow
 * on the ETA values and 12px across the five lines of a maneuver instruction, with
 * nothing in the layout to absorb it. `tools/reflow.mjs` reported those as five
 * "clipped labels", which is what the overflow looked like from outside.
 *
 * A multiplier is the same design spec and it follows the font: Google's 64/56 and
 * 40/32 are ratios, and this is how they are now written. At 100% the computed
 * line box is unchanged to within 0.002px (§14.1), and at 175% the overlap is zero.
 *
 * The px figures are kept in the table below as the source of truth, because that
 * is how the specification states them, and the ratio is derived from them rather
 * than typed twice.
 */
export type TypeToken = Omit<CSSProperties, 'lineHeight'> & {
  readonly lineHeight: number;
};

/** Google Sans at 32dp and up; Roboto below. Sizes in pt (== dp for our purposes). */
const sans = 'var(--sans)';
const roboto = 'var(--roboto)';

/**
 * One step of the scale, from the specification's own dp pair.
 *
 * @param fontSize   dp, as published
 * @param lineHeight dp, as published — Google states leading as a length, and the
 *                   ratio derived from it is what makes the leading follow the type
 */
function step(
  fontFamily: string,
  fontSize: number,
  lineHeight: number,
  letterSpacing: number,
  fontWeight?: number,
): TypeToken {
  return {
    fontFamily,
    fontSize,
    // React writes a number straight through, and CSS reads it as a multiplier. The
    // rounding to 4dp keeps 100% within 0.002px of the published leading.
    lineHeight: Math.round((lineHeight / fontSize) * 10_000) / 10_000,
    letterSpacing,
    ...(fontWeight ? { fontWeight } : {}),
  };
}

export const type = {
  display1: step(sans, 56, 64, 0),
  display2: step(sans, 44, 52, 0.1),
  display3: step(sans, 36, 44, 0.2),
  body1: step(sans, 32, 40, 0.3),
  body1m: step(sans, 32, 40, 0.3, 500),
  body2: step(roboto, 28, 36, 0.3),
  body3: step(roboto, 24, 32, 0.6),
  body3m: step(roboto, 24, 32, 0.6, 500),
  sub1: step(roboto, 22, 28, 1.1),
  sub2: step(roboto, 20, 26, 1.2),
  sub3: step(roboto, 18, 24, 1.2),
} satisfies Record<string, TypeToken>;

export type ScreenWidthClass = 'standard' | 'wide' | 'extraWide' | 'superWide';

export function widthClass(dp: number): ScreenWidthClass {
  if (dp >= 1920) return 'superWide';
  if (dp >= 1280) return 'extraWide';
  if (dp >= 930) return 'wide';
  return 'standard';
}

export function heightClass(dp: number): 'short' | 'standard' | 'tall' {
  if (dp >= 1200) return 'tall';
  if (dp >= 610) return 'standard';
  return 'short';
}

/** KL0-KL4 by screen-width category. */
export const KEYLINES: Record<ScreenWidthClass, readonly number[]> = {
  standard: [16, 24, 96, 112, 148],
  wide: [24, 32, 112, 128, 168],
  extraWide: [24, 32, 112, 128, 168],
  superWide: [32, 48, 112, 152, 168],
};

/** Side margin = 12% of app working-space width. */
export const sideMargin = (widthDp: number) => Math.round(widthDp * 0.12);

/** List item height by height category. */
export const listItemHeight = (h: number) => (h >= 1200 ? 128 : h >= 610 ? 116 : 96);

/** Google Maps navigation palette. */
export const gmaps = {
  route: '#1A73E8',
  routeCasing: '#0B4FB0',
  routeTraffic: '#E8A33D',
  routeTrafficSlow: '#E5484D',
  maneuverGreen: '#188038',
  maneuverBlue: '#1A73E8',
  destinationPin: '#EA4335',
  originDot: '#1A73E8',
  accuracyCircle: '#1A73E8',
} as const;
