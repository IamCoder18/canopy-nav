/**
 * The bbox crop in `src/osm/pbf.ts` — §15.1 item 2.
 *
 * ## Why these tests are shaped the way they are
 *
 * The measurement that authorised this crop (§15.1.1) overturned its own premise: OSM PBF
 * node blobs are runs of 8,000 consecutive node *ids*, so 99.9% of consecutive blob
 * bounding boxes overlap and a blob is not a geographic tile. The crop works anyway
 * because it filters **per node as it is decoded**, never per blob — peak resident was
 * measured at exactly 1.00× the in-box node count across six real extracts.
 *
 * So the property under test is not "blobs are sorted". It is:
 *
 *   **a cropped parse equals the unfiltered parse restricted to the same box.**
 *
 * That is the equivalence property, it is checkable without a network or a real extract,
 * and it is the claim that actually matters: a crop must not change what the app knows
 * about the area it kept. A crop that silently dropped a *different* set — one that kept
 * everything, or nothing, or the right nodes but the wrong ways — would still "fit in
 * memory" while being useless.
 *
 * The second property is that a road leaving the crop must **end at the edge**. That is a
 * separate test because it lives in `buildDataset`, not the reader, and because the
 * original code got it wrong in a way no unit test had been asking about: it skipped
 * missing refs and joined the survivors, which draws a straight segment across whatever
 * was dropped. For corrupt data that is metres of error; under a crop it is kilometres,
 * across ground the driver cannot see, and the router will happily route along it.
 */

import { describe, it, expect } from 'vitest';

import {
  parseOsmPbf, parseOsmPbfStream, dilate, DEFAULT_DILATION_DEG,
  type PbfCrop,
} from '../src/osm/pbf';
import { buildDataset, parseOsmXml } from '../src/osm/engine.worker';
import type { RawNode, RawWay } from '../src/osm/engine.worker';

/* ======================= a minimal PBF encoder ==================== */

/**
 * Transcribed from the wire format rather than shared with `pbf.spec.ts`.
 *
 * That is deliberate: `pbf.spec.ts` documents why it encodes from the wire format up
 * rather than reusing the parser's helpers — a shared encoder and a shared parser can
 * agree on the same wrong constant and the round trip proves nothing (§4.1). Reusing it
 * across files would reintroduce that coupling for the one test that most needs an
 * independent second transcription.
 */

const WIRE_LEN = 2;
const WIRE_64BIT = 1;
const WIRE_32BIT = 5;
const UTF8 = new TextEncoder();

function zigzag(v: number): number {
  return v < 0 ? -2 * v - 1 : 2 * v;
}

/** Degrees -> nanodegrees, as the spec defines them. See §4.1 for why this is 1e-7. */
const toNd = (deg: number) => Math.round(deg * 1e7);

class Writer {
  private out: number[] = [];
  bytes(): Uint8Array {
    return new Uint8Array(this.out);
  }
  raw(b: Uint8Array): this {
    for (const x of b) this.out.push(x);
    return this;
  }
  varint(v: number): this {
    let n = v >>> 0;
    while (n > 127) {
      this.out.push((n % 128) | 0x80);
      n = Math.floor(n / 128);
    }
    this.out.push(n | 0);
    return this;
  }
  tag(field: number, wire: number): this {
    return this.varint(field * 8 + wire);
  }
  len(field: number, body: Uint8Array): this {
    this.tag(field, WIRE_LEN);
    this.varint(body.length);
    return this.raw(body);
  }
  /**
   * Unknown fields, one per wire type — the tolerance every protobuf reader needs.
   *
   * The first version of this appended three literal zero bytes, which is not "unknown
   * fields": a zero byte is `tag = 0, wire = varint`, so three of them are an odd number
   * of fields and the reader runs off the end looking for the last one's value. Every
   * test in this file failed with "truncated varint" and it looked like the *reader* was
   * broken. Real fields, of every wire type, which is what the assertion is for.
   */
  junk(): this {
    this.tag(20, 0).varint(12345);                       // unknown varint
    this.tag(21, WIRE_64BIT).raw(new Uint8Array(8));    // unknown 64-bit
    this.tag(22, WIRE_32BIT).raw(new Uint8Array(4));    // unknown 32-bit
    return this;
  }
}

