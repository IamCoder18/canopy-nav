/**
 * The offline turn-by-turn inference, and a trace of how it decided.
 *
 * ## Why this exists
 *
 * §3.11 made offline guidance work by inferring turns from bearing changes, because the
 * offline engine supplies no maneuvers at all — and it is the default engine, so for most
 * drivers this is the whole of their guidance. §7 gap 6 then measured it: three of seven
 * real maneuvers missed, one invented, one direction reversed.
 *
 * **It has been wrong for four passes and there has been no way to look at it.** "The turn
 * was wrong" has been an argument rather than a diff, because the inference was a loop
 * inside a `useMemo` in `App.tsx` and the only record of its reasoning was the steps it
 * chose to keep. A turn that was *not* produced left nothing at all — which is precisely the
 * interesting case. You cannot see a miss.
 *
 * So this returns the misses too.
 *
 * ## What the trace is for
 *
 * Each entry is one window the inference looked at, with the two bearings, the signed turn,
 * the kind it chose (or `null`), and — when `null` — **why**. A reviewer asking "why did it
 * miss the roundabout" gets an answer instead of a reimplementation.
 *
 * That matters more than the extra code suggests: a *missing* turn and a *spurious* turn
 * look identical in the output and are opposite defects, and only the trace distinguishes
 * them.
 *
 * ## The thresholds, unchanged
 *
 * `STEP_EVERY` and `TURN_THRESHOLD_DEG` are the numbers §3.11 chose and §7 gap 6 measured
 * against. They are named, exported and pinned by `test/guidance.spec.ts` rather than being
 * literals in a loop, because "the constant moved" is otherwise indistinguishable from "the
 * behaviour regressed" — and a change to either is a deliberate act that should be reviewed
 * as one.
 */

import { lineLength, formatDistance, type LatLng } from '../geo';
import type { LegStep } from './maneuver';

/**
 * How many vertices the inference looks at on each side of a candidate turn.
 *
 * Eight, and the window is `2 * 8 + 1` points wide. A route with fewer than
 * `2 * STEP_EVERY + 1` points has no window at all — see `TOO_SPARSE`.
 */
export const STEP_EVERY = 8;

/** The fewest geometry points the inference needs before it can look at anything. */
export const TOO_SPARSE = 2 * STEP_EVERY + 1;

/** Below this the window is straight. §3.11's value, measured as part of §7 gap 6. */
export const STRAIGHT_DEG = 18;

/** From here the bend is a `slight-`, then a plain turn at 45°. */
export const SLIGHT_DEG = 45;

/** Past here it is sharp, and past 150° a U-turn. */
export const SHARP_DEG = 115;
export const UTURN_DEG = 150;

/**
 * Bearing in degrees from north, from `a` to `b`.
 *
 * Moved here rather than imported: it is one of the two inputs to every decision below, and
 * leaving it in `App.tsx` would mean the inference could not be run, tested or traced outside
 * a React render — which is the whole reason this module exists.
 */
