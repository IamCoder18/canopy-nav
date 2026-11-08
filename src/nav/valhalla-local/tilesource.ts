/**
 * Pack tile sources: where tile bytes come from at route time.
 *
 * The engine reads tiles lazily — Valhalla's own LRU pulls the tiles a route
 * touches and nothing else — so the source is a *synchronous random reader*
 * over a pack, not a loaded graph.
 *
 * ## The whole-tile cache is load-bearing, not an optimisation
 *
 * Measured (research/valhalla-local-feasibility.md §4.1): Valhalla reads a tile
 * in many small chunks. Against a source where every `read()` paid its own
 * storage hop (a real `OPFS` `SyncAccessHandle`), a cold 164 km route took
 * **5,346 ms**. Wrapping the same source so the *first* touch of a tile pulls
 * the whole tile in one read cut it to **206 ms** — 25x. Any `PackSource` that
 * is slower than RAM (file, OPFS, Capacitor) must be wrapped in
 * `wholeTileCached`; the RAM-only source does not need it but takes no harm.
 */

import { parseTarIndex, type ByteRead, type TarEntry } from './tar';

/** A readable routing pack: indexed tiles plus random access. */
export interface PackSource {
  entries: readonly TarEntry[];
  read: ByteRead;
}

export interface CacheStats {
  /** Reads that reached the *underlying* source. Tiles, not chunks. */
  sourceReads: number;
  /** Bytes pulled from the underlying source. */
  sourceBytes: number;
  cachedTiles: number;
  cachedBytes: number;
}

export interface CachedPackSource extends PackSource {
  stats(): CacheStats;
}

/** Whole tiles held before eviction. 32 MB ≈ a metro corridor plus slack. */
export const DEFAULT_TILE_CACHE_BYTES = 32 * 1024 * 1024;

/**
 * A pack held in memory as one buffer.
 *
 * The fallback source and the one unit tests use: no storage layer, so reads
 * are already RAM-speed. Large packs cost their whole size in RAM — for
 * province-scale packs prefer a file-backed source with this cache in front.
 */
export function arrayBufferSource(pack: ArrayBuffer | Uint8Array): PackSource {
  const bytes = pack instanceof Uint8Array ? pack : new Uint8Array(pack);
  const read: ByteRead = (into, at) => {
    if (at >= bytes.length) return 0;
    const n = Math.min(into.length, bytes.length - at);
    into.set(bytes.subarray(at, at + n));
    return n;
  };
  return { entries: parseTarIndex(read, bytes.length), read };
}

/** Binary-search the entry whose body contains `at`. Entries sorted by offset. */
function entryAt(sorted: readonly TarEntry[], at: number): TarEntry | null {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const e = sorted[mid];
    if (at < e.offset) hi = mid - 1;
    else if (at >= e.offset + e.size) lo = mid + 1;
    else return e;
  }
  return null;
}

/**
 * Wrap a source so each tile is read from storage in one shot on first touch.
 *
 * `maxBytes` bounds the raw-tile cache (LRU). Evicted tiles are re-read on next
 * touch — correctness never depends on the cache, only speed.
 */
export function wholeTileCached(
  inner: PackSource,
  opts: { maxBytes?: number } = {},
): CachedPackSource {
  const maxBytes = opts.maxBytes ?? DEFAULT_TILE_CACHE_BYTES;
  const sorted = [...inner.entries].sort((a, b) => a.offset - b.offset);
  const cache = new Map<string, Uint8Array>();
  const stats: CacheStats = { sourceReads: 0, sourceBytes: 0, cachedTiles: 0, cachedBytes: 0 };

  const load = (e: TarEntry): Uint8Array => {
    let data = cache.get(e.name);
    if (data) {
      // Refresh LRU position: Map iteration is insertion order.
      cache.delete(e.name);
      cache.set(e.name, data);
      return data;
    }
    data = new Uint8Array(e.size);
    let got = 0;
    while (got < e.size) {
      const n = inner.read(data.subarray(got), e.offset + got);
      if (n <= 0) break;
      got += n;
    }
    stats.sourceReads += 1;
    stats.sourceBytes += got;
    cache.set(e.name, data);
    stats.cachedTiles = cache.size;
    stats.cachedBytes += data.length;
    while (stats.cachedBytes > maxBytes && cache.size > 1) {
      const oldest = cache.keys().next().value as string;
      const dropped = cache.get(oldest)!;
      cache.delete(oldest);
      stats.cachedTiles = cache.size;
      stats.cachedBytes -= dropped.length;
    }
    return data;
  };

  return {
    entries: inner.entries,
    read: (into, at) => {
      const e = entryAt(sorted, at);
      if (!e) return 0;
      const data = load(e);
      const start = at - e.offset;
      const n = Math.min(into.length, data.length - start);
      if (n <= 0) return 0;
      into.set(data.subarray(start, start + n));
      return n;
    },
    stats: () => ({ ...stats }),
  };
}
