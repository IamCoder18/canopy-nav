/**
 * Tar indexing for routing packs.
 *
 * A routing pack is an uncompressed tar of Valhalla `.gph` tiles — the `tiles/`
 * tree `valhalla_build_tiles` produces, archived by `tools/build-pack.mjs`. The
 * engine never needs the whole pack in hand at once: a route touches a corridor
 * of tiles, so the pack is indexed once (headers only) and read by offset.
 *
 * `parseTarIndex` is adapted from `ecc521/valhalla-wasm`'s `web/tileSource.ts`
 * (MIT, (c) ecc521), trimmed to what a pack contains: POSIX/ustar and PAX
 * regular-file entries. That implementation was extracted from rivers.run,
 * which routes offline in the field with exactly these archives.
 */

export interface TarEntry {
  /** Path inside the archive, e.g. `0/003/194.gph`. */
  name: string;
  /** Absolute byte offset of the file body (after the 512-byte header). */
  offset: number;
  /** File body size in bytes. */
  size: number;
}

/**
 * Synchronous random read: fill `into` starting at absolute offset `at`.
 * Returns the number of bytes read (short reads are possible at end of source).
 */
export type ByteRead = (into: Uint8Array, at: number) => number;

/**
 * Index every regular file in an uncompressed tar, without reading bodies.
 *
 * Returns entries in archive order. A trailing zero block (or several) ends the
 * archive; anything after it is ignored, which is what `tar` itself does.
 */
export function parseTarIndex(read: ByteRead, totalSize: number): TarEntry[] {
  const BLOCK = 512;
  const header = new Uint8Array(BLOCK);
  const entries: TarEntry[] = [];
  const decoder = new TextDecoder();

  let pos = 0;
  let paxName: string | null = null;

  while (pos + BLOCK <= totalSize) {
    read(header, pos);

    let allZero = true;
    for (let i = 0; i < BLOCK; i++) {
      if (header[i] !== 0) { allZero = false; break; }
    }
    if (allZero) { pos += BLOCK; continue; }

    const nameRaw = decoder.decode(header.subarray(0, 100)).replace(/\0+$/, '');
    const sizeOctal = decoder.decode(header.subarray(124, 136)).replace(/\0+$/, '').trim();
    const typeflag = String.fromCharCode(header[156]);
    const prefix = decoder.decode(header.subarray(345, 500)).replace(/\0+$/, '');

    const fileSize = parseInt(sizeOctal, 8) || 0;
    const dataOffset = pos + BLOCK;
    const dataBlocks = Math.ceil(fileSize / BLOCK);

    if (typeflag === 'x' || typeflag === 'g') {
      // PAX extended header — carries the real name when it exceeded 100 bytes.
      if (fileSize > 0 && fileSize < 65536) {
        const paxBuf = new Uint8Array(fileSize);
        read(paxBuf, dataOffset);
        const match = decoder.decode(paxBuf).match(/\d+ path=(.+)\n/);
        if (match) paxName = match[1];
      }
      pos = dataOffset + dataBlocks * BLOCK;
      continue;
    }

    if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
      let fullName = prefix ? `${prefix}/${nameRaw}` : nameRaw;
      if (paxName) { fullName = paxName; paxName = null; }
      // Only entries whose body actually exists: a truncated pack must not
      // advertise a tile it cannot serve — the read would come back short and
      // the failure would surface as a corrupt tile, which names the wrong
      // cause. Refusing to index it makes the missing tile exactly that.
      if (fileSize > 0 && dataOffset + fileSize <= totalSize) {
        entries.push({ name: fullName, offset: dataOffset, size: fileSize });
      }
    } else {
      paxName = null;
    }

    pos = dataOffset + dataBlocks * BLOCK;
  }

  return entries;
}