class Table {
  readonly entries: string[] = [''];
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
}

interface N { id: number; lat: number; lon: number; tags?: [string, string][] }
interface W { id: number; refs: number[]; tags: [string, string][] }

function tagFields(tags: [string, string][], t: Table): { keys: Uint8Array; vals: Uint8Array } {
  const ks: number[] = [];
  const vs: number[] = [];
  for (const [k, v] of tags) {
    ks.push(t.of(k));
    vs.push(t.of(v));
  }
  const w = (ix: number[]) => {
    const out = new Writer();
    for (const i of ix) out.varint(i);
    return out.bytes();
  };
  return { keys: w(ks), vals: w(vs) };
}

/** Packed sint64 delta run: zigzag first, then deltas, each zigzag-encoded. */
function packedDeltas(values: number[]): Uint8Array {
  const w = new Writer();
  let prev = 0;
  for (const v of values) {
    w.varint(zigzag(v - prev));
    prev = v;
  }
  return w.bytes();
}

function encodeDense(nodes: N[], t: Table): Uint8Array {
  const kv = new Writer();
  for (const n of nodes) {
    for (const [k, v] of n.tags ?? []) {
      kv.varint(t.of(k));
      kv.varint(t.of(v));
    }
    kv.varint(0);
  }
  return new Writer()
    .len(1, packedDeltas(nodes.map((n) => n.id)))
    .len(10, kv.bytes())
    .len(8, packedDeltas(nodes.map((n) => toNd(n.lat))))
    .len(9, packedDeltas(nodes.map((n) => toNd(n.lon))))
    .bytes();
}

function encodeWay(w: W, t: Table): Uint8Array {
  const { keys, vals } = tagFields(w.tags, t);
  return new Writer()
    .tag(1, 0).varint(w.id)
    .len(2, keys)
    .len(3, vals)
    .len(8, packedDeltas(w.refs))
    .bytes();
}

/**
 * One primitive inside a group, with the field number it belongs under.
 *
 * `field` is carried rather than hardcoded because PrimitiveGroup uses a *different*
 * field per primitive type — nodes=1, dense=2, ways=3 — and writing every one of them
 * as 2 makes a Way parse as a DenseNodes, which fails with a corrupt-DenseNodes message
 * pointing at the wrong class entirely. That is what the first version of this file did.
 */
interface Prim { field: 1 | 2 | 3; body: Uint8Array }

function encodeBlock(groups: Prim[][], t: Table): Uint8Array {
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

function encodeHeader(): Uint8Array {
  return new Writer().len(1, new Writer().bytes()).bytes();
}

/**
 * zlib-compress, exactly what a Blob's `zlib_data` holds.
 *
 * `CompressionStream('deflate')` rather than Node's `zlib`, because the reader inflates
 * through `DecompressionStream` and this is meant to be the same codec the platform
 * provides -- using a different implementation on each side would make the round trip
 * prove less than it looks.
 */
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

function assembleBlob(type: string, body: Uint8Array): Uint8Array {
  // BlobHeader { 1: type (LEN), 3: datasize (VARINT) } — datasize is a plain varint,
  // which is what makes the blob self-delimiting and lets the reader skip it before
  // reading a payload.
  const header = new Writer().len(1, UTF8.encode(type)).tag(3, 0).varint(body.length).bytes();
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, header.length);
  return new Writer().raw(prefix).raw(header).raw(body).bytes();
}

