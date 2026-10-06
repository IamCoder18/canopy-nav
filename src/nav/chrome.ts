/**
 * Where the chrome between the two bars ends and begins.
 *
 * ## The problem this exists to solve
 *
 * The navigation screen stacks four absolutely positioned things: the ETA bar at
 * the top, the bottom bar at the bottom, the maneuver banner between them, and the
 * off-route notice under that. Two of those positions were *constants written in
 * CSS* rather than measurements:
 *
 * ```css
 * .banner-stack { top:  calc(var(--app-bar, 96px) + var(--inset-top) + 24px);
 *                  bottom: calc(var(--navbot, 128px) + var(--inset-bottom)); }
 * ```
 *
 * which is only correct while the bars really are 96px and 128px tall. Change the
 * type scale, or wrap a label onto a second line, and both bounds are wrong at once:
 * the banner is drawn *underneath* the ETA bar, or *over* the bottom bar, and
 * nothing in the CSS says so. §12.7 and §13.8 chased the symptoms of exactly this,
 * and §13.9 concluded that the honest fix is to stop deriving positions from
 * constants.
 *
 * ## The fix, and its limits
 *
 * `--eta-h` and `--nav-h` carry the bars' *measured* heights, so a bar that grows
 * pushes the banner out of its way instead of being overlapped by it. `ResizeObserver`
 * is the mechanism, because the thing being tracked is content: the ETA bar's height
 * is a function of how many lines its numbers wrap to, which nothing in CSS can
 * predict.
 *
 * Two properties are written to the document root rather than to an element, so that
 * `.banner-stack` can read them wherever it is. They are **not** written over the
 * design tokens (`--app-bar`, `--navbot`): those say how tall a bar should be, these
 * say how tall it is, and collapsing the two would make each bar's height feed back
 * into its own input.
 *
 * Where a measurement is unavailable — no `ResizeObserver`, no layout, server
 * rendering — nothing is written and the CSS falls back to the design tokens, which
 * is the same behaviour as before this existed.
 *
 * Rounding is to whole pixels. Sub-pixel churn would push a custom property onto
 * every element that inherits it on every frame of a zoom gesture, and the gain is
 * invisible.
 */

/** Bars whose height is published, and the property each one is published as. */
const BARS = [
  { selector: '.eta-bar', property: '--eta-h' },
  { selector: '.nav-bottom', property: '--nav-h' },
] as const;

export interface ChromeHeights {
  /** Stop observing and remove every property written. */
  stop(): void;
}

/**
 * Publish the measured heights of the navigation screen's two bars.
 *
 * Writes nothing until both elements exist and have been laid out, so the first
 * paint uses the design tokens and is corrected on the observer's first callback —
 * which arrives before the next paint.
 *
 * `ResizeObserver` is read off `globalThis` rather than imported, so a test can
 * substitute one and drive the callbacks synchronously. Where it is missing, this
 * measures once and does not track, and says so rather than pretending.
 *
 * @param root the element the properties are written to; `documentElement` by
 *             default, so absolutely positioned descendants inherit them
 */
export function observeChromeHeights(
  root: HTMLElement | undefined = globalThis.document?.documentElement,
): ChromeHeights {
  if (!root) return { stop() {} };

  const written: string[] = [];
  const write = () => {
    for (const { selector, property } of BARS) {
      const el = root.querySelector(selector);
      if (!el) continue;
      const h = Math.round(el.getBoundingClientRect().height);
      // A hidden or not-yet-laid-out bar measures 0. Publishing that would collapse
      // the banner's bounds to nothing, so the previous value is kept instead.
      if (h <= 0) continue;
      if (root.style.getPropertyValue(property) !== `${h}px`) {
        root.style.setProperty(property, `${h}px`);
        if (!written.includes(property)) written.push(property);
      }
    }
  };

  const Ctor = globalThis.ResizeObserver;
  if (!Ctor) {
    write();
    return { stop() {} };
  }

  const ro = new Ctor(() => write());
  for (const { selector } of BARS) {
    const el = root.querySelector(selector);
    if (el) ro.observe(el);
  }
  write();

  return {
    stop() {
      ro.disconnect();
      for (const property of written) {
        try {
          root.style.removeProperty(property);
        } catch {
          // A detached element throws on `style` access in some engines, and there
          // is nothing to clean up if the document is going away.
        }
      }
    },
  };
}