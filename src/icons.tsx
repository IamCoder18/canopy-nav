import React from 'react';

interface P {
  size?: number;
  /**
   * Defaults to `currentColor` so an icon always inherits its container's
   * colour. Never hardcode a default here: a light button with a white icon
   * renders as an invisible glyph.
   */
  color?: string;
  className?: string;
}

/**
 * Every icon here is decorative.
 *
 * Each one in this app sits beside a text label or inside a control that already
 * carries an `aria-label`, so a screen reader announcing the SVG adds a second,
 * unnamed "graphic" to every button it walks past. `aria-hidden` plus
 * `focusable="false"` removes it — the second half matters in IE and in older
 * Android WebViews, where an `<svg>` is still in the tab order.
 *
 * `className` was also declared on `P` but only `ManeuverIcon` ever destructured
 * it; the rest silently dropped anything passed. Threading it through `s()` is
 * cheaper than deleting it, because a caller that wants to size or animate an
 * icon should not have to reach for `style`.
 */
const s = (size = 24, className?: string) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  className,
  'aria-hidden': true as const,
  focusable: 'false' as const,
  style: { display: 'block', flexShrink: 0 } as React.CSSProperties,
});

/* ------------------------------------------------------------------ */
/* Maneuver arrows — redrawn to match Google Maps' iconography.        */
/* Drawn on a 24x24 grid, stroke-width 2, round caps/joins.            */
/* ------------------------------------------------------------------ */

type Maneuver =
  | 'start' | 'start-left' | 'start-right' | 'destination' | 'destination-left' | 'destination-right'
  | 'continue' | 'slight-left' | 'left' | 'sharp-left' | 'uturn-left'
  | 'slight-right' | 'right' | 'sharp-right' | 'uturn-right'
  | 'ramp-straight' | 'ramp-left' | 'ramp-right'
  | 'exit-left' | 'exit-right' | 'fork-left' | 'fork-right'
  | 'roundabout-enter' | 'roundabout-exit' | 'merge' | 'merge-left' | 'merge-right'
  | 'ferry' | 'arrive';

