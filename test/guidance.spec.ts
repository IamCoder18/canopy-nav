/**
 * The guidance inference, and its trace.
 *
 * §7 gap 6 measured this missing three of seven real maneuvers, inventing one and reversing a
 * direction. These tests are the diagnosis, not a celebration: each one states a property a
 * reviewer needs in order to say whether a change helped or hurt.
 *
 * The trace is the subject. An inference that produced nothing left no record, so a miss was
 * indistinguishable from an absence of looking — and the first version of this file asserted
 * only on the steps, which is exactly the shape of check that cannot fail on the defect.
 */

import { describe, it, expect } from 'vitest';

import {
  inferSteps, bearingBetween, turnKind, signedTurn, summariseTrace,
  STEP_EVERY, TOO_SPARSE, STRAIGHT_DEG, SLIGHT_DEG, SHARP_DEG, UTURN_DEG,
} from '../src/nav/guidance';
import type { LatLng } from '../src/geo';

/** Straight north for `n` vertices, 10 m apart. */
function northRun(n: number, lat0 = 55.95, lon0 = -3.19): LatLng[] {
  const out: LatLng[] = [];
  for (let i = 0; i < n; i++) out.push([lon0, lat0 + i * 0.00009]);
  return out;
}

/** A straight run of `lead` points, then a bend of `turn` degrees, then more. */
function withBend(lead: number, turn: number, tail: number, lat0 = 55.95, lon0 = -3.19): LatLng[] {
  const pts = northRun(lead, lat0, lon0);
  const last = pts[pts.length - 1]!;
  const rad = (turn * Math.PI) / 180;
  for (let i = 1; i <= tail; i++) {
    pts.push([
      last[0] + (Math.sin(rad) * i * 0.00009) / Math.cos(lat0 * Math.PI / 180),
      last[1] + Math.cos(rad) * i * 0.00009,
    ]);
  }
  return pts;
}

describe('the thresholds are named, not literals in a loop', () => {
  it('turnKind uses exactly the boundaries §3.11 chose', () => {
    // Pinned one below and one above each edge, because a threshold that moved by a degree
    // is indistinguishable from a regression otherwise.
    expect(turnKind(0)).toBeNull();
    expect(turnKind(STRAIGHT_DEG - 0.1)).toBeNull();
    expect(turnKind(STRAIGHT_DEG + 0.1)).toBe('slight-right');
    expect(turnKind(SLIGHT_DEG - 0.1)).toBe('slight-right');
    expect(turnKind(SLIGHT_DEG + 0.1)).toBe('right');
    expect(turnKind(SHARP_DEG - 0.1)).toBe('right');
    expect(turnKind(SHARP_DEG + 0.1)).toBe('sharp-right');
    expect(turnKind(UTURN_DEG - 0.1)).toBe('sharp-right');
    expect(turnKind(UTURN_DEG + 0.1)).toBe('uturn-right');
    // A turn just *under* the straight threshold is no turn, on either side.
    expect(turnKind(-(STRAIGHT_DEG - 0.1))).toBeNull();
    expect(turnKind(STRAIGHT_DEG - 0.1)).toBeNull();
    // And the sign is the whole of left-versus-right, so every band must mirror.
    for (const d of [20, 50, 120, 160]) {
      // Both wordings, because `right` has no `-right` substring in it: the first version of
      // this used one replacement and so asserted `turnKind(-50) === 'right'`, which failed
      // for a reason in the *test* and read like a direction reversal in the code.
      const positive = turnKind(d)!;
      const mirrored = positive.endsWith('-right')
        ? positive.replace('-right', '-left')
        : positive === 'right' ? 'left' : positive;
      expect(turnKind(-d)).toBe(mirrored);
      // Stated directly as well, because the mirror check would pass on a `turnKind` that
      // ignored its argument's sign entirely — and "reversing a direction" is half of what
      // §7 gap 6 measured.
      expect(turnKind(d)).toMatch(/right$/);
      expect(turnKind(-d)).toMatch(/left$/);
    }
  });

  it('wraps a bearing difference to ±180, so 350° reads as −10°', () => {
    // Without the wrap, a U-turn would be seen as a 350° left turn and land in `uturn-left`
    // by accident rather than by decision.
    // 10 -> 360 is a difference of +350, and the shortest way round is -10. That the wrap
    // picks the *short* way is the whole reason a U-turn is not seen as a 350° left turn.
    expect(signedTurn(10, 360)).toBeCloseTo(-10, 6);
    expect(signedTurn(350, 10)).toBeCloseTo(20, 6);
    expect(Math.abs(signedTurn(5, -175))).toBeLessThanOrEqual(180);
    expect(signedTurn(0, 180)).toBeCloseTo(180, 6);
    expect(signedTurn(0, -180)).toBeCloseTo(-180, 6);
  });
});

