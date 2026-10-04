/**
 * Region download tests.
 *
 * `fetch` is replaced with a mock that hands back a real `Response` carrying a
 * `ReadableStream`, because the whole point of `src/regions/download.ts` is
 * what it does with a *stream*: chunk boundaries, a body that stops early, a
 * body that is not OSM data at all, a body the user cancels halfway. A mock
 * that returned one pre-built buffer would pass a module that called
 * `response.arrayBuffer()` on a province.
 *
 * The payloads are synthetic and deterministic so "the bytes came back exactly
 * as they were sent" is an equality check rather than a round-trip through a
 * fixture. Where a format matters the payload starts the way the real thing
 * does: a PBF begins with a 4-byte big-endian blob-header length, an `.osm`
 * with `<?xml`.
 *
 * The last block additionally fakes Capacitor's Filesystem plugin, so the code
 * that only ever runs on a device — writing a part file, resuming from it, and
 * re-reading a finished extract — is covered here rather than on a phone.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  downloadRegion, checkRegionAvailable, sniffFormat, formatBytes,
  DownloadError, type DownloadProgress,
} from '../src/regions/download';
import type { CatalogEntry } from '../src/osm/regions';

/* ------------------------------- fixtures ------------------------------- */

const AB: CatalogEntry = {
  id: 'ca-ab',
  name: 'Alberta',
  country: 'Canada',
  pbfUrl: 'https://download.geofabrik.de/north-america/canada/alberta-latest.osm.pbf',
  approxMb: 380,
  parentId: 'ca',
};

/** A plausible PBF head: big-endian blob length, then `OSMHeader`. */
function pbfBytes(n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(n);
  out.set([0x00, 0x00, 0x01, 0x02], 0);      // blob header length = 258
  for (let i = 4; i < n; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

function encoder(): TextEncoder { return new TextEncoder(); }

function bytesOf(s: string): Uint8Array { return encoder().encode(s); }

/**
 * Byte-for-byte comparison that reports *where* the two differ.
 *
 * `expect(Array.from(a)).toEqual(Array.from(b))` on a multi-megabyte payload
 * spends most of its time building two 6-million-element arrays, which is why
 * the device tests below use this instead.
 */
function expectSameBytes(actual: Uint8Array, expected: Uint8Array) {
  const n = Math.min(actual.length, expected.length);
  let at = -1;
  for (let i = 0; i < n; i++) {
    if (actual[i] !== expected[i]) { at = i; break; }
  }
  const same = at === -1 && actual.length === expected.length;
  expect(
    same,
    same
      ? `identical, ${actual.length} bytes`
      : `differs at byte ${at} (got ${actual.length} bytes, want ${expected.length})`,
  ).toBe(true);
}

const XML_DOC =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<osm version="0.6" generator="test">\n' +
  '  <note>café ☃ — naïve</note>\n' +
  '</osm>\n';

/** A 200-with-HTML-body, i.e. a captive portal or Geofabrik's own 404 page. */
const HTML_PAGE =
  '<!DOCTYPE html>\n<html><head><title>404 Not Found</title></head>' +
  '<body><h1>Not Found</h1><p>The requested URL was not found.</p></body></html>\n';

/* --------------------------------- fetch -------------------------------- */

/** A Response whose body is a ReadableStream that emits `chunks` in order. */
function streaming(chunks: readonly Uint8Array[], init: ResponseInit = {}): Response {
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[i++]);
    },
  });
  return new Response(stream as unknown as BodyInit, init);
}

function bytesResponse(data: Uint8Array, init: ResponseInit = {}): Response {
  return new Response(data as unknown as BodyInit, init);
}

interface FetchLog {
  (input: string, init?: RequestInit): Promise<Response>;
  calls: { url: string; headers: Record<string, string> }[];
}