export function bearingBetween(a: LatLng, b: LatLng): number {
  const toRad = Math.PI / 180;
  const lon1 = a[0] * toRad, lat1 = a[1] * toRad;
  const lon2 = b[0] * toRad, lat2 = b[1] * toRad;
  const y = Math.sin(lon2 - lon1) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/**
 * The kind of maneuver a signed turn is, or `null` if it is not one.
 *
 * Kept exactly as `App.tsx` had it — same thresholds, same order — because this is a
 * refactor plus a trace, not a fix. §7 gap 6 says the thresholds are wrong for real
 * maneuvers, and changing them here would conflate "made the reasoning visible" with "made
 * the reasoning correct", so the fix stays a separate, reviewable act.
 */
export function turnKind(delta: number): LegStep['icon'] | null {
  const d = Math.abs(delta);
  if (d < STRAIGHT_DEG) return null;
  if (d < SLIGHT_DEG) return delta > 0 ? 'slight-right' : 'slight-left';
  if (d < SHARP_DEG) return delta > 0 ? 'right' : 'left';
  if (d < UTURN_DEG) return delta > 0 ? 'sharp-right' : 'sharp-left';
  return delta > 0 ? 'uturn-right' : 'uturn-left';
}

/**
 * One window the inference looked at.
 *
 * `kind` is `null` for a window that produced no step, and `reason` then says why — which is
 * the whole point of the type.
 */
export interface GuidanceTraceEntry {
  /** Index of the centre vertex of the window. */
  index: number;
  /** Bearing in degrees from north, into the window. */
  inBearing: number;
  /** Bearing out of it. */
  outBearing: number;
  /** `outBearing - inBearing`, wrapped to ±180. */
  turn: number;
  /** The kind chosen, or `null` when the window produced nothing. */
  kind: string | null;
  /** Why, when `kind` is `null`. Absent when a step was produced. */
  reason?: string;
  /** Length of the leg the window covers, in metres. Always present. */
  legMetres: number;
}

export interface GuidanceInference {
  /** The steps, in route order. */
  steps: LegStep[];
  /** Every window considered, in order — including the ones that produced nothing. */
  trace: GuidanceTraceEntry[];
  /** True when the route had too few points for any window to exist. */
  tooSparse: boolean;
}

/** Wrap a bearing difference to ±180, so 350° reads as −10° rather than 350°. */
export function signedTurn(inBearing: number, outBearing: number): number {
  let turn = outBearing - inBearing;
  while (turn > 180) turn -= 360;
  while (turn < -180) turn += 360;
  return turn;
}

export interface InferOptions {
  /** `'metric' | 'imperial'`, for the distance labels. */
  units?: 'metric' | 'imperial';
}

/**
 * Run the inference over a route geometry.
 *
 * Pure, and therefore the thing a bug report can be reduced to: give it a geometry and it
 * gives the same steps every time. That is what makes §7 gap 6 answerable — a reported miss
 * becomes a geometry plus an index, not a car ride.
 */
export function inferSteps(
  geometry: LatLng[],
  opts: InferOptions = {},
): GuidanceInference {
  const units = opts.units ?? 'metric';
  const trace: GuidanceTraceEntry[] = [];

  if (geometry.length < TOO_SPARSE) {
    return {
      steps: [],
      trace,
      // Distinguishing "too short to look" from "looked and found nothing" is the whole
      // reason `tooSparse` exists, and it is what the Steps screen's copy turns on.
      tooSparse: true,
    };
  }

  const steps: LegStep[] = [];
  for (let i = STEP_EVERY; i < geometry.length - STEP_EVERY; i += STEP_EVERY) {
    const inBearing = bearingBetween(geometry[i - STEP_EVERY]!, geometry[i]!);
    const outBearing = bearingBetween(geometry[i]!, geometry[i + STEP_EVERY]!);
    const turn = signedTurn(inBearing, outBearing);
    const kind = turnKind(turn);
    const legM = lineLength(geometry.slice(i, i + STEP_EVERY + 1));

    if (!kind) {
      trace.push({
        index: i, inBearing, outBearing, turn, kind: null, legMetres: legM,
        // Stated rather than left to the reader, because "no turn" is the outcome §7 gap 6
        // is about and it deserves to be visible in the same words every time. `nextKind`
        // is included so a near miss reads as one: "18.4°, just under slight-left's 45°"
        // says what to change, where "too small" says nothing.
        reason: `turn ${turn.toFixed(1)}° is under the ${STRAIGHT_DEG}° straight threshold`
          + `; the next kind up starts at ${SLIGHT_DEG}°`,
      });
      continue;
    }

    steps.push({
      icon: kind as LegStep['icon'],
      major: Math.abs(turn) > 120,
      title: `${kind.replace('-', ' ')} onto unnamed road`,
      distanceLabel: formatDistance(legM, units),
      distanceMeters: legM,
      shapeIndex: i,
    });
    trace.push({ index: i, inBearing, outBearing, turn, kind, legMetres: legM });
  }

  return { steps, trace, tooSparse: false };
}

/**
 * A one-line summary of a trace, for a panel or a bug report.
 *
 * The counts, because they are the question a reviewer asks first — and because a trace
 * with 40 windows and 2 steps is itself the answer to "why did it miss three turns".
 */
export function summariseTrace(trace: GuidanceTraceEntry[]): string {
  const kept = trace.filter((e) => e.kind !== null).length;
  return `${kept} step${kept === 1 ? '' : 's'} from ${trace.length} window`
    + `${trace.length === 1 ? '' : 's'}`;
}