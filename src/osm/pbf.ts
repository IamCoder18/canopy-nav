/**
 * `.osm.pbf` reader — OSM ProtocolBuffer Binary Format.
 *
 * This is the format Geofabrik actually ships, so it is what makes a real
 * extract importable without an `osmium cat` round trip on a desktop first.
 *
 * The output shape is identical to the XML parser in `engine.worker.ts`, so
 * both feed straight into `buildDataset(nodes, ways)`:
 *
 *     const { nodes, ways } = await parseOsmPbf(bytes, onProgress);
 *     buildDataset(nodes, ways, onProgress);
 *
 * File structure (https://wiki.openstreetmap.org/wiki/PBF_Format):
 *
 *     repeat:
 *       uint32be  length of BlobHeader
 *       BlobHeader { 1: type "OSMHeader" | "OSMData", 3: datasize }
 *       Blob       { 1: raw | 3: zlib_data | 6: zstd_data, ... }
 *
 * An `OSMData` blob holds one `PrimitiveBlock` { 1: StringTable, 2: groups* },
 * and a `PrimitiveGroup` holds `Node`* (1), `DenseNodes` (2), `Way`* (3) and
 * `Relation`* (4). DenseNodes is what every real extract uses; it is
 * delta- and zigzag-encoded to stay small.
 *
 * No dependencies: zlib inflate uses the platform `DecompressionStream`, which
 * exists in Chrome/Android WebView and Node 18+. zstd is detected and reported
 * clearly rather than mis-parsed into garbage coordinates.
 */

import type { RawNode, RawWay } from './engine.worker';
import { isInterestingTag } from './tags';

export type { RawNode, RawWay };

/** Thrown for anything that is not a well-formed `.osm.pbf`. */
export class PbfFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PbfFormatError';
  }
}

/* ----------------------------- protobuf ------------------------------- */

/** Wire types. 3/4 (groups) do not occur in OSM PBF and are rejected below. */
const WIRE_VARINT = 0;
const WIRE_64BIT = 1;
const WIRE_LEN = 2;
const WIRE_START_GROUP = 3;
const WIRE_END_GROUP = 4;
const WIRE_32BIT = 5;

/** Sanity ceilings so garbage fails fast instead of allocating wildly. */
const MAX_BLOB_HEADER = 64 * 1024;
const MAX_BLOB_SIZE = 96 * 1024 * 1024;
const MAX_VARINT_BYTES = 10;

const EMPTY = new Uint8Array(0);
const DECODER = new TextDecoder();

/**
 * Two's-complement reinterpretation of a 10-byte varint, i.e. a negative
 * int64. Every value this parser reads — node ids (~1e10), way ids,
 * nanodegrees (~1e11) — is far inside ±2^53, so this cold path exists only so
 * a malformed negative int64 cannot turn into a huge positive number.
 */
function signedFrom10Bytes(buf: Uint8Array, start: number): number {
  let v = 0n;
  for (let i = 0; i < MAX_VARINT_BYTES; i++) {
    v |= BigInt(buf[start + i]! & 0x7f) << BigInt(7 * i);
  }
  if (v >= 1n << 63n) v -= 1n << 64n;
  return Number(v);
}

/** Minimal protobuf cursor over the byte range [start, end). */
class Reader {
  private readonly buf: Uint8Array;
  private readonly start: number;
  private pos: number;
  private readonly end: number;

  constructor(buf: Uint8Array, pos = 0, end = buf.length) {
    this.buf = buf;
    this.start = pos;
    this.pos = pos;
    this.end = end;
  }

  get done(): boolean {
    return this.pos >= this.end;
  }

  /** A second cursor over the same range, for two-pass reads. */
  fork(): Reader {
    return new Reader(this.buf, this.start, this.end);
  }