function mockFetch(handler: (n: number) => Response | Promise<Response>): FetchLog {
  const log = ((input: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[k] = v;
    }
    log.calls.push({ url: String(input), headers });
    return Promise.resolve(handler(log.calls.length));
  }) as FetchLog;
  log.calls = [];
  return log;
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ------------------------------ progress ------------------------------- */

function collect() {
  const seen: DownloadProgress[] = [];
  return { seen, onProgress: (p: DownloadProgress) => seen.push(p) };
}

describe('downloadRegion: progress', () => {
  it('reports monotonic progress ending at exactly 1', async () => {
    const payload = pbfBytes(1000);
    const parts = [payload.subarray(0, 250), payload.subarray(250, 700), payload.subarray(700)];
    vi.stubGlobal('fetch', mockFetch(() =>
      streaming(parts, { headers: { 'content-length': String(payload.length) } })));

    const { seen, onProgress } = collect();
    const res = await downloadRegion(AB, { onProgress, retries: 0 });

    expect(seen.length).toBeGreaterThanOrEqual(4);           // 0, then one per chunk
    expect(seen[0]).toEqual({ received: 0, total: 1000, fraction: 0 });
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i].received).toBeGreaterThanOrEqual(seen[i - 1].received);
      expect(seen[i].fraction).toBeGreaterThanOrEqual(seen[i - 1].fraction ?? 0);
    }
    expect(seen[seen.length - 1].received).toBe(1000);
    expect(seen[seen.length - 1].fraction).toBe(1);
    expect(res.size).toBe(1000);
  });

  it('leaves total and fraction null when Content-Length is absent', async () => {
    const payload = pbfBytes(300);
    // No content-length header at all: the size is genuinely unknown.
    vi.stubGlobal('fetch', mockFetch(() => streaming([payload.subarray(0, 100), payload.subarray(100)])));

    const { seen, onProgress } = collect();
    const res = await downloadRegion(AB, { onProgress, retries: 0 });

    expect(seen.length).toBeGreaterThan(1);
    for (const p of seen) {
      expect(p.total).toBeNull();
      expect(p.fraction).toBeNull();
    }
    expect(res.totalBytes).toBeNull();
    expect(res.size).toBe(300);
  });
});

/* ------------------------------ the bytes ------------------------------ */

describe('downloadRegion: bytes', () => {
  it('returns exactly the bytes the stream produced', async () => {
    const payload = pbfBytes(4096, 3);
    // Awkward sizes that still tile the whole payload exactly once.
    const chunks = [0, 13, 28, 55, 196, 2197].map(
      (n, i, all) => payload.subarray(n, (all[i + 1] ?? payload.length)),
    );
    vi.stubGlobal('fetch', mockFetch(() =>
      streaming(chunks, { headers: { 'content-length': String(payload.length) } })));

    const res = await downloadRegion(AB, { retries: 0 });
    expect(Array.from(new Uint8Array(await res.file.arrayBuffer())))
      .toEqual(Array.from(payload));
    expect(res.file.size).toBe(payload.length);
    expect(res.name).toBe('alberta-latest.osm.pbf');
    expect(res.format).toBe('pbf');
    expect(res.source).toBe('network');
  });

  it('reassembles correctly when chunk boundaries split multi-byte characters', async () => {
    // 'é' is two bytes and '☃' three, and both sit right where the awkward
    // one-byte-at-a-time chunking will cut them.
    const payload = bytesOf(XML_DOC);
    const chunks = Array.from(payload, (b) => new Uint8Array([b]));
    vi.stubGlobal('fetch', mockFetch(() =>
      streaming(chunks, { headers: { 'content-length': String(payload.length) } })));

    const res = await downloadRegion(AB, { retries: 0 });

    expect(res.format).toBe('xml');
    // The name follows the bytes, not the URL: this payload is XML, not PBF.
    expect(res.name).toBe('alberta-latest.osm');
    expect(await res.file.text()).toBe(XML_DOC);
    expect(Array.from(new Uint8Array(await res.file.arrayBuffer())))
      .toEqual(Array.from(payload));
  });
});

