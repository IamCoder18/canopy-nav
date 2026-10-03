#!/usr/bin/env node
/**
 * osm2pbf — convert an `.osm` XML extract to `.osm.pbf`.
 *
 * The app reads `.osm.pbf` natively now, so this is only needed to slice a
 * large regional download down to something a phone can hold:
 *
 *   osmium extract -b -114,51,-113,52 -o city.osm.pbf alberta-latest.osm.pbf
 *
 * but it is also useful for producing a PBF from hand-written XML, and it is
 * what the PBF test suite uses to build its fixtures.
 *
 * Usage:
 *   node tools/osm2pbf.mjs input.osm output.osm.pbf [nodesPerBlock]
 */

import { readFileSync, writeFileSync } from 'node:fs';

/* ======================= minimal PBF encoder ======================= */

const WIRE_LEN = 2;
const UTF8 = new TextEncoder();

function zigzag(v) {
  return v < 0 ? -2 * v - 1 : 2 * v;
}

const toNd = (deg) => Math.round(deg * 1e9);

class Writer {
  out = [];

  varint(v) {
    if (!Number.isSafeInteger(v) || v < 0) {
      throw new Error(`varint needs a safe non-negative integer, got ${v}`);
    }
    let x = v;
    while (x >= 0x80) {
      const rem = x % 128; // % not >>, which would wrap above 2^31
      this.out.push(rem + 0x80);
      x = (x - rem) / 128;
    }
    this.out.push(x);
    return this;
  }

  sint(field, v) { return this.tag(field, 0).varint(zigzag(v)); }
  int(field, v) { return this.tag(field, 0).varint(v); }
  bool(field, v) { return this.int(field, v ? 1 : 0); }

  tag(field, wire) { return this.varint(field * 8 + wire); }

  len(field, body) {
    this.tag(field, WIRE_LEN).varint(body.length);
    return this.raw(body);
  }

  str(field, s) { return this.len(field, UTF8.encode(s)); }

  raw(b) {
    for (const byte of b) this.out.push(byte);
    return this;
  }

  bytes() { return Uint8Array.from(this.out); }
}