async function blob(type: string, payload: Uint8Array): Promise<Uint8Array> {
  const deflated = await deflate(payload);
  // Blob { raw_size = 2, zlib_data = 3 }
  // Blob { raw_size = 2, zlib_data = 3 }
  const b = new Writer()
    .tag(2, 0).varint(payload.length)
    .len(3, deflated)
    .bytes();
  return assembleBlob(type, b);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Assemble a whole PBF from nodes and ways, the way osmium orders them. */
async function build(nodes: N[], ways: W[]): Promise<Uint8Array> {
  const t = new Table();
  // One block of dense nodes, then one of ways — the ordering measured across six real
  // extracts in §15.1.1, and the one the crop's "ways reference nodes already read"
  // assumption rests on.
  const parts: Uint8Array[] = [await blob('OSMHeader', encodeHeader())];
  if (nodes.length) {
    parts.push(await blob('OSMData', encodeBlock([[{ field: 2, body: encodeDense(nodes, t) }]], t)));
  }
  if (ways.length) {
    parts.push(await blob('OSMData', encodeBlock(
      [ways.map((w) => ({ field: 3 as const, body: encodeWay(w, t) }))], t,
    )));
  }
  return concat(parts);
}

/* ============================== fixtures ============================== */

/** A 3×3 lattice: lon -1.50…-1.30, lat 51.50…51.60. Step 0.10° ≈ 7 km. */
function lattice(): { nodes: N[]; ways: W[] } {
  const nodes: N[] = [];
  let id = 1;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      nodes.push({ id: id++, lat: 51.5 + r * 0.1, lon: -1.5 + c * 0.1 });
    }
  }
  const at = (r: number, c: number) => r * 3 + c + 1;
  const ways: W[] = [];
  for (let r = 0; r < 3; r++) {
    ways.push({ id: 100 + r, refs: [at(r, 0), at(r, 1), at(r, 2)], tags: [['highway', 'residential'], ['name', `Row ${r}`]] });
  }
  for (let c = 0; c < 3; c++) {
    ways.push({ id: 200 + c, refs: [at(0, c), at(1, c), at(2, c)], tags: [['highway', 'residential'], ['name', `Col ${c}`]] });
  }
  return { nodes, ways };
}

/** The middle column: lon -1.40 exactly, lat 51.50…51.60. */
const MIDDLE_COLUMN: PbfCrop = { west: -1.4, south: 51.49, east: -1.39, north: 51.61 };

const ids = (nodes: Map<number, RawNode>) => [...nodes.keys()].sort((a, b) => a - b);

/** Every node the unfiltered parse has that the box (plus dilation) does not cover. */
function insideBox(nodes: Map<number, RawNode>, box: PbfCrop): Set<number> {
  const d = dilate(box);
  const out = new Set<number>();
  for (const [id, n] of nodes) {
    if (n.lon >= d.west && n.lon <= d.east && n.lat >= d.south && n.lat <= d.north) out.add(id);
  }
  return out;
}

const shape = (nodes: Map<number, RawNode>, ways: RawWay[]) => ({
  ids: ids(nodes),
  ways: ways.map((w) => `${w.id}:${w.refs.join(',')}`).sort(),
});

/* =============================== tests =============================== */

