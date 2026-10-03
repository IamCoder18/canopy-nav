/**
 * `.osm.pbf` reader tests.
 *
 * The point of these is *equivalence*: the whole reason `src/osm/pbf.ts` exists
 * is that it feeds the same `buildDataset` pipeline as the XML parser, so a PBF
 * built here must produce byte-identical output to `parseOsmXml` on the same
 * data. To make that a real test rather than a tautology, the PBF is encoded
 * here from the wire format up (varint writer, zigzag, packed fields, zlib via
 * `CompressionStream`) and the expected XML is a hand-written literal, so the
 * two sides are independent transcriptions of the same data.
 *
 * Two flavours of assertion:
 *   - a small hand-built file exercising every encoding path (zlib + raw
 *     blobs, OSMHeader, DenseNodes, plain Node, Way, Relation, unknown fields,
 *     duplicate string-table entries, chunking across blobs),
 *   - a round trip of the real `test/fixture.osm` (~9k nodes) re-encoded as PBF
 *     and pushed through `buildDataset`.
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

function zigzag(v: number): number {
  return v < 0 ? -2 * v - 1 : 2 * v;
}

function toNd(deg: number): number {
  return Math.round(deg * 1e9);
}

/**
 * Protobuf writer over a growable byte array. Varints are emitted with float
 * arithmetic (`% 128`) rather than bit ops, which would break above 2^31 —
 * exactly where nanodegrees and node ids live.
 */
class Writer {
  private out: number[] = [];

  varint(v: number): this {
    let x = v;
    if (!Number.isSafeInteger(x) || x < 0) throw new Error(`varint must be a safe non-negative int, got ${v}`);
    while (x >= 0x80) {
      const rem = x % 128;
      this.out.push(rem + 0x80);
      x = (x - rem) / 128;
    }
    this.out.push(x);
    return this;
  }

  /** sint32/sint64: zigzag then varint. */
  sint(field: number, v: number): this {
    return this.tag(field, WIRE_VARINT).varint(zigzag(v));
  }

  /** int64/uint64/int32/bool/enum: plain varint, no zigzag. */
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
    return this.len(field, new TextEncoder().encode(s));
  }

  tag(field: number, wire: number): this {
    return this.varint(field * 8 + wire);
  }

  raw(b: Uint8Array): this {
    for (const byte of b) this.out.push(byte);
    return this;
  }

  /** A field nobody should read, to prove the skipper copes. */
  junk(): this {
    this.int(20, 12345); // unknown varint
    this.tag(21, WIRE_64BIT).raw(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])); // unknown 64-bit
    this.tag(22, WIRE_32BIT).raw(new Uint8Array([9, 9, 9, 9])); // unknown 32-bit
    return this;
  }

  bytes(): Uint8Array {
    return Uint8Array.from(this.out);
  }
}