const STROKE = { fill: 'none', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

export function ManeuverIcon({ kind, size = 24, color: c = 'currentColor', className }: P & { kind: Maneuver }) {
  const p = { ...s(size), className };
  const stroke = { stroke: c, ...STROKE };

  switch (kind) {
    case 'start':
    case 'continue':
      return (
        <svg {...p}>
          <path d="M12 21 V4" {...stroke} />
          <path d="M6.5 9.5 L12 4 L17.5 9.5" {...stroke} />
        </svg>
      );
    case 'slight-left':
      return (
        <svg {...p}>
          <path d="M12 21 V14 q0 -5 5 -5 h3" {...stroke} />
          <path d="M17 5.5 L20.5 9 L17 12.5" {...stroke} />
        </svg>
      );
    case 'slight-right':
      return (
        <svg {...p}>
          <path d="M12 21 V14 q0 -5 -5 -5 h-3" {...stroke} />
          <path d="M7 5.5 L3.5 9 L7 12.5" {...stroke} />
        </svg>
      );
    case 'left':
      return (
        <svg {...p}>
          <path d="M18 21 V11 a3 3 0 0 0 -3 -3 H6" {...stroke} />
          <path d="M10 3.5 L5 8 L10 12.5" {...stroke} />
        </svg>
      );
    case 'right':
      return (
        <svg {...p}>
          <path d="M6 21 V11 a3 3 0 0 1 3 -3 h9" {...stroke} />
          <path d="M14 3.5 L19 8 L14 12.5" {...stroke} />
        </svg>
      );
    case 'sharp-left':
      return (
        <svg {...p}>
          <path d="M19 21 V7 L7 19" {...stroke} />
          <path d="M11 15.5 L7 19 L11 22.5" {...stroke} />
        </svg>
      );
    case 'sharp-right':
      return (
        <svg {...p}>
          <path d="M5 21 V7 L17 19" {...stroke} />
          <path d="M13 15.5 L17 19 L13 22.5" {...stroke} />
        </svg>
      );
    case 'uturn-left':
      return (
        <svg {...p}>
          <path d="M17 22 V11 a5 5 0 0 0 -10 0" {...stroke} />
          <path d="M3 11 L7 6.5 L11 11" {...stroke} />
        </svg>
      );
    case 'uturn-right':
      return (
        <svg {...p}>
          <path d="M7 22 V11 a5 5 0 0 1 10 0" {...stroke} />
          <path d="M21 11 L17 6.5 L13 11" {...stroke} />
        </svg>
      );
    case 'start-left':
      return (
        <svg {...p}>
          <path d="M12 22 V12 a4 4 0 0 0 -4 -4 H6" {...stroke} />
          <path d="M9 4.5 L5 8 L9 11.5" {...stroke} />
        </svg>
      );
    case 'start-right':
      return (
        <svg {...p}>
          <path d="M12 22 V12 a4 4 0 0 1 4 -4 h2" {...stroke} />
          <path d="M15 4.5 L19 8 L15 11.5" {...stroke} />
        </svg>
      );
    case 'ramp-left':
      return (
        <svg {...p}>
          <path d="M20 22 V13 a4 4 0 0 0 -4 -4 H5" {...stroke} />
          <path d="M9 5.5 L4 9 L9 12.5" {...stroke} />
        </svg>
      );
    case 'ramp-right':
      return (
        <svg {...p}>
          <path d="M4 22 V13 a4 4 0 0 1 4 -4 h11" {...stroke} />
          <path d="M15 5.5 L20 9 L15 12.5" {...stroke} />
        </svg>
      );
    case 'ramp-straight':
      return (
        <svg {...p}>
          <path d="M12 22 V14 a4 4 0 0 1 4 -4 h4" {...stroke} />
          <path d="M17 6.5 L20 10 L17 13.5" {...stroke} />
        </svg>
      );
    case 'fork-left':
      return (
        <svg {...p}>
          <path d="M12 22 V13" {...stroke} />
          <path d="M12 13 A5 5 0 0 0 7 8" {...stroke} />
          <path d="M8 4 L4 8 L8 12" {...stroke} />
        </svg>
      );
    case 'fork-right':
      return (
        <svg {...p}>
          <path d="M12 22 V13" {...stroke} />
          <path d="M12 13 A5 5 0 0 1 17 8" {...stroke} />
          <path d="M16 4 L20 8 L16 12" {...stroke} />
        </svg>
      );
    case 'exit-right':
      return (
        <svg {...p}>
          <path d="M4 22 V12 a3 3 0 0 1 3 -3 h4" {...stroke} />
          <path d="M11 4.5 L15.5 9 L11 13.5" {...stroke} />
          <path d="M15 20 H21" {...stroke} />
        </svg>
      );
    case 'exit-left':
      return (
        <svg {...p}>
          <path d="M20 22 V12 a3 3 0 0 0 -3 -3 h-4" {...stroke} />
          <path d="M13 4.5 L8.5 9 L13 13.5" {...stroke} />
          <path d="M9 20 H3" {...stroke} />
        </svg>
      );
    case 'merge':
    case 'merge-right':
      return (
        <svg {...p}>
          <path d="M7 22 V9" {...stroke} />
          <path d="M7 14 C7 11 9 10 12 9 L19 6" {...stroke} />
          <path d="M16 3 L20.5 6 L16 9" {...stroke} />
        </svg>
      );
    case 'merge-left':
      return (
        <svg {...p}>
          <path d="M17 22 V9" {...stroke} />
          <path d="M17 14 C17 11 15 10 12 9 L5 6" {...stroke} />
          <path d="M8 3 L3.5 6 L8 9" {...stroke} />
        </svg>
      );
    case 'roundabout-enter':
      return (
        <svg {...p}>
          <path d="M6 22 V8" {...stroke} />
          <path d="M6 8 h12 a4 4 0 1 1 -4 4" {...stroke} />
          <path d="M14 12 L14 16" {...stroke} />
        </svg>
      );
    case 'roundabout-exit':
      return (
        <svg {...p}>
          <path d="M6 22 V9 a4 4 0 0 1 8 0" {...stroke} />
          <path d="M14 9 h4 a4 4 0 1 1 -4 4" {...stroke} />
        </svg>
      );
    case 'ferry':
      return (
        <svg {...p}>
          <path d="M3 15 L12 9 L21 15 Z" {...stroke} />
          <path d="M5 18 h14" {...stroke} />
          <path d="M12 9 V4" {...stroke} />
        </svg>
      );
    // Arrival with a side of travel. These were declared in the union but had no
    // case, so they fell through to `default` and silently rendered as a plain
    // arrival pin -- Valhalla emits these types (5 and 6) for arrivals from the
    // left or right.
    case 'destination-left':
    case 'destination-right': {
      const fromLeft = kind === 'destination-left';
      const armY = 12;
      const tipX = fromLeft ? 19 : 5;
      return (
        <svg {...p}>
          <path
            d={`M${fromLeft ? 5 : 19} 4 V${armY} H9`}
            {...stroke}
          />
          <path
            d={`M9 ${armY - 5} L${tipX} ${armY} L9 ${armY + 5}`}
            {...stroke}
          />
        </svg>
      );
    }

    case 'destination':
    case 'arrive':
    default:
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="7" {...stroke} />
          <circle cx="12" cy="12" r="2.5" fill={c} />
        </svg>
      );
  }
}

export type ManeuverKindForTest = Maneuver;

/* ------------------------------------------------------------------ */
/* System icons                                                        */
/* ------------------------------------------------------------------ */