/* ------------------------------- failures ------------------------------ */

describe('downloadRegion: failures', () => {
  it('rejects an HTML error page as not OSM data, and does not retry it', async () => {
    const log = mockFetch(() =>
      // A captive portal answers 200, so only the bytes give it away.
      streaming([bytesOf(HTML_PAGE)], {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }));
    vi.stubGlobal('fetch', log);

    const err = await downloadRegion(AB, { retries: 2 }).then(
      () => { throw new Error('should have rejected'); },
      (e: DownloadError) => e,
    );

    expect(err).toBeInstanceOf(DownloadError);
    expect(err.code).toBe('not-osm');
    expect(err.message).toMatch(/not OSM data/i);
    expect(err.message).toContain(AB.pbfUrl);
    expect(err.message).toContain(AB.name);
    expect(log.calls).toHaveLength(1);          // a wrong payload is not retryable
  });

  it('rejects a 404 with the status in the message', async () => {
    const log = mockFetch(() => new Response('Not Found', { status: 404, statusText: 'Not Found' }));
    vi.stubGlobal('fetch', log);

    const err = await downloadRegion(AB, { retries: 2 }).then(
      () => { throw new Error('should have rejected'); },
      (e: DownloadError) => e,
    );

    expect(err.code).toBe('http');
    expect(err.status).toBe(404);
    expect(err.message).toContain('404');
    expect(err.message).toMatch(/wrong or the extract has been renamed/i);
    expect(log.calls).toHaveLength(1);
  });

  it('reports a stream that stops early, and does not claim success', async () => {
    const payload = pbfBytes(400);
    vi.stubGlobal('fetch', mockFetch(() =>
      // Says 400 bytes, sends 100, then closes cleanly.
      streaming([payload.subarray(0, 100)], { headers: { 'content-length': '400' } })));

    const err = await downloadRegion(AB, { retries: 0 }).then(
      () => { throw new Error('should have rejected'); },
      (e: DownloadError) => e,
    );

    expect(err.code).toBe('truncated');
    expect(err.message).toMatch(/stopped early/i);
    expect(err.message).toContain('400 B');
  });

  it('reports an empty body rather than importing nothing', async () => {
    vi.stubGlobal('fetch', mockFetch(() => streaming([], { headers: { 'content-length': '0' } })));

    const err = await downloadRegion(AB, { retries: 0 }).then(
      () => { throw new Error('should have rejected'); },
      (e: DownloadError) => e,
    );
    expect(err.code).toBe('empty');
  });

  it('reports a dead network with the host in the message', async () => {
    vi.stubGlobal('fetch', mockFetch(() => { throw new TypeError('fetch failed'); }));

    const err = await downloadRegion(AB, { retries: 0 }).then(
      () => { throw new Error('should have rejected'); },
      (e: DownloadError) => e,
    );
    expect(err.code).toBe('network');
    expect(err.message).toContain('download.geofabrik.de');
  });

  it('refuses before the first byte when the device is out of room', async () => {
    const log = mockFetch(() => streaming([pbfBytes(10)]));
    vi.stubGlobal('fetch', log);
    // 380 MB needed, 50 MB free.
    vi.stubGlobal('navigator', {
      storage: { estimate: async () => ({ quota: 100 * 1024 * 1024, usage: 50 * 1024 * 1024 }) },
    });

    const err = await downloadRegion(AB, { retries: 0 }).then(
      () => { throw new Error('should have rejected'); },
      (e: DownloadError) => e,
    );

    expect(err.code).toBe('disk-full');
    expect(err.message).toMatch(/not enough room/i);
    expect(err.message).toContain('380 MB');
    expect(log.calls).toHaveLength(0);          // refused up front
  });

  it('downloads when the platform cannot report free space', async () => {
    vi.stubGlobal('fetch', mockFetch(() =>
      streaming([pbfBytes(64)], { headers: { 'content-length': '64' } })));
    // No navigator.storage at all: an unknown answer must not block a download.
    vi.stubGlobal('navigator', {});

    const res = await downloadRegion(AB, { retries: 0 });
    expect(res.size).toBe(64);
  });
});