  /** Read a base-128 varint. */
  varint(): number {
    const start = this.pos;
    let result = 0;
    let shift = 0;
    let byte = 0;
    let count = 0;
    do {
      if (this.pos >= this.end) throw new PbfFormatError('truncated varint (message ends mid-field)');
      byte = this.buf[this.pos++]!;
      result += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (++count > MAX_VARINT_BYTES) {
        throw new PbfFormatError('varint longer than 10 bytes — not a protobuf stream');
      }
    } while (byte & 0x80);
    // Ten bytes puts the 64-bit sign bit in play.
    if (count === MAX_VARINT_BYTES) return signedFrom10Bytes(this.buf, start);
    return result;
  }

  /** Consume a length-delimited field and return a view of its bytes. */
  bytes(): Uint8Array {
    const len = this.varint();
    if (len < 0 || this.pos + len > this.end) {
      throw new PbfFormatError(
        `length-delimited field overruns its message: wants ${len} bytes, ${this.end - this.pos} available`,
      );
    }
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  skip(n: number): void {
    if (n < 0 || this.pos + n > this.end) {
      throw new PbfFormatError(`skip of ${n} bytes runs past the end of the message`);
    }
    this.pos += n;
  }

  /** Step over a field we do not care about, keyed by its wire type. */
  skipField(wire: number): void {
    switch (wire) {
      case WIRE_VARINT: this.varint(); return;
      case WIRE_64BIT: this.skip(8); return;
      case WIRE_LEN: this.bytes(); return;
      case WIRE_32BIT: this.skip(4); return;
      case WIRE_START_GROUP:
      case WIRE_END_GROUP:
        throw new PbfFormatError('protobuf groups (wire type 3/4) are not valid in OSM PBF — file looks corrupt');
      default:
        throw new PbfFormatError(`unknown protobuf wire type ${wire} — file is not OSM PBF`);
    }
  }

  /**
   * True when the current field has the expected wire type; otherwise it is
   * skipped and false is returned. Lets the message readers switch on field
   * number alone without tripping over a wire-type mismatch.
   */
  isWire(wire: number, want: number): boolean {
    if (wire === want) return true;
    this.skipField(wire);
    return false;
  }
}

/** `sint32`/`sint64` zigzag decode. Avoids bit ops, which break past 2^31. */
function zigzag(n: number): number {
  return n % 2 === 0 ? n / 2 : -(n + 1) / 2;
}

/**
 * Decode a packed, delta-encoded, zigzag `sint64` field into absolute values.
 * An absent or empty field yields an empty list.
 */
function deltas(b: Uint8Array): number[] {
  const out: number[] = [];
  const r = new Reader(b);
  let acc = 0;
  while (!r.done) {
    acc += zigzag(r.varint());
    out.push(acc);
  }
  return out;
}

/* ------------------------------ string table -------------------------- */

/**
 * Decoded `StringTable`, index-addressed like the protobuf message. Duplicate
 * entries are legal on the wire and simply occupy two indices, so this is a
 * plain array: `get` never assumes uniqueness or interning.
 */
class StringTable {
  private readonly list: string[] = [];

  parse(r: Reader): void {
    while (!r.done) {
      const tag = r.varint();
      const field = tag >>> 3;
      const wire = tag & 7;
      if (field === 1 && wire === WIRE_LEN) this.list.push(DECODER.decode(r.bytes()));
      else r.skipField(wire);
    }
  }

  /** String at `i`, or '' for an out-of-range index (never throw mid-extract). */
  get(i: number): string {
    return this.list[i] ?? '';
  }
}

/* ------------------------------- scratch ------------------------------ */

/** Growable buffer reused across every blob, so a big file allocates once. */
class Scratch {
  private buf = new Uint8Array(64 * 1024);