/** Stroke style shared by every system icon. */
const ic = (c: string) => ({ stroke: c, ...STROKE });

export const IconSearch = ({ size = 24, color: c = 'currentColor', className }: P) => (
  <svg {...s(size, className)}><circle cx="11" cy="11" r="6.5" {...ic(c)} /><path d="M15.8 15.8 L21 21" {...ic(c)} /></svg>
);
export const IconBack = ({ size = 24, color: c = 'currentColor', className }: P) => (
  <svg {...s(size, className)}><path d="M15 4 L7 12 L15 20" {...ic(c)} /></svg>
);
export const IconClose = ({ size = 24, color: c = 'currentColor', className }: P) => (
  <svg {...s(size, className)}><path d="M6 6 L18 18 M18 6 L6 18" {...ic(c)} /></svg>
);
export const IconMute = ({ size = 24, color: c = 'currentColor', className }: P) => (
  <svg {...s(size, className)}>
    <path d="M11 5 L6.5 9 H3 v6 h3.5 L11 19 Z" {...ic(c)} />
    <path d="M15.5 9.5 L20 14 M20 9.5 L15.5 14" {...ic(c)} />
  </svg>
);
export const IconSound = ({ size = 24, color: c = 'currentColor', className }: P) => (
  <svg {...s(size, className)}>
    <path d="M11 5 L6.5 9 H3 v6 h3.5 L11 19 Z" {...ic(c)} />
    <path d="M15 9 a4.5 4.5 0 0 1 0 6" {...ic(c)} />
  </svg>
);
export const IconOverview = ({ size = 24, color: c = 'currentColor', className }: P) => (
  <svg {...s(size, className)}>
    <path d="M9 4 L3.5 12 L9 20 Z" {...ic(c)} />
    <path d="M15 4 L20.5 12 L15 20 Z" {...ic(c)} />
  </svg>
);
export const IconLayers = ({ size = 24, color: c = 'currentColor', className }: P) => (
  <svg {...s(size, className)}>
    <path d="M12 3 L21 8 L12 13 L3 8 Z" {...ic(c)} />
    <path d="M3 13 L12 18 L21 13" {...ic(c)} />
  </svg>
);
export const IconTraffic = ({ size = 24, color: c = 'currentColor', className }: P) => (
  <svg {...s(size, className)}>
    <rect x="9" y="3" width="6" height="18" rx="2.5" {...ic(c)} />
    <circle cx="12" cy="7" r="1.4" fill={c} /><circle cx="12" cy="12" r="1.4" fill={c} /><circle cx="12" cy="17" r="1.4" fill={c} />
  </svg>
);
export const IconCompass = ({ size = 24, color: c = 'currentColor', className }: P) => (
  <svg {...s(size, className)}><circle cx="12" cy="12" r="8.5" {...ic(c)} /><path d="M15 9 L10.5 14.5 L9 9 Z" fill={c} /></svg>
);
export const IconSettings = ({ size = 24, color: c = 'currentColor', className }: P) => (
  <svg {...s(size, className)}>
    <circle cx="12" cy="12" r="3" {...ic(c)} />
    <path d="M12 2v3 M12 19v3 M2 12h3 M19 12h3 M4.9 4.9l2.1 2.1 M17 17l2.1 2.1 M19.1 4.9L17 7 M7 17l-2.1 2.1" {...ic(c)} />
  </svg>
);
export const IconHome = ({ size = 24, color: c = 'currentColor', className }: P) => (
  <svg {...s(size, className)}><path d="M4 11 L12 4 L20 11" {...ic(c)} /><path d="M6.5 10 v10 h11 v-10" {...ic(c)} /></svg>
);
export const IconCar = ({ size = 24, color: c = 'currentColor', className }: P) => (
  <svg {...s(size, className)}>
    <path d="M4 15 l1.6 -5 a2 2 0 0 1 1.9 -1.4 h9 a2 2 0 0 1 1.9 1.4 L20 15" {...ic(c)} />
    <rect x="3" y="15" width="18" height="4.5" rx="1.6" {...ic(c)} />
  </svg>
);
export const IconGoto = ({ size = 24, color: c = 'currentColor', className }: P) => (
  <svg {...s(size, className)}><path d="M21 3 L3 10.5 l7 3 3 7 Z" {...ic(c)} /></svg>
);
export const IconPlus = ({ size = 24, color: c = 'currentColor', className }: P) => (
  <svg {...s(size, className)}><path d="M12 5v14 M5 12h14" {...ic(c)} /></svg>
);
export const IconMinus = ({ size = 24, color: c = 'currentColor', className }: P) => (
  <svg {...s(size, className)}><path d="M5 12h14" {...ic(c)} /></svg>
);
export const IconLocate = ({ size = 24, color: c = 'currentColor', className }: P) => (
  <svg {...s(size, className)}><circle cx="12" cy="12" r="3.2" fill={c} /><circle cx="12" cy="12" r="7" {...ic(c)} /></svg>
);
export const IconChevronRight = ({ size = 24, color: c = 'currentColor', className }: P) => (
  <svg {...s(size, className)}><path d="M9 5 l7 7 -7 7" {...ic(c)} /></svg>
);
export const IconPhone = ({ size = 24, color: c = 'currentColor', className }: P) => (
  <svg {...s(size, className)}>
    <path d="M7 3 h3 l1.5 4 -2 1.5 a11 11 0 0 0 6 6 L17 12.5 21 14 v3 a2 2 0 0 1 -2.2 2 A16.5 16.5 0 0 1 3.9 5.2 2 2 0 0 1 5.9 3 Z" {...ic(c)} />
  </svg>
);
export const IconMessage = ({ size = 24, color: c = 'currentColor', className }: P) => (
  <svg {...s(size, className)}><path d="M4 5 h16 v11 h-9 l-5 4 v-4 H4 Z" {...ic(c)} /></svg>
);
export const IconMusic = ({ size = 24, color: c = 'currentColor', className }: P) => (
  <svg {...s(size, className)}><path d="M9 18 V6 l11 -2 v12" {...ic(c)} /><circle cx="6.5" cy="18" r="2.5" {...ic(c)} /><circle cx="17.5" cy="16" r="2.5" {...ic(c)} /></svg>
);
export const IconFile = ({ size = 24, color: c = 'currentColor', className }: P) => (
  <svg {...s(size, className)}><path d="M6 3 h7 l5 5 v13 H6 Z" {...ic(c)} /><path d="M13 3 v5 h5" {...ic(c)} /></svg>
);
export const IconRefresh = ({ size = 24, color: c = 'currentColor', className }: P) => (
  <svg {...s(size, className)}><path d="M20 12a8 8 0 1 1 -2.4 -5.7" {...ic(c)} /><path d="M20 4v5h-5" {...ic(c)} /></svg>
);