/* -------------------------------- abort -------------------------------- */

describe('downloadRegion: abort', () => {
  it('rejects with a clear error when the signal fires mid-stream', async () => {
    const payload = pbfBytes(400);
    const controller = new AbortController();
    const cancelled = { seen: false };

    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (i < 2) {
          c.enqueue(payload.subarray(i * 100, (i + 1) * 100));
          i++;
          return;
        }
        // Then stall, so the abort lands mid-stream rather than at the end.
        return new Promise<void>(() => {});
      },
      cancel() { cancelled.seen = true; },
    });

    const log = mockFetch(() => new Response(stream as unknown as BodyInit, {
      headers: { 'content-length': '400' },
    }));
    vi.stubGlobal('fetch', log);

    const seen: DownloadProgress[] = [];
    const err = await downloadRegion(AB, {
      retries: 2,
      signal: controller.signal,
      onProgress: (p) => {
        seen.push(p);
        // 100 bytes in: the user pressed cancel.
        if (p.received === 100) controller.abort();
      },
    }).then(
      () => { throw new Error('should have rejected'); },
      (e: DownloadError) => e,
    );

    expect(err).toBeInstanceOf(DownloadError);
    expect(err.code).toBe('aborted');
    expect(err.message).toMatch(/cancelled/i);
    expect(err.message).toContain(AB.name);
    expect(cancelled.seen).toBe(true);
    expect(log.calls).toHaveLength(1);          // an abort is never retried
    expect(seen[seen.length - 1].received).toBeLessThan(400);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const log = mockFetch(() => streaming([pbfBytes(10)]));
    vi.stubGlobal('fetch', log);

    const err = await downloadRegion(AB, {
      retries: 0,
      signal: AbortSignal.abort(),
    }).then(
      () => { throw new Error('should have rejected'); },
      (e: DownloadError) => e,
    );
    expect(err.code).toBe('aborted');
    expect(log.calls).toHaveLength(0);
  });
});

/* --------------------------- retry and resume -------------------------- */

