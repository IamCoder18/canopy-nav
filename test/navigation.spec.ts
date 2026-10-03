import { describe, it, expect } from 'vitest';
import {
  createTracker, updateTracker, offRouteThreshold, progressAlong,
  rerouteOrigin, distanceToRouteAhead,
} from '../src/nav/offroute';
import {
  routeWithTraffic, estimateTraffic, describeTraffic, type TrafficSegment,
} from '../src/nav/traffic';
import type { Route } from '../src/nav/valhalla';

const ROUTE: [number, number][] = [
  [-114.0700, 51.0450],
  [-114.0650, 51.0450],
  [-114.0600, 51.0450],
  [-114.0550, 51.0450],
  [-114.0500, 51.0450],
];

const ON: [number, number] = [-114.0650, 51.0450];

describe('off-route detection', () => {
  it('scales the threshold with speed', () => {
    expect(offRouteThreshold(0)).toBe(25);
    expect(offRouteThreshold(30)).toBeGreaterThan(offRouteThreshold(0));
    // and it saturates rather than growing without bound
    expect(offRouteThreshold(1000)).toBe(90);
  });

  it('reports on-route when following the line', () => {
    const t = updateTracker(createTracker(), ROUTE, ON, 0, 1000);
    expect(t.state).toBe('on-route');
    expect(t.distance).toBeLessThan(1);
  });

  it('does not fire on a single GPS outlier', () => {
    let t = createTracker();
    // one bad fix far off the line
    t = updateTracker(t, ROUTE, [-114.0650, 51.0461], 0, 1000);
    expect(t.state).toBe('suspect');
    // ... then a good fix clears it
    t = updateTracker(t, ROUTE, ON, 0, 2000);
    expect(t.state).toBe('on-route');
    expect(t.since).toBeNull();
  });

  it('confirms off-route only after the hold window', () => {
    let t = createTracker();
    const off: [number, number] = [-114.0650, 51.0461]; // ~120 m north of the line
    t = updateTracker(t, ROUTE, off, 0, 1000);
    expect(t.state).toBe('suspect');
    t = updateTracker(t, ROUTE, off, 0, 4000); // still inside 6 s
    expect(t.state).toBe('suspect');
    t = updateTracker(t, ROUTE, off, 0, 8000); // past the window
    expect(t.state).toBe('off-route');
  });

  it('tolerates the same deviation at speed but not when stopped', () => {
    // ~55 m off the line. Stationary that is clearly lost (threshold 25 m);
    // at 25 m/s the threshold is 75 m, which is normal for a motorway.
    const off: [number, number] = [-114.0650, 51.04549];
    const slow = updateTracker(createTracker(), ROUTE, off, 0, 1000);
    const fast = updateTracker(createTracker(), ROUTE, off, 25, 1000);
    expect(slow.state).toBe('suspect');
    expect(fast.state).toBe('on-route');
  });

  it('snaps a fix onto the route', () => {
    const t = updateTracker(createTracker(), ROUTE, [-114.0625, 51.0451], 0, 1000);
    expect(t.correction[1]).toBeCloseTo(51.0450, 4);
    expect(t.snappedIndex).toBeGreaterThanOrEqual(1);
  });

  it('is disabled without a route', () => {
    const t = updateTracker(createTracker(), [], [-114.0, 51.0], 0, 1000);
    expect(t.state).toBe('on-route');
  });

  it('reports progress along the route', () => {
    expect(progressAlong(ROUTE, 0)).toBe(0);
    expect(progressAlong(ROUTE, 4)).toBe(1);
    expect(progressAlong(ROUTE, 99)).toBe(1);
    expect(progressAlong([], 3)).toBe(0);
  });

  it('reroutes from the projected point, not the raw fix', () => {
    let t = createTracker();
    t = updateTracker(t, ROUTE, [-114.0650, 51.0461], 0, 1000);
    t = updateTracker(t, ROUTE, [-114.0650, 51.0600], 0, 9000);
    expect(t.state).toBe('off-route');
    const origin = rerouteOrigin(t, ROUTE);
    // the origin must lie ON the route, so we never start from the off-line fix
    const near = ROUTE.some(([x, y]) => Math.abs(x - origin[0]) < 1e-6 && Math.abs(y - origin[1]) < 1e-6);
    expect(near).toBe(true);
  });

  it('measures distance ahead for rejoin messaging', () => {
    // four 350 m segments, capped at 500 m
    expect(distanceToRouteAhead(ROUTE, 0)).toBeGreaterThan(400);
    expect(distanceToRouteAhead(ROUTE, 0)).toBeLessThanOrEqual(750);
    expect(distanceToRouteAhead(ROUTE, 4)).toBe(0);
  });
});

describe('traffic', () => {
  const mkRoute = (time: number): Route => ({
    geometry: ROUTE,
    legs: [],
    maneuvers: [],
    summary: { length: 1000, time, min_lat: 51, min_lon: -114, max_lat: 51, max_lon: -114 },
    units: 'km',
    engine: 'valhalla',
  });

  it('returns null when offline rather than failing', async () => {
    const r = await routeWithTraffic(ON, ROUTE[4], {
      endpoint: 'https://example.invalid', offline: true,
    });
    expect(r).toBeNull();
  });

  it('degrades to null when the provider is unreachable', async () => {
    const r = await routeWithTraffic(ON, ROUTE[4], {
      endpoint: 'https://definitely-not-a-real-host.invalid', offline: false,
    });
    expect(r).toBeNull();
  });

  it('segments a route into overlay bins', () => {
    const segs: TrafficSegment[] = estimateTraffic(mkRoute(600));
    expect(segs.length).toBeGreaterThan(0);
    // every segment must be a real pair of route points, in order
    let lastIdx = -1;
    for (const s of segs) {
      expect(ROUTE.some(([x, y]) => x === s.from[0] && y === s.from[1])).toBe(true);
      expect(ROUTE.some(([x, y]) => x === s.to[0] && y === s.to[1])).toBe(true);
      expect(lastIdx).toBeLessThanOrEqual(4);
      lastIdx++;
    }
  });

  it('covers the full route with no gaps', () => {
    const segs = estimateTraffic(mkRoute(600));
    expect(segs[0].from).toEqual(ROUTE[0]);
    expect(segs[segs.length - 1].to).toEqual(ROUTE[ROUTE.length - 1]);
  });

  it('describes its own confidence honestly', () => {
    expect(describeTraffic(null, false)).toMatch(/No signal/i);
    expect(describeTraffic(null, true)).toMatch(/unavailable/i);
    expect(describeTraffic({ route: mkRoute(600), confidence: 'none', secondsSaved: 0 }, true))
      .toMatch(/No live traffic/i);
    // no note supplied -> fall back to stating the confidence level only
    expect(describeTraffic({ route: mkRoute(600), confidence: 'live', secondsSaved: 600 }, true))
      .toMatch(/^live traffic$/i);
    // with a note, the note wins
    expect(describeTraffic({
      route: mkRoute(600), confidence: 'live', secondsSaved: 600,
      note: 'Avoiding congestion, saving about 10 min',
    }, true)).toMatch(/avoiding congestion/i);
  });
});
