/**
 * Respects the platform's font scale.
 *
 * ## The problem, precisely
 *
 * Every piece of type in this app is set inline from a `T.*` token as an absolute
 * pixel value — `style={{ fontSize: 24 }}`. The driver who raises the system font
 * size because the display is not big enough at a glance — the exact audience AAOS's
 * 24dp minimum type size exists for — must see the result of that.
 *
 * ## Why this watches *two* signals, and used to watch one
 *
 * The first version of this watched **the resolved root font size**, on the reasoning
 * that: *"On Android, the system font-size setting reaches a WebView by scaling the
 * root font size. Absolute px lengths are not affected by it."*
 *
 * **That premise is false, and it was the load-bearing one** — four passes of this
 * project nominated converting the type scale to `rem` as "the real fix" on the
 * strength of it. Chromium's own WebView documentation says the opposite, twice:
 *
 * > "Font Scale is only affected by the TextZoom setting."
 * >
 * > `setTextZoom` — "Sets the text zoom of the page in percent."
 * >  — android_webview/docs/web-page-layout.md
 *
 * So the platform multiplies **text**, whatever unit it was specified in — `px`
 * included, which is why the browser-like configuration in the same document is
 * `setLayoutAlgorithm(TEXT_AUTOSIZING)` — and it does **not** change the CSS root
 * font size. Which means:
 *
 *  - a `rem` conversion would have achieved **nothing** here. Every token is already
 *    scaled by the platform, because text is scaled and `px` is a unit of text size.
 *    §14.9 records the correction.
 *  - what was genuinely broken is **below**: this detector watched the one value the
 *    platform's mechanism does *not* change, so `data-textsize` never became `large`,
 *    so the large-text layout never applied — while the screen rendered at whatever
 *    size the driver asked for. §12.7 measured that collision and §14 fixed it;
 *    without this detector it would never have been used.
 *
 * Two independent measurements agree with the documentation: in Chromium at 892×412 a
 * probe span carrying an inline `font-size: 16px` measures 19px unscaled and 33px once
 * the text is scaled, while the root stays at 16px — the signature of a text scale and
 * not of a root enlargement. No device was available to confirm it on (§7 gap 1), which
 * is why this rests on the platform's documentation plus two browser measurements
 * rather than on a phone.
 *
 * ## Why this watches *two* signals anyway
 *
 * Because the premise above was wrong for four passes, this does not assume one
 * mechanism. A platform has more than one way to scale text, and the two leave
 * *different* evidence — which is precisely how the wrong one survived:
 *
 * | how the platform scales it | root font size | a 16px probe's rendered height |
 * |---|---|---|
 * | it enlarges the root font size | **28px** | 19px — unchanged |
 * | it scales rendered text (WebView text zoom) | 16px — unchanged | **33px** |
 *
 * Guessing wrong here is not a cosmetic failure: `data-textsize` is the only thing
 * that turns on the large-text layout, so a missed detection means the app renders at
 * 200% type with the layout it uses at 100%, which is the collision §12.7 measured.
 *
 * So this watches both and takes whichever fires. Neither signal is trusted to be
 * sufficient, and the root reading is kept even though the documentation says the
 * platform does not use it: the cost of keeping it is one comparison, and the cost of
 * having removed it would be a second four passes spent on the wrong fix.
 *
 * ## What it does with the answer
 *
 * It marks the document:
 *
 *     <html data-textsize="large">
 *
 * which `styles.css` reflows for. It is measured rather than guessed, it reacts to a
 * settings change while the app is open, and it is a single attribute — so the CSS
 * stays declarative and the thresholds are two numbers in one place.
 *
 * It is not a general text-scaling system, and it is not what makes the platform's
 * setting reach the type — the platform already does that, on `px` as much as on
 * `rem`. What it does is notice that it happened, so the layout can respond. That is
 * the whole of the fix, and it was the whole of the defect.
 */

import { useEffect } from 'react';

/**
 * The root size above which this layout stops fitting.
 *
 * 16px is the browser default and therefore "unscaled". 20px is roughly where the
 * 96px app bar can no longer hold its two text lines at their design sizes, which is
 * the first thing that breaks and the cheapest thing to measure.
 */
export const TEXT_SCALE_THRESHOLD_PX = 20;

/**
 * The rendered height above which a 16px probe means the platform has scaled text.
 *
 * 24px is derived rather than chosen. An unscaled 16px line box measures 19px in
 * Chromium at this viewport (the font's ascent plus descent) and 33px when the type is
 * scaled 1.75×, so 24px sits between them at roughly **125%** — the same boundary
 * `TEXT_SCALE_THRESHOLD_PX` expresses as 20/16. The two thresholds are deliberately
 * the same scale seen two ways, so a platform using either mechanism trips the same
 * boundary.
 *
 * The cost of being wrong here is asymmetric and small: too low and ordinary text is
 * treated as large (a layout that is merely roomier), too high and a genuinely large
 * setting is missed (the collision this exists to prevent).
 */