describe('downloadRegion: retry', () => {
  it('resumes with a Range request after a connection dies at 60%', async () => {
    const payload = pbfBytes(1000);
    const log = mockFetch((n) => {
      if (n === 1) {
        // First attempt: 600 bytes arrive, then the connection drops.
        let sent = false;
        const stream = new ReadableStream<Uint8Array>({
          pull(c) {
            if (!sent) { sent = true; c.enqueue(payload.subarray(0, 600)); return; }
            c.error(new Error('connection reset'));
          },
        });
        return new Response(stream as unknown as BodyInit, {
          headers: { 'content-length': '1000', etag: '"abc123"' },
        });
      }
      // Retry: the server honours the range.
      return streaming([payload.subarray(600)], {
        status: 206,
        headers: { 'content-range': 'bytes 600-999/1000', 'content-length': '400' },
      });
    });
    vi.stubGlobal('fetch', log);

    const { seen, onProgress } = collect();
    const res = await downloadRegion(AB, { onProgress, retries: 1 });

    expect(log.calls).toHaveLength(2);
    expect(log.calls[1].headers.Range).toBe('bytes=600-');
    // If-Range lets the server refuse a prefix from a different version of the
    // file instead of splicing two different extracts together.
    expect(log.calls[1].headers['If-Range']).toBe('"abc123"');

    expect(Array.from(new Uint8Array(await res.file.arrayBuffer())))
      .toEqual(Array.from(payload));
    expect(res.size).toBe(1000);
    // Progress must never go backwards, even though the retry started at 600.
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i].received).toBeGreaterThanOrEqual(seen[i - 1].received);
    }
    expect(seen[seen.length - 1].fraction).toBe(1);
  });

  it('restarts from zero when the server ignores the range', async () => {
    const payload = pbfBytes(500);
    const log = mockFetch((n) => {
      if (n === 1) {
        let sent = false;
        const stream = new ReadableStream<Uint8Array>({
          pull(c) {
            if (!sent) { sent = true; c.enqueue(payload.subarray(0, 250)); return; }
            c.error(new Error('connection reset'));
          },
        });
        return new Response(stream as unknown as BodyInit, { headers: { 'content-length': '500' } });
      }
      // A server that ignores Range answers 200 with the whole file.
      return streaming([payload], { headers: { 'content-length': '500' } });
    });
    vi.stubGlobal('fetch', log);

    const res = await downloadRegion(AB, { retries: 1 });
    expect(log.calls[1].headers.Range).toBe('bytes=250-');
    expect(Array.from(new Uint8Array(await res.file.arrayBuffer())))
      .toEqual(Array.from(payload));
  });

  it('retries a 503 but not a 404', async () => {
    const payload = pbfBytes(100);
    const log503 = mockFetch((n) => (n === 1
      ? new Response('busy', { status: 503, statusText: 'Service Unavailable' })
      : streaming([payload], { headers: { 'content-length': '100' } })));
    vi.stubGlobal('fetch', log503);
    const res = await downloadRegion(AB, { retries: 1 });
    expect(res.size).toBe(100);
    expect(log503.calls).toHaveLength(2);

    const log404 = mockFetch(() => new Response('gone', { status: 404 }));
    vi.stubGlobal('fetch', log404);
    await downloadRegion(AB, { retries: 3 }).then(
      () => { throw new Error('should have rejected'); },
      (e: DownloadError) => e,
    );
    expect(log404.calls).toHaveLength(1);
  });
});

/* ------------------------------ availability --------------------------- */

describe('checkRegionAvailable', () => {
  it('reports size and range support from a HEAD', async () => {
    vi.stubGlobal('fetch', mockFetch(() => new Response(null, {
      status: 200,
      headers: {
        'content-length': '398652876',
        'accept-ranges': 'bytes',
        etag: '"abc123"',
      },
    })));

    const avail = await checkRegionAvailable(AB);
    expect(avail.ok).toBe(true);
    expect(avail.bytes).toBe(398652876);
    expect(avail.resumable).toBe(true);
    expect(avail.etag).toBe('"abc123"');
    expect(avail.error).toBeNull();
  });

  it('falls back to a one-byte ranged GET when HEAD is refused', async () => {
    const log = mockFetch((n) => (n === 1
      ? new Response(null, { status: 405, statusText: 'Method Not Allowed' })
      : streaming([pbfBytes(8)], {
          status: 206,
          headers: { 'content-range': 'bytes 0-0/398652876' },
        })));
    vi.stubGlobal('fetch', log);

    const avail = await checkRegionAvailable(AB);
    expect(log.calls[0].url).toBe(AB.pbfUrl);
    expect(avail.ok).toBe(true);
    expect(avail.bytes).toBe(398652876);
    expect(avail.resumable).toBe(true);
  });

  it('never throws on a missing extract', async () => {
    vi.stubGlobal('fetch', mockFetch(() => new Response('no', { status: 404, statusText: 'Not Found' })));
    const avail = await checkRegionAvailable(AB);
    expect(avail.ok).toBe(false);
    expect(avail.status).toBe(404);
    expect(avail.error).toContain('404');
  });

  it('never throws when the network is down', async () => {
    const log = mockFetch(() => { throw new TypeError('fetch failed'); });
    vi.stubGlobal('fetch', log);

    const avail = await checkRegionAvailable(AB);
    expect(avail.ok).toBe(false);
    expect(avail.status).toBe(0);
    expect(avail.error).toContain('download.geofabrik.de');
    // HEAD failed, so the one-byte GET fallback was tried too, and its failure
    // is the reported one — not a Response-constructor range error.
    expect(log.calls).toHaveLength(2);
    expect(log.calls[1].headers.Range).toBe('bytes=0-0');
    expect(avail.error).toMatch(/fetch failed/);
  });
});

