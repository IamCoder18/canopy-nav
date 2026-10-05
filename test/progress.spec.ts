/**
 * The ETA readout.
 *
 * These tests exist because the bar used to lie, in two ways that were both
 * measured in the running app (see `src/nav/progress.ts`):
 *
 *   - it flipped between `0 m` and `670 m` on a 36 m move, because remaining
 *     distance was recomputed from a fresh projection of each fix and could
 *     therefore move *backwards* on a route that doubles back;
 *   - it read `0 m` to destination while the driver was 900 m off course,
 *     because a fix too far from the line to place the car was still snapped to
 *     the nearest point *anywhere* on the line, and that point was sometimes
 *     near the end.
 *
 * The bar is a readout a driver acts on without checking, so the properties are
 * asserted as properties — over a whole driven route, including the awkward
 * geometry that caused it — rather than as single hand-picked cases that would
 * only prove those cases.
 */

import { describe, it, expect } from 'vitest';
import { formatDistance, haversine, lineLength, snapAlong, type LatLng } from '../src/geo';
import {
  placeOnRoute,
  remainingFrom,
  startPosition,
  MIN_REPORTABLE_REMAINING_M,
  type RoutePosition,
} from '../src/nav/progress';

/**
 * The true length of a degree of latitude on the sphere `haversine` measures on.
 *
 * Note this is *not* the 111320 that `projectOnSegment` uses for its local planar
 * approximation — that constant is ~0.1% high, which is fine for projecting and
 * wrong for asserting, so the fixtures below assert against the sphere.
 */
const DEG_LAT_M = (6371008.8 * Math.PI) / 180;

/** A straight east-west line of `n` vertices, `stepDeg` apart. */
function straight(n: number, stepDeg = 0.001): LatLng[] {
  const line: LatLng[] = [];
  for (let i = 0; i < n; i++) line.push([i * stepDeg, 0]);
  return line;
}

/**
 * A route that doubles back on itself, which is what breaks a naive
 * "closest point on the whole line" projection: the outbound and return legs are
 * 12 m apart, so a fix on one is almost equally close to the other, and at some
 * points nearer to the part already driven.
 */
function doublingBack(): LatLng[] {
  const out: LatLng[] = [];
  const step = 0.0001; // ~11.1 m
  for (let i = 0; i < 60; i++) out.push([i * step, 0]);
  for (let i = 0; i < 40; i++) out.push([(60 - i) * step, 0.0001]); // ~11 m north
  for (let i = 0; i < 60; i++) out.push([i * step, 0.0002]);
  return out;
}

/** Walk a car along a route, calling `placeOnRoute` on each fix. */
function drive(
  line: LatLng[],
  fixes: LatLng[],
  threshold = 25,
): RoutePosition[] {
  let pos = startPosition(line);
  const seen: RoutePosition[] = [pos];
  for (const fix of fixes) {
    pos = placeOnRoute(line, fix, pos, threshold);
    seen.push(pos);
  }
  return seen;
}

/** Sample a route at `count` evenly spaced fractions, as a driven sequence. */
function alongRoute(line: LatLng[], count: number): LatLng[] {
  // Cumulative distances once, rather than re-measuring the prefix per sample.
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + haversine(line[i - 1], line[i]));
  const total = cum[cum.length - 1];
  const out: LatLng[] = [];
  let seg = 0;
  for (let k = 1; k < count; k++) {
    const target = (total * k) / count;
    while (seg < line.length - 2 && cum[seg + 1] < target) seg++;
    const span = cum[seg + 1] - cum[seg];
    const t = span === 0 ? 0 : (target - cum[seg]) / span;
    out.push([
      line[seg][0] + (line[seg + 1][0] - line[seg][0]) * t,
      line[seg][1] + (line[seg + 1][1] - line[seg][1]) * t,
    ]);
  }
  return out;
}

