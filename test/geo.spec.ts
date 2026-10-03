/**
 * Pure geo helper tests — decodePolyline, distance, bearing, formatting,
 * polyline maths. Everything here is exact-value assertions: each case has a
 * closed form (R * Δφ, a canonical polyline vector, a unit conversion) rather
 * than a re-implementation of the same formula.
 *
 * Run with `npx vitest run test/geo.spec.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  decodePolyline,
  haversine,
  bearing,
  formatDistance,
  formatDuration,
  formatClock,
  lineLength,
  pointAtFraction,
  snapToPolyline,
  bboxOf,
  simplify,
  R_EARTH,
  type LatLng,
} from '../src/geo';

/** One degree of latitude along a meridian: R * π/180. */
const DEG_LAT = R_EARTH * (Math.PI / 180);
const FT_PER_M = 3.28084;
const M_PER_MI = 1609.344;
const M_PER_FT = 0.3048;

/** Reference polyline5 encoder (Google's algorithm) for round-trip tests. */
function encodePolyline(coords: LatLng[], precision: number): string {
  let out = '';
  let prevLat = 0;
  let prevLon = 0;
  const factor = 10 ** precision;
  const enc = (n: number) => {
    let v = n < 0 ? ~(n << 1) : n << 1;
    while (v >= 0x20) {
      out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    out += String.fromCharCode(v + 63);
  };
  for (const [lon, lat] of coords) {
    const iLat = Math.round(lat * factor);
    const iLon = Math.round(lon * factor);
    enc(iLat - prevLat);
    enc(iLon - prevLon);
    prevLat = iLat;
    prevLon = iLon;
  }
  return out;
}

describe('decodePolyline', () => {
  it('decodes the canonical polyline5 vector from the Google docs', () => {
    const pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5);
    expect(pts).toHaveLength(3);
    expect(pts[0][0]).toBeCloseTo(-120.2, 5);
    expect(pts[0][1]).toBeCloseTo(38.5, 5);
    expect(pts[1][0]).toBeCloseTo(-120.95, 5);
    expect(pts[1][1]).toBeCloseTo(40.7, 5);
    expect(pts[2][0]).toBeCloseTo(-126.453, 5);
    expect(pts[2][1]).toBeCloseTo(43.252, 5);
  });

  it('returns [lon, lat] pairs, not [lat, lon]', () => {
    const pts = decodePolyline(encodePolyline([[13.3978, 52.5172]], 6), 6);
    // If the order were swapped this would be lon 52.5, which is not a valid
    // longitude for Berlin.
    expect(pts).toEqual([[13.3978, 52.5172]]);
  });

  it('round-trips at precision 6 to the micro-degree', () => {
    const input: LatLng[] = [
      [-114.0719, 51.0447],
      [-113.4938, 53.5461],
      [-123.1207, 49.2827],
      [0, 0],
      [-179.999999, 89.999999],
    ];
    const out = decodePolyline(encodePolyline(input, 6), 6);
    expect(out).toHaveLength(input.length);
    for (let i = 0; i < input.length; i++) {
      expect(out[i][0]).toBeCloseTo(input[i][0], 6);
      expect(out[i][1]).toBeCloseTo(input[i][1], 6);
    }
  });

  it('round-trips at precision 5 to 1e-5 degrees', () => {
    const input: LatLng[] = [[-120.2, 38.5], [-120.95, 40.7], [-126.453, 43.252]];
    expect(decodePolyline(encodePolyline(input, 5), 5)).toEqual(input);
  });

  it('decodes negative deltas (westbound / southbound)', () => {
    // Second point is west and south of the first: deltas are negative.
    const out = decodePolyline(encodePolyline([[10, 10], [9, 9]], 6), 6);
    expect(out).toEqual([[10, 10], [9, 9]]);
  });

  it('defaults to precision 6 and returns [] for empty input', () => {
    expect(decodePolyline('')).toEqual([]);
    expect(decodePolyline(encodePolyline([[1, 2]], 6))).toEqual([[1, 2]]);
  });

  it('handles deltas that need multiple 5-bit chunks', () => {
    // ~1 degree at precision 6 is 1e6, which needs 4 varint chunks.
    const out = decodePolyline(encodePolyline([[0, 0], [1, -1]], 6), 6);
    expect(out).toEqual([[0, 0], [1, -1]]);
  });
});

