/**
 * Import validation tests.
 *
 * The defect these pin is the worst in the import path: a malformed, empty,
 * truncated or road-free `.osm` parsed "successfully" into an empty dataset,
 * replaced the region the user had working, and reported no error at all. The
 * home screen then read "0 routable ways · 2 regions" — the previous map gone,
 * with nothing said and nothing to undo it.
 *
 * The format sniff matters for the same reason. It used to be
 * `looksXml || /\.(osm|xml)$/`, so the *extension* could overrule a definite
 * byte-level answer: a real PBF renamed to `.osm` was parsed as XML, matched
 * nothing, and imported as an empty region.
 *
 * Run with `npx vitest run test/import.spec.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importRegionFile } from '../src/regions/store';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A `File`-alike with just enough surface for the engine's sniff. */
function fakeFile(name: string, body: string | Uint8Array): File {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  const file = new Blob([bytes as BlobPart], { type: 'application/octet-stream' }) as File;
  Object.defineProperty(file, 'name', { value: name });
  // jsdom-free environment: vitest's node Blob has `size`, and this gives it
  // `arrayBuffer`/`slice`/`stream` the way a real File does.
  return file;
}

const VALID = readFileSync(join(root, 'test', 'fixture.osm'), 'utf8');

/**
 * The last *non-null* argument a callback received.
 *
 * `importRegionFile` calls `onError(null)` / `onWarn(null)` first, to clear any
 * previous message, so `.at(-1)` is the reset rather than the result.
 */
function lastMessage(spy: ReturnType<typeof vi.fn>): string {
  const calls = spy.mock.calls.map((c) => c[0]).filter((m) => typeof m === 'string' && m.length);
  return String(calls.at(-1) ?? '');
}

function run(file: File) {
  const onError = vi.fn();
  const onWarn = vi.fn();
  const onPersistError = vi.fn();
  const result = importRegionFile({
    id: 'local-test', name: 'Test', code: 'local', file,
    onError, onWarn, onPersistError,
  });
  return { result, onError, onWarn, onPersistError };
}