/**
 * A route that runs beside an earlier section of itself for its whole length.
 *
 * Leg 1 east at y=0, leg 2 back west ~11 m north, leg 3 east again ~22 m north.
 * At any x all three legs are candidates, so a fix's nearest point on the line is
 * a genuine choice between "behind the driver" and "ahead" — the situation that
 * made the ETA bar jump. Geometrically this is a divided road with both
 * carriageways in the route, or a route that loops back past where it came from.
 */
function threeLegs(): LatLng[] {
  const step = 0.0002; // ~22 m
  const out: LatLng[] = [];
  for (let i = 0; i < 80; i++) out.push([i * step, 0]);
  for (let i = 0; i < 80; i++) out.push([(79 - i) * step, 0.0001]);
  for (let i = 0; i < 80; i++) out.push([i * step, 0.0002]);
  return out;
}

describe('snapAlong', () => {
  it('measures distance from the start in metres, not vertex count', () => {
    const line = straight(10, 0.001); // 9 segments of ~111.2 m
    const s = snapAlong([0.003, 0], line);
    // Three whole segments along.
    expect(s.along).toBeCloseTo(3 * DEG_LAT_M * 0.001, 0);
  });

  it('is independent of how finely the geometry is tessellated', () => {
    // Same road, same distance travelled, different vertex density. A
    // vertex-index readout cannot express this; a metres readout can.
    const coarse = straight(5, 0.004);
    const fine = straight(81, 0.00025);
    const a = snapAlong([0.004, 0], coarse);
    const b = snapAlong([0.004, 0], fine);
    expect(a.along).toBeCloseTo(b.along, 0);
    expect(a.along).toBeCloseTo(4 * DEG_LAT_M * 0.001, 0);
  });

  it('expresses arrival, which a segment index cannot', () => {
    const line = straight(20);
    const atEnd = snapAlong(line[line.length - 1], line);
    expect(atEnd.along).toBeCloseTo(lineLength(line), 0);
    // The segment index of the final segment is 18, so an index-based readout
    // could never say "at the destination" for a multi-vertex line.
    expect(snapAlong(line[0], line).index).toBe(0);
    expect(atEnd.index).toBe(line.length - 2);
  });

  it('places a point inside a segment, not at its start', () => {
    const line = straight(3, 0.01); // two ~1.11 km segments
    const s = snapAlong([0.005, 0], line);
    // Half way along the *first* segment: an index readout would say 0, and
    // with it the driver would be reported 1.1 km behind where they are.
    expect(s.along).toBeCloseTo(0.5 * DEG_LAT_M * 0.01, 0);
    expect(s.along).toBeGreaterThan(0);
    expect(s.index).toBe(0);
  });

  it('places a point in the second segment inside that segment', () => {
    const line = straight(3, 0.01);
    const s = snapAlong([0.015, 0], line);
    expect(s.along).toBeCloseTo(1.5 * DEG_LAT_M * 0.01, 0);
  });

  it('clamps a point beyond the end to the full length', () => {
    const line = straight(5);
    const s = snapAlong([9, 0], line);
    expect(s.along).toBeCloseTo(lineLength(line), 0);
  });

  it('clamps a point before the start to zero', () => {
    const s = snapAlong([-9, 0], straight(5));
    expect(s.along).toBe(0);
  });

  it('reports the deviation in metres for an off-course fix', () => {
    const s = snapAlong([0.005, 0.001], straight(20));
    expect(s.dist).toBeCloseTo(0.001 * DEG_LAT_M, 0);
  });

  it('does not throw on a degenerate line', () => {
    expect(snapAlong([1, 1], []).along).toBe(0);
    expect(snapAlong([1, 1], [[0, 0]]).along).toBe(0);
  });
});