/* -------------------------------- sniffing ----------------------------- */

describe('sniffFormat', () => {
  it('recognises protobuf', () => {
    expect(sniffFormat(new Uint8Array([0, 0, 0, 0x14, 0x02, 0x03]))).toBe('pbf');
  });

  it('recognises OSM XML, including after a BOM', () => {
    expect(sniffFormat(bytesOf(XML_DOC))).toBe('xml');
    expect(sniffFormat(bytesOf('﻿<osm version="0.6">'))).toBe('xml');
    expect(sniffFormat(bytesOf('\n  <osm version="0.6">'))).toBe('xml');
  });

  it('calls HTML what it is, rather than feeding it to the parser', () => {
    expect(sniffFormat(bytesOf(HTML_PAGE))).toBe('html');
    expect(sniffFormat(bytesOf('<!doctype HTML PUBLIC "-//W3C//DTD">'))).toBe('html');
    expect(sniffFormat(bytesOf('<h1>Sign in to the guest network</h1>'))).toBe('html');
    // An unfamiliar '<' is not silently accepted as data either.
    expect(sniffFormat(bytesOf('<blink>'))).toBe('unknown');
  });

  it('refuses to guess from too little data', () => {
    expect(sniffFormat(new Uint8Array(0))).toBe('unknown');
    expect(sniffFormat(bytesOf('   '))).toBe('unknown');
  });
});

describe('formatBytes', () => {
  it('writes sizes a person can act on', () => {
    expect(formatBytes(398652876)).toBe('380 MB');
    expect(formatBytes(1024 ** 3 * 1.4)).toBe('1.4 GB');
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-1)).toBe('unknown size');
  });
});

/* ------------------------ the import hand-off ------------------------- */

/* This is the contract `store.ts` relies on, asserted here so a change to the
 * returned shape fails loudly rather than at parse time in the worker. */
describe('import hand-off', () => {
  it('returns something importRegionFile accepts', async () => {
    const payload = pbfBytes(2048, 11);
    vi.stubGlobal('fetch', mockFetch(() =>
      streaming([payload.subarray(0, 1024), payload.subarray(1024)], {
        headers: { 'content-length': '2048' },
      })));

    const res = await downloadRegion(AB, { retries: 0 });

    // `OsmFile`, the structural minimum `OsmEngine.build` uses.
    expect(typeof res.file.name).toBe('string');
    expect(typeof res.file.size).toBe('number');
    expect(typeof res.file.text).toBe('function');
    expect(typeof res.file.arrayBuffer).toBe('function');
    expect(typeof res.file.slice).toBe('function');

    // ...and `store.ts` reads `req.file.size` for the region's byte count, and
    // `localRegionName`/`localRegionId` read `name`.
    expect(res.file.size).toBe(2048);
    expect(res.file.name).toBe('alberta-latest.osm.pbf');

    // The engine sniffs the format from `file.slice(0, 16)`, so that path has to
    // work on what comes back.
    const head = new Uint8Array(await res.file.slice(0, 16).arrayBuffer());
    expect(head[0]).toBe(0x00);
    expect(head[3]).toBe(0x02);
  });
});

/* ------------------ device filesystem (Capacitor plugin) ----------------- */

/**
 * A fake `@capacitor/filesystem` + `@capacitor/core`, so the on-device path runs
 * under test.
 *
 * `native.on` is what `Capacitor.isNativePlatform()` returns, and it is off for
 * every test above: they exercise the browser path, where there is no part file
 * and no offline copy. Because `vi.mock` is hoisted and file-wide, the fake has
 * to be inert until the device tests turn it on — hence the mutable flag and the
 * module reset that follows it.
 */