async function deflate(src) {
  const source = new ReadableStream({
    start(c) { c.enqueue(src); c.close(); },
  });
  const reader = source.pipeThrough(new CompressionStream('deflate')).getReader();
  const chunks = [];
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

/** String table. Index 0 is empty by convention. */
class Table {
  entries = [''];
  index = new Map([['', 0]]);

  of(s) {
    let i = this.index.get(s);
    if (i === undefined) {
      i = this.entries.length;
      this.entries.push(s);
      this.index.set(s, i);
    }
    return i;
  }
}

const packed = (indices) => {
  const w = new Writer();
  for (const i of indices) w.varint(i);
  return w.bytes();
};

function tagFields(tags, t) {
  const ks = [];
  const vs = [];
  for (const [k, v] of tags) {
    ks.push(t.of(k));
    vs.push(t.of(v));
  }
  return { keys: packed(ks), vals: packed(vs) };
}

/** DenseNodes: keys_vals=10, id=1, lat=8, lon=9, all delta-encoded. */
function encodeDense(nodes, t) {
  const kv = new Writer();
  for (const n of nodes) {
    for (const [k, v] of n.tags ?? []) { kv.varint(t.of(k)); kv.varint(t.of(v)); }
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
  return new Writer().len(10, kv.bytes()).len(1, ids.bytes()).len(8, lats.bytes()).len(9, lons.bytes()).bytes();
}

/** Way: id=1 int64 (not zigzag), keys=2, vals=3, refs=8 packed sint64 delta. */
function encodeWay(id, refs, tags, t) {
  const { keys, vals } = tagFields(tags, t);
  const r = new Writer();
  let prev = 0;
  for (const ref of refs) { r.varint(zigzag(ref - prev)); prev = ref; }
  return new Writer().int(1, id).len(2, keys).len(3, vals).len(8, r.bytes()).bytes();
}

/** One PrimitiveBlock: groups as field 2, string table as field 1. */
function encodeBlock(groups, t) {
  const w = new Writer();
  for (const group of groups) {
    const g = new Writer();
    for (const [field, body] of group) g.len(field, body);
    w.len(2, g.bytes());
  }
  const st = new Writer();
  for (const s of t.entries) st.len(1, UTF8.encode(s));
  return w.len(1, st.bytes()).bytes();
}

/** HeaderBlock, which a reader must skip rather than treat as data. */
function encodeHeader(bbox) {
  const [w, s, e, n] = bbox;
  const box = new Writer()
    .sint(1, toNd(w)).sint(2, toNd(e)).sint(3, toNd(n)).sint(4, toNd(s))
    .bytes();
  return new Writer()
    .len(1, box)
    .str(4, 'OsmSchema-V0.6')
    .str(4, 'DenseNodes')
    .bool(16, true)
    .bytes();
}

function assembleBlob(type, body) {
  const header = new Writer().str(1, type).int(3, body.length).bytes();
  const len = header.length;
  return new Writer()
    .raw(Uint8Array.of((len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff))
    .raw(header)
    .raw(body)
    .bytes();
}

async function blob(type, payload) {
  const deflated = await deflate(payload);
  // Blob: raw_size=2 (uncompressed length), zlib_data=3.
  const body = new Writer().int(2, payload.length).len(3, deflated).bytes();
  return assembleBlob(type, body);
}

const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

/* ============================ XML parsing =========================== */

function parseOsmXml(text) {
  const nodes = new Map();
  const ways = [];

  const NODE_RE = /<node\b([^>]*?)(?:\/>|>([\s\S]*?)<\/node>)/g;
  const WAY_RE = /<way\b([^>]*?)(?:\/>|>([\s\S]*?)<\/way>)/g;
  const TAG_RE = /<tag\b([^>]*?)\/>/g;
  const REF_RE = /<nd\b[^>]*?ref\s*=\s*"(-?\d+)"/g;

  const attrs = (s) => {
    const o = {};
    for (const m of s.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) o[m[1]] = m[2];
    return o;
  };

  let m;
  while ((m = NODE_RE.exec(text))) {
    const a = attrs(m[1]);
    const node = { id: +a.id, lat: +a.lat, lon: +a.lon };
    const body = m[2];
    if (body && body.includes('<tag')) {
      const tags = {};
      for (const t of body.matchAll(TAG_RE)) {
        const ta = attrs(t[1]);
        tags[ta.k] = ta.v;
      }
      if (Object.keys(tags).length) node.tags = Object.entries(tags);
    }
    nodes.set(node.id, node);
  }

  while ((m = WAY_RE.exec(text))) {
    const a = attrs(m[1]);
    const body = m[2];
    if (!body) continue;
    const tags = [];
    for (const t of body.matchAll(TAG_RE)) {
      const ta = attrs(t[1]);
      tags.push([ta.k, ta.v]);
    }
    if (!tags.length) continue;
    const refs = [...body.matchAll(REF_RE)].map((r) => +r[1]);
    if (refs.length < 2) continue;
    ways.push({ id: +a.id, refs, tags });
  }

  return { nodes, ways };
}

/* ============================== driver ============================== */

/**
 * @param nodes   Map<id, {id,lat,lon,tags?}>
 * @param ways    Array<{id,refs,tags}>
 * @param perBlock how many nodes per PrimitiveBlock
 */
export async function encodeFromParsed(nodes, ways, perBlock = 4000) {
  const all = [...nodes.values()];
  const parts = [];

  const xs = all.map((n) => n.lon);
  const ys = all.map((n) => n.lat);
  const bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];

  parts.push(await blob('OSMHeader', encodeHeader(bbox)));

  const t = new Table();
  // Reserve string-table indices up front so a node group and the ways that
  // reference the same strings share one table, as real writers do.
  for (const n of all) for (const [k, v] of n.tags ?? []) { t.of(k); t.of(v); }
  for (const w of ways) for (const [k, v] of w.tags) { t.of(k); t.of(v); }

  const wayByFirstNode = new Map();
  for (const w of ways) {
    if (!wayByFirstNode.has(w.refs[0])) wayByFirstNode.set(w.refs[0], []);
    wayByFirstNode.get(w.refs[0]).push(w);
  }

  for (let i = 0; i < all.length; i += perBlock) {
    const chunk = all.slice(i, i + perBlock);
    // Ways whose nodes all fall in this chunk.
    const waysHere = [];
    for (const n of chunk) {
      for (const w of wayByFirstNode.get(n.id) ?? []) {
        if (waysHere.includes(w)) continue;
        if (w.refs.every((r) => nodes.has(r))) waysHere.push(w);
      }
    }
    const group = [];
    if (chunk.length) group.push([2, encodeDense(chunk, t)]);
    for (const w of waysHere) group.push([3, encodeWay(w.id, w.refs, w.tags, t)]);
    parts.push(await blob('OSMData', encodeBlock([group], t)));
  }

  return concat(parts);
}

export async function osmToPbf(xmlText, perBlock) {
  const { nodes, ways } = parseOsmXml(xmlText);
  return { bytes: await encodeFromParsed(nodes, ways, perBlock), nodeCount: nodes.size, wayCount: ways.length };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , input, output, perBlock] = process.argv;
  if (!input || !output) {
    console.error('usage: node tools/osm2pbf.mjs input.osm output.osm.pbf [nodesPerBlock]');
    process.exit(2);
  }
  const xml = readFileSync(input, 'utf8');
  const { bytes, nodeCount, wayCount } = await osmToPbf(xml, perBlock ? +perBlock : undefined);
  writeFileSync(output, bytes);
  console.log(`${input} -> ${output}: ${nodeCount} nodes, ${wayCount} ways, ${(bytes.length / 1024).toFixed(1)} KiB`);
}
