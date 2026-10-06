/**
 * Android Auto / Automotive OS design tokens.
 *
 * Layout values: official "Design for Driving" layout spec
 * (8dp grid, padding P0-P8, keylines KL0-KL4, 12% side margins).
 * Colours: the AAOS grayscale palette + elevation ramp (night mode),
 * as published at docs.partner.android.com/drivingux/automotive-os/design-system/color.
 *
 * Elevation ramp (night mode):
 *   +1 #0E1013   +2 #17181B   +3 #202124
 */

import type { CSSProperties } from 'react';

/* ---------------- AAOS grayscale palette ---------------- */
export const grey = {
  black: '#000000',
  g958: '#0E1013',
  g928: '#17181B',
  g900: '#202124',
  g868: '#282A2D',
  g846: '#2E3134',
  g800: '#3C4043',
  g700: '#5F6368',
  g600: '#80868B',
  g500: '#9AA0A6',
  g400: '#BDC1C6',
  g300: '#DADCE0',
  g200: '#E8EAED',
  g100: '#F1F3F4',
  g50: '#F8F9FA',
} as const;

/** Night-mode elevation surfaces. */
export const elevation = {
  e0: grey.black,
  e1: grey.g958,
  e2: grey.g928,
  e3: grey.g900,
  e4: grey.g900, // dialogs/HUN/snackbar rest at +3..+4, mapped to g900
} as const;

/** Car accent. Day #66B5FF, night #60A8F0. */
export const accentNight = '#60A8F0';
export const accentDay = '#66B5FF';

/** White opacity ramp for text/icons/dividers (night mode). */
export const white = (pct: number) => `rgba(255,255,255,${pct})`;
export const ink = {
  primary: white(0.88),   // Headline/Title, Body 1
  secondary: white(0.6),  // Body copy, option labels
  tertiary: white(0.5),   // inactive icons
  divider: white(0.12),
  track: white(0.12),
  outline: white(0.2),
  scrim84: 'rgba(0,0,0,0.84)',
  scrim70: 'rgba(0,0,0,0.7)',
} as const;

/** Padding scale P0-P8. */
export const DP = { P0: 4, P1: 8, P2: 12, P3: 16, P4: 24, P5: 32, P6: 48, P7: 64, P8: 96 } as const;

/** Corner radius scale R0-R4. */
export const R = { R0: 0, R1: 4, R2: 8, R3: 16, R4: 9999 } as const;

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
 * Publish the structural tokens as CSS custom properties.
 *
 * Called once at startup. This is the seam that lets `styles.css` consume the
 * tokens without a build-time CSS-in-JS dependency: TypeScript owns the values,
 * CSS reads them, and `styles.css` falls back to the literal so a stylesheet
 * loaded without this running still lays out correctly.
 */
export function applyThemeTokens(root: HTMLElement | undefined = globalThis.document?.documentElement): void {
  if (!root) return;
  for (const [name, value] of Object.entries(STRUCTURE)) {
    root.style.setProperty(`--${name.toLowerCase().replace(/_/g, '-')}`, `${value}px`);
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
