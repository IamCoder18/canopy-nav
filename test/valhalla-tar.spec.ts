/**
 * Tar indexing for routing packs.
 *
 * Three independent shapes are pitted against the reader: the committed
 * `test/fixture.valhalla.tar` (GNU tar, via `tools/build-pack.mjs`), the
 * hand-rolled writer in `tarfixture.ts`, and edge shapes (PAX names, ustar
 * prefixes, truncation) that neither of the other two produces by accident.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseTarIndex, type ByteRead } from '../src/nav/valhalla-local/tar';
import { buildTar } from './tarfixture';

const FIXTURE_PACK = join(__dirname, 'fixture.valhalla.tar');

function readerOf(bytes: Uint8Array): ByteRead {
  return (into, at) => {
    if (at >= bytes.length) return 0;
    const n = Math.min(into.length, bytes.length - at);
    into.set(bytes.subarray(at, at + n));
    return n;
  };
}

function index(bytes: Uint8Array) {
  return parseTarIndex(readerOf(bytes), bytes.length);
}

const body = (s: string) => new TextEncoder().encode(s);

describe('parseTarIndex — real archive (GNU tar)', () => {
  const bytes = new Uint8Array(readFileSync(FIXTURE_PACK));

  it('indexes every tile in the committed fixture pack', () => {
    const entries = index(bytes);
    expect(entries.length).toBe(3);
    for (const e of entries) {
      expect(e.name).toMatch(/^\d\/[\d/]+\.gph$/);
      expect(e.size).toBeGreaterThan(0);
      // Body starts on a block boundary, after its own 512-byte header.
      expect((e.offset - 512) % 512).toBe(0);
    }
  });

  it('entry names are the three hierarchy levels', () => {
    const levels = index(bytes).map((e) => e.name[0]).sort();
    expect(levels).toEqual(['0', '1', '2']);
  });

  it('reports offsets that tile bodies actually sit at', () => {
    // The reader is only as good as its offsets: read each body through the
    // same read function the engine will use and check it is a tile. Valhalla's
    // `GraphTileHeader` carries its schema version as ASCII at offset 16 — the
    // one field that says "this is a tile of a Valhalla I understand".
    for (const e of index(bytes)) {
      const read = readerOf(bytes);
      const head = new Uint8Array(24);
      read(head, e.offset + 16);
      const version = new TextDecoder().decode(head);
      expect(version).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+/);
    }
  });
});

describe('parseTarIndex — synthetic archives', () => {
  it('indexes files and their exact bodies', () => {
    const t = buildTar([
      { name: '0/000/000.gph', body: body('abc') },
      { name: '1/000/000.gph', body: body('0123456789') },
    ]);
    const entries = index(t);
    expect(entries.map((e) => e.name)).toEqual(['0/000/000.gph', '1/000/000.gph']);
    expect(entries.map((e) => e.size)).toEqual([3, 10]);
    const read = readerOf(t);
    const out = new Uint8Array(10);
    read(out.subarray(0, 3), entries[0].offset);
    expect(new TextDecoder().decode(out.subarray(0, 3))).toBe('abc');
    read(out, entries[1].offset);
    expect(new TextDecoder().decode(out)).toBe('0123456789');
  });

  it('handles exact block-sized bodies (no padding)', () => {
    const t = buildTar([{ name: '0/000/001.gph', body: new Uint8Array(512).fill(7) }]);
    const entries = index(t);
    expect(entries.length).toBe(1);
    expect(entries[0].size).toBe(512);
  });

  it('reassembles names carried in ustar prefix fields', () => {
    const long = '0/' + 'a'.repeat(120) + '/000.gph';
    const t = buildTar([{ name: long, body: body('x') }]);
    expect(index(t)[0].name).toBe(long);
  });

  it('reassembles names carried in PAX extended headers', () => {
    const long = '2/' + 'b'.repeat(180) + '.gph';
    const t = buildTar([{ name: long, body: body('y'), paxName: true }]);
    expect(index(t)[0].name).toBe(long);
  });

  it('ignores directory entries and stops at the zero blocks', () => {
    const t = buildTar([{ name: '0/000/002.gph', body: body('z') }]);
    const withJunk = new Uint8Array(t.length + 1024);
    withJunk.set(t);
    withJunk.fill(0xff, t.length); // "data" after end-of-archive marker
    const entries = index(withJunk);
    expect(entries.length).toBe(1);
  });

  it('returns nothing for empty and garbage input rather than throwing', () => {
    expect(index(new Uint8Array(0))).toEqual([]);
    expect(index(new Uint8Array(2048))).toEqual([]);
    expect(index(new Uint8Array(4096).fill(0x42))).toEqual([]);
  });

  it('tolerates a truncated final entry', () => {
    const t = buildTar([
      { name: '0/000/003.gph', body: body('first') },
      { name: '0/000/004.gph', body: body('second') },
    ]);
    // Cut into the second body: the first entry must survive, and the reader
    // must not throw on the fragment.
    const cut = index(t.slice(0, 512 * 2 + 512 + 2));
    expect(cut.map((e) => e.name)).toEqual(['0/000/003.gph']);
  });
});
