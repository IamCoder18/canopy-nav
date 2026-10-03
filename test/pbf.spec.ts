/**
 * `.osm.pbf` reader tests.
 *
 * The point of these is *equivalence*: `src/osm/pbf.ts` exists to feed the same
 * `buildDataset` pipeline as the XML parser, so a PBF built here must produce
 * output identical to `parseOsmXml` on the same data. To keep that from being a
 * tautology, the PBF is encoded here from the wire format up (varint writer,
 * zigzag, packed fields, zlib via `CompressionStream`) while the expected XML
 * is a hand-written literal — two independent transcriptions of one dataset.
 *
 * Coverage: zlib and uncompressed blobs, the OSMHeader blob (which must never
 * be read as data), DenseNodes, plain Node, Way, a Relation (must be ignored),
 * unknown fields of every wire type, out-of-order protobuf fields, a duplicated
 * string-table entry, ways split across blobs, progress, and a pile of corrupt
 * inputs. Plus a full re-encode of `test/fixture.osm` pushed through
 * `buildDataset`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseOsmPbf, PbfFormatError } from '../src/osm/pbf';
import { parseOsmXml, buildDataset } from '../src/osm/engine.worker';
import type { RawNode, RawWay } from '../src/osm/engine.worker';

const XML_FIXTURE = readFileSync(join(__dirname, 'fixture.osm'), 'utf8');

/* ======================= minimal PBF encoder (test) ==================== */

const WIRE_VARINT = 0;
const WIRE_64BIT = 1;
const WIRE_LEN = 2;
const WIRE_32BIT = 5;

const UTF8 = new TextEncoder();

function zigzag(v: number): number {
  return v < 0 ? -2 * v - 1 : 2 * v;
}

/** Degrees -> nanodegrees, the way a real writer does it. */
function toNd(deg: number): number {
  return Math.round(deg * 1e9);
}

/**
 * Protobuf writer over a growable byte array. Varints use `% 128` rather than
 * bit ops, which coerce to int32 and would wrap above 2^31 — exactly where
 * nanodegrees and node ids live.
 */
class Writer {
  private out: number[] = [];

  varint(v: number): this {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`varint needs a safe non-negative int, got ${v}`);
    let x = v;
    while (x >= 0x80) {
      const rem = x % 128;
      this.out.push(rem + 0x80);
      x = (x - rem) / 128;
    }
    this.out.push(x);
    return this;
  }

  /** sint32/sint64: zigzag, then varint. */
  sint(field: number, v: number): this {
    return this.tag(field, WIRE_VARINT).varint(zigzag(v));
  }

  /** int64/uint64/int32/enum/bool: plain varint, no zigzag. */
  int(field: number, v: number): this {
    return this.tag(field, WIRE_VARINT).varint(v);
  }

  bool(field: number, v: boolean): this {
    return this.int(field, v ? 1 : 0);
  }

  len(field: number, body: Uint8Array): this {
    this.tag(field, WIRE_LEN).varint(body.length);
    return this.raw(body);
  }

  str(field: number, s: string): this {
    return this.len(field, UTF8.encode(s));
  }

  tag(field: number, wire: number): this {
    return this.varint(field * 8 + wire);
  }

  raw(b: Uint8Array): this {
    for (const byte of b) this.out.push(byte);
    return this;
  }

  /** Fields no reader should touch, one per wire type, to prove skipping works. */
  junk(): this {
    return this
      .int(20, 12345) // unknown varint
      .tag(21, WIRE_64BIT).raw(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8))
      .tag(22, WIRE_32BIT).raw(Uint8Array.of(9, 9, 9, 9));
  }

  bytes(): Uint8Array {
    return Uint8Array.from(this.out);
  }
}