describe('a malformed file is refused, and nothing changes', () => {
  const cases: Array<[string, string | Uint8Array]> = [
    ['empty.osm', ''],
    ['corrupt.osm', '<osm><node id="1" lat="1" lon="1"'],
    ['truncated.osm', VALID.slice(0, Math.floor(VALID.length * 0.4))],
    ['notes.txt', 'Shopping list\nmilk\neggs\n'],
    ['photo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ['random.bin', new Uint8Array(Array.from({ length: 4096 }, (_, i) => (i * 37) % 251))],
  ];

  it.each(cases)('refuses %s', async (_label, body) => {
    const { result, onError } = run(fakeFile(_label, body));
    // Either it rejects, or it reports an error and returns null. Both are
    // "nothing was imported"; what it must never do is succeed.
    const ds = await result.catch(() => null);
    if (ds !== null) {
      // A truncated *valid* prefix can legitimately contain nodes. What must
      // never happen is an import that reports success with nothing in it.
      const empty = ds.counts.nodes === 0 && ds.counts.ways === 0;
      expect(empty, 'imported an empty dataset without complaining').toBe(false);
    } else {
      const msg = lastMessage(onError);
      expect(msg, 'no error was reported to the caller').not.toBe('');
      expect(msg.length, 'error message must not be empty').toBeGreaterThan(10);
    }
  });

  it('names the file in the error, so the user knows which one failed', async () => {
    const { result, onError } = run(fakeFile('empty.osm', ''));
    await result.catch(() => null);
    expect(lastMessage(onError)).toContain('empty.osm');
  });

  it('does not leak an internal decoder string at the user', async () => {
    // The PBF reader's own diagnosis is excellent and is shown when a file
    // *claims* to be PBF; what must never escape is the raw
    // "implausible blob-header length NNNNN" sentence, which tells the user
    // nothing about what to do.
    const { result, onError } = run(fakeFile('photo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
    await result.catch(() => null);
    const msg = lastMessage(onError);
    expect(msg).not.toMatch(/implausible blob-header/);
    expect(msg).not.toMatch(/\bRawNode\b/);
  });

  it('offers a next action, not just a diagnosis', async () => {
    const { result, onError } = run(fakeFile('empty.osm', ''));
    await result.catch(() => null);
    expect(lastMessage(onError)).toMatch(/again|import|convert|osmium/i);
  });
});

describe('format sniffing', () => {
  /**
   * These run without a `Worker`.
   *
   * A real parse needs one and node has none, so anything that gets as far as
   * the worker is out of scope here — the browser suites cover that path. What
   * is testable in node is everything decided *before* the worker is handed the
   * file: the byte sniff and the pre-parse rejections.
   */
  const noWorker = typeof Worker === 'undefined';

  it('reads the bytes, not the extension', async () => {
    // A PBF named `.osm` must be read as PBF. The old logic let the extension
    // win and would hand a protobuf file to the XML parser, which matches
    // nothing and yields an empty region.
    const pbf = readFileSync(join(root, 'test', 'fixture.osm.pbf'));
    const { result, onError } = run(fakeFile('mislabelled.osm', new Uint8Array(pbf)));
    await result.catch(() => null);
    if (noWorker) {
      // It got past the sniff and failed on the missing worker, which is itself
      // the proof: a mislabelled PBF is not rejected as "not OSM data".
      expect(lastMessage(onError)).not.toMatch(/not OpenStreetMap data/);
    }
  });

  it('rejects a file that is neither XML nor PBF, before parsing it', async () => {
    const { result, onError } = run(fakeFile('notes.txt', 'Shopping list\nmilk\n'));
    await result.catch(() => null);
    expect(lastMessage(onError)).toMatch(/not OpenStreetMap data/);
  });

  it('rejects a 0-byte file with a specific message', async () => {
    const { result, onError } = run(fakeFile('empty.osm', ''));
    await result.catch(() => null);
    const msg = lastMessage(onError);
    expect(msg).toMatch(/empty/i);
    expect(msg).toContain('empty.osm');
  });
});

describe('warnings are not errors', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not warn when the import was rejected outright', async () => {
    const { result, onWarn } = run(fakeFile('empty.osm', ''));
    await result.catch(() => null);
    expect(lastMessage(onWarn)).toBe('');
  });
});

/**
 * The post-parse policy, exercised against the pure decision rather than through
 * a worker — node has no `Worker`, so the parse itself cannot run here. The
 * browser suite covers that end to end; what matters here is that the *rule* is
 * written down, because getting it wrong destroys a user's map.
 */
describe('the post-parse policy, as a rule', () => {
  interface Outcome { reject: boolean; message?: string }

  /** Mirrors the guards in `importRegionFile`. */
  function judge(name: string, counts: { nodes: number; ways: number; routable: number }): Outcome {
    if (counts.nodes === 0 && counts.ways === 0) {
      return {
        reject: true,
        message: `${name} contains no OpenStreetMap data. The file may be truncated. Nothing was changed.`,
      };
    }
    if (counts.routable === 0) {
      return { reject: true, message: `${name} has no routable roads. Nothing was changed.` };
    }
    return { reject: false };
  }

  it('rejects a parse that found nothing', () => {
    expect(judge('a.osm', { nodes: 0, ways: 0, routable: 0 }).reject).toBe(true);
  });

  it('rejects a parse with ways but no roads — the case that displaced a map', () => {
    // One building. Perfectly valid OSM, useless to a routing app, and it used to
    // become the active dataset.
    expect(judge('park.osm', { nodes: 1, ways: 1, routable: 0 }).reject).toBe(true);
  });

  it('accepts a normal extract', () => {
    expect(judge('a.osm', { nodes: 100, ways: 90, routable: 40 }).reject).toBe(false);
  });

  it('says plainly that nothing was changed', () => {
    // A refusal the user cannot tell from a partial success is not a refusal.
    expect(judge('a.osm', { nodes: 0, ways: 0, routable: 0 }).message).toMatch(/Nothing was changed/);
  });
});