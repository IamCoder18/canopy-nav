import type { ManeuverIcon } from '../icons';

type Kind = React.ComponentProps<typeof ManeuverIcon>['kind'];

/**
 * Valhalla maneuver type codes (TripDirections.Maneuver.Type).
 * Docs: https://valhalla.github.io/valhalla/api/turn-by-turn/api-reference
 */
const TYPE_MAP: Record<number, Kind> = {
  0: 'continue',
  1: 'start',          // kStart
  2: 'start-right',    // kStartRight
  3: 'start-left',     // kStartLeft
  4: 'destination',    // kDestination
  5: 'destination-right',
  6: 'destination-left',
  7: 'continue',       // kBecomes
  8: 'continue',       // kContinue
  9: 'slight-right',
  10: 'right',
  11: 'sharp-right',
  12: 'uturn-right',
  13: 'uturn-left',
  14: 'sharp-left',
  15: 'left',
  16: 'slight-left',
  17: 'ramp-straight',
  18: 'ramp-right',
  19: 'ramp-left',
  20: 'exit-right',
  21: 'exit-left',
  22: 'continue',      // kStayStraight
  23: 'fork-right',    // kStayRight
  24: 'fork-left',     // kStayLeft
  25: 'merge-right',   // kMerge
  26: 'roundabout-enter',
  27: 'roundabout-exit',
  28: 'ferry',         // kFerryEnter
  29: 'ferry',         // kFerryExit
  30: 'continue',      // kTransit
  36: 'merge-right',   // kMergeRight
  37: 'merge-left',    // kMergeLeft
  38: 'continue',      // kElevatorEnter
  39: 'continue',      // kElevatorExit
  40: 'continue',      // kStepsEnter
};

/** Motorway/trunk maneuvers get the green shield treatment. */
const MAJOR_TYPES = new Set([11, 12, 14, 17, 18, 19, 25, 36, 37]);

export function maneuverIcon(type: number): Kind {
  return TYPE_MAP[type] ?? 'continue';
}

export function isMajorManeuver(type: number): boolean {
  return MAJOR_TYPES.has(type);
}

export interface LegStep {
  icon: Kind;
  major: boolean;
  /** e.g. "Turn right onto Main Street" */
  title: string;
  /** e.g. "0.4 mi" */
  distanceLabel: string;
  distanceMeters: number;
  shapeIndex: number;
  /** Road shield text, e.g. "I-95" — Valhalla puts it in the `sign` object. */
  shield?: string;
  roundaboutExits?: number;
}

/** Road-shield text (e.g. "I-95"), as Valhalla returns it. */
export function shieldOf(m: { sign?: { exit_number_elements?: { text: string }[] } }): string | undefined {
  const t = m.sign?.exit_number_elements?.map((e) => e.text).join('').trim();
  return t || undefined;
}

/**
 * Valhalla's `instruction` is already a full sentence; Google Maps shows a
 * short bold action plus the road name, so derive the compact form.
 */
export function shortInstruction(instruction: string): string {
  return instruction.replace(/\s+/g, ' ').trim();
}