describe('remainingFrom', () => {
  const line = straight(50);

  it('is the whole route at the start and nothing at the end', () => {
    expect(remainingFrom(line, 0)).toBeCloseTo(lineLength(line), 0);
    expect(remainingFrom(line, lineLength(line))).toBe(0);
  });

  it('never reports zero before the last vertex', () => {
    // The whole point: zero remaining means "arrived", so it must not be
    // reachable by a car that is short of the end.
    const total = lineLength(line);
    for (let along = 0; along < total; along += 0.5) {
      const left = remainingFrom(line, along);
      expect(left).toBeGreaterThan(0);
      expect(left).toBeGreaterThanOrEqual(MIN_REPORTABLE_REMAINING_M);
    }
  });

  it('never increases as the car advances', () => {
    let previous = Infinity;
    for (let along = 0; along <= lineLength(line); along += 1) {
      const left = remainingFrom(line, along);
      expect(left).toBeLessThanOrEqual(previous);
      previous = left;
    }
  });

  it('clamps out-of-range input rather than reporting nonsense', () => {
    const total = lineLength(line);
    expect(remainingFrom(line, -500)).toBeCloseTo(total, 0);
    expect(remainingFrom(line, total + 500)).toBe(0);
  });
});

describe('placeOnRoute — the two properties the ETA bar was violating', () => {
  it('never lets remaining distance increase while the car drives forwards', () => {
    // The regression shape: a route that doubles back, where the nearest point
    // on the line is sometimes behind the driver.
    const line = doublingBack();
    const positions = drive(line, alongRoute(line, 400));
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i].remaining).toBeLessThanOrEqual(positions[i - 1].remaining);
      expect(positions[i].along).toBeGreaterThanOrEqual(positions[i - 1].along);
    }
  });

  it('holds the property on a route with two carriageways 12 m apart', () => {
    // An overpass pair: the same road twice, close enough that a fix on the
    // outbound leg is nearer to the return leg than to its own future.
    const out: LatLng[] = [];
    const step = 0.0002;
    for (let i = 0; i < 50; i++) out.push([i * step, 0]);
    for (let i = 0; i < 50; i++) out.push([(50 - i) * step, 0.0001]);
    const positions = drive(out, alongRoute(out, 300));
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i].remaining).toBeLessThanOrEqual(positions[i - 1].remaining);
    }
  });

  it('never reports zero remaining while the driver is short of the destination', () => {
    const line = straight(400);
    // Drive up to the halfway point and stop, as a driver 11 km out would be.
    // The samples are truncated at halfway *and then* the midpoint appended:
    // appending it to a run that had already gone past would be refused by the
    // monotonic clamp, which is the other property under test here.
    const midpoint = line[200];
    // (wrapped: `concat` would spread a bare `[lon, lat]` into two numbers)
    const positions = drive(line, alongRoute(line, 400).slice(0, 199).concat([midpoint]));
    for (const p of positions) {
      expect(p.remaining).toBeGreaterThan(0);
      expect(formatDistance(p.remaining, 'metric')).not.toBe('0 m');
    }
    // And the number is the truth: half the route in, half of it is left. The
    // tolerance is one segment, because with 399 segments the halfway *point*
    // in distance falls between two vertices rather than on one.
    const last = positions[positions.length - 1];
    const total = lineLength(line);
    const oneSegment = haversine(line[0], line[1]);
    expect(last.along + last.remaining).toBeCloseTo(total, 6);
    expect(Math.abs(last.remaining - total / 2)).toBeLessThan(oneSegment);
    expect(last.remaining).toBeGreaterThan(5_000);
  });

  it('does not move the car to the destination when the fix is far off course', () => {
    // The measured failure: 900 m off the route, and the bar said `0 m` because
    // the nearest point on the line happened to be near its end.
    const line = straight(200); // ~22 km
    let pos = startPosition(line);
    for (let i = 0; i < 40; i++) pos = placeOnRoute(line, [0.001, 0], pos, 25);
    const before = pos.remaining;
    expect(before).toBeGreaterThan(15_000);

    // A fix 900 m north of the whole route, near the destination's longitude.
    const off = placeOnRoute(line, [0.199, 0.008], pos, 25);
    expect(off.onRoute).toBe(false);
    expect(off.deviation).toBeGreaterThan(500);
    // The last trustworthy number is kept — not blanked, and not invented.
    expect(off.remaining).toBe(before);
    expect(off.along).toBe(pos.along);
    expect(formatDistance(off.remaining, 'metric')).not.toBe('0 m');
  });

  it('keeps the last good number through a detour and resumes from it', () => {
    const line = straight(200);
    let pos = startPosition(line);
    for (let i = 0; i < 20; i++) pos = placeOnRoute(line, [0.0001 * i, 0], pos, 25);
    const detour = pos.remaining;
    // Three bad fixes, then a good one further along.
    for (let i = 0; i < 3; i++) pos = placeOnRoute(line, [0.005, 0.01], pos, 25);
    expect(pos.remaining).toBe(detour);
    pos = placeOnRoute(line, [0.0025, 0], pos, 25);
    expect(pos.onRoute).toBe(true);
    expect(pos.remaining).toBeLessThan(detour);
  });

  it('holds the property when the route runs 11 m beside an earlier section', () => {
    // The discriminating case. A fix between two parallel sections is nearer to
    // the one *behind* the car, so a projection that has no memory of where the
    // driver was puts them back on the road they already left — on a divided
    // highway that is two carriageways of the same road, ~11 m apart, and the
    // driver is physically between them.
    const out = threeLegs();
    const step = 0.0002;

    // Drive out along the first carriageway to x = 0.004.
    let pos = startPosition(out);
    for (let i = 1; i <= 20; i++) pos = placeOnRoute(out, [i * step, 0], pos, 25);
    const outbound = pos.remaining;

    // Now on the second carriageway at the same x, 11 m north: a different
    // place on the route, so less of it is left.
    pos = placeOnRoute(out, [0.004, 0.0001], pos, 25);
    expect(pos.onRoute).toBe(true);
    const inbound = pos.remaining;
    expect(inbound).toBeLessThan(outbound);

    // A fix biased toward the *first* carriageway — the driver is between them.
    // Without the monotonic clamp this snaps the car ~2 km back down the route
    // and the remaining distance jumps by a third of the whole trip.
    const between = placeOnRoute(out, [0.004, 0.00004], pos, 25);
    expect(between.remaining).toBeLessThanOrEqual(inbound);
    expect(between.remaining).toBeGreaterThan(0);
  });

  it('does not move the driver back onto a road they already left', () => {
    // The same trap as a whole driven route, asserted end to end. The fixes on
    // legs 2 and 3 carry a few metres of lateral noise, as real GPS on a divided
    // road does — enough that some land nearer the carriageway the driver has
    // already left, which is exactly when a memoryless projection sends them
    // backwards.
    const line = threeLegs();
    const step = 0.0002;

    const fixes: LatLng[] = [];
    for (let i = 1; i <= 79; i++) fixes.push([i * step, 0]);
    for (let i = 79; i >= 0; i--) fixes.push([i * step, 0.0001]);
    for (let i = 0; i <= 79; i++) fixes.push([i * step, 0.0002]);
    // Mid-junction, the receiver reports the car between the two levels of road
    // rather than cleanly on one of them. Each of these is nearer the leg the
    // driver already left, so a projection with no memory of where they were
    // walks them back down the route one at a time.
    for (const x of [0.012, 0.008, 0.004]) fixes.push([x, 0.00004], [x, 0.0001]);

    const positions = drive(line, fixes);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i].remaining).toBeLessThanOrEqual(positions[i - 1].remaining);
    }
    // And the car really did traverse the route, rather than the assertions
    // passing on a position that never moved.
    expect(positions[positions.length - 1].along).toBeGreaterThan(0.9 * lineLength(line));
  });

  it('ignores a fix that would move the car backwards, but still reports it', () => {
    const line = straight(200);
    let pos = startPosition(line);
    for (let i = 0; i < 50; i++) pos = placeOnRoute(line, [0.0001 * i, 0], pos, 25);
    const ahead = pos.along;
    // A stale fix from behind, well inside tolerance so it is trusted as a
    // position — it must not un-drive the car.
    pos = placeOnRoute(line, [0.0001, 0], pos, 25);
    expect(pos.along).toBe(ahead);
    expect(pos.remaining).toBeCloseTo(remainingFrom(line, ahead), 0);
  });

  it('reaches zero only at the end of the route', () => {
    const line = straight(50);
    const positions = drive(line, [line[line.length - 1], line[line.length - 1]]);
    expect(positions[positions.length - 1].remaining).toBe(0);
    expect(positions[positions.length - 1].along).toBeCloseTo(lineLength(line), 0);
  });

  it('survives a degenerate route without inventing distance', () => {
    expect(placeOnRoute([], [1, 1], startPosition([]), 25).remaining).toBe(0);
    const dot: LatLng[] = [[5, 5]];
    const p = placeOnRoute(dot, [5, 5], startPosition(dot), 25);
    expect(p.remaining).toBe(0);
  });

  it('tolerates GPS jitter around a fix without ever going backwards', () => {
    // Deterministic pseudo-jitter: a driver crawling in a street canyon, where
    // every fix is a few metres off in a random direction.
    const line = straight(400);
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff - 0.5;
    };
    const fixes: LatLng[] = [];
    for (let i = 0; i < 400; i++) {
      fixes.push([0.0001 * i, rand() * 0.00018]); // ±10 m of noise
    }
    const positions = drive(line, fixes);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i].remaining).toBeLessThanOrEqual(positions[i - 1].remaining);
    }
    // And the end state is a sane arrival, not a wild overshoot.
    const last = positions[positions.length - 1];
    expect(last.remaining).toBeGreaterThanOrEqual(0);
    expect(last.remaining).toBeLessThan(lineLength(line));
  });

  it('agrees with the distance actually driven', () => {
    // The bar should be telling the truth: remaining + travelled = the route.
    const line = straight(200);
    const total = lineLength(line);
    const positions = drive(line, alongRoute(line, 150));
    const last = positions[positions.length - 1];
    expect(last.along + last.remaining).toBeCloseTo(total, 0);
  });
});

