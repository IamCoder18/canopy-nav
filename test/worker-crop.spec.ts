/**
 * The worker's `build` handler, and the crop travelling through it.
 *
 * ## Why this file exists
 *
 * §15.1 item 2 puts a bbox filter in the reader, and `test/pbfcrop.spec.ts` proves the
 * reader honours a box. That leaves one link unproven: that a crop handed to
 * `OsmEngine.build(file, crop)` survives the trip — postMessage, structured clone, the
 * worker's `build` handler, `parseOsmPbfStream` — and comes out the other side as a
 * *cropped* dataset.
 *
 * **The browser suite cannot close this, and the attempt to is worth recording.** The e2e
 * block drives the area-crop button with a 146 MB fixture whose body is padding, so both
 * a cropped and an uncropped parse of it end in "contains no OpenStreetMap data". Two
 * reversals — `store.ts` dropping `req.crop`, and the guard re-applying the whole-file
 * refusal — both left that check **green**, which is how the limit was found. Asserting a
 * crop was *requested* is not asserting it was *applied*.
 *
 * So the link is closed here instead, with a fixture whose content differs **inside and
 * outside** the box. That is the only shape that can tell the two apart: if the data
 * inside the box is what loads, and the data outside it does not, then the filter ran.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PbfCrop } from '../src/osm/pbf';

const REAL_PBF = join(__dirname, 'fixture.osm.pbf');

/**
 * Run the worker's `build` handler once, in Node, with `self` stubbed.
 *
 * The handler is installed by importing `engine.worker.ts` for its side effect — that is
 * what a real Worker does — and it is driven through the same `postMessage` shape the
 * browser uses, including the `stream` path. So this exercises the seam rather than a
 * function extracted from it.
 */
