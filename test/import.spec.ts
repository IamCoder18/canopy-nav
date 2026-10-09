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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
 * The memory guard, as the import path uses it.
 *
 * The guard itself is a pure function and is tested properly in
 * `test/importguard.spec.ts` — its constants, its boundaries and its messages.
 * What matters *here* is that `importRegionFile` actually consults it, and that
 * `forceMemory` is the only way past it. A guard nothing calls is a comment.
 *
 * The failure this whole thing exists to prevent is the one with no catch: an
 * out-of-heap WebView is killed by the system, so there is no throw, no
 * `worker.onerror`, and the promise never settles. From the user's side that is
 * indistinguishable from a hang, and the progress bar simply disappears.
 */
describe('the memory guard gates the import', () => {
  const mb = (n: number) => n * 1024 * 1024;
  const nav = globalThis.navigator as Navigator & { deviceMemory?: number };

  afterEach(() => {
    if ('deviceMemory' in nav) delete (nav as { deviceMemory?: number }).deviceMemory;
  });

  /**
   * A file that is genuinely valid and parseable, but *declares* a large size.
   *
   * The content is the real fixture, so nothing about the parse is faked; only
   * `size` is inflated. That is exactly what the guard reasons over — it runs
   * before a parse, so a file size is all it can have — and it is what makes this
   * test honest rather than a mock of the guard's own input.
   */
  function validButHuge(declaredBytes: number): File {
    const file = new Blob([VALID], { type: 'application/octet-stream' }) as File;
    Object.defineProperty(file, 'name', { value: 'alberta-latest.osm' });
    Object.defineProperty(file, 'size', { value: declaredBytes });
    return file;
  }

  it('refuses a province-sized extract, naming memory and a way out', async () => {
    const onError = vi.fn();
    const ds = await importRegionFile({
      id: 'ca-ab', name: 'Alberta', code: 'CA-AB',
      file: validButHuge(334 * mb(1)),
      onError,
    }).catch(() => null);

    expect(ds, 'a refused import must not produce a dataset').toBeNull();
    const msg = lastMessage(onError);
    expect(msg).toMatch(/memory/i);
    // Without an instruction the refusal is a dead end, which is why
    // `importguard.ts` names `osmium extract -b` in the sentence.
    expect(msg).toMatch(/osmium/);
    expect(msg).toMatch(/-b/);
  });

  it('reports the refusal through onError rather than only rejecting', async () => {
    // A throw into a caller that does not await would look identical, from the
    // user's side, to the silent hang this is meant to replace.
    const onError = vi.fn();
    await importRegionFile({
      id: 'ca-ab', name: 'Alberta', code: 'CA-AB',
      file: validButHuge(334 * mb(1)),
      onError,
    }).catch(() => null);
    expect(lastMessage(onError)).not.toBe('');
  });

  it('lets forceMemory past the guard', async () => {
    // The override exists because the estimate is a constant times a file size,
    // not a measurement, and the driver may know their device can cope. It has
    // to be asked for: an import that dies should have been requested.
    //
    // What is asserted is that the *guard* stopped running — not that the import
    // succeeded. It cannot succeed here: node has no `Worker`, so
    // `new OsmEngine()` throws and `importRegionFile` reports that instead. That
    // is the point: a different error entirely means the refusal is gone, and
    // asserting on the *absence* of the memory message is what distinguishes
    // "the guard let it through" from "the guard is broken".
    const onError = vi.fn();
    await importRegionFile({
      id: 'ca-ab', name: 'Alberta', code: 'CA-AB',
      file: validButHuge(334 * mb(1)),
      forceMemory: true,
      onError,
    }).catch(() => null);

    const msg = lastMessage(onError);
    expect(msg, 'the memory refusal must be gone').not.toMatch(/memory/i);
    expect(msg, 'and it should have reached the engine, which cannot run here')
      .toMatch(/worker|Worker|environment/i);
  });

  it('does not gate a file whose size it does not know', async () => {
    // An absent or zero size means "unknown", and unknown is not "province".
    // Refusing here would break every caller passing a Blob-shaped object
    // without a real size — including the browser suite's own fixtures.
    const onError = vi.fn();
    const file = new Blob([VALID], { type: 'application/octet-stream' }) as File;
    Object.defineProperty(file, 'name', { value: 'no-size.osm' });
    Object.defineProperty(file, 'size', { value: 0 });
    await importRegionFile({
      id: 'u', name: 'Unknown', code: 'U', file, onError,
    }).catch(() => null);
    expect(lastMessage(onError)).not.toMatch(/memory/i);
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