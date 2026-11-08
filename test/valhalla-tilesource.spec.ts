/**
 * Pack tile sources, and the whole-tile cache in front of them.
 *
 * The cache is load-bearing: measured, a cold 164 km route took 5,346 ms
 * against a per-chunk storage source and 206 ms with this cache in front
 * (research/valhalla-local-feasibility.md §4.1). These tests pin the property
 * that made the difference — one source read per tile, ever — so it cannot
 * regress silently into per-chunk reads.
 */

import { describe, it, expect } from 'vitest';

import {
  arrayBufferSource,
  wholeTileCached,
  type PackSource,
} from '../src/nav/valhalla-local/tilesource';
import type { ByteRead, TarEntry } from '../src/nav/valhalla-local/tar';
import { buildTar } from './tarfixture';

const body = (s: string) => new TextEncoder().encode(s);
const str = (b: Uint8Array) => new TextDecoder().decode(b);

/** A source that counts the reads and bytes that reach storage. */
function countingSource(bytes: Uint8Array): PackSource & { reads: number; bytes: number } {
  const inner = arrayBufferSource(bytes);
  const stats = { reads: 0, bytes: 0 };
  const read: ByteRead = (into, at) => {
    const n = inner.read(into, at);
    if (n > 0) { stats.reads += 1; stats.bytes += n; }
    return n;
  };
  return {
    get entries() { return inner.entries; },
    read,
    get reads() { return stats.reads; },
    get bytes() { return stats.bytes; },
  };
}

function sampleTar() {
  return buildTar([
    { name: '0/000/000.gph', body: body('tile-zero-contents') },
    { name: '1/000/000.gph', body: body('tile-one-contents!') },
  ]);
}

describe('arrayBufferSource', () => {
  const src = arrayBufferSource(sampleTar());

  it('indexes the pack it was given', () => {
    expect(src.entries.map((e: TarEntry) => e.name)).toEqual(['0/000/000.gph', '1/000/000.gph']);
  });

  it('serves exact ranges', () => {
    const e = src.entries[0];
    const out = new Uint8Array(e.size);
    expect(src.read(out, e.offset)).toBe(e.size);
    expect(str(out)).toBe('tile-zero-contents');
  });

  it('returns 0 past the end instead of throwing', () => {
    const out = new Uint8Array(4);
    expect(src.read(out, 1 << 30)).toBe(0);
  });

  it('drops a truncated entry from the index and short-reads at the edge', () => {
    const bytes = sampleTar();
    // Second body starts at 1536 (after two 512-byte blocks); cut mid-body.
    const cut = arrayBufferSource(bytes.slice(0, 1546));
    expect(cut.entries.length).toBe(1);
    expect(cut.entries[0].name).toBe('0/000/000.gph');
    // A read from the surviving edge returns what is there, not the request.
    const out = new Uint8Array(64);
    expect(cut.read(out, 1536)).toBe(10);
    expect(cut.read(out, 1 << 30)).toBe(0);
  });
});

describe('wholeTileCached', () => {
  it('reads each tile from storage exactly once, however much Valhalla asks', () => {
    const inner = countingSource(sampleTar());
    const src = wholeTileCached(inner);
    const e = src.entries[0];
    const out = new Uint8Array(8);
    for (let i = 0; i < 50; i++) {
      src.read(out, e.offset); // first bytes
      src.read(out, e.offset + 4); // middle
      src.read(out, e.offset + e.size - 8); // end
    }
    expect(inner.reads).toBe(1);
    expect(inner.bytes).toBe(e.size);
    expect(src.stats().sourceReads).toBe(1);
    expect(src.stats().cachedTiles).toBe(1);
  });

  it('reads one source read per tile across many tiles', () => {
    const files = Array.from({ length: 20 }, (_, i) => ({
      name: `0/${i}/000.gph`,
      body: body(`tile-${i}-` + 'x'.repeat(i * 17)),
    }));
    const inner = countingSource(buildTar(files));
    const src = wholeTileCached(inner);
    const out = new Uint8Array(4);
    for (const e of src.entries) src.read(out, e.offset + 1);
    expect(inner.reads).toBe(20);
    expect(src.stats().cachedTiles).toBe(20);
  });

  it('returns the right bytes from the cache', () => {
    const src = wholeTileCached(arrayBufferSource(sampleTar()));
    const expected = ['tile-zero-contents', 'tile-one-contents!'];
    src.entries.forEach((e, i) => {
      const out = new Uint8Array(e.size);
      // Read in three chunks, all served from the cached tile.
      src.read(out.subarray(0, 2), e.offset);
      src.read(out.subarray(2, e.size - 2), e.offset + 2);
      src.read(out.subarray(e.size - 2), e.offset + e.size - 2);
      expect(str(out)).toBe(expected[i]);
    });
  });

  it('bounds the cache and re-reads evicted tiles (correctness survives eviction)', () => {
    const files = Array.from({ length: 6 }, (_, i) => ({
      name: `0/${i}/000.gph`,
      body: body('y'.repeat(1000) + i),
    }));
    const inner = countingSource(buildTar(files));
    // Room for about two tiles at a time.
    const src = wholeTileCached(inner, { maxBytes: 2500 });
    const out = new Uint8Array(100);
    for (const e of src.entries) src.read(out, e.offset);
    expect(src.stats().cachedBytes).toBeLessThanOrEqual(2500);
    expect(src.stats().cachedTiles).toBeLessThanOrEqual(3);
    // Everything that was read still reads back correctly after churn.
    for (const e of src.entries) {
      const check = new Uint8Array(e.size);
      src.read(check, e.offset);
      expect(check[check.length - 1]).toBe(String(e.name.split('/')[1]).charCodeAt(0));
    }
    // The churn forced re-reads: more source reads than tiles.
    expect(inner.reads).toBeGreaterThan(6);
  });

  it('never evicts the tile it is loading', () => {
    const inner = countingSource(sampleTar());
    const src = wholeTileCached(inner, { maxBytes: 1 }); // absurdly small
    const e = src.entries[0];
    const out = new Uint8Array(e.size);
    expect(src.read(out, e.offset)).toBe(e.size);
    expect(str(out)).toBe('tile-zero-contents');
  });

  it('answers 0 for offsets outside every tile', () => {
    const src = wholeTileCached(arrayBufferSource(sampleTar()));
    const out = new Uint8Array(4);
    expect(src.read(out, 0)).toBe(0); // inside the tar header region
    expect(src.read(out, 1 << 28)).toBe(0);
  });
});