const device = vi.hoisted(() => ({
  on: false,
  files: new Map<string, Uint8Array>(),
  writes: 0,
  failWrite: false,
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => device.on },
}));

vi.mock('@capacitor/filesystem', () => {
  // Native semantics, which the module is written against: binary writes and
  // appends carry base64 and the plugin decodes *each call independently*,
  // appending bytes; a binary read comes back as a base64 string.
  const decode = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, 'base64'));
  const join = (a: Uint8Array, b: Uint8Array): Uint8Array => {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  };

  return {
    Filesystem: {
      async mkdir() { /* directories are implicit here */ },
      async stat(o: { path: string }) {
        const bytes = device.files.get(o.path);
        if (bytes === undefined) throw new Error(`ENOENT: ${o.path}`);
        return { type: 'file', size: bytes.byteLength };
      },
      async readFile(o: { path: string; encoding?: string }) {
        const bytes = device.files.get(o.path);
        if (bytes === undefined) throw new Error(`ENOENT: ${o.path}`);
        return {
          data: o.encoding === 'utf8'
            ? Buffer.from(bytes).toString('utf8')
            : Buffer.from(bytes).toString('base64'),
          uri: `file:///data/${o.path}`,
        };
      },
      async writeFile(o: { path: string; data: string | Blob; encoding?: string }) {
        if (device.failWrite) throw new Error('ENOSPC: no space left on device');
        device.writes++;
        device.files.set(
          o.path,
          typeof o.data === 'string'
            ? (o.encoding === 'utf8'
              ? new Uint8Array(Buffer.from(o.data, 'utf8'))
              : decode(o.data))
            : new Uint8Array(await (o.data as Blob).arrayBuffer()),
        );
      },
      async appendFile(o: { path: string; data: string }) {
        device.files.set(o.path, join(device.files.get(o.path) ?? new Uint8Array(0), decode(o.data)));
      },
      async deleteFile(o: { path: string }) {
        if (!device.files.delete(o.path)) throw new Error(`ENOENT: ${o.path}`);
      },
    },
    Directory: { Data: 'DATA', Cache: 'CACHE', Documents: 'DOCUMENTS' },
    Encoding: { UTF8: 'utf8' },
  };
});

/** Fresh module instance, so the memoised plugin binding is rebuilt. */
async function deviceModule() {
  device.on = true;
  vi.resetModules();
  return import('../src/regions/download');
}

