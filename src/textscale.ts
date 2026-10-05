/**
 * Respects the platform's font scale.
 *
 * ## The problem, precisely
 *
 * Every piece of type in this app is set inline from a `T.*` token as an absolute
 * pixel value — `style={{ fontSize: '24px' }}`. On Android, the system font-size
 * setting reaches a WebView by scaling the *root* font size. Absolute `px`
 * lengths are not affected by it.
 *
 * So the setting a driver uses because the display is not big enough at a glance
 * — the exact audience AAOS's 24dp minimum type size exists for — does nothing at
 * all in this app.
 *
 * And when the text is scaled by other means (browser zoom, a per-element
 * override, a future `rem` migration), the navigation screen cannot cope: it is
 * entirely `position: absolute` over a fixed-size app, so the banner grows
 * *underneath* the bottom bar and the ETA bar's text spills out of its own 96px.
 * Measured at 200% on an 892x412 landscape phone, `tools/reflow.mjs` found the
 * banner stack intersecting the bottom bar by 560x20px, and every one of the
 * seven chrome labels clipped. The instruction — the only thing on the screen —
 * was unreadable, with no way to scroll any of it into view.
 *
 * ## What this does
 *
 * It watches the resolved root font size and marks the document when the platform
 * has scaled it beyond what this layout was built for:
 *
 *     <html data-textsize="large">
 *
 * which `styles.css` reflows for. It is measured rather than guessed, it reacts
 * to a settings change while the app is open, and it is a single attribute — so
 * the CSS stays declarative and the threshold is one number in one place.
 *
 * It is not a general text-scaling system. It is the app acknowledging that a
 * setting exists which it currently ignores, and stopping lying about the result.
 * Converting the type scale to `rem` is the real fix and is a larger change; §11.9
 * records it.
 */

import { useEffect } from 'react';

/**
 * The root size above which this layout stops fitting.
 *
 * 16px is the browser default and therefore "unscaled". 20px is roughly where the
 * 96px app bar can no longer hold its two text lines at their design sizes, which
 * is the first thing that breaks and the cheapest thing to measure.
 */
export const TEXT_SCALE_THRESHOLD_PX = 20;

const rootSizePx = () => {
  if (typeof getComputedStyle !== 'function' || typeof document === 'undefined') return 16;
  const px = parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(px) && px > 0 ? px : 16;
};

export function useTextScale(): void {
  useEffect(() => {
    const root = document.documentElement;

    const apply = () => {
      const large = rootSizePx() > TEXT_SCALE_THRESHOLD_PX;
      const next = large ? 'large' : 'normal';
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
    };
  }, []);
}