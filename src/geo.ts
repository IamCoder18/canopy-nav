/** Geo helpers: polyline codec, distance, bearing, formatting. */

export type LatLng = [number, number]; // [lon, lat] for GeoJSON

/** Decode Google/Valhalla encoded polylines. `precision` 5 = polyline5, 6 = polyline6. */
export function decodePolyline(str: string, precision = 6): LatLng[] {
  const factor = 10 ** precision;
  const coords: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  while (index < str.length) {
    let result = 1;
    let shift = 0;
    let b: number;
    do {
      b = str.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 1;
    shift = 0;
    do {
      b = str.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lon += result & 1 ? ~(result >> 1) : result >> 1;

    coords.push([lon / factor, lat / factor]);
  }
  return coords;
}

export const R_EARTH = 6371008.8;

export function haversine(a: LatLng, b: LatLng): number {
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const lat1 = a[1] * toRad;
  const lat2 = b[1] * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearing(a: LatLng, b: LatLng): number {
  const toRad = Math.PI / 180;
  const lon1 = a[0] * toRad, lat1 = a[1] * toRad;
  const lon2 = b[0] * toRad, lat2 = b[1] * toRad;
  const y = Math.sin(lon2 - lon1) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

export function formatDistance(meters: number, units: 'metric' | 'imperial'): string {
  if (units === 'imperial') {
    // Google Maps uses feet for short distances and miles for longer ones;
    // the switch-over is around 0.1 mi (~528 ft / 161 m).
    const ft = meters * 3.28084;
    const mi = meters / 1609.344;
    if (mi < 0.1) return `${snapTo(ft, 50, meters > 0)} ft`;
    return mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`;
  }
  if (meters < 20) return `${snapTo(meters, 5, meters > 0)} m`;
  if (meters < 1000) return `${snapTo(meters, 10, meters > 0)} m`;
  const km = meters / 1000;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

/**
 * Round to the nearest `step`, but never round a real distance down to nothing.
 *
 * Snapping 4 m to the nearest 5 m gives 0, and "0 m to destination" is a
 * statement about the world, not a rounding artefact: a driver who is still on
 * the road reads it as *you have arrived*, and stops looking. A genuinely zero
 * distance still prints 0 — this only rescues a value that is nonzero and would
 * otherwise be reported as none. Rounding *up* to one step is the truthful
 * direction, because it over-estimates the distance remaining rather than
 * under-estimating it.
 */
function snapTo(value: number, step: number, nonzero: boolean): number {
  const snapped = Math.round(value / step) * step;
  return nonzero && snapped === 0 ? step : snapped;
}

/** Android Auto / Google Maps style compact duration ("1 hr 5 min", "24 min"). */
export function formatDuration(seconds: number): string {
  // Google Maps shows "<1 min" for anything under 60 s rather than rounding to 0.
  if (seconds < 60) return '<1 min';
  const mins = Math.round(seconds / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m} min`;
  if (h === 1) return m === 0 ? '1 hr' : `1 hr ${m} min`;
  return `${h} hr ${m} min`;
}

export function formatClock(date: Date): string {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Snap a point to the closest position on a polyline; returns dist + index. */
export function snapToPolyline(pt: LatLng, line: LatLng[]): { index: number; dist: number; point: LatLng } {
  // A line with fewer than two points has no segment to project onto. Report
  // the point as the answer and a distance of 0, not Infinity: an infinite
  // distance reads as "maximally off route", which would fail a threshold
  // comparison and claim the driver is lost when there is no route to be lost
  // from.
  if (line.length < 2) {
    return { index: 0, dist: 0, point: line[0] ?? pt };
  }
  let best = { index: 0, dist: Infinity, point: line[0] };
  for (let i = 0; i < line.length - 1; i++) {
    const [px, py] = projectOnSegment(pt, line[i], line[i + 1]);
    // Measure in metres, not degrees: a degree of longitude is ~cos(lat) times
    // a degree of latitude, so a Euclidean degree distance badly understates
    // east-west deviation and would make off-route detection useless.
    const d = haversine(pt, [px, py]);
    if (d < best.dist) best = { index: i, dist: d, point: [px, py] };
  }
  return best;
}

/**
 * Where on a polyline a point sits, in **metres from the start of the line**.
 *
 * `snapToPolyline` answers "which segment is nearest", which is the right
 * question for "which leg am I on" and the wrong one for "how far is left". A
 * segment index has three problems that matter to a driver:
 *
 *  - It counts *vertices*, not distance, so the same road is a different number
 *    of steps depending on how finely the geometry was tessellated.
 *  - It names the segment's **start**, so a car mid-segment is reported as being
 *    a whole segment behind where it is, and a car between the last two
 *    vertices reads as being a whole segment short of the destination.
 *  - It cannot express arrival at all on a multi-vertex line.
 *
 * Measuring in metres fixes all three, and gives the monotonic quantity the ETA
 * needs: `along` only grows as the car drives forward.
 *
 * The nearest point is still chosen over the *whole* line, with no memory of
 * where the car was. That is correct for a single fix and wrong as a time
 * series — a route that doubles back has two equally near candidates, and the
 * closer one can be behind the driver. Enforcing "never goes backwards" needs
 * the previous position, so it lives in `nav/progress.ts` rather than here.
 */
export function snapAlong(
  pt: LatLng,
  line: LatLng[],
): { along: number; dist: number; point: LatLng; index: number } {
  if (line.length < 2) {
    return { along: 0, dist: 0, point: line[0] ?? pt, index: 0 };
  }
  let bestIndex = 0;
  let bestDist = Infinity;
  let bestPoint: LatLng = line[0];
  for (let i = 0; i < line.length - 1; i++) {
    const [px, py] = projectOnSegment(pt, line[i], line[i + 1]);
    const d = haversine(pt, [px, py]);
    if (d < bestDist) {
      bestDist = d;
      bestIndex = i;
      bestPoint = [px, py];
    }
  }
  // Distance from the start of the line to the winning projection: the full
  // length of every segment before it, plus the part of this one it used.
  let along = 0;
  for (let i = 0; i < bestIndex; i++) along += haversine(line[i], line[i + 1]);
  along += haversine(line[bestIndex], bestPoint);
  return { along, dist: bestDist, point: bestPoint, index: bestIndex };
}

/**
 * Project `p` onto segment `a`–`b`, returning the point and the parameter `t`
 * along the segment (0 at `a`, 1 at `b`, clamped).
 *
 * `t` is returned because a vertex index cannot express where inside a segment
 * the car actually is — see `snapAlong`.
 */
function projectOnSegment(p: LatLng, a: LatLng, b: LatLng): [number, number, number] {
  // Work in local metres so the projection stays well-conditioned at small spans.
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos((a[1] * Math.PI) / 180);
  const mLat = (p[1] - a[1]) * mPerDegLat;
  const mLon = (p[0] - a[0]) * mPerDegLon;
  const bx = (b[0] - a[0]) * mPerDegLon;
  const by = (b[1] - a[1]) * mPerDegLat;
  const len2 = bx * bx + by * by;
  if (len2 === 0) return [a[0], a[1], 0];
  let t = (mLon * bx + mLat * by) / len2;
  t = Math.max(0, Math.min(1, t));
  return [a[0] + (t * bx) / mPerDegLon, a[1] + (t * by) / mPerDegLat, t];
}

/**
 * The vertex nearest a given distance along a polyline.
 *
 * The inverse of `snapAlong`, for the places that need a vertex index — the
 * dimmed/drawn portion of the route line, or the point a step list is scanned
 * from. Those are inherently per-vertex, so the conversion has to happen
 * explicitly and from a distance-based position: deriving them from a fresh
 * projection is what let the drawn "already driven" portion and the ETA disagree
 * about where the car is.
 */
export function vertexAt(line: LatLng[], along: number): number {
  if (line.length < 2) return 0;
  const total = lineLength(line);
  const target = Math.max(0, Math.min(total, along));
  let acc = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const seg = haversine(line[i], line[i + 1]);
    if (acc + seg >= target) {
      const into = target - acc;
      return into < seg - into ? i : i + 1;
    }
    acc += seg;
  }
  return line.length - 1;
}

/** Total length of a polyline in metres. */
export function lineLength(line: LatLng[]): number {
  let t = 0;
  for (let i = 1; i < line.length; i++) t += haversine(line[i - 1], line[i]);
  return t;
}

/** Interpolate a position at `frac` (0..1) of the way along a polyline. */
export function pointAtFraction(line: LatLng[], frac: number): LatLng {
  const total = lineLength(line);
  let target = total * frac;
  for (let i = 1; i < line.length; i++) {
    const seg = haversine(line[i - 1], line[i]);
    if (target <= seg) {
      const t = seg === 0 ? 0 : target / seg;
      return [
        line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t,
        line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t,
      ];
    }
    target -= seg;
  }
  return line[line.length - 1] ?? [0, 0];
}

/** Bounding box [west, south, east, north] of a set of points. */
export function bboxOf(pts: LatLng[]): [number, number, number, number] {
  let w = 180, s = 90, e = -180, n = -90;
  for (const [x, y] of pts) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return [w, s, e, n];
}

/** Downsample a polyline to at most `max` points (Douglas-Peucker-lite by stride). */
export function simplify(line: LatLng[], max = 4000): LatLng[] {
  if (line.length <= max) return line;
  const stride = Math.ceil(line.length / max);
  const out: LatLng[] = [];
  for (let i = 0; i < line.length; i += stride) out.push(line[i]);
  if (out[out.length - 1] !== line[line.length - 1]) out.push(line[line.length - 1]);
  return out;
}