/** zlib-compress — exactly what a Blob's `zlib_data` holds. */
async function deflate(src: Uint8Array): Promise<Uint8Array> {
  const source = new ReadableStream<BufferSource>({
    start(c) { c.enqueue(src as Uint8Array<ArrayBuffer>); c.close(); },
  });
  const reader = source.pipeThrough(new CompressionStream('deflate')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** String table builder. Deduplicates, but `dup()` forces a repeated entry. */
class Table {
  readonly entries: string[] = ['']; // index 0 is empty, by convention
  private index = new Map<string, number>([['', 0]]);

  of(s: string): number {
    let i = this.index.get(s);
    if (i === undefined) {
      i = this.entries.length;
      this.entries.push(s);
      this.index.set(s, i);
    }
    return i;
  }

  dup(s: string): number {
    this.entries.push(s);
    return this.entries.length - 1;
  }
}

interface PbfNode { id: number; lat: number; lon: number; tags?: [string, string][] }

function packed(indices: number[]): Uint8Array {
  const w = new Writer();
  for (const i of indices) w.varint(i);
  return w.bytes();
}

function tagFields(tags: [string, string][], t: Table, keys?: Map<string, number>): {
  keys: Uint8Array; vals: Uint8Array;
} {
  const ks: number[] = [];
  const vs: number[] = [];
  for (const [k, v] of tags) {
    ks.push(keys?.get(k) ?? t.of(k));
    vs.push(t.of(v));
  }
  return { keys: packed(ks), vals: packed(vs) };
}

/**
 * DenseNodes. `keys_vals` is deliberately emitted *before* id/lat/lon: field
 * order is not guaranteed by protobuf, so the reader must not rely on it.
 */
function encodeDense(nodes: PbfNode[], t: Table, keyOverride?: Map<string, number>): Uint8Array {
  const kv = new Writer();
  for (const n of nodes) {
    for (const [k, v] of n.tags ?? []) {
      kv.varint(keyOverride?.get(k) ?? t.of(k));
      kv.varint(t.of(v));
    }
    kv.varint(0);
  }

  const ids = new Writer();
  const lats = new Writer();
  const lons = new Writer();
  let pId = 0, pLat = 0, pLon = 0;
  for (const n of nodes) {
    ids.varint(zigzag(n.id - pId)); pId = n.id;
    const lat = toNd(n.lat), lon = toNd(n.lon);
    lats.varint(zigzag(lat - pLat)); pLat = lat;
    lons.varint(zigzag(lon - pLon)); pLon = lon;
  }

  return new Writer()
    .len(10, kv.bytes())
    .len(1, ids.bytes())
    .len(8, lats.bytes())
    .len(9, lons.bytes())
    .bytes();
}

/** Plain `Node`: id=1 sint64, keys=2, vals=3, lat=8, lon=9. */
function encodeNode(n: PbfNode, t: Table): Uint8Array {
  const { keys, vals } = tagFields(n.tags ?? [], t);
  const w = new Writer();
  w.sint(1, n.id);
  if (keys.length) {
    w.len(2, keys);
    w.len(3, vals);
  }
  w.int(4, 3); // version-ish varint the reader must skip
  w.tag(7, WIRE_64BIT).raw(new Uint8Array(8));
  w.sint(8, toNd(n.lat));
  w.sint(9, toNd(n.lon));
  return w.bytes();
}

/** `Way`: id=1 int64 (NOT zigzag), keys=2, vals=3, refs=8 packed sint64 delta. */
function encodeWay(id: number, refs: number[], tags: [string, string][], t: Table): Uint8Array {
  const { keys, vals } = tagFields(tags, t);
  const refs_ = new Writer();
  let prev = 0;
  for (const ref of refs) {
    refs_.varint(zigzag(ref - prev));
    prev = ref;
  }
  return new Writer()
    .int(1, id)
    .len(2, keys)
    .len(3, vals)
    .len(8, refs_.bytes())
    .bytes();
}

/** `Relation` — unused by the pipeline, so the reader must step over it. */
function encodeRelation(id: number, refs: number[]): Uint8Array {
  const memids = new Writer();
  let prev = 0;
  for (const ref of refs) {
    memids.varint(zigzag(ref - prev));
    prev = ref;
  }
  return new Writer()
    .int(1, id)
    .len(8, packed([1])) // roles_sid
    .len(9, memids.bytes()) // memids
    .len(10, packed([1, 1])) // types: node / node
    .bytes();
}

/** One primitive inside a PrimitiveGroup, with its field number. */
interface Primitive { field: 1 | 2 | 3 | 4; body: Uint8Array }

/**
 * One PrimitiveBlock: each entry of `groups` becomes a PrimitiveGroup written
 * as field 2. Groups are written *before* the string table, which is legal and
 * forces the reader's two-pass string-table handling to work.
 */
function encodeBlock(groups: Primitive[][], t: Table): Uint8Array {
  const w = new Writer();
  for (const group of groups) {
    const g = new Writer();
    for (const p of group) g.len(p.field, p.body);
    w.len(2, g.bytes());
  }
  const st = new Writer();
  for (const s of t.entries) st.len(1, UTF8.encode(s));
  return w.len(1, st.bytes()).junk().bytes();
}

/** HeaderBlock: bbox + required features, which must never be read as data. */
function encodeHeader(): Uint8Array {
  const bbox = new Writer()
    .sint(1, -133000000) // left
    .sint(2, -127800000) // right
    .sint(3, 515100000) // top
    .sint(4, 515074000) // bottom
    .bytes();
  return new Writer()
    .len(1, bbox)
    .str(4, 'OsmSchema-V0.6')
    .str(4, 'DenseNodes')
    .bool(16, true) // writing
    .junk()
    .bytes();
}

/** Assemble one 4-byte-BE length + BlobHeader + Blob record. */
function assembleBlob(type: string, body: Uint8Array, indexData?: Uint8Array): Uint8Array {
  const hw = new Writer().str(1, type);
  if (indexData) hw.len(2, indexData);
  const header = hw.int(3, body.length).bytes();

  const len = header.length;
  return new Writer()
    .raw(Uint8Array.of((len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff))
    .raw(header)
    .raw(body)
    .bytes();
}

/** A `Blob` holding `payload`, optionally zlib-compressed like real files. */
async function blob(type: string, payload: Uint8Array, compress: boolean): Promise<Uint8Array> {
  if (!compress) return assembleBlob(type, new Writer().len(1, payload).bytes());
  const deflated = await deflate(payload);
  const body = new Writer().int(2, payload.length).len(3, deflated).bytes(); // raw_size
  return assembleBlob(type, body, type === 'OSMHeader' ? Uint8Array.of(0, 1, 2) : undefined);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/* ============================= comparison ============================= */

/**
 * PBF stores coordinates as integer nanodegrees, so it cannot hold the 17th
 * decimal digit that JavaScript's `String(lon)` sprinkles through
 * `test/fixture.osm`. Comparisons therefore snap coordinates to the nanodegree
 * grid — the finest precision the format can express — while ids, refs and
 * tags are compared exactly.
 */
const atNano = (deg: number): number => Math.round(deg * 1e9) / 1e9;

/** Order-independent view of parse output, to compare against the XML path. */
function shape(nodes: Map<number, RawNode>, ways: RawWay[]) {
  return {
    nodes: [...nodes.values()]
      .map((n) => ({
        id: n.id,
        lat: atNano(n.lat),
        lon: atNano(n.lon),
        tags: (n as RawNode & { tags?: Record<string, string> }).tags,
      }))
      .sort((a, b) => a.id - b.id),
    ways: ways
      .map((w) => ({ id: w.id, refs: w.refs, tags: w.tags }))
      .sort((a, b) => a.id - b.id),
  };
}

/* ====================== hand-built equivalent data ==================== */

/** The same small dataset as literal XML, for the reader to match. */
const HAND_XML = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="canopy-pbf-test">
  <node id="1" lat="51.5074" lon="-0.1278" version="1">
    <tag k="name" v="Testford"/>
    <tag k="place" v="town"/>
    <tag k="population" v="12345"/>
  </node>
  <node id="2" lat="51.5080" lon="-0.1290" version="1"/>
  <node id="3" lat="51.5085" lon="-0.1300" version="1">
    <tag k="name" v="Corner Cafe"/>
    <tag k="amenity" v="cafe"/>
  </node>
  <node id="4" lat="51.5090" lon="-0.1310" version="1">
    <tag k="highway" v="traffic_signals"/>
    <tag k="source" v="survey"/>
  </node>
  <node id="5" lat="51.5095" lon="-0.1320" version="1">
    <tag k="surface" v="asphalt"/>
  </node>
  <node id="100" lat="51.5100" lon="-0.1330" version="1"/>
  <way id="200" version="1">
    <nd ref="1"/>
    <nd ref="2"/>
    <nd ref="3"/>
    <tag k="highway" v="residential"/>
    <tag k="name" v="High Street"/>
  </way>
  <way id="201" version="1">
    <nd ref="3"/>
    <nd ref="4"/>
    <tag k="highway" v="oneway"/>
    <tag k="name" v="One Way Street"/>
    <tag k="oneway" v="yes"/>
  </way>
  <way id="202" version="1">
    <nd ref="4"/>
    <nd ref="5"/>
    <nd ref="1"/>
    <tag k="waterway" v="river"/>
    <tag k="name" v="Test River"/>
  </way>
  <way id="203" version="1">
    <nd ref="1"/>
    <tag k="highway" v="footway"/>
  </way>
  <way id="204" version="1">
    <nd ref="1"/>
    <nd ref="2"/>
  </way>
  <way id="205" version="1">
    <nd ref="5"/>
    <nd ref="100"/>
    <tag k="highway" v="path"/>
    <tag k="name" v="Lane"/>
  </way>
  <way id="206" version="1">
    <nd ref="100"/>
    <nd ref="2"/>
    <tag k="building" v="yes"/>
  </way>
</osm>`;

const HAND_DENSE: PbfNode[] = [
  { id: 1, lat: 51.5074, lon: -0.1278, tags: [['name', 'Testford'], ['place', 'town'], ['population', '12345']] },
  { id: 2, lat: 51.508, lon: -0.129 },
  { id: 3, lat: 51.5085, lon: -0.13, tags: [['name', 'Corner Cafe'], ['amenity', 'cafe']] },
  { id: 4, lat: 51.509, lon: -0.131, tags: [['highway', 'traffic_signals'], ['source', 'survey']] },
  { id: 5, lat: 51.5095, lon: -0.132, tags: [['surface', 'asphalt']] },
];

const HAND_PLAIN: PbfNode[] = [{ id: 100, lat: 51.51, lon: -0.133 }];

const HAND_WAYS: { id: number; refs: number[]; tags: [string, string][] }[] = [
  { id: 200, refs: [1, 2, 3], tags: [['highway', 'residential'], ['name', 'High Street']] },
  { id: 201, refs: [3, 4], tags: [['highway', 'oneway'], ['name', 'One Way Street'], ['oneway', 'yes']] },
  // Refs run backwards mid-way, i.e. a negative delta inside the run.
  { id: 202, refs: [4, 5, 1], tags: [['waterway', 'river'], ['name', 'Test River']] },
  { id: 203, refs: [1], tags: [['highway', 'footway']] }, // one ref -> both parsers drop it
  { id: 204, refs: [1, 2], tags: [] }, // untagged -> both parsers drop it
  { id: 205, refs: [5, 100], tags: [['highway', 'path'], ['name', 'Lane']] },
  { id: 206, refs: [100, 2], tags: [['building', 'yes']] },
];

/** Header blob, then two OSMData blobs with mixed compression. */
async function buildHandPbf(): Promise<Uint8Array> {
  const t1 = new Table();
  // The table legally holds 'name' twice; one node refers to the later index,
  // so a reader that assumes one index per string would break here.
  const dupName = t1.dup('name');

  const dense = encodeDense(HAND_DENSE, t1, new Map([['name', dupName]]));
  const plain = encodeNode(HAND_PLAIN[0]!, t1);
  const ways: Primitive[] = HAND_WAYS.slice(0, 3)
    .map((w) => ({ field: 3 as const, body: encodeWay(w.id, w.refs, w.tags, t1) }));
  ways.push({ field: 4, body: encodeRelation(1, [1, 2, 3]) }); // must be ignored
  const blockA = encodeBlock([
    [{ field: 2, body: dense }],
    [{ field: 1, body: plain }],
    ways,
  ], t1);

  const t2 = new Table();
  const blockB = encodeBlock([HAND_WAYS.slice(3)
    .map((w) => ({ field: 3 as const, body: encodeWay(w.id, w.refs, w.tags, t2) }))], t2);

  return concat([
    await blob('OSMHeader', encodeHeader(), false),
    await blob('OSMData', blockA, true), // zlib
    await blob('OSMData', blockB, false), // uncompressed
  ]);
}

/* ========================= encode parsed output ======================= */

/** Re-encode parser output as PBF: one dense group per blob, mixed zlib/raw. */
async function encodeFromParsed(
  nodes: Map<number, RawNode>,
  ways: RawWay[],
  perBlob: number,
): Promise<Uint8Array> {
  const all = [...nodes.values()];
  const parts: Uint8Array[] = [await blob('OSMHeader', encodeHeader(), false)];
  let zipped = true;

  for (let i = 0; i < all.length; i += perBlob) {
    const slice = all.slice(i, i + perBlob).map((n) => ({
      id: n.id,
      lat: n.lat,
      lon: n.lon,
      tags: Object.entries((n as RawNode & { tags?: Record<string, string> }).tags ?? {}),
    }));
    const t = new Table();
    parts.push(await blob('OSMData', encodeBlock([[{ field: 2, body: encodeDense(slice, t) }]], t), zipped));
    zipped = !zipped;
  }

  // Ways after the nodes, in their own groups, so a way group is never split.
  for (let i = 0; i < ways.length; i += 300) {
    const t = new Table();
    const group = ways.slice(i, i + 300)
      .map((way) => ({ field: 3 as const, body: encodeWay(way.id, way.refs, Object.entries(way.tags), t) }));
    parts.push(await blob('OSMData', encodeBlock([group], t), zipped));
    zipped = !zipped;
  }

  return concat(parts);
}

const fixtureXml = parseOsmXml(XML_FIXTURE);
const fixturePbf = encodeFromParsed(fixtureXml.nodes, fixtureXml.ways, 700);

/* ================================ tests =============================== */

describe('osm pbf parsing', () => {
  it('matches the XML parser on a hand-built file', async () => {
    const fromPbf = await parseOsmPbf(await buildHandPbf());
    const fromXml = parseOsmXml(HAND_XML);

    expect(shape(fromPbf.nodes, fromPbf.ways)).toEqual(shape(fromXml.nodes, fromXml.ways));
    expect(fromPbf.nodes.size).toBe(6);
    expect(fromPbf.ways.map((w) => w.id)).toEqual([200, 201, 202, 205, 206]);
  });

  it('decodes dense nodes, plain nodes, refs and node tags', async () => {
    const { nodes, ways } = await parseOsmPbf(await buildHandPbf());

    // Nanodegrees -> degrees, with the delta chains fully accumulated.
    expect(nodes.get(1)).toMatchObject({ id: 1, lat: 51.5074, lon: -0.1278 });
    expect(nodes.get(5)).toMatchObject({ id: 5, lat: 51.5095, lon: -0.132 });
    expect(nodes.get(100)).toMatchObject({ id: 100, lat: 51.51, lon: -0.133 });

    // Only "interesting" tags survive, exactly as in the XML parser.
    // 'population' is not interesting, so node 1 keeps two tags.
    expect(tagsOf(nodes.get(1)!)).toEqual({ name: 'Testford', place: 'town' });
    expect(tagsOf(nodes.get(4)!)).toEqual({ highway: 'traffic_signals' });
    // 'source' / 'surface' are not interesting: node 4 keeps one tag, and
    // node 5 — whose only tag is 'surface' — carries no tags at all.
    expect('tags' in nodes.get(5)!).toBe(false);
    expect('tags' in nodes.get(2)!).toBe(false);
    expect('tags' in nodes.get(100)!).toBe(false);

    // Negative ref deltas, and ways landing in a second blob.
    expect(ways.find((w) => w.id === 202)!.refs).toEqual([4, 5, 1]);
    expect(ways.find((w) => w.id === 205)!.refs).toEqual([5, 100]);
    expect(ways.find((w) => w.id === 205)!.tags).toEqual({ highway: 'path', name: 'Lane' });
  });

  it('never mistakes the OSMHeader blob for data', async () => {
    // HeaderBlock holds a bbox in nanodegrees; read as data it would invent
    // four bogus nodes. The file has one header blob and six real nodes.
    const { nodes } = await parseOsmPbf(await buildHandPbf());
    expect([...nodes.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 100]);
  });

  it('round-trips the whole fixture and feeds buildDataset identically', async () => {
    const pbf = await fixturePbf;
    const pbfOut = await parseOsmPbf(pbf);

    expect(shape(pbfOut.nodes, pbfOut.ways)).toEqual(shape(fixtureXml.nodes, fixtureXml.ways));

    const fromXml = buildDataset(fixtureXml.nodes, fixtureXml.ways);
    const fromPbf = buildDataset(pbfOut.nodes, pbfOut.ways);
    expect(fromPbf.counts).toEqual(fromXml.counts);
    expect(fromPbf.bbox).toEqual(fromXml.bbox);
    expect(fromPbf.graph.nodeCount).toBe(fromXml.graph.nodeCount);
    expect(fromPbf.roads.length).toBe(fromXml.roads.length);
    expect(fromPbf.water.length).toBe(fromXml.water.length);
    expect(fromPbf.green.length).toBe(fromXml.green.length);
    expect(fromPbf.gaz.map((g) => `${g.name}|${g.cat}|${g.rank}`).sort())
      .toEqual(fromXml.gaz.map((g) => `${g.name}|${g.cat}|${g.rank}`).sort());
  });

  it('reports monotonic progress ending at 1', async () => {
    const seen: number[] = [];
    await parseOsmPbf(await fixturePbf, (p) => seen.push(p));
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[0]).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBe(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]!);
  });

  it('rejects garbage rather than returning an empty result', async () => {
    const rejects = async (bytes: Uint8Array, pattern: RegExp) => {
      await expect(parseOsmPbf(bytes)).rejects.toThrow(PbfFormatError);
      await expect(parseOsmPbf(bytes)).rejects.toThrow(pattern);
    };

    await rejects(new Uint8Array(0), /empty/);
    await rejects(UTF8.encode('not a pbf at all, just some text'), /implausible|truncated|blob header/);
    await rejects(Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0, 1, 2), /implausible/);
    await rejects(UTF8.encode(XML_FIXTURE.slice(0, 200)), /looks like OSM XML/);
    // Structurally valid, but it contains no OSMData blobs.
    await rejects(await blob('OSMHeader', encodeHeader(), true), /no OSMData blobs/);
  });

  it('rejects truncation at every boundary', async () => {
    const good = await fixturePbf;
    // Walking the cut back through the file: every one must raise rather than
    // hang, or quietly return {}.
    for (const cut of [1, 2, 3, 4, 5, 17, 64, 128, 1024, good.length - 1, good.length - 8]) {
      await expect(parseOsmPbf(good.subarray(0, cut)), `cut at ${cut}`).rejects.toThrow(PbfFormatError);
    }
    // A header whose datasize promises more than the file holds.
    const lying = assembleBlob('OSMData', new Writer().len(1, new Uint8Array([8, 1, 2])).bytes());
    await expect(parseOsmPbf(new Uint8Array([0, 0, 0, 12, ...lying.subarray(0, 8), 0, 0, 0])))
      .rejects.toThrow(PbfFormatError);
  });

  it('names the compression it cannot undo', async () => {
    for (const [field, name] of [[6, 'zstd'], [4, 'lzma'], [5, 'lz4']] as const) {
      const body = new Writer().len(field, Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd)).bytes();
      await expect(parseOsmPbf(assembleBlob('OSMData', body))).rejects.toThrow(new RegExp(name));
    }
  });

  it('rejects a corrupt DenseNodes whose coordinate runs disagree', async () => {
    const dense = new Writer()
      .len(1, new Writer().varint(1).varint(1).bytes()) // two ids
      .len(8, new Writer().varint(zigzag(toNd(51.5))).bytes()) // one lat
      .bytes();
    const block = encodeBlock([[{ field: 2, body: dense }]], new Table());
    await expect(parseOsmPbf(assembleBlob('OSMData', new Writer().len(1, block).bytes())))
      .rejects.toThrow(/corrupt DenseNodes/);
  });

  it('rejects protobuf group wire types instead of guessing', async () => {
    const body = new Writer().tag(1, 3).tag(1, 4).bytes(); // start + end group
    await expect(parseOsmPbf(assembleBlob('OSMData', body))).rejects.toThrow(/groups/);
  });

  it('says so plainly when DecompressionStream is unavailable', async () => {
    const pbf = await buildHandPbf();
    const saved = (globalThis as Record<string, unknown>).DecompressionStream;
    try {
      delete (globalThis as Record<string, unknown>).DecompressionStream;
      await expect(parseOsmPbf(pbf)).rejects.toThrow(/no DecompressionStream/);
    } finally {
      (globalThis as Record<string, unknown>).DecompressionStream = saved;
    }
    await expect(parseOsmPbf(pbf)).resolves.toBeTruthy(); // restored
  });
});

/* ----------------------------- helpers ------------------------------- */

function tagsOf(n: RawNode): Record<string, string> | undefined {
  return (n as RawNode & { tags?: Record<string, string> }).tags;
}