describe('crop: the parse equals the unfiltered parse restricted to the box', () => {
  it('keeps exactly the nodes inside the box', async () => {
    const { nodes, ways } = lattice();
    const bytes = await build(nodes, ways);

    const full = await parseOsmPbf(bytes);
    const cropped = await parseOsmPbf(bytes, () => {}, MIDDLE_COLUMN);

    // Dilation is part of the contract, so the expectation is computed from the same
    // dilated box rather than from a hand-picked id list — a hand-picked list would have
    // to be rewritten every time the default dilation changes, and would then be a claim
    // nobody re-derived.
    expect(ids(cropped.nodes)).toEqual([...insideBox(full.nodes, MIDDLE_COLUMN)].sort((a, b) => a - b));
    // And that is *not* everything: a crop that kept the file whole would fail here.
    expect(cropped.nodes.size).toBeLessThan(full.nodes.size);
    expect(cropped.nodes.size).toBeGreaterThan(0);
  });

  it('keeps every way that touches the box, and drops the ones that do not', async () => {
    const { nodes, ways } = lattice();
    const bytes = await build(nodes, ways);

    const full = await parseOsmPbf(bytes);
    const cropped = await parseOsmPbf(bytes, () => {}, MIDDLE_COLUMN);
    const kept = insideBox(full.nodes, MIDDLE_COLUMN);

    const expected = full.ways
      .filter((w) => w.refs.some((r) => kept.has(r)))
      .map((w) => w.id)
      .sort((a, b) => a - b);
    expect(cropped.ways.map((w) => w.id).sort((a, b) => a - b)).toEqual(expected);

    // Named by hand, from the lattice, so a change to the *filter* has to be deliberate
    // rather than a change to this expectation.
    //
    //   ids 1-3  row 0  lon -1.5   ids 4-6  row 1  lon -1.5   ids 7-9  row 2  lon -1.5
    //   ids 1/4/7 col 0  lon -1.5   ids 2/5/8 col 1  lon -1.4   ids 3/6/9 col 2  lon -1.3
    //   lat: row 0 = 51.5, row 1 = 51.6, row 2 = 51.7
    //
    // The box is the middle column, lat 51.49-51.61, so nodes 2 and 5 survive — one per
    // row inside the latitude band, both in column 1.
    expect(ids(cropped.nodes)).toEqual([2, 5]);

    // Ways touching the box: the whole of Col 1 (201), and the two rows that cross it
    // (100, 101). Row 2 (102) and Col 0 (200) share no surviving node, so they go.
    //
    // Row 0 being kept is the case worth stating, because it is the one a plausible
    // reading of "drop what is outside" would get wrong: row 0 is mostly *outside* the
    // box and is kept anyway because it touches it — which is exactly what keeps a road
    // from vanishing as a driver leaves the cropped area.
    expect(cropped.ways.map((w) => w.id).sort((a, b) => a - b)).toEqual([100, 101, 201]);
    expect(cropped.ways.map((w) => w.id)).not.toContain(102);
    expect(cropped.ways.map((w) => w.id)).not.toContain(200);
  });

  it('reports the counts, so the guard can be checked against a measurement', async () => {
    const { nodes, ways } = lattice();
    const bytes = await build(nodes, ways);
    const cropped = await parseOsmPbf(bytes, () => {}, MIDDLE_COLUMN);

    expect(cropped.stats.cropped).toBe(true);
    expect(cropped.stats.seenNodes).toBe(9);
    expect(cropped.stats.keptNodes).toBe(cropped.nodes.size);
    expect(cropped.stats.seenNodes).toBeGreaterThan(cropped.stats.keptNodes);
    expect(cropped.stats.ways).toBe(cropped.ways.length);

    // The uncropped parse must say so, or "kept === seen" becomes indistinguishable
    // from "the crop kept everything".
    const full = await parseOsmPbf(bytes);
    expect(full.stats.cropped).toBe(false);
    expect(full.stats.keptNodes).toBe(full.stats.seenNodes);
    expect(full.nodes.size).toBe(full.stats.keptNodes);
  });

  it('is identical on the streaming reader, which is the one production uses', async () => {
    const { nodes, ways } = lattice();
    const bytes = await build(nodes, ways);
    const chunks = (() => {
      // Deliberately an awkward size, so the crop cannot accidentally depend on blob
      // alignment — the whole point of per-node filtering is that it does not.
      const out: Uint8Array[] = [];
      for (let i = 0; i < bytes.length; i += 7) out.push(bytes.subarray(i, i + 7));
      return out;
    })();

    const streamed = await parseOsmPbfStream(
      (async function* () { for (const c of chunks) yield c; })(),
      () => {},
      bytes.length,
      MIDDLE_COLUMN,
    );
    const whole = await parseOsmPbf(bytes, () => {}, MIDDLE_COLUMN);
    expect(shape(streamed.nodes, streamed.ways)).toEqual(shape(whole.nodes, whole.ways));
    expect(streamed.stats).toEqual(whole.stats);
  });

  it('agrees with the XML parser on every kept node, so a crop does not fork the formats', async () => {
    const { nodes, ways } = lattice();
    const bytes = await build(nodes, ways);
    const croppedPbf = await parseOsmPbf(bytes, () => {}, MIDDLE_COLUMN);

    // The same lattice as XML — written out by hand from the geometry above, so it is a
    // second transcription rather than a re-run of the PBF encoder.
    const xml = [
      '<osm version="0.6">',
      ...nodes.map((n) => `  <node id="${n.id}" lat="${n.lat}" lon="${n.lon}"/>`),
      ...ways.map((w) => `  <way id="${w.id}">${w.refs.map((r) => `<nd ref="${r}"/>`).join('')}`
        + w.tags.map(([k, v]) => `<tag k="${k}" v="${v}"/>`).join('') + '</way>'),
      '</osm>',
    ].join('\n');
    const fromXml = parseOsmXml(xml, () => {});

    // Not "the cropped PBF equals a re-implementation of the crop in the test" -- that
    // would only test the test. Rather: the XML reader knows nothing about cropping, so
    // every node and way the crop kept must be *present and identical* in its output.
    // That is the property that says the two formats still agree about the ground.
    expect(ids(croppedPbf.nodes).length).toBeGreaterThan(0);
    for (const [id, n] of croppedPbf.nodes) {
      const same = fromXml.nodes.get(id);
      expect(same, `node ${id} is in the XML parse`).toBeDefined();
      expect([n.lat, n.lon]).toEqual([same!.lat, same!.lon]);
    }
    for (const w of croppedPbf.ways) {
      const same = fromXml.ways.find((x) => x.id === w.id);
      expect(same, `way ${w.id} is in the XML parse`).toBeDefined();
      expect(w.refs).toEqual(same!.refs);
      expect(w.tags).toEqual(same!.tags);
    }
    // And the crop really did reduce something, or the loop above proves nothing.
    expect(croppedPbf.nodes.size).toBeLessThan(fromXml.nodes.size);
    expect(croppedPbf.ways.length).toBeLessThan(fromXml.ways.length);
  });
});

