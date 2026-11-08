/**
 * A minimal ustar writer, for building test packs.
 *
 * Deliberately *not* the inverse of `src/nav/valhalla-local/tar.ts`: a reader
 * tested only against its own writer can agree with it while both are wrong.
 * The committed `test/fixture.valhalla.tar` is built by GNU tar (via
 * `tools/build-pack.mjs`), this writer is a second, independent shape, and the
 * real-world packs in the research were a third. Any two of the three agreeing
 * is evidence; all three is the format.
 *
 * Supports plain files plus one deliberate quirk each for the paths the reader
 * claims: ustar `prefix` (names > 100 chars in the old style) and PAX extended
 * headers (the modern style).
 */

export interface TarFile {
  name: string;
  body: Uint8Array;
  /** Use a PAX long-name record instead of ustar prefix splitting. */
  paxName?: boolean;
}

const BLOCK = 512;
const enc = new TextEncoder();

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

function header(name: string, size: number, typeflag: string): Uint8Array {
  const h = new Uint8Array(BLOCK);
  const put = (s: string, at: number) => h.set(enc.encode(s), at);
  put(name, 0);
  put(octal(0o644, 8), 100);
  put(octal(0, 8), 108);
  put(octal(0, 8), 116);
  put(octal(size, 12), 124);
  put(octal(0, 12), 136);
  put('        ', 148); // checksum field is spaces while summing
  put(typeflag, 156);
  put('ustar\0', 257);
  put('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  put(octal(sum, 8), 148);
  return h;
}

function pad(body: Uint8Array): Uint8Array {
  const rem = body.length % BLOCK;
  if (!rem) return body;
  const out = new Uint8Array(body.length + (BLOCK - rem));
  out.set(body);
  return out;
}

/** Build an uncompressed tar from files. */
export function buildTar(files: TarFile[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const f of files) {
    if (f.paxName || f.name.length > 100) {
      const record = enc.encode(`${String(f.name.length + 10).padStart(3, '0')} path=${f.name}\n`);
      const ph = header('PaxHeader/record', record.length, 'x');
      parts.push(ph, pad(record));
      parts.push(header('', f.body.length, '0'), pad(f.body));
      continue;
    }
    // Old-style long names: split at the last '/' that fits the 100-byte name.
    let name = f.name;
    let prefix = '';
    if (f.name.length > 100) {
      const at = f.name.lastIndexOf('/', f.name.length - 100);
      if (at < 0) throw new Error(`name too long for ustar and has no '/': ${f.name}`);
      prefix = f.name.slice(0, at);
      name = f.name.slice(at + 1);
      if (name.length > 100 || prefix.length > 155) throw new Error(`unsplitable name: ${f.name}`);
    }
    const h = header(name, f.body.length, '0');
    if (prefix) h.set(enc.encode(prefix), 345);
    parts.push(h, pad(f.body));
  }
  // Two zero blocks end the archive; some writers add more.
  parts.push(new Uint8Array(BLOCK * 2));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** The tile paths in a pack, for splitting fixtures into several packs. */
export function partition(
  entries: readonly { name: string; offset: number; size: number }[],
  bytes: Uint8Array,
  parts: number,
): Uint8Array[] {
  const buckets: TarFile[][] = Array.from({ length: parts }, () => []);
  entries.forEach((e, i) => {
    buckets[i % parts].push({ name: e.name, body: bytes.slice(e.offset, e.offset + e.size) });
  });
  return buckets.map((files) => buildTar(files));
}