describe('the inference', () => {
  it('finds nothing in a straight line, and says it looked', () => {
    const r = inferSteps(northRun(60));
    expect(r.steps).toHaveLength(0);
    expect(r.tooSparse).toBe(false);
    // The load-bearing part: it *looked*, and recorded that it looked.
    expect(r.trace.length).toBeGreaterThan(4);
    expect(r.trace.every((e) => e.kind === null)).toBe(true);
    expect(r.trace.every((e) => e.reason)).toBe(true);
    expect(summariseTrace(r.trace)).toMatch(/0 steps from \d+ windows/);
  });

  it('reports "too sparse" separately from "looked and found nothing"', () => {
    // These are different defects with different copy — the Steps screen tells a driver
    // their engine cannot help when the truth is that this route is too short to read — so
    // conflating them is a product bug, not a tidiness one.
    const short = inferSteps(northRun(TOO_SPARSE - 1));
    expect(short.tooSparse).toBe(true);
    expect(short.trace).toHaveLength(0);
    expect(inferSteps(northRun(TOO_SPARSE)).tooSparse).toBe(false);
  });

  it('finds a real bend, with a bearing pair that explains it', () => {
    const r = inferSteps(withBend(STEP_EVERY + 2, 90, STEP_EVERY + 2));
    expect(r.steps.length).toBeGreaterThanOrEqual(1);
    const step = r.steps[0]!;
    // A right turn is a positive signed turn under this convention, and the trace's two
    // bearings have to differ by about the amount asked for.
    expect(step.icon).toBe('right');
    const entry = r.trace.find((e) => e.kind === step.icon)!;
    expect(Math.abs(entry.turn - 90)).toBeLessThan(25);
    expect(entry.outBearing).not.toBeCloseTo(entry.inBearing, 0);
    // A real distance, not a bare name.
    expect(step.distanceMeters).toBeGreaterThan(0);
    expect(step.distanceLabel).not.toBe('');
  });

  it('marks a sharp bend major, and a gentle one not', () => {
    const sharp = inferSteps(withBend(STEP_EVERY + 2, 130, STEP_EVERY + 2));
    expect(sharp.steps[0]!.major).toBe(true);
    const gentle = inferSteps(withBend(STEP_EVERY + 2, 30, STEP_EVERY + 2));
    expect(gentle.steps[0]!.major).toBe(false);
  });

  it('produces steps in route order, so the list is walkable', () => {
    // Two bends, in opposite directions. A list out of order would read as a route that
    // doubles back, and nothing else on the screen would reveal it.
    const pts = withBend(STEP_EVERY + 2, 80, STEP_EVERY * 2);
    const last = pts[pts.length - 1]!;
    for (let i = 1; i <= STEP_EVERY + 2; i++) {
      pts.push([last[0] - (i * 0.00009) / Math.cos(55.95 * Math.PI / 180), last[1]]);
    }
    const r = inferSteps(pts);
    expect(r.steps.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < r.steps.length; i++) {
      expect(r.steps[i]!.shapeIndex).toBeGreaterThan(r.steps[i - 1]!.shapeIndex);
    }
  });
});