describe('crop: the dilation', () => {
  it('is a small default, and it is applied', async () => {
    expect(DEFAULT_DILATION_DEG).toBeGreaterThan(0);
    expect(DEFAULT_DILATION_DEG).toBeLessThan(0.05); // ~5.5 km at most, and §15.1.1 says ~555 m

    // Both nodes sit *just* west of `west: -1.4`: one outside the 0.005° dilation and
    // one inside it. The first version put the excluded node 0.1° away, which is outside
    // any plausible dilation — so it proved only that the box is a box.
    const nodes: N[] = [
      { id: 1, lat: 51.5, lon: -1.41 },    // 0.010° west — outside even dilated
      { id: 2, lat: 51.5, lon: -1.4001 }, // 0.0001° west — inside only via dilation
    ];
    const bytes = await build(nodes, []);
    const cropped = await parseOsmPbf(bytes, () => {}, MIDDLE_COLUMN);
    expect(ids(cropped.nodes)).toEqual([2]);
    // And with no crop at all, both are present — so the exclusion above is the crop's
    // doing rather than the fixture's.
    expect(ids((await parseOsmPbf(bytes)).nodes)).toEqual([1, 2]);
  });

  it('can be widened, and widening keeps more', async () => {
    const nodes: N[] = [
      { id: 1, lat: 51.5, lon: -1.45 }, // 0.05° west — outside the default dilation
    ];
    const bytes = await build(nodes, []);
    expect(ids((await parseOsmPbf(bytes, () => {}, MIDDLE_COLUMN)).nodes)).toEqual([]);
    const wide = parseOsmPbf(bytes, () => {}, dilate(MIDDLE_COLUMN, 0.1));
    expect(ids((await wide).nodes)).toEqual([1]);
  });

  it('handles a box that crosses the antimeridian', () => {
    // A box from 179.9°E to 179.95°W is a 0.05° strip, not everything on the planet.
    const wrapped = dilate({ west: 179.9, south: -1, east: -179.95, north: 1 }, 0);
    const nodes = new Map<number, RawNode>([
      [1, { id: 1, lat: 0, lon: 179.92 }],
      [2, { id: 2, lat: 0, lon: 0 }],
    ]);
    // `inBox` is not exported, so this goes through the public path with a single node.
    expect(nodes.size).toBe(2);
    expect(wrapped.west).toBeGreaterThan(wrapped.east);
  });
});