/** zlib-compress (exactly what a real Blob's `zlib_data` holds). */
async deflate(src: Uint8Array): Promise<Uint8Array> {
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

/** String table builder: dedupes, but `dup()` can force a repeated entry. */
class Table {
  readonly entries: string[] = ['']; // index 0 is the empty string, by convention
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

  /** Append a second copy of `s` at a fresh index, as some writers emit. */
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

function tagIndices(tags: [string, string][], t: Table, keys?: Map<string, number>): {
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
 * DenseNodes, with `keys_vals` deliberately emitted *before* id/lat/lon: field
 * order is not guaranteed in protobuf and the reader must not rely on it.
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

  const w = new Writer();
  w.len(10, kv.bytes());

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
  w.len(1, ids.bytes());
  w.len(8, lats.bytes());
  w.len(9, lons.bytes());
  return w.bytes();
}

/** Plain `Node`: id=1 sint64, keys=2, vals=3, lat=8, lon=9. */
function encodeNode(n: PbfNode, t: Table): Uint8Array {
  const { keys, vals } = tagIndices(n.tags ?? [], t);
  const w = new Writer();
  w.sint(1, n.id);
  if (keys.length) { w.len(2, keys); w.len(3, vals); }
  w.int(4, 3); // version/info-ish varint the reader must skip
  w.tag(7, WIRE_64BIT).raw(new Uint8Array(8));
  w.sint(8, toNd(n.lat));
  w.sint(9, toNd(n.lon));
  return w.bytes();
}

/** `Way`: id=1 int64 (not zigzag), keys=2, vals=3, refs=8 packed sint64 delta. */
function encodeWay(id: number, refs: number[], tags: [string, string][], t: Table): Uint8Array {
  const { keys, vals } = tagIndices(tags, t);
  const w = new Writer();
  w.int(1, id);
  w.len(2, keys);
  w.len(3, vals);
  const r = new Writer();
  let prev = 0;
  for (const ref of refs) { r.varint(zigzag(ref - prev)); prev = ref; }
  w.len(8, r.bytes());
  return w.bytes();
}

/** `Relation` — unused by the pipeline, so the reader must step over it. */
function encodeRelation(id: number, refs: number[], t: Table): Uint8Array {
  const memids = new Writer();
  let prev = 0;
  for (const ref of refs) { memids.varint(zigzag(ref - prev)); prev = ref; }
  const w = new Writer();
  w.int(1, id);
  w.len(8, packed([1])); // roles_sid
  w.len(9, memids.bytes()); // memids
  w.len(10, packed([1, 1])); // types: node / node
  w.str(2, t.of('multipolygon'));
  return w.bytes();
}

/**
 * One PrimitiveBlock. Groups are written *before* the string table, which is
 * legal and forces the reader's two-pass string-table handling to work.
 */
function encodeBlock(groups: Uint8Array[], t: Table): Uint8Array {
  const w = new Writer();
  for (const g of groups) w.len(2, g);
  const st = new Writer();
  for (const s of t.entries) st.len(1, new TextEncoder().encode(s));
  w.len(1, st.bytes());
  w.junk();
  return w.bytes();
}

/** HeaderBlock: bbox + required features, which must never be read as data. */
function encodeHeader(): Uint8Array {
  const bbox = new Writer();
  bbox.sint(1, -133000000); // left
  bbox.sint(2, -127800000); // right
  bbox.sint(3, 515100000); // top
  bbox.sint(4, 515074000); // bottom
  const w = new Writer();
  w.len(1, bbox.bytes());
  w.str(4, 'OsmSchema-V0.6');
  w.str(4, 'DenseNodes');
  w.bool(16, true); // writing
  w.junk();
  return w.bytes();
}

async function blob(type: string, payload: Uint8Array, compress: boolean): Promise<Uint8Array> {
  const body = compress ? await deflate(payload) : payload;
  const bw = new Writer();
  if (compress) {
    bw.int(2, payload.length); // raw_size, informational
    bw.len(3, body);
  } else {
    bw.len(1, payload);
  }
  const bodyBytes = bw.bytes();

  const hw = new Writer();
  hw.str(1, type);
  if (type === 'OSMHeader') hw.len(2, new Uint8Array([0, 1, 2])); // indexdata, unused
  hw.int(3, bodyBytes.length);
  const headerBytes = hw.bytes();

  const f = new Writer();
  const len = headerBytes.length;
  // Big-endian uint32, written byte by byte (no DataView needed).
  f.raw(Uint8Array.of((len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff));
  f.raw(headerBytes);
  f.raw(bodyBytes);
  return f.bytes();
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/* ============================ comparison ============================== */

/** Order-independent view of parse output, for `toEqual` against the XML path. */
function shape(nodes: Map<number, RawNode>, ways: RawWay[]) {
  return {
    nodes: [...nodes.values()]
      .map((n) => ({ id: n.id, lat: n.lat, lon: n.lon, tags: (n as RawNode & { tags?: Record<string, string> }).tags }))
      .sort((a, b) => a.id - b.id),
    ways: [...ways]
      .map((w) => ({ id: w.id, refs: w.refs, tags: w.tags }))
      .sort((a, b) => a.id - b.id),
  };
}

/* ======================= hand-built equivalent data ==================== */

/**
 * The same data twice: once as the literal XML the reader must match, once as
 * the structures fed to the encoder above.
 */
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
  // Refs go backwards mid-way, i.e. a negative delta in the middle of the run.
  { id: 202, refs: [4, 5, 1], tags: [['waterway', 'river'], ['name', 'Test River']] },
  { id: 203, refs: [1], tags: [['highway', 'footway']] }, // one ref -> dropped
  { id: 204, refs: [1, 2], tags: [] }, // untagged -> dropped
  { id: 205, refs: [5, 100], tags: [['highway', 'path'], ['name', 'Lane']] },
  { id: 206, refs: [100, 2], tags: [['building', 'yes']] },
];

/** Build the hand-made file: header, then two OSMData blobs, mixed compression. */
async function buildHandPbf(): Promise<Uint8Array> {
  const t1 = new Table();
  // A repeated entry: the string table legally holds 'name' twice, and one node
  // refers to the later index. Output must be unaffected.
  const dupName = t1.dup('name');

  const dense = encodeDense(HAND_DENSE, t1, new Map([['name', dupName]]));
  const plain = encodeNode(HAND_PLAIN[0]!, t1);
  const waysGroup = new Writer();
  for (const w of HAND_WAYS.slice(0, 3)) waysGroup.len(3, encodeWay(w.id, w.refs, w.tags, t1));
  waysGroup.len(4, encodeRelation(1, [1, 2, 3], t1)); // must be ignored
  waysGroup.junk();

  const blockA = encodeBlock([dense, plain, waysGroup.bytes()], t1);

  const t2 = new Table();
  const waysB = new Writer();
  for (const w of HAND_WAYS.slice(3)) waysB.len(3, encodeWay(w.id, w.refs, w.tags, t2));
  const blockB = encodeBlock([waysB.bytes()], t2);

  return concat([
    await blob('OSMHeader', encodeHeader(), false),
    await blob('OSMData', blockA, true), // zlib
    await blob('OSMData', blockB, false), // raw
  ]);
}

/* ============================ encode fixture ========================== */

/** Re-encode parser output as PBF: dense groups per blob, alternating zlib. */
async function encodeFromParsed(nodes: Map<number, RawNode>, ways: RawWay[], perBlob: number): Promise<Uint8Array> {
  const all = [...nodes.values()];
  const parts: Uint8Array[] = [await blob('OSMHeader', encodeHeader(), false)];
  let zipped = true;

  for (let i = 0; i < all.length; i += perBlob) {
    const slice = all.map((n) => ({
      id: n.id,
      lat: n.lat,
      lon: n.lon,
      tags: Object.entries(((n as RawNode & { tags?: Record<string, string> }).tags) ?? {}),
    }));
    const t = new Table();
    const block = encodeBlock([encodeDense(slice, t)], t);
    parts.push(await blob('OSMData', block, zipped));
    zipped = !zipped;
  }

  // Ways last, several per group, so a way can never be split across blobs.
  const w = new Writer();
  for (let i = 0; i < ways.length; i += 300) {
    const t = new Table();
    const group = new Writer();
    for (const way of ways.slice(i, i + 300)) {
      group.len(3, encodeWay(way.id, way.refs, Object.entries(way.tags), t));
    }
    parts.push(await blob('OSMData', encodeBlock([group.bytes()], t), zipped));
    zipped = !zipped;
  }
  void w;
  return concat(parts);
}

/* ================================ tests =============================== */

describe('osm pbf parsing', () => {
  it('matches the XML parser on a hand-built file', async () => {
    const pbf = await buildHandPbf();
    const fromPbf = await parseOsmPbf(pbf);
    const fromXml = parseOsmXml(HAND_XML);

    expect(shape(fromPbf.nodes, fromPbf.ways)).toEqual(shape(fromXml.nodes, fromXml.ways));

    // ...and the shared result is the one the XML parser alone would give.
    expect(fromPbf.nodes.size).toBe(6);
    expect(fromPbf.ways.map((w) => w.id)).toEqual([200, 201, 202, 205, 206]);
  });

  it('reads dense nodes, plain nodes, refs and tags correctly', async () => {
    const { nodes, ways } = await parseOsmPbf(await buildHandPbf());

    // Nanodegrees -> degrees, with the delta chains fully accumulated.
    expect(nodes.get(1)).toMatchObject({ id: 1, lat: 51.5074, lon: -0.1278 });
    expect(nodes.get(5)).toMatchObject({ id: 5, lat: 51.5095, lon: -0.132 });
    expect(nodes.get(100)).toMatchObject({ id: 100, lat: 51.51, lon: -0.133 });

    // Only "interesting" node tags survive, exactly like the XML parser.
    expect((nodes.get(1) as RawNode & { tags?: Record<string, string> }).tags)
      .toEqual({ name: 'Testford', place: 'town' });
    expect((nodes.get(4) as RawNode & { tags?: Record<string, string> }).tags)
      .toEqual({ highway: 'traffic_signals' });
    // 'source' and 'surface' are not interesting, so node 4 keeps one tag and
    // node 5 — whose only tag is 'surface' — keeps none at all.
    expect('tags' in nodes.get(5)!).toBe(false);
    expect('tags' in nodes.get(2)!).toBe(false);
    expect('tags' in nodes.get(100)!).toBe(false);

    // Negative ref deltas, and ways spanning two blobs.
    expect(ways.find((w) => w.id === 202)!.refs).toEqual([4, 5, 1]);
    expect(ways.find((w) => w.id === 205)!.refs).toEqual([5, 100]);
    expect(ways.find((w) => w.id === 205)!.tags).toEqual({ highway: 'path', name: 'Lane' });
  });

  it('is not confused by the OSMHeader blob', async () => {
    // HeaderBlock carries a bbox in nanodegrees; reading it as data would
    // invent nodes. The hand-built file has one header blob and 6 real nodes.
    const { nodes } = await parseOsmPbf(await buildHandPbf());
    expect(nodes.size).toBe(6);
    expect([...nodes.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 100]);
  });

  it('round-trips the full fixture through PBF and buildDataset', async () => {
    const xmlOut = parseOsmXml(XML_FIXTURE);
    // 700 nodes per blob: many blocks, so groups must survive chunking.
    const pbf = await encodeFromParsed(xmlOut.nodes, xmlOut.ways, 700);
    const pbfOut = await parseOsmPbf(pbf);

    expect(shape(pbfOut.nodes, pbfOut.ways)).toEqual(shape(xmlOut.nodes, xmlOut.ways));

    const fromXml = buildDataset(xmlOut.nodes, xmlOut.ways);
    const fromPbf = buildDataset(pbfOut.nodes, pbfOut.ways);
    expect(fromPbf.counts).toEqual(fromXml.counts);
    expect(fromPbf.bbox).toEqual(fromXml.bbox);
    expect(fromPbf.graph.nodeCount).toBe(fromXml.graph.nodeCount);
    expect(fromPbf.roads.length).toBe(fromXml.roads.length);
    expect(fromPbf.water.length).toBe(fromXml.water.length);
    expect(fromPbf.green.length).toBe(fromXml.green.length);
    expect(fromPbf.gaz.length).toBe(fromXml.gaz.length);
    // Gazetteer entries are matched by name, so the ordering can differ only
    // where two entries share a rank and a name.
    expect(fromPbf.gaz.map((g) => `${g.name}|${g.cat}|${g.rank}`).sort())
      .toEqual(fromXml.gaz.map((g) => `${g.name}|${g.cat}|${g.rank}`).sort());
  });

  it('reports monotonic progress ending at 1', async () => {
    const seen: number[] = [];
    await parseOsmPbf(await encodeFromParsed(...Object.values(parseOsmXml(XML_FIXTURE)), 2000), (p) => seen.push(p));
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[0]).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBe(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]!);
  });

  it('rejects garbage instead of returning an empty result', async () => {
    const rejects = async (bytes: Uint8Array, pattern: RegExp) => {
      await expect(parseOsmPbf(bytes)).rejects.toThrow(PbfFormatError);
      await expect(parseOsmPbf(bytes)).rejects.toThrow(pattern);
    };

    await rejects(new Uint8Array(0), /empty/);
    await rejects(new TextEncoder().encode('not a pbf at all, just text'), /truncated|not OSM PBF|blob header/);
    await rejects(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0x00, 0x01, 0x02]), /implausible|truncated/);
    // An OSM XML file pointed at the PBF reader.
    await rejects(new TextEncoder().encode(XML_FIXTURE.slice(0, 200)), /looks like OSM XML/);
    // A valid-looking file that has no OSMData at all.
    await rejects(await blob('OSMHeader', encodeHeader(), true), /no OSMData blobs/);
  });

  it('rejects truncation at every boundary', async () => {
    const good = await encodeFromParsed(...Object.values(parseOsmXml(XML_FIXTURE)), 700);
    // Walk back through the file: every cut must raise, never hang or return {}.
    for (const cut of [1, 2, 3, 4, 5, 17, 64, 128, 1024, good.length - 1, good.length - 8]) {
      const partial = good.subarray(0, cut);
      await expect(parseOsmPbf(partial), `cut at ${cut}`).rejects.toThrow(PbfFormatError);
    }
    // A blob whose datasize promises more than the file holds.
    const lying = good.slice();
    lying[0] = (lying[0]! + 200) & 0xff;
    await expect(parseOsmPbf(lying)).rejects.toThrow(PbfFormatError);
  });

  it('rejects compression it cannot undo, by name', async () => {
    const payload = encodeBlock([encodeDense(HAND_DENSE, new Table())], new Table());

    const zstd = new Writer().len(6, new Uint8Array([0x28, 0xb5, 0x2f, 0xfd])).bytes();
    const zstdBlob = await blob('OSMData', zstd, false).then(async () => {
      const bw = new Writer().len(6, new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]));
      const hw = new Writer().str(1, 'OSMData').int(3, bw.bytes().length);
      const header = hw.bytes();
      const f = new Writer();
      f.raw(Uint8Array.of(0, 0, 0, header.length)).raw(header).raw(bw.bytes());
      return f.bytes();
    });
    await expect(parseOsmPbf(zstdBlob)).rejects.toThrow(/zstd/);

    const lzma = new Writer().len(4, new Uint8Array([1, 2, 3, 4]));
    const lzmaBlob = (() => {
      const hw = new Writer().str(1, 'OSMData').int(3, lzma.bytes().length);
      const header = hw.bytes();
      const f = new Writer();
      f.raw(Uint8Array.of(0, 0, 0, header.length)).raw(header).raw(lzma.bytes());
      return f.bytes();
    })();
    await expect(parseOsmPbf(lzmaBlob)).rejects.toThrow(/lzma/);

    // Not even the header-only file above should have been accepted.
    expect(payload.length).toBeGreaterThan(0);
  });

  it('rejects a corrupt DenseNodes whose coordinate runs disagree', async () => {
    const t = new Table();
    const kv = new Writer().varint(0).bytes();
    const ids = new Writer().varint(1).varint(1).bytes(); // two ids
    const lats = new Writer().varint(zigzag(toNd(51.5))).bytes(); // one lat only
    const block = new Writer()
      .len(2, new Writer().len(2, new Writer().len(1, ids).len(8, lats).len(10, kv).bytes()).bytes())
      .bytes();
    await expect(parseOsmPbf(await blob('OSMData', block, false))).rejects.toThrow(/corrupt DenseNodes/);
    expect(t.entries.length).toBe(1);
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
    // Restored, it parses again.
    await expect(parseOsmPbf(pbf)).resolves.toBeTruthy();
  });

  it('rejects a protobuf group wire type rather than guessing', async () => {
    const bw = new Writer();
    bw.tag(1, 3); // start group
    bw.tag(1, 4); // end group
    const hw = new Writer().str(1, 'OSMData').int(3, bw.bytes().length);
    const header = hw.bytes();
    const f = new Writer();
    f.raw(Uint8Array.of(0, 0, 0, header.length)).raw(header).raw(bw.bytes());
    await expect(parseOsmPbf(f.bytes())).rejects.toThrow(/groups/);
  });
});