describe('haversine', () => {
  it('is zero for identical points', () => {
    expect(haversine([13.4, 52.5], [13.4, 52.5])).toBe(0);
  });

  it('measures one degree of latitude as R*π/180 exactly', () => {
    expect(DEG_LAT).toBeCloseTo(111195.0802335329, 6);
    expect(haversine([0, 0], [0, 1])).toBeCloseTo(DEG_LAT, 6);
  });

  it('is exact for short spans (the regime routing works in)', () => {
    expect(haversine([0, 0], [0, 0.001])).toBeCloseTo(0.001 * DEG_LAT, 9);
    expect(haversine([-114.0719, 51.0447], [-114.0719, 51.0448])).toBeCloseTo(
      0.0001 * DEG_LAT, 6,
    );
  });

  it('measures one degree of longitude as R*π/180 at the equator', () => {
    expect(haversine([0, 0], [1, 0])).toBeCloseTo(DEG_LAT, 6);
  });

  it('shrinks a degree of longitude by cos(lat) away from the equator', () => {
    // A degree of *parallel* length is R*Δλ*cos(φ) = 55 597.54 m, but the
    // shortest great circle between two points at 60°N bulges poleward and is
    // ~0.5 m shorter, so compare with a 2e-5 relative tolerance.
    const at60 = haversine([0, 60], [1, 60]);
    const parallel = DEG_LAT * Math.cos((60 * Math.PI) / 180);
    expect(at60).toBeLessThan(DEG_LAT);
    expect(Math.abs(at60 - parallel) / parallel).toBeLessThan(2e-5);
    expect(at60).toBeCloseTo(55597.01, 1);
  });

  it('handles antipodal-in-quarter points on the 60° great circle', () => {
    // 45N45E -> 45S45W is 120° of arc on the great circle, not 180°.
    expect(haversine([45, 45], [-45, -45])).toBeCloseTo(((2 * Math.PI) / 3) * R_EARTH, 3);
  });

  it('matches an independent spherical law-of-cosines reference', () => {
    const pairs: LatLng[][] = [
      [[-114.0719, 51.0447], [-113.4938, 53.5461]], // Calgary -> Edmonton
      [[-122.4194, 37.7749], [-74.006, 40.7128]], // SF -> NYC
      [[2.3522, 48.8566], [139.6917, 35.6895]], // Paris -> Tokyo
    ];
    for (const [a, b] of pairs) {
      const toRad = Math.PI / 180;
      const ref =
        R_EARTH *
        Math.acos(
          Math.sin(a[1] * toRad) * Math.sin(b[1] * toRad) +
            Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) *
              Math.cos((b[0] - a[0]) * toRad),
        );
      expect(haversine(a, b)).toBeCloseTo(ref, 6);
    }
    // spot-check the Calgary -> Edmonton straight line (~281 km, vs ~300 km by road)
    const ab = haversine(pairs[0][0], pairs[0][1]);
    expect(ab).toBeGreaterThan(278_000);
    expect(ab).toBeLessThan(283_000);
  });

  it('is symmetric', () => {
    expect(haversine([-120.2, 38.5], [-126.453, 43.252])).toBe(
      haversine([-126.453, 43.252], [-120.2, 38.5]),
    );
  });

  it('never exceeds half the circumference', () => {
    expect(haversine([-180, 0], [180, 0])).toBeCloseTo(0, 6);
    expect(haversine([0, -90], [0, 90])).toBeCloseTo(Math.PI * R_EARTH, 3);
  });
});