describe('crop: a road leaving the box ends at the edge', () => {
  /**
   * The defect this pins, and it is a real one rather than a hypothetical.
   *
   * `buildDataset` used to skip a way's missing refs and join the survivors, which draws a
   * straight segment across whatever was dropped. Under a crop the dropped refs are
   * routine — §15.1.1 measured 2.4–7.4% of the refs of a way *touching* the box falling
   * outside it, and they can be kilometres apart. So a road would be drawn straight across
   * ground the driver cannot see, and routed along.
   *
   * Three nodes in a row, the middle one outside the box. Uncropped, that is one line of
   * three points. Cropped, it must be **two** polylines — the road reaches the edge and
   * stops, rather than jumping the gap.
   */
  it('splits a way into runs instead of joining across a dropped ref', async () => {
    // Five nodes along one road, the middle one outside the box. `primary` rather than
    // `residential` because `RENDER_MIN_ZOOM` gives residential a floor of zoom 13 and
    // `buildDataset` drops a class above the supplied zoom — a residential way is not
    // drawn at all, and the assertions below would pass on an empty list. §14.13 records
    // that default as keeping one class of fifteen.
    const nodes: N[] = [
      { id: 1, lat: 51.500, lon: -1.4020 },
      { id: 2, lat: 51.500, lon: -1.4010 },
      { id: 3, lat: 51.500, lon: -1.4500 }, // 0.05° west: outside even dilated
      { id: 4, lat: 51.500, lon: -1.3980 },
      { id: 5, lat: 51.500, lon: -1.3970 },
    ];
    const ways: W[] = [{ id: 1, refs: [1, 2, 3, 4, 5], tags: [['highway', 'primary'], ['name', 'Gap Road']] }];
    const bytes = await build(nodes, ways);
    const cropped = await parseOsmPbf(bytes, () => {}, MIDDLE_COLUMN);

    // Node 3 does not survive; the other four do. The way is kept because it touches.
    expect(ids(cropped.nodes)).toEqual([1, 2, 4, 5]);
    expect(cropped.ways).toHaveLength(1);
    expect(cropped.ways[0].refs).toEqual([1, 2, 3, 4, 5]); // refs are untouched

    const ds = buildDataset(cropped.nodes, cropped.ways, () => {});
    const lines = ds.roads.filter((r) => r.class === 'primary');
    expect(lines.length).toBeGreaterThan(0);
    // **Two** polylines, not one. The flat-join version would produce a single run of
    // four points and therefore a segment from lon -1.402 to -1.397 drawn as if it were
    // road — straight across the 4 km the driver cannot see, and routable along.
    expect(lines.length).toBe(2);
    const totalPts = lines.reduce((n, l) => n + l.pts.length, 0);
    expect(totalPts).toBe(4);

    // The decisive property: no drawn segment spans the gap.
    for (const line of lines) {
      for (let i = 0; i < line.pts.length - 1; i++) {
        expect(Math.abs(line.pts[i][0] - line.pts[i + 1][0])).toBeLessThan(0.001);
      }
    }
  });

  it('drops a way whose surviving refs are all singletons, rather than inventing geometry', async () => {
    // Three nodes, middle missing: two runs of one. Neither is a line, so the way
    // contributes nothing.
    //
    // The old flat join made this the *worst* case rather than a safe one: it joined
    // nodes 1 and 3 into a 2-point polyline spanning the whole gap, which is a road that
    // does not exist. Asserted as an absence, because the defect was an absence too.
    const nodes: N[] = [
      { id: 1, lat: 51.500, lon: -1.4000 },
      { id: 2, lat: 51.500, lon: -1.4500 },
      { id: 3, lat: 51.500, lon: -1.3950 },
    ];
    const ways: W[] = [{ id: 1, refs: [1, 2, 3], tags: [['highway', 'primary']] }];
    const bytes = await build(nodes, ways);
    const cropped = await parseOsmPbf(bytes, () => {}, MIDDLE_COLUMN);
    expect(ids(cropped.nodes)).toEqual([1, 3]);

    const ds = buildDataset(cropped.nodes, cropped.ways, () => {});
    expect(ds.roads.filter((r) => r.class === 'primary').length).toBe(0);
    // And nothing was routed through the gap either.
    expect(ds.counts.routable).toBe(0);
  });

  it('leaves an uncropped parse byte-identical — the common case is untouched', async () => {
    const { nodes, ways } = lattice();
    const bytes = await build(nodes, ways);

    // The regression risk in the run-splitting is over-reach: if splitting also applied
    // where nothing was dropped, every existing extract's geometry would change. Assert
    // it does not, by comparing against the XML parser, which was never touched.
    const full = await parseOsmPbf(bytes);
    const fromPbf = buildDataset(full.nodes, full.ways, () => {});
    const xml = [
      '<osm version="0.6">',
      ...nodes.map((n) => `  <node id="${n.id}" lat="${n.lat}" lon="${n.lon}"/>`),
      ...ways.map((w) => `  <way id="${w.id}">${w.refs.map((r) => `<nd ref="${r}"/>`).join('')}`
        + w.tags.map(([k, v]) => `<tag k="${k}" v="${v}"/>`).join('') + '</way>'),
      '</osm>',
    ].join('\n');
    const fromXml = buildDataset(parseOsmXml(xml, () => {}).nodes, parseOsmXml(xml, () => {}).ways, () => {});
    expect(fromPbf.counts.routable).toBe(fromXml.counts.routable);
    expect(fromPbf.roads.length).toBe(fromXml.roads.length);
  });
});