/**
 * A circled "i".
 *
 * Used to mark a message worth reading that is not a failure. The distinction
 * matters in this app specifically: one shared red card teaches people to
 * ignore the card that means *your map is gone*, so warnings get their own
 * surface, their own glyph and their own `role`.
 */
export const IconInfo = ({ size = 24, color: c = 'currentColor', className }: P) => (
  <svg {...s(size, className)}>
    <circle cx="12" cy="12" r="9" {...ic(c)} />
    <path d="M12 11v5.5" {...ic(c)} />
    <circle cx="12" cy="7.6" r="1.1" fill={c} stroke="none" />
  </svg>
);

/** A triangle with an exclamation — for a warning that is not merely advice. */
export const IconWarning = ({ size = 24, color: c = 'currentColor', className }: P) => (
  <svg {...s(size, className)}>
    <path d="M12 3.6 L22 20.4 H2 Z" {...ic(c)} />
    <path d="M12 9.5v5" {...ic(c)} />
    <circle cx="12" cy="17.4" r="1.1" fill={c} stroke="none" />
  </svg>
);

/** A tick, for a completed step. */
export const IconCheck = ({ size = 24, color: c = 'currentColor', className }: P) => (
  <svg {...s(size, className)}><path d="M4.5 12.5 l5 5 10 -11" {...ic(c)} /></svg>
);

/** A clock face, for an arrival time. */
export const IconClock = ({ size = 24, color: c = 'currentColor', className }: P) => (
  <svg {...s(size, className)}>
    <circle cx="12" cy="12" r="9" {...ic(c)} />
    <path d="M12 6.6V12l3.6 2.2" {...ic(c)} />
  </svg>
);

/** A trash can, for a destructive action that has to be named. */
export const IconTrash = ({ size = 24, color: c = 'currentColor', className }: P) => (
  <svg {...s(size, className)}>
    <path d="M4.5 6.5h15 M9.5 6.5V4.5h5v2 M6.5 6.5 L7.6 20h8.8 L17.5 6.5" {...ic(c)} />
  </svg>
);

/** A map pin outline, for a destination row. */
export const IconPin = ({ size = 24, color: c = 'currentColor', className }: P) => (
  <svg {...s(size, className)}>
    <path d="M12 21.5s7-6.4 7-11a7 7 0 1 0-14 0c0 4.6 7 11 7 11Z" {...ic(c)} />
    <circle cx="12" cy="10.2" r="2.6" {...ic(c)} />
  </svg>
);

/** A filled dot, for a status indicator that carries meaning in its colour. */
export const IconDot = ({ size = 24, color: c = 'currentColor', className }: P) => (
  <svg {...s(size, className)}><circle cx="12" cy="12" r="5" fill={c} stroke="none" /></svg>
);