describe('bearing', () => {
  it('reports 90° due east and 0° due north at the equator', () => {
    expect(bearing([0, 0], [1, 0])).toBeCloseTo(90, 6);
    expect(bearing([0, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it('reports -90° due west and 180° due south', () => {
    expect(bearing([0, 0], [-1, 0])).toBeCloseTo(-90, 6);
    expect(bearing([0, 0], [0, -1])).toBeCloseTo(180, 6);
  });

  it('reports the quadrant of travel, not of displacement', () => {
    // NE from the equator. The *initial* great-circle bearing is not the grid
    // angle: it is 44.9956° because the meridian converges along the leg.
    expect(bearing([0, 0], [1, 1])).toBeCloseTo(45, 2);
    // Due east at 60°N is *not* 90°: meridians converge, so the initial
    // great-circle bearing bends slightly north of the parallel (89.567°).
    expect(bearing([0, 60], [1, 60])).toBeLessThan(90);
    expect(bearing([0, 60], [1, 60])).toBeCloseTo(90, 0);
  });

  it('is 0 for the same point', () => {
    expect(bearing([13.4, 52.5], [13.4, 52.5])).toBe(0);
  });

  it('stays in (-180, 180]', () => {
    for (const b of [[-179, 0], [179, 0], [0, -89], [0, 89], [-0.0001, -0.0001]]) {
      const x = bearing([0, 0], b as LatLng);
      expect(x).toBeGreaterThan(-180.000001);
      expect(x).toBeLessThanOrEqual(180.000001);
    }
  });
});

describe('formatDistance', () => {
  it('metric: <20 m snaps to 5 m', () => {
    expect(formatDistance(0, 'metric')).toBe('0 m');
    expect(formatDistance(12.4, 'metric')).toBe('10 m');
    expect(formatDistance(19, 'metric')).toBe('20 m');
  });

  it('metric: 20..999 m snaps to 10 m', () => {
    expect(formatDistance(20, 'metric')).toBe('20 m');
    expect(formatDistance(994, 'metric')).toBe('990 m');
    expect(formatDistance(999, 'metric')).toBe('1000 m');
  });

  it('metric: switches to km at 1 km, one decimal until 10 km', () => {
    expect(formatDistance(1000, 'metric')).toBe('1.0 km');
    expect(formatDistance(1500, 'metric')).toBe('1.5 km');
    expect(formatDistance(9949, 'metric')).toBe('9.9 km');
    expect(formatDistance(10000, 'metric')).toBe('10 km');
    expect(formatDistance(12345, 'metric')).toBe('12 km');
    expect(formatDistance(123_456, 'metric')).toBe('123 km');
  });

  it('imperial: feet below 0.1 mi, snapped to 50 ft', () => {
    expect(formatDistance(0, 'imperial')).toBe('0 ft');
    expect(formatDistance(30.48, 'imperial')).toBe('100 ft'); // exactly 100 ft
    expect(formatDistance(10, 'imperial')).toBe(`${Math.round((10 * FT_PER_M) / 50) * 50} ft`);
  });

  it('imperial: switches from feet to miles at exactly 0.1 mi', () => {
    // 528 ft = 0.1 mi exactly; below that it is still feet.
    expect(M_PER_MI / 10 * FT_PER_M).toBeCloseTo(528, 2);
    expect(M_PER_FT).toBeCloseTo(1 / FT_PER_M, 5);
    expect(formatDistance(M_PER_MI / 10, 'imperial')).toBe('0.1 mi');
    // One metre short of 0.1 mi is still feet: 159.93 m -> 524.9 ft -> 500 ft.
    expect(formatDistance(M_PER_MI / 10 - 1, 'imperial')).toBe('500 ft');
    expect(formatDistance(160, 'imperial')).toBe('500 ft');
  });

  it('imperial: one decimal up to 10 mi, then whole miles', () => {
    expect(formatDistance(800, 'imperial')).toBe('0.5 mi');
    expect(formatDistance(M_PER_MI, 'imperial')).toBe('1.0 mi');
    expect(formatDistance(9 * M_PER_MI, 'imperial')).toBe('9.0 mi');
    expect(formatDistance(10 * M_PER_MI, 'imperial')).toBe('10 mi');
    expect(formatDistance(123.4 * M_PER_MI, 'imperial')).toBe('123 mi');
  });
});

describe('formatDuration', () => {
  it('is "<1 min" for anything under 60 s', () => {
    expect(formatDuration(0)).toBe('<1 min');
    expect(formatDuration(1)).toBe('<1 min');
    expect(formatDuration(59)).toBe('<1 min');
    expect(formatDuration(59.999)).toBe('<1 min');
  });

  it('switches to whole minutes at exactly 60 s', () => {
    expect(formatDuration(60)).toBe('1 min');
    expect(formatDuration(89)).toBe('1 min');
    expect(formatDuration(90)).toBe('2 min');
    expect(formatDuration(24 * 60)).toBe('24 min');
  });

  it('rolls over to hours at exactly 60 min', () => {
    expect(formatDuration(3599)).toBe('1 hr'); // rounds to 60 min first
    expect(formatDuration(3600)).toBe('1 hr');
    expect(formatDuration(3600 + 60)).toBe('1 hr 1 min');
    expect(formatDuration(65 * 60)).toBe('1 hr 5 min');
    expect(formatDuration(125 * 60)).toBe('2 hr 5 min');
    expect(formatDuration(24 * 3600)).toBe('24 hr 0 min');
  });
});

describe('formatClock', () => {
  it('formats a wall-clock time', () => {
    const s = formatClock(new Date(2024, 0, 2, 15, 4));
    expect(s).toContain('3');
    expect(s).toContain('04');
  });
});

describe('lineLength / pointAtFraction', () => {
  it('sums segment lengths in metres', () => {
    expect(lineLength([])).toBe(0);
    expect(lineLength([[0, 0]])).toBe(0);
    expect(lineLength([[0, 0], [0, 1]])).toBeCloseTo(DEG_LAT, 6);
    expect(lineLength([[0, 0], [0, 1], [0, 2]])).toBeCloseTo(2 * DEG_LAT, 6);
  });

  it('interpolates along a meridian at the requested fraction', () => {
    const line: LatLng[] = [[0, 0], [0, 2]];
    expect(pointAtFraction(line, 0)).toEqual([0, 0]);
    expect(pointAtFraction(line, 0.25)[1]).toBeCloseTo(0.5, 6);
    expect(pointAtFraction(line, 0.5)[1]).toBeCloseTo(1, 6);
    expect(pointAtFraction(line, 1)[1]).toBeCloseTo(2, 6);
  });

  it('clamps beyond the ends instead of extrapolating', () => {
    const line: LatLng[] = [[0, 0], [0, 2]];
    expect(pointAtFraction(line, 1.5)).toEqual([0, 2]);
    expect(pointAtFraction(line, 99)).toEqual([0, 2]);
  });

  it('returns [0, 0] for an empty line', () => {
    expect(pointAtFraction([], 0.5)).toEqual([0, 0]);
  });

  it('skips zero-length segments without dividing by zero', () => {
    // Without the `seg === 0` guard this is 0/0 = NaN.
    const line: LatLng[] = [[0, 0], [0, 0], [0, 1]];
    expect(pointAtFraction(line, 0.5)[1]).toBeCloseTo(0.5, 6);
  });
});

describe('snapToPolyline', () => {
  const line: LatLng[] = [[0, 0], [1, 0], [2, 0]];

  it('snaps a perpendicular offset onto the right segment', () => {
    const s = snapToPolyline([1.5, 0.1], line);
    expect(s.index).toBe(1);
    expect(s.point[0]).toBeCloseTo(1.5, 9);
    expect(s.point[1]).toBeCloseTo(0, 9);
    // 0.1° of latitude is ~11.1 km, measured in metres not degrees.
    expect(s.dist).toBeCloseTo(0.1 * DEG_LAT, 3);
  });

  it('reports zero distance for a point already on the line', () => {
    const s = snapToPolyline([1, 0], line);
    expect(s.index).toBe(0);
    expect(s.dist).toBe(0);
  });

  it('measures an east-west offset with the cos(lat) metres-per-degree factor', () => {
    // A naive Euclidean-in-degrees implementation would report 1e-2 "degrees".
    const s = snapToPolyline([0.5, 60.001], [
      [0, 60],
      [1, 60],
    ]);
    expect(s.dist).toBeCloseTo(0.001 * DEG_LAT, 3);
  });

  it('clamps to the endpoint for a point beyond the end of the line', () => {
    const s = snapToPolyline([2, 0.5], line);
    expect(s.index).toBe(1); // last segment
    expect(s.point).toEqual([2, 0]);
    expect(s.dist).toBeCloseTo(0.5 * DEG_LAT, 3);
  });

  it('clamps to the start for a point before the start of the line', () => {
    const s = snapToPolyline([-1, 0], line);
    expect(s.index).toBe(0);
    expect(s.point).toEqual([0, 0]);
    expect(s.dist).toBeCloseTo(DEG_LAT, 1);
  });

  it('clamps to the start even when the offset is mostly longitudinal', () => {
    // A degree-based Euclidean metric would report ~1.03 degrees here; the
    // answer must be the great-circle distance to the clamped endpoint
    // (~114.7 km), which is what the law-of-cosines reference gives.
    const s = snapToPolyline([-1, 0.25], line);
    expect(s.point).toEqual([0, 0]);
    const toRad = Math.PI / 180;
    const ref =
      R_EARTH *
      Math.acos(
        Math.sin(-1 * 0 * toRad + 0.25 * toRad) * Math.sin(0) +
          Math.cos(0.25 * toRad) * 1 * Math.cos(-1 * toRad),
      );
    expect(s.dist).toBeCloseTo(ref, 6);
    expect(s.dist).toBeGreaterThan(114_000);
    expect(s.dist).toBeLessThan(115_000);
  });

  it('projects onto a slanted segment exactly', () => {
    // Line from (0,0) to (1,1) in degrees; the perpendicular foot of
    // (1,0) is the midpoint of that segment.
    const s = snapToPolyline([1, 0], [
      [0, 0],
      [1, 1],
    ]);
    expect(s.index).toBe(0);
    expect(s.point[0]).toBeCloseTo(0.5, 6);
    expect(s.point[1]).toBeCloseTo(0.5, 6);
  });

  it('ignores a degenerate zero-length segment', () => {
    const s = snapToPolyline([0.5, 0], [
      [0, 0],
      [0, 0],
      [1, 0],
    ]);
    expect(Number.isFinite(s.point[0])).toBe(true);
    expect(s.dist).toBe(0);
  });

  it('reports distance 0, not Infinity, for a degenerate line', () => {
    // With fewer than 2 points there is no segment to project onto. Returning
    // Infinity would read as "maximally off route" to any threshold comparison,
    // claiming the driver is lost when there is no route to be lost from.
    const one = snapToPolyline([1, 1], [[0, 0]]);
    expect(one.index).toBe(0);
    expect(one.dist).toBe(0);
    expect(one.point).toEqual([0, 0]);

    const none = snapToPolyline([1, 1], []);
    expect(none.dist).toBe(0);
    expect(none.point).toEqual([1, 1]);
  });
});

describe('bboxOf', () => {
  it('returns [west, south, east, north]', () => {
    expect(bboxOf([[13.0, 52.0], [10.0, 50.0], [12.0, 53.0]])).toEqual([10, 50, 13, 53]);
  });

  it('degenerates for a single point', () => {
    expect(bboxOf([[5, 6]])).toEqual([5, 6, 5, 6]);
  });

  it('returns an inverted sentinel for an empty set', () => {
    // [180, 90, -180, -90] — west > east and south > north.
    expect(bboxOf([])).toEqual([180, 90, -180, -90]);
  });
});

describe('simplify', () => {
  const line = (n: number): LatLng[] => Array.from({ length: n }, (_, i) => [i * 0.001, 0]);

  it('returns the input untouched when it already fits', () => {
    const l = line(10);
    expect(simplify(l, 10)).toEqual(l);
    expect(simplify(l, 4000)).toEqual(l);
  });

  it('strides down to roughly the requested budget', () => {
    const out = simplify(line(1000), 100);
    expect(out.length).toBeGreaterThanOrEqual(100);
    expect(out.length).toBeLessThanOrEqual(101);
    // stride sampling, not Douglas-Peucker: every kept index is a multiple of 10
    for (let i = 1; i < out.length - 1; i++) expect(out[i][0]).toBe(i * 0.01);
  });

  it('always keeps the final point', () => {
    const out = simplify(line(1000), 100);
    expect(out[out.length - 1]).toEqual(line(1000)[999]);
    const l = line(11);
    const out2 = simplify(l, 10);
    expect(out2[0]).toEqual(l[0]);
    expect(out2[out2.length - 1]).toEqual(l[l.length - 1]);
  });

  it('does not duplicate the final point when the stride lands on it', () => {
    const l = line(11); // stride 2 => indices 0,2,4,6,8,10 — 10 is the last index
    const out = simplify(l, 10);
    expect(out).toHaveLength(6);
  });

  it('can exceed the budget by one to keep the last point', () => {
    // 100 points, stride 10 => indices 0..90 (10 points), then 99 is appended.
    expect(simplify(line(100), 10)).toHaveLength(11);
  });

  it('returns the same array instance when nothing needs removing', () => {
    const l = line(5);
    expect(simplify(l, 5)).toBe(l);
  });
});