describe('formatDistance never claims arrival', () => {
  it('keeps a genuine zero as zero', () => {
    expect(formatDistance(0, 'metric')).toBe('0 m');
    expect(formatDistance(0, 'imperial')).toBe('0 ft');
  });

  it('rounds a small nonzero distance up rather than to nothing', () => {
    // Rounding 4 m to the nearest 5 m gives 0, and "0 m" tells a driver on the
    // road that they have arrived.
    expect(formatDistance(0.4, 'metric')).toBe('5 m');
    expect(formatDistance(4.9, 'metric')).toBe('5 m');
    expect(formatDistance(0.4, 'imperial')).toBe('50 ft');
    expect(formatDistance(4, 'imperial')).toBe('50 ft');
  });

  it('leaves every other bucket exactly as it was', () => {
    expect(formatDistance(12.4, 'metric')).toBe('10 m');
    expect(formatDistance(19, 'metric')).toBe('20 m');
    expect(formatDistance(20, 'metric')).toBe('20 m');
    expect(formatDistance(994, 'metric')).toBe('990 m');
    expect(formatDistance(1000, 'metric')).toBe('1.0 km');
    expect(formatDistance(10_000, 'metric')).toBe('10 km');
    expect(formatDistance(30.48, 'imperial')).toBe('100 ft');
  });
});

describe('haversine sanity, used by the fixtures above', () => {
  it('measures a degree of latitude as the radius implies', () => {
    expect(haversine([0, 0], [0, 1])).toBeCloseTo(DEG_LAT_M, 6);
  });
});
