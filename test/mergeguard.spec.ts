/**
 * The merge memory guard.
 *
 * A merge is the most expensive thing the app does, and on a phone it can fail by
 * killing the WebView rather than by throwing — so the decision to attempt one
 * is made from static size, before any of it runs. These tests pin the three
 * outcomes and, more importantly, the behaviour at the boundaries, because a
 * guard that is only ever tested with comfortable numbers is a guard that has
 * never been tested.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  canMerge, graphBytes, heapLimitBytes,
  BYTES_PER_NODE, BYTES_PER_EDGE, MEMORY_FRACTION, THIN_HEADROOM, ASSUMED_HEAP_MB,
} from '../src/osm/mergeguard';
import type { RoadGraph } from '../src/osm/engine.worker';

/** A graph of the requested shape, with the typed arrays the real one has. */
function graph(nodeCount: number, edges: number): RoadGraph {
  return {
    coords: new Float64Array(nodeCount * 2),
    osmIds: new Float64Array(nodeCount),
    edgeStart: new Uint32Array(nodeCount + 1),
    edgeTo: new Int32Array(edges),
    edgeCost: new Float32Array(edges),
    edgeFlags: new Uint8Array(edges),
    edgeName: new Array(edges).fill(''),
    nodeCount,
  };
}

const nav = globalThis.navigator as Navigator & { deviceMemory?: number };

/** The guard's limit parameter is in bytes; tests talk in MiB. */
const mb = (n: number) => n * 1024 * 1024;

afterEach(() => {
  // `navigator.deviceMemory` is read-only in a browser but is an own property in
  // a test environment, so it has to be put back or it leaks into the next file.
  if ('deviceMemory' in nav) delete (nav as { deviceMemory?: number }).deviceMemory;
});

describe('graphBytes', () => {
  it('is derived from the arrays the graph actually holds', () => {
    const g = graph(1000, 4000);
    expect(graphBytes(g)).toBe(1000 * BYTES_PER_NODE + 4000 * BYTES_PER_EDGE);
  });

  it('is zero for an empty graph', () => {
    expect(graphBytes(graph(0, 0))).toBe(0);
  });
});

describe('heapLimitBytes', () => {
  it('prefers what the device states, taking a share of it', () => {
    (nav as { deviceMemory?: number }).deviceMemory = 8;
    const { bytes, assumed } = heapLimitBytes();
    expect(assumed).toBe(false);
    expect(bytes).toBe(8 * 1024 * 1024 * 1024 * MEMORY_FRACTION);
  });

  it('assumes rather than reading a missing value as unlimited', () => {
    const { bytes, assumed } = heapLimitBytes();
    expect(assumed).toBe(true);
    expect(bytes).toBe(ASSUMED_HEAP_MB * 1024 * 1024);
  });

  it('ignores a nonsensical deviceMemory rather than trusting it', () => {
    (nav as { deviceMemory?: number }).deviceMemory = 0;
    expect(heapLimitBytes().assumed).toBe(true);
  });
});

describe('canMerge', () => {
  it('proceeds for two small extracts', () => {
    const v = canMerge([graph(2000, 8000), graph(2000, 8000)], mb(4096));
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.thin).toBe(false);
  });

  it('reports the shortfall instead of failing silently', () => {
    // Two graphs far too big for the stated heap.
    const v = canMerge([graph(4_000_000, 16_000_000), graph(4_000_000, 16_000_000)], mb(64));
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toMatch(/memory/i);
      // The message has to name both numbers, or the driver cannot tell whether
      // the problem is their device or their download.
      expect(v.reason).toMatch(/MB/);
      expect(v.reason).toMatch(/extract|engine/i);
    }
  });

  it('warns without refusing when the headroom is thin', () => {
    // Somewhere between THIN_HEADROOM and 1.0 of the budget.
    const small = [graph(1000, 4000)];
    const base = small.reduce((s, g) => s + graphBytes(g), 0);
    const needed = base * 2.5 * 3;
    // Budget chosen so needed / budget is just under 1.
    const budget = needed / 0.9;
    const v = canMerge(small, budget / MEMORY_FRACTION);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.thin).toBe(true);
      expect(v.memory.ratio).toBeGreaterThan(THIN_HEADROOM);
    }
  });

  it('is exactly at the boundary: a ratio of 1 is allowed, above 1 is not', () => {
    const g = graph(1000, 4000);
    const needed = graphBytes(g) * 2.5 * 3;
    const atLimit = canMerge([g], needed / MEMORY_FRACTION);
    expect(atLimit.ok).toBe(true);
    const overLimit = canMerge([g], (needed / MEMORY_FRACTION) * 0.99);
    expect(overLimit.ok).toBe(false);
  });

  it('never claims unlimited when the budget cannot be determined', () => {
    // A zero budget is not "infinite headroom"; it is an unknown one.
    const v = canMerge([graph(1000, 4000)], 0);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/cannot estimate/i);
  });

  it('scales with the number of regions, not just their size', () => {
    // Four small regions need four times the transient copy of two, even though
    // each one alone is comfortable. A guard that looked at only the largest
    // graph would wave this through.
    const one = [graph(500_000, 2_000_000)];
    const four = [graph(500_000, 2_000_000), graph(500_000, 2_000_000),
                  graph(500_000, 2_000_000), graph(500_000, 2_000_000)];
    const limit = mb(2048);
    expect(canMerge(one, limit).ok).toBe(true);
    expect(canMerge(four, limit).ok).toBe(false);
  });

  it('proceeds for an empty set rather than dividing by zero', () => {
    expect(canMerge([], 4096).ok).toBe(true);
  });

  it('accounts for the sources staying resident, not just the result', () => {
    // The multiplier is what makes this true; asserting it keeps the constant
    // honest, because lowering TRANSIENT_MULTIPLIER to make a device "fit" is the
    // obvious and wrong way to make this test pass.
    const g = graph(1000, 4000);
    const v = canMerge([g], mb(4096));
    if (v.ok) {
      expect(v.memory.needed).toBeGreaterThan(graphBytes(g) * 2);
    }
  });
});