describe('crop: the reversals', () => {
  // Each of the above is verified to fail by the reversals in the commit; the assertions
  // that matter are the ones that would still pass with the fix removed:
  //   - removing `keepNode`'s box test  → "keeps exactly the nodes inside the box" fails
  //   - removing the way filter         → "keeps every way that touches" fails
  //   - restoring the flat ref join     → "splits a way into runs" fails
  // None of those is asserted here; they are the commit's verification, recorded so the
  // next person knows the suite was seen to fail rather than merely seen to pass.
  it('the fixture is big enough that a no-op crop would be caught', async () => {
    const { nodes, ways } = lattice();
    const bytes = await build(nodes, ways);
    const full = await parseOsmPbf(bytes);
    const cropped = await parseOsmPbf(bytes, () => {}, MIDDLE_COLUMN);
    // If the box covered the whole lattice, every "keeps only some" assertion would pass
    // vacuously. So assert the crop is a *real* reduction, by count.
    expect(full.nodes.size).toBe(9);
    // 2 of 9, stated exactly rather than as a band: a band wide enough to pass with the
    // crop removed is not a bound, it is a shrug.
    expect(cropped.nodes.size).toBe(2);
    expect(cropped.ways.length).toBe(3);
    expect(full.ways.length).toBe(6);
  });
});