  /** Copy `src` at `offset`, growing as needed. */
  write(src: Uint8Array, offset: number): void {
    const need = offset + src.length;
    if (need > this.buf.length) {
      let cap = this.buf.length;
      while (cap < need) cap *= 2;
      const next = new Uint8Array(cap);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf.set(src, offset);
  }

  view(length: number): Uint8Array {
    return this.buf.subarray(0, length);
  }
}

/* ---------------------------- primitives ------------------------------ */

type TaggedNode = RawNode & { tags?: Record<string, string> };

interface ParseOutput {
  nodes: Map<number, RawNode>;
  ways: RawWay[];
}

/** `Node` — id=1 sint64, keys=2 packed, vals=3 packed, lat=8, lon=9 (nanodegrees). */
function parseNode(r: Reader, st: StringTable, out: ParseOutput): void {
  let id = 0;
  let lat = 0;
  let lon = 0;
  let keys: Uint8Array | null = null;
  let vals: Uint8Array | null = null;
  while (!r.done) {
    const tag = r.varint();
    const field = tag >>> 3;
    const wire = tag & 7;
    switch (field) {
      case 1: if (r.isWire(wire, WIRE_VARINT)) id = zigzag(r.varint()); break;
      case 2: if (r.isWire(wire, WIRE_LEN)) keys = r.bytes(); break;
      case 3: if (r.isWire(wire, WIRE_LEN)) vals = r.bytes(); break;
      case 8: if (r.isWire(wire, WIRE_VARINT)) lat = zigzag(r.varint()); break;
      case 9: if (r.isWire(wire, WIRE_VARINT)) lon = zigzag(r.varint()); break;
      default: r.skipField(wire); break; // info / version / future fields
    }
  }
  // OSM PBF stores coordinates as **nanodegrees**: 1e-7 degrees, not 1e-9.
  //
  // This was wrong for a long time and nothing caught it, because `tools/osm2pbf.mjs`
  // -- the encoder that builds the fixtures -- divided by the same 1e9, so the
  // round trip was self-consistent and every test passed. A real Geofabrik
  // extract, which uses the spec's 1e7, decoded 100x too small: Andorra's
  // 42.42 N arrived as 0.4242, putting the whole country in the Gulf of Guinea
  // and making every cross-region distance and every route wrong.
  //
  // Divided rather than multiplied by 1e-7: both powers of ten are exactly
  // representable, and division by 1e7 is the form the spec's integer-to-degrees
  // step is usually written in.
  const dLat = lat / 1e7;
  const dLon = lon / 1e7;
  // Same bound the XML reader applies, for the same reason: a coordinate outside
  // the valid range is a corrupt or hostile element, and accepting it puts
  // invented places into the gazetteer and nonsense into the bounding box.
  if (!Number.isFinite(dLat) || !Number.isFinite(dLon)) return;
  if (dLat < -90 || dLat > 90 || dLon < -180 || dLon > 180) return;
  const node: TaggedNode = { id, lat: dLat, lon: dLon };
  const tags = readTags(keys, vals, st);
  if (tags) node.tags = tags;
  out.nodes.set(id, node);
}

/**
 * `DenseNodes` — the common case. id/lat/lon are packed sint64 delta runs
 * accumulated across the whole block; keys_vals is a packed int32 stream of
 * alternating (key index, value index) pairs with a 0 ending each node's pairs.
 */
function parseDenseNodes(r: Reader, st: StringTable, out: ParseOutput): void {
  let idBuf: Uint8Array | null = null;
  let latBuf: Uint8Array | null = null;
  let lonBuf: Uint8Array | null = null;
  let kvBuf: Uint8Array | null = null;
  while (!r.done) {
    const tag = r.varint();
    const field = tag >>> 3;
    const wire = tag & 7;
    switch (field) {
      case 1: if (r.isWire(wire, WIRE_LEN)) idBuf = r.bytes(); break;
      case 8: if (r.isWire(wire, WIRE_LEN)) latBuf = r.bytes(); break;
      case 9: if (r.isWire(wire, WIRE_LEN)) lonBuf = r.bytes(); break;
      case 10: if (r.isWire(wire, WIRE_LEN)) kvBuf = r.bytes(); break;
      default: r.skipField(wire); break;
    }
  }

  const ids = deltas(idBuf ?? EMPTY);
  const lats = deltas(latBuf ?? EMPTY);
  const lons = deltas(lonBuf ?? EMPTY);
  const n = ids.length;

  // Mismatched runs would smear one node's coordinate onto another, silently
  // producing plausible-looking nonsense, so treat that as corruption.
  if (lats.length !== n || lons.length !== n) {
    throw new PbfFormatError(`corrupt DenseNodes: ${n} ids but ${lats.length} lats / ${lons.length} lons`);
  }

  const kv = kvBuf ? new Reader(kvBuf) : null;
  for (let i = 0; i < n; i++) {
    const lat = lats[i]! / 1e7;
    const lon = lons[i]! / 1e7;
    // Same range check as the single-node path: a corrupt delta run must not be
    // able to inject off-Earth coordinates into the gazetteer.
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    const node: TaggedNode = { id: ids[i]!, lat, lon };
    if (kv) {
      let tags: Record<string, string> | null = null;
      for (;;) {
        const k = kv.varint();
        if (k === 0) break; // end of this node's pairs
        const v = kv.varint();
        const key = st.get(k);
        if (isInterestingTag(key)) (tags ??= {})[key] = st.get(v);
      }
      if (tags) node.tags = tags;
    }
    out.nodes.set(node.id, node);
  }
}

/** `Way` — id=1 int64 (NOT zigzag), keys=2, vals=3, refs=8 packed sint64 delta. */
function parseWay(r: Reader, st: StringTable, out: ParseOutput): void {
  let id = 0;
  let keys: Uint8Array | null = null;
  let vals: Uint8Array | null = null;
  let refs: Uint8Array | null = null;
  while (!r.done) {
    const tag = r.varint();
    const field = tag >>> 3;
    const wire = tag & 7;
    switch (field) {
      case 1: if (r.isWire(wire, WIRE_VARINT)) id = r.varint(); break;
      case 2: if (r.isWire(wire, WIRE_LEN)) keys = r.bytes(); break;
      case 3: if (r.isWire(wire, WIRE_LEN)) vals = r.bytes(); break;
      case 8: if (r.isWire(wire, WIRE_LEN)) refs = r.bytes(); break;
      default: r.skipField(wire); break; // info / deprecated lat-lon
    }
  }

  // Same two filters the XML parser applies: an untagged way is never useful to
  // the routing graph, and a way with fewer than two refs has no geometry.
  // Dropping them here keeps both parsers producing identical output.
  const tags = readTags(keys, vals, st);
  if (!tags) return;

  const wayRefs = refs ? deltas(refs) : [];
  if (wayRefs.length < 2) return;

  out.ways.push({ id, refs: wayRefs, tags });
}

/** Pair up packed key/value index runs against the string table. */
function readTags(
  keys: Uint8Array | null,
  vals: Uint8Array | null,
  st: StringTable,
): Record<string, string> | null {
  if (!keys || !vals) return null;
  const kr = new Reader(keys);
  const vr = new Reader(vals);
  const out: Record<string, string> = {};
  let count = 0;
  while (!kr.done && !vr.done) {
    out[st.get(kr.varint())] = st.get(vr.varint());
    count++;
  }
  return count > 0 ? out : null;
}

/** `PrimitiveGroup` — nodes=1, dense=2, ways=3, relations=4. */
function parsePrimitiveGroup(r: Reader, st: StringTable, out: ParseOutput): void {
  while (!r.done) {
    const tag = r.varint();
    const field = tag >>> 3;
    const wire = tag & 7;
    // Every field we handle here is a submessage, so anything else is unknown.
    if (wire !== WIRE_LEN) { r.skipField(wire); continue; }
    const body = new Reader(r.bytes());
    switch (field) {
      case 1: parseNode(body, st, out); break;
      case 2: parseDenseNodes(body, st, out); break;
      case 3: parseWay(body, st, out); break;
      // 4 = Relation: unused by the road graph, so skipped.
      default: break;
    }
  }
}

/** `PrimitiveBlock` — stringtable=1, primitivegroup=2. */
function parsePrimitiveBlock(block: Reader, out: ParseOutput): void {
  const st = new StringTable();
  // Two passes rather than trusting field order: groups cannot be read until
  // the string table is complete, and protobuf does not promise the writer put
  // the table first. Re-reading is far cheaper than buffering every group.
  let r = block.fork();
  while (!r.done) {
    const tag = r.varint();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 1 && wire === WIRE_LEN) st.parse(new Reader(r.bytes()));
    else r.skipField(wire);
  }
  r = block.fork();
  while (!r.done) {
    const tag = r.varint();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 2 && wire === WIRE_LEN) parsePrimitiveGroup(new Reader(r.bytes()), st, out);
    else r.skipField(wire);
  }
}