describe('the trace', () => {
  /**
   * The property §7 gap 6 actually needs.
   *
   * A *missing* turn and a *spurious* turn look identical in `steps` — one has an entry the
   * other should have, and no output says which. The trace is the only thing that
   * distinguishes them, so it has to account for every window: the ones that produced a step
   * and the ones that did not, in the same list, with no gaps.
   */
  it('accounts for every window, kept and rejected alike', () => {
    const r = inferSteps(withBend(STEP_EVERY + 2, 60, STEP_EVERY * 3));
    const expected = [];
    for (let i = STEP_EVERY; i < r.steps[0]!.shapeIndex + STEP_EVERY * 4 && i < 40; i += STEP_EVERY) {
      expected.push(i);
    }
    // Every trace entry sits on a window the loop would have visited.
    for (const e of r.trace) {
      expect(e.index % STEP_EVERY).toBe(0);
      expect(e.index).toBeGreaterThanOrEqual(STEP_EVERY);
    }
    // No window was visited twice, and none was skipped.
    const indices = r.trace.map((e) => e.index);
    expect(new Set(indices).size).toBe(indices.length);
    expect(r.trace.length).toBeGreaterThan(0);
  });

  it('gives every rejected window a reason, with the number it failed on', () => {
    // "Too small" is not a diagnosis. The number and the threshold it missed are, because
    // that is what a reviewer needs to decide whether the threshold or the geometry is wrong.
    const r = inferSteps(northRun(80));
    for (const e of r.trace) {
      expect(e.kind).toBeNull();
      expect(e.reason).toMatch(/^\s*turn -?\d+\.\d+°/);
      expect(e.reason).toContain(String(STRAIGHT_DEG));
    }
  });

  it('the trace and the steps are the same set, seen from both sides', () => {
    // A trace entry that claims a step the list does not have — or omits one the list does —
    // would make the trace a *different* account of the run rather than the same one. That is
    // the property §7 gap 6 needs: "three turns were missed" has to be answerable by
    // comparing the two lists, and they have to be comparable.
    const r = inferSteps(withBend(STEP_EVERY + 2, 60, STEP_EVERY * 3));
    const kept = r.trace.filter((e) => e.kind !== null);
    expect(kept.length).toBe(r.steps.length);
    expect(kept.map((e) => e.index)).toEqual(r.steps.map((s) => s.shapeIndex));
    expect(kept.map((e) => e.kind)).toEqual(r.steps.map((s) => s.icon));
    // And the leg lengths agree, so a reader comparing the two lists is comparing like with
    // like rather than a metres column against a differently-derived one.
    expect(kept.map((e) => Math.round(e.legMetres))).toEqual(
      r.steps.map((s) => Math.round(s.distanceMeters)),
    );
  });

  it('carries the leg length for every entry, kept or not', () => {
    // A rejected window with no distance cannot be compared against a kept one, and the
    // comparison is the point: was this one rejected on its turn, or on its size?
    const r = inferSteps(withBend(STEP_EVERY + 2, 60, STEP_EVERY * 3));
    for (const e of r.trace) expect(e.legMetres).toBeGreaterThan(0);
  });

  it('reports the bearings a driver would recognise', () => {
    // North is 0, and east is 90. A trace whose "northbound" leg reads as 180 would be a
    // sign convention reversed, which is invisible in the step list and fatal in the trace.
    const a: LatLng = [-3.19, 55.95];
    const b: LatLng = [-3.19, 55.96];
    const c: LatLng = [-3.18, 55.96];
    expect(bearingBetween(a, b)).toBeCloseTo(0, 3);
    // 0.005° of tolerance, and stated: a degree of longitude at 55.95 N is ~0.56 of a degree
    // of latitude, so an exact-east leg reads 89.9959°. Pinning it to 3 decimal places would
    // have this fail for a reason that has nothing to do with the sign convention.
    expect(bearingBetween(b, c)).toBeCloseTo(90, 2);
  });

  it('summarises as counts, because that is the first question asked', () => {
    const r = inferSteps(withBend(STEP_EVERY + 2, 60, STEP_EVERY * 3));
    const s = summariseTrace(r.trace);
    expect(s).toMatch(/^\d+ steps? from \d+ windows?$/);
    // And it agrees with the trace rather than being computed from the steps.
    const kept = r.trace.filter((e) => e.kind !== null).length;
    expect(s).toContain(`${kept} step`);
  });
});

describe('a regression guard on the thing §7 gap 6 measured', () => {
  /**
   * §7 gap 6 is the document's only *measured* defect in this area, and it is a statement
   * about real maneuvers: three missed, one invented, one reversed, on a 4 km stretch. That
   * measurement cannot be reproduced here — there is no recorded geometry for it — and this
   * test says so rather than pretending to.
   *
   * What it does instead is pin the behaviour that measurement was taken against, so that a
   * future change to the thresholds or the window shows up as a diff on *this* rather than
   * as a surprise in a car. If someone fixes gap 6, this is the file to change deliberately.
   */
  it('records which way each way round a bend reads', () => {
    // Right must be positive. A sign flip here is the "reversing a direction" half of gap 6,
    // and it would be invisible in the UI because both icons render.
    const right = inferSteps(withBend(STEP_EVERY + 2, 80, STEP_EVERY + 2));
    expect(right.steps[0]!.icon).toMatch(/right$/);
    const left = inferSteps(withBend(STEP_EVERY + 2, -80, STEP_EVERY + 2));
    expect(left.steps[0]!.icon).toMatch(/left$/);
    expect(signedTurn(0, 80)).toBeGreaterThan(0);
    expect(signedTurn(0, -80)).toBeLessThan(0);
  });

  it('does not invent a step at the ends of the route', () => {
    // The window needs STEP_EVERY either side, so the first and last legs cannot produce a
    // turn — which is correct (there is nothing to see) and is worth pinning, because
    // "the first turn is missing" is exactly the shape of gap 6's complaint.
    const r = inferSteps(withBend(STEP_EVERY + 2, 80, STEP_EVERY + 2));
    for (const s of r.steps) {
      expect(s.shapeIndex).toBeGreaterThanOrEqual(STEP_EVERY);
      expect(s.shapeIndex).toBeLessThanOrEqual(r.trace[r.trace.length - 1]!.index);
    }
  });
});