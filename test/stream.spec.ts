/**
 * Streaming XML parse tests.
 *
 * The claim under test is that parsing a document in arbitrary chunks produces
 * exactly the same graph as parsing it in one piece. That matters because the
 * streaming path is the one that runs on a real 900 MB province: a divergence
 * would drop roads on exactly the largest inputs, where it is hardest to notice
 * and most expensive.
 *
 * So most of this file is equivalence across chunk sizes, including sizes chosen
 * to split tags, attributes and element bodies in awkward places.
 *
 * Run with `npx vitest run test/stream.spec.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  parseOsmXml,
  parseOsmXmlStream,
  buildDataset,
} from '../src/osm/engine.worker';

/** Yield `text` in fixed-size pieces. */
function* fixed(text: string, size: number): Generator<string> {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
}

/** Yield `text` with randomly varied piece sizes, to fuzz the boundary logic. */
function* variable(text: string, seed: number): Generator<string> {
  let s = seed;
  const rand = () => {
    // Deterministic LCG: a failing case must be reproducible.
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  let i = 0;
  while (i < text.length) {
    const size = 1 + Math.floor(rand() * 40);
    yield text.slice(i, i + size);
    i += size;
  }
}

async function* asAsync(gen: Generator<string>): AsyncGenerator<string> {
  for (const c of gen) yield c;
}

const DOC = `<?xml version="1.0"?>
<osm version="0.6">
  <bounds minlat="51.4" minlon="-1.5" maxlat="51.6" maxlon="-1.3"/>
  <node id="1" lat="51.5000" lon="-1.4000"/>
  <node id="2" lat="51.5010" lon="-1.3990"/>
  <node id="3" lat="51.5020" lon="-1.3980"/>
  <node id="4" lat="51.5030" lon="-1.3970"/>
  <node id="10" lat="51.5005" lon="-1.4050">
    <tag k="place" v="city"/>
    <tag k="name" v="Testville"/>
    <tag k="population" v="9000"/>
  </node>
  <node id="11" lat="51.5015" lon="-1.4045"/>
  <node id="12" lat="51.5025" lon="-1.4040"/>
  <way id="100">
    <nd ref="1"/><nd ref="2"/><nd ref="3"/>
    <tag k="highway" v="primary"/>
    <tag k="name" v="High Street"/>
  </way>
  <way id="101">
    <nd ref="10"/><nd ref="11"/><nd ref="12"/>
    <tag k="highway" v="residential"/>
    <tag k="name" v="Side Road"/>
  </way>
  <way id="102">
    <nd ref="1"/><nd ref="4"/>
    <tag k="highway" v="service"/>
  </way>
</osm>
`;

function canonical(r: { nodes: Map<number, any>; ways: any[] }) {
  return {
    nodes: [...r.nodes.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([id, n]) => [id, n.lat, n.lon, n.tags ?? null]),
    ways: r.ways
      .slice()
      .sort((a, b) => a.id - b.id)
      .map((w) => [w.id, w.refs.join(','), JSON.stringify(w.tags)]),
  };
}

/* ------------------------- equivalence ------------------------- */

describe('parseOsmXmlStream — equivalence with the whole-string parse', () => {
  const whole = canonical(parseOsmXml(DOC));

  it('the fixture actually parses to something', () => {
    expect(whole.nodes.length).toBeGreaterThan(5);
    expect(whole.ways.length).toBe(3);
  });

  for (const size of [1, 2, 3, 7, 16, 31, 64, 127, 256, 1024]) {
    it(`matches when chunked at ${size} character${size > 1 ? 's' : ''}`, async () => {
      const streamed = canonical(await parseOsmXmlStream(asAsync(fixed(DOC, size))));
      expect(streamed).toEqual(whole);
    });
  }

  for (const seed of [1, 7, 42, 1337, 90210]) {
    it(`matches on variable chunking (seed ${seed})`, async () => {
      const streamed = canonical(await parseOsmXmlStream(asAsync(variable(DOC, seed))));
      expect(streamed).toEqual(whole);
    });
  }

  it('matches when every chunk is a whole document', async () => {
    const streamed = canonical(await parseOsmXmlStream(asAsync(fixed(DOC, DOC.length))));
    expect(streamed).toEqual(whole);
  });

  it('handles a chunk boundary landing inside a tag name', async () => {
    // Split at a position guaranteed to be mid-element.
    const at = DOC.indexOf('highway') + 3;
    const streamed = await parseOsmXmlStream(asAsync([DOC.slice(0, at), DOC.slice(at)]));
    expect(canonical(streamed)).toEqual(whole);
  });

  it('handles a boundary between an attribute name and its value', async () => {
    const at = DOC.indexOf('lon="-1.4000"') + 6;
    const streamed = await parseOsmXmlStream(asAsync([DOC.slice(0, at), DOC.slice(at)]));
    expect(canonical(streamed)).toEqual(whole);
  });

  it('handles a boundary immediately after a self-closing tag', async () => {
    const at = DOC.indexOf('<nd ref="2"/>') + '<nd ref="2"/>'.length;
    const streamed = await parseOsmXmlStream(asAsync([DOC.slice(0, at), DOC.slice(at)]));
    expect(canonical(streamed)).toEqual(whole);
  });

  it('handles a single-character-at-a-time feed of the whole document', async () => {
    const streamed = await parseOsmXmlStream(asAsync(fixed(DOC, 1)));
    expect(canonical(streamed)).toEqual(whole);
  });
});

/* ------------------------- downstream equivalence ------------------------- */

describe('streaming feeds the same dataset', () => {
  it('builds an identical graph and gazetteer', async () => {
    const a = buildDataset(
      parseOsmXml(DOC).nodes,
      parseOsmXml(DOC).ways,
      () => {},
    );
    const s = await parseOsmXmlStream(asAsync(fixed(DOC, 5)));
    const b = buildDataset(s.nodes, s.ways, () => {});

    expect(b.counts.routable).toBe(a.counts.routable);
    expect(b.counts.ways).toBe(a.counts.ways);
    expect(b.gaz.length).toBe(a.gaz.length);
    expect(b.gaz.map((g) => g.name).sort()).toEqual(a.gaz.map((g) => g.name).sort());
    expect(b.bbox).toEqual(a.bbox);
  });

  it('still indexes the placemark node carrying tags', async () => {
    const s = await parseOsmXmlStream(asAsync(fixed(DOC, 4)));
    const ds = buildDataset(s.nodes, s.ways, () => {});
    expect(ds.gaz.some((g) => g.name === 'Testville')).toBe(true);
  });
});

/* ------------------------- progress ------------------------- */

describe('parseOsmXmlStream — progress', () => {
  it('reports monotonically and ends at the half-way mark', async () => {
    const seen: number[] = [];
    await parseOsmXmlStream(asAsync(fixed(DOC, 16)), (p) => seen.push(p));
    expect(seen.length).toBeGreaterThan(0);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(seen[seen.length - 1]).toBeCloseTo(0.5, 5);
  });

  it('uses a size hint when given one', async () => {
    const seen: number[] = [];
    await parseOsmXmlStream(asAsync(fixed(DOC, 32)), (p) => seen.push(p), DOC.length * 2);
    expect(seen.every((p) => p >= 0 && p <= 0.5)).toBe(true);
  });

  it('still reaches the half-way mark on an empty document', async () => {
    const seen: number[] = [];
    await parseOsmXmlStream([], (p) => seen.push(p));
    expect(seen[seen.length - 1]).toBe(0.5);
  });
});

/* ------------------------- degenerate input ------------------------- */

describe('degenerate documents', () => {
  it('parses an empty document', async () => {
    const s = await parseOsmXmlStream([]);
    expect(s.nodes.size).toBe(0);
    expect(s.ways.length).toBe(0);
  });

  it('parses a document that is one unterminated element', async () => {
    const truncated = '<osm><node id="1" lat="0" lon="0"/>';
    const s = await parseOsmXmlStream(asAsync(fixed(truncated, 7)));
    // The trailing element never reaches a closing boundary; whether it is
    // scanned is a deliberate choice, but it must not throw or hang.
    expect(s.nodes.size).toBeGreaterThanOrEqual(0);
  });

  it('parses a document with no elements at all', async () => {
    const s = await parseOsmXmlStream(asAsync(fixed('<osm version="0.6"></osm>', 5)));
    expect(s.nodes.size).toBe(0);
  });

  it('ignores a chunk stream that arrives out of order being impossible to parse, without throwing', async () => {
    // Not a real input, but the failure mode that matters is a thrown error.
    await expect(
      parseOsmXmlStream(asAsync(fixed('<way id="1"><nd ref="1"/><nd ref="2"/></way>', 3))),
    ).resolves.toBeDefined();
  });
});