/* ------------------------------- blobs -------------------------------- */

/** Inflate zlib bytes into the shared scratch buffer. */
async function inflateInto(scratch: Scratch, src: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new PbfFormatError(
      'this environment has no DecompressionStream, so zlib-compressed .osm.pbf blobs cannot be read. ' +
      'Convert the extract on a desktop instead: osmium cat region.osm.pbf -o region.osm',
    );
  }
  // Typed as BufferSource (rather than Uint8Array) because that is what
  // DecompressionStream's writable side accepts. The cast is sound at runtime:
  // `src` is always a view onto a plain ArrayBuffer read from a File.
  const source = new ReadableStream<BufferSource>({
    start(c) { c.enqueue(src as Uint8Array<ArrayBuffer>); c.close(); },
  });
  const reader = source.pipeThrough(new DecompressionStream('deflate')).getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    scratch.write(value, total);
    total += value.length;
  }
  return scratch.view(total);
}

/** Extract one `Blob`'s payload, inflating zlib as needed. */
async function readBlobPayload(r: Reader, scratch: Scratch): Promise<Uint8Array> {
  let raw: Uint8Array | null = null;
  let zlib: Uint8Array | null = null;
  let zstd = false;
  let exotic = '';
  while (!r.done) {
    const tag = r.varint();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (wire !== WIRE_LEN) { r.skipField(wire); continue; }
    // Note every branch still has to consume its body, or the next iteration
    // would read the payload as if it were a field tag.
    const body = r.bytes();
    if (field === 1) raw = body;
    else if (field === 3) zlib = body;
    else if (field === 6) zstd = true;
    else if (field === 4) exotic = 'lzma';
    else if (field === 5) exotic = 'lz4';
  }

  if (zstd) {
    throw new PbfFormatError(
      'this .osm.pbf uses zstd-compressed blobs, which this build cannot decompress ' +
      '(no built-in zstd in Chrome/WebView). Convert it on a desktop: osmium cat region.osm.pbf -o region.osm',
    );
  }
  if (exotic) {
    throw new PbfFormatError(
      `this .osm.pbf uses ${exotic}-compressed blobs, which this build cannot decompress. ` +
      'Convert it on a desktop: osmium cat region.osm.pbf -o region.osm',
    );
  }
  if (raw) return raw;
  if (zlib) return await inflateInto(scratch, zlib);
  throw new PbfFormatError('blob carries neither raw nor zlib_data payload');
}