export const PROBE_THRESHOLD_PX = 24;

/** The probe's own nominal size, in px. Absolute, so root scaling cannot move it. */
const PROBE_FONT_PX = 16;

/** What the two measurements say about the current scale. */
export interface TextScaleReading {
  /** Resolved root font size, in px. */
  rootPx: number;
  /**
   * Rendered height of a 16px probe, in px.
   *
   * `null` when no probe could be measured — a document with no body, or an engine
   * that refuses layout — so that a missing signal is never read as an unscaled one.
   */
  probePx: number | null;
}

export type TextScaleVerdict = 'normal' | 'large';

/**
 * Decide whether the text is being scaled, from whichever signals are available.
 *
 * Pure, and exported for that reason: this is the decision the whole large-text
 * layout hangs on, and it was previously embedded in a `useEffect` where the only way
 * to test it was to render the app.
 *
 * **Either signal is sufficient.** Neither is treated as necessary, because the two
 * mechanisms are mutually blind to each other — see the table at the top of this file.
 */
export function textScaleVerdict(reading: TextScaleReading): TextScaleVerdict {
  if (reading.rootPx > TEXT_SCALE_THRESHOLD_PX) return 'large';
  if (reading.probePx !== null && reading.probePx > PROBE_THRESHOLD_PX) return 'large';
  return 'normal';
}

/**
 * A hidden span whose *rendered* height reveals the effective font size.
 *
 * The `font-size` is inline and absolute on purpose: it must not follow the root, or
 * it could not tell mechanism A from no scaling at all.
 */
function createProbe(): HTMLElement | null {
  if (typeof document === 'undefined' || !document.body) return null;
  const el = document.createElement('span');
  // Two glyphs: one with a descender, so the line box is the font's full height rather
  // than something narrower that happens to fit inside it.
  el.textContent = 'Mg';
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = [
    // Fixed at the origin rather than parked off-screen at `left:-9999px`. The
    // off-screen version is the usual trick, and it fails 39 checks in
    // `test/screens.mjs`, which rightly flags any element outside the viewport as
    // horizontal overflow — a real find by that suite and not by this one. `fixed`
    // keeps the probe out of document flow and out of the overflow region, and
    // `pointer-events: none` keeps it off anything.
    'position:fixed',
    'left:0',
    'top:0',
    // `opacity: 0` and not `visibility: hidden`. Both keep it out of sight, and both
    // are laid out, so the measurement works either way — but tools that scale text
    // tend to skip invisible elements (`tools/reflow.mjs` does, on `visibility`), and
    // a probe that a measuring tool skips is a probe that reports nothing. `opacity`
    // is also what a `visibility: hidden` element's own size would be, so nothing is
    // given up by preferring it.
    'opacity:0',
    'pointer-events:none',
    'white-space:nowrap',
    `font-size:${PROBE_FONT_PX}px`,
    'line-height:normal',
  ].join(';');
  document.body.appendChild(el);
  return el;
}

/** The resolved root font size, or the browser default when it cannot be read. */
export function rootFontSizePx(): number {
  if (typeof getComputedStyle !== 'function' || typeof document === 'undefined') return 16;
  const px = parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(px) && px > 0 ? px : 16;
}

export function useTextScale(): void {
  useEffect(() => {
    const root = document.documentElement;
    const probe = createProbe();

    const measure = (): TextScaleReading => ({
      rootPx: rootFontSizePx(),
      probePx: probe ? probe.getBoundingClientRect().height : null,
    });

    const apply = () => {
      const next = textScaleVerdict(measure());
      // Compare before writing: setting an attribute on the root invalidates
      // style for the whole document, and this runs on every resize.
      if (root.dataset.textsize === next) return;
      root.dataset.textsize = next;
    };

    apply();

    // The system font setting can change while the app is open, and a WebView
    // does not reload on it. `resize` is what a font-scale change produces in
    // every Android WebView and Chromium, and it costs one measurement.
    window.addEventListener('resize', apply);
    // Some engines fire nothing for a font-scale change; a slow poll is the
    // belt-and-braces, and it is a no-op unless the value actually moved.
    const id = setInterval(apply, 2000);
    return () => {
      window.removeEventListener('resize', apply);
      clearInterval(id);
      probe?.remove();
    };
  }, []);
}