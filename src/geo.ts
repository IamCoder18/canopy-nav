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
    if (mi < 0.1) return `${Math.round(ft / 50) * 50} ft`;
    return mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`;
  }
  if (meters < 20) return `${Math.round(meters / 5) * 5} m`;
  if (meters < 1000) return `${Math.round(meters / 10) * 10} m`;
  const km = meters / 1000;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
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
  let best = { index: 0, dist: Infinity, point: line[0] ?? pt };
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

function projectOnSegment(p: LatLng, a: LatLng, b: LatLng): [number, number] {
  // Work in local metres so the projection stays well-conditioned at small spans.
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos((a[1] * Math.PI) / 180);
  const mLat = (p[1] - a[1]) * mPerDegLat;
  const mLon = (p[0] - a[0]) * mPerDegLon;
  const bx = (b[0] - a[0]) * mPerDegLon;
  const by = (b[1] - a[1]) * mPerDegLat;
  const len2 = bx * bx + by * by;
  if (len2 === 0) return [a[0], a[1]];
  let t = (mLon * bx + mLat * by) / len2;
  t = Math.max(0, Math.min(1, t));
  return [a[0] + (t * bx) / mPerDegLon, a[1] + (t * by) / mPerDegLat];
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