function readU32BE(b: Uint8Array, p: number): number {
  return b[p]! * 0x1000000 + ((b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!);
}

/* ------------------------------- public ------------------------------- */

/**
 * Parse a `.osm.pbf` file into the same `{ nodes, ways }` the XML parser
 * returns, so the result drops straight into `buildDataset`.
 *
 * `onProgress` gets a monotonic 0..1 based on bytes consumed.
 *
 * Not supported: zstd-compressed blobs (detected and reported rather than
 * mis-parsed), relations (irrelevant to the road graph), and streaming from
 * disk — the whole file must be in memory.

 * That last one used to say "exactly like the XML path", which was true of the
 * pre-streaming design and is false now: the XML path *does* stream, in a bounded
 * window (`parseOsmXmlStream`), and that is the path production uses. PBF is the
 * normal format and is always held whole. Recorded in STATUS.md §14.16.
 */
export async function parseOsmPbf(
  bytes: Uint8Array,
  onProgress: (pct: number) => void = () => {},
): Promise<{ nodes: Map<number, RawNode>; ways: RawWay[] }> {
  if (!(bytes instanceof Uint8Array)) {
    throw new PbfFormatError('parseOsmPbf expects the file contents as a Uint8Array');
  }
  if (bytes.length === 0) throw new PbfFormatError('file is empty — not an .osm.pbf');
  if (bytes[0] === 0x3c /* < */) {
    throw new PbfFormatError(
      'this looks like OSM XML rather than .osm.pbf — parse it with parseOsmXml, ' +
      'or check that a .osm.pbf download was not saved with an .osm extension.',
    );
  }

  const out: ParseOutput = { nodes: new Map<number, RawNode>(), ways: [] };
  const scratch = new Scratch();
  let dataBlobs = 0;
  let reported = 0;
  let pos = 0;

  while (pos < bytes.length) {
    if (bytes.length - pos < 4) {
      throw new PbfFormatError(
        `truncated file: ${bytes.length - pos} trailing byte(s) where a 4-byte blob-header length was expected`,
      );
    }
    const headerLen = readU32BE(bytes, pos);
    pos += 4;
    if (headerLen > MAX_BLOB_HEADER) {
      throw new PbfFormatError(`implausible blob-header length ${headerLen} — file is not OSM PBF`);
    }
    if (pos + headerLen > bytes.length) {
      throw new PbfFormatError(
        `truncated file: blob header claims ${headerLen} bytes, only ${bytes.length - pos} remain`,
      );
    }

    let type = '';
    let datasize = -1;
    const hr = new Reader(bytes, pos, pos + headerLen);
    while (!hr.done) {
      const tag = hr.varint();
      const field = tag >>> 3;
      const wire = tag & 7;
      if (field === 1 && wire === WIRE_LEN) type = DECODER.decode(hr.bytes());
      else if (field === 3 && wire === WIRE_VARINT) datasize = hr.varint();
      else hr.skipField(wire);
    }
    pos += headerLen;

    if (!type) throw new PbfFormatError('blob header has no type field');
    if (datasize < 0) throw new PbfFormatError(`blob header "${type}" has no datasize field`);
    if (datasize > MAX_BLOB_SIZE) {
      throw new PbfFormatError(`implausible blob size ${datasize} for "${type}" — file is not OSM PBF`);
    }
    if (pos + datasize > bytes.length) {
      throw new PbfFormatError(
        `truncated file: ${type} blob claims ${datasize} bytes, only ${bytes.length - pos} remain`,
      );
    }

    if (type === 'OSMData') {
      // A PrimitiveBlock is always wholly inside one Blob, so the previous
      // block's data is finished with by the time we get here.
      const payload = await readBlobPayload(new Reader(bytes, pos, pos + datasize), scratch);
      parsePrimitiveBlock(new Reader(payload), out);
      dataBlobs++;
    }
    // OSMHeader carries bbox/feature metadata only — never parse it as data.

    pos += datasize;
    const pct = pos / bytes.length;
    if (pct > reported) {
      reported = pct;
      onProgress(pct);
    }
  }

  if (dataBlobs === 0) {
    throw new PbfFormatError('no OSMData blobs in this file — headers only, or not OSM PBF at all');
  }

  onProgress(1);
  return { nodes: out.nodes, ways: out.ways };
}