describe('on a device (Capacitor Filesystem)', () => {
  beforeEach(() => {
    device.files.clear();
    device.writes = 0;
    device.failWrite = false;
  });

  afterEach(() => {
    device.on = false;
  });

  it('keeps the finished extract and reuses it without touching the network', async () => {
    // A length that is not a multiple of 3, so base64 padding is exercised.
    const payload = pbfBytes(1001, 5);
    const mod = await deviceModule();

    const log = mockFetch(() => streaming([payload.subarray(0, 400), payload.subarray(400)], {
      headers: { 'content-length': String(payload.length) },
    }));
    vi.stubGlobal('fetch', log);

    const first = await mod.downloadRegion(AB, { retries: 0 });
    expect(first.source).toBe('network');
    expect(first.path).toBe('canopy-regions/ca-ab');
    expect(device.files.has('canopy-regions/ca-ab')).toBe(true);

    // Second time round the extract is already on the device.
    const log2 = mockFetch(() => { throw new Error('the network must not be used'); });
    vi.stubGlobal('fetch', log2);
    const second = await mod.downloadRegion(AB, { retries: 0 });

    expect(log2.calls).toHaveLength(0);
    expect(second.source).toBe('disk-cache');
    expect(second.size).toBe(payload.length);
    expectSameBytes(new Uint8Array(await second.file.arrayBuffer()), payload);
  });

  it('resumes an interrupted download from the part file it left behind', async () => {
    const CH = 1024 * 1024;
    const payload = pbfBytes(6 * CH, 9);
    const mod = await deviceModule();

    const log = mockFetch((n) => {
      if (n === 1) {
        // Five of six chunks arrive, then the connection ends early.
        let i = 0;
        const stream = new ReadableStream<Uint8Array>({
          pull(c) {
            if (i >= 5) { c.close(); return; }
            c.enqueue(payload.subarray(i * CH, (i + 1) * CH));
            i++;
          },
        });
        return new Response(stream as unknown as BodyInit, {
          headers: { 'content-length': String(payload.length), etag: '"v1"' },
        });
      }
      const from = 5 * CH;
      return streaming([payload.subarray(from)], {
        status: 206,
        headers: { 'content-range': `bytes ${from}-${payload.length - 1}/${payload.length}` },
      });
    });
    vi.stubGlobal('fetch', log);

    // First attempt ends short of its Content-Length and gives up (no retries),
    // leaving a part file behind.
    const failed = await mod.downloadRegion(AB, { retries: 0 }).then(
      () => { throw new Error('should have rejected'); },
      (e: DownloadError) => e,
    );
    expect(failed.code).toBe('truncated');
    const partSize = device.files.get('canopy-regions/ca-ab.part')?.byteLength ?? 0;
    expect(partSize).toBe(5 * CH);

    // The next call picks the partial up and asks only for what is missing.
    const res = await mod.downloadRegion(AB, { retries: 0 });
    expect(log.calls).toHaveLength(2);
    expect(log.calls[1].headers.Range).toBe(`bytes=${5 * CH}-`);
    expect(log.calls[1].headers['If-Range']).toBe('"v1"');
    expect(res.size).toBe(payload.length);
    expectSameBytes(new Uint8Array(await res.file.arrayBuffer()), payload);
    // The part file is gone once the real file exists.
    expect(device.files.has('canopy-regions/ca-ab.part')).toBe(false);
  });

  it('discards a partial file it cannot vouch for, and starts clean', async () => {
    const payload = pbfBytes(2048, 13);
    const mod = await deviceModule();

    // A part file with no validator beside it: resuming from it could splice two
    // different versions of the file together.
    device.files.set('canopy-regions/ca-ab.part', payload.slice(0, 1000));

    const log = mockFetch(() => streaming([payload], {
      headers: { 'content-length': String(payload.length) },
    }));
    vi.stubGlobal('fetch', log);

    const res = await mod.downloadRegion(AB, { retries: 0 });
    expect(log.calls[0].headers.Range).toBeUndefined();
    expectSameBytes(new Uint8Array(await res.file.arrayBuffer()), payload);
  });

  it('still returns the bytes when the offline copy cannot be written', async () => {
    const payload = pbfBytes(512, 21);
    const mod = await deviceModule();
    device.failWrite = true;
    vi.stubGlobal('fetch', mockFetch(() => streaming([payload], {
      headers: { 'content-length': String(payload.length) },
    })));

    const res = await mod.downloadRegion(AB, { retries: 0 });
    expect(res.size).toBe(512);
    expect(res.path).toBeUndefined();
    expect(res.warnings.join(' ')).toMatch(/could not be saved on the device/i);
    expectSameBytes(new Uint8Array(await res.file.arrayBuffer()), payload);
  });

  it('clears both the copy and any partial', async () => {
    const mod = await deviceModule();
    device.files.set('canopy-regions/ca-ab', new Uint8Array([0]));
    device.files.set('canopy-regions/ca-ab.part', new Uint8Array([0]));

    await mod.clearCachedRegion(AB);
    expect(device.files.size).toBe(0);
    expect(await mod.cachedRegion(AB)).toBeNull();
  });
});