async function runWorkerBuild(
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; dataset?: Record<string, unknown>; message?: string }> {
  const posted: unknown[] = [];
  const g = globalThis as unknown as {
    self: { postMessage(m: unknown): void; onmessage: ((ev: unknown) => void) | null };
  };
  const realSelf = g.self;
  g.self = {
    postMessage(m: unknown) { posted.push(m); },
    onmessage: null,
  };
  try {
    // Fresh module registry each call, because the handler assigns `self.onmessage` at
    // import time and a second import would not re-install it.
    vi.resetModules();
    await import('../src/osm/engine.worker');
    const handler = g.self.onmessage;
    if (!handler) throw new Error('the worker installed no onmessage handler');
    await handler({ data: { type: 'build', payload } } as unknown as MessageEvent);
    // The handler is async and posts `built` or `error` when it finishes; drain the queue.
    for (let i = 0; i < 200 && posted.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const built = posted.find((m) => (m as { type?: string }).type === 'built') as
      | { type: 'built'; payload: Record<string, unknown> }
      | undefined;
    const failed = posted.find((m) => (m as { type?: string }).type === 'error') as
      | { type: 'error'; message: string }
      | undefined;
    if (built) return { ok: true, dataset: built.payload };
    return { ok: false, message: failed?.message ?? 'the worker posted nothing' };
  } finally {
    g.self = realSelf;
  }
}

describe('the worker build handler', () => {
  it('builds a dataset from a real PBF', async () => {
    const bytes = new Uint8Array(readFileSync(REAL_PBF));
    const r = await runWorkerBuild({ bytes: bytes.buffer, format: 'pbf' });
    expect(r.ok, r.message).toBe(true);
    const counts = r.dataset!.counts as { routable: number; nodes: number };
    expect(counts.nodes).toBeGreaterThan(0);
    expect(r.dataset!.cropApplied).toBe(false);
    expect((r.dataset!.cropStats as { cropped: boolean }).cropped).toBe(false);
  });

  /**
   * The crop, through the seam.
   *
   * The fixture spans lat 51.18–53.55 and lon -115.57 to -1.32 — a deliberately scattered
   * test set, which is ideal here: a box around Edinburgh keeps the eastern nodes and
   * drops everything in the -115 range, so a filter that did nothing would keep all 103
   * and this fails.
   */
  it('applies a crop and reports what it kept', async () => {
    const bytes = new Uint8Array(readFileSync(REAL_PBF));
    const whole = await runWorkerBuild({ bytes: bytes.buffer.slice(0), format: 'pbf' });
    expect(whole.ok, whole.message).toBe(true);
    const wholeCounts = whole.dataset!.counts as { nodes: number };

    // A box tight around the fixture's eastern cluster (Edinburgh, ~51.5/-1.4).
    const crop: PbfCrop = { west: -1.45, south: 51.45, east: -1.30, north: 51.65 };
    const cropped = await runWorkerBuild(
      { bytes: bytes.buffer.slice(0), format: 'pbf', crop },
    );
    expect(cropped.ok, cropped.message).toBe(true);

    const stats = cropped.dataset!.cropStats as {
      seenNodes: number; keptNodes: number; ways: number; cropped: boolean;
    };
    expect(cropped.dataset!.cropApplied).toBe(true);
    expect(stats.cropped).toBe(true);
    // The load-bearing assertion: fewer nodes survived than were seen, and fewer than
    // the uncropped parse kept. A worker that dropped the crop reports seen === kept.
    expect(stats.seenNodes).toBe(wholeCounts.nodes);
    expect(stats.keptNodes).toBeLessThan(stats.seenNodes);
    expect(stats.keptNodes).toBeGreaterThan(0);
    const croppedCounts = cropped.dataset!.counts as { nodes: number };
    expect(croppedCounts.nodes).toBe(stats.keptNodes);
    expect(croppedCounts.nodes).toBeLessThan(wholeCounts.nodes);
  });

  /**
   * The same crop over the **stream** path, which is the one production uses.
   *
   * §14.16 moved `.osm.pbf` to a stream handle, and `engine.build` prefers it whenever
   * the file has a `stream()` — which a real `File` always does. A first version of this
   * file posted `bytes` only, and reversing the *stream* call's crop argument left all
   * three tests green, because that line was never executed. So both paths are asserted,
   * and they are separate `postMessage` shapes in the worker.
   */
  it('applies a crop over the streaming path too', async () => {
    const bytes = new Uint8Array(readFileSync(REAL_PBF));
    const crop: PbfCrop = { west: -1.45, south: 51.45, east: -1.3, north: 51.65 };
    // A `ReadableStream` shaped exactly like the one `engine.ts` posts, and deliberately
    // chunked at 5 bytes, since the reader must not care about boundaries.
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 5) chunks.push(bytes.subarray(i, i + 5));
    const stream = new ReadableStream<Uint8Array>({
      start(c) { for (const ch of chunks) c.enqueue(ch); c.close(); },
    });

    const r = await runWorkerBuild({ stream, format: 'pbf', totalBytes: bytes.length, crop });
    expect(r.ok, r.message).toBe(true);
    expect(r.dataset!.cropApplied).toBe(true);
    const stats = r.dataset!.cropStats as { seenNodes: number; keptNodes: number; cropped: boolean };
    expect(stats.cropped).toBe(true);
    expect(stats.keptNodes).toBeGreaterThan(0);
    expect(stats.keptNodes).toBeLessThan(stats.seenNodes);
  });

  /**
   * That `OsmEngine` puts the crop in the message at all.
   *
   * The two tests above drive the worker's handler directly, so they cannot see
   * `engine.ts` — and reversing `OsmEngine.build` to drop its `crop` argument left them
   * green, because the argument never crossed that seam.
   *
   * Node has no `Worker`, so one is stubbed that records what it was posted. The claim is
   * about the payload, not about parsing: that a box survives the trip across the boundary
   * a real worker would cross.
   */
  it('puts the crop in the message OsmEngine sends', async () => {
    const bytes = new Uint8Array(readFileSync(REAL_PBF));
    const crop: PbfCrop = { west: -1.45, south: 51.45, east: -1.3, north: 51.65 };
    const posted: { payload: Record<string, unknown> }[] = [];

    const g = globalThis as unknown as { Worker?: unknown };
    const realWorker = g.Worker;
    g.Worker = class {
      onmessage: ((ev: unknown) => void) | null = null;
      onerror: ((ev: unknown) => void) | null = null;
      onmessageerror: ((ev: unknown) => void) | null = null;
      set onProgress(_: unknown) { /* engine.ts assigns this */ }
      postMessage(msg: { payload: Record<string, unknown> }) { posted.push(msg); }
      dispose() { /* nothing to release */ }
    };
    try {
      const { OsmEngine } = await import('../src/osm/engine');
      const engine = new OsmEngine();
      const file = {
        name: 'fixture.osm.pbf',
        size: bytes.length,
        // `OsmFile.slice` returns an object with `arrayBuffer()`, not bytes -- the
        // engine only ever asks for the head. Getting this wrong throws inside
        // `build`, where it is swallowed, and the test then fails as "nothing was
        // posted", which reads as a wiring problem rather than a stub problem.
        // Synchronous `slice` returning `{ arrayBuffer() }` -- the engine calls
        // `file.slice(0, 32).arrayBuffer()` without awaiting the slice itself, so an
        // `async` stub returns a Promise and the method is missing. Which threw inside
        // `build`, where it was swallowed, and surfaced as "nothing was posted".
        slice: (a: number, b?: number) => ({
          arrayBuffer: async () => bytes.buffer.slice(a, b ?? bytes.length),
        }),
        arrayBuffer: async () => bytes.buffer.slice(0),
        text: async () => '',
        stream: () => new ReadableStream<Uint8Array>({
          start(c) { c.enqueue(bytes); c.close(); },
        }),
      };
      // It never resolves: the stub worker never replies. What is asserted is the
      // message, so a build left hanging is the correct shape rather than a timeout.
      // The rejection is captured rather than discarded: `build` swallows its own errors
      // into the promise, so a stub mistake here is otherwise invisible.
      let buildError: string | null = null;
      void engine.build(file, crop).catch((e: Error) => { buildError = e.message; });
      for (let i = 0; i < 50 && posted.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(buildError, 'the stub build threw before posting').toBeNull();
      expect(posted.length).toBeGreaterThan(0);
      expect(posted[0].payload.format).toBe('pbf');
      expect(posted[0].payload.crop).toEqual(crop);
    } finally {
      g.Worker = realWorker;
    }
  });

  it('says so when a crop is asked for on a format that cannot honour one', async () => {
    const xml = readFileSync(join(__dirname, 'fixture.osm'), 'utf8');
    const r = await runWorkerBuild({
      text: xml,
      format: 'xml',
      crop: { west: -1.45, south: 51.45, east: -1.3, north: 51.65 },
    });
    expect(r.ok, r.message).toBe(true);
    // Not silently ignored: a caller trying to avoid being OOM-killed must be able to
    // tell that its crop did not happen.
    expect(r.dataset!.cropIgnored).toBe(true);
    expect(r.dataset!.cropApplied).toBe(false);
    expect(r.dataset!.cropStats).toBeNull();
  });
});