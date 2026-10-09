/**
 * Progress reporting when there is no size hint, and three comments that had drifted.
 *
 * ## The streaming progress branch
 *
 * `parseOsmXmlStream`'s docstring used to claim that, without a `totalChars` hint,
 * progress "is reported against the high-water mark". It was not. A variable named
 * `high` was accumulated on every window cut and **never read anywhere in the repo** —
 * the fingerprint of reporting that was removed and not re-wired — so a caller passing
 * no hint received exactly one value, `onProgress(0.5)`, after the last chunk.
 *
 * `test/stream.spec.ts` could not see it: it asserts progress is monotonic and ends at
 * the half-way mark, and a one-element `[0.5]` satisfies both.
 *
 * ## Why the honest answer is one report, not a rising trace
 *
 * The tempting repair is `high / seen`, which rises toward the half-way mark — but it is
 * **1.0** the instant the first boundary is cut and stays there, so it is not a fraction
 * of anything. Any other rising value without a denominator is **invented**: it claims
 * the parse is 40% done when nothing knows that. That is the same defect as §13.14's
 * steps list, where a screen reported a cause nothing had established.
 *
 * So the behaviour is unchanged, the dead state is gone, and what is asserted here is
 * that it stays a single terminal report — plus that the app, which always supplies a
 * hint, still gets a real trace.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOsmXmlStream } from '../src/osm/engine.worker';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** A document long enough to be cut at several element boundaries. */
function chunksOf(elements: number): string[] {
  const head = '<?xml version="1.0"?><osm version="0.6">';
  const body: string[] = [];
  for (let i = 0; i < elements; i++) {
    body.push(
      `<node id="${i + 1}" lat="51.5${i}" lon="-1.4"/>`,
      `<way id="${i + 1}"><nd ref="${i + 1}"/><nd ref="${i + 2}"/><tag k="highway" v="residential"/></way>`,
    );
  }
  const out = [head];
  for (const piece of body) out.push(piece);
  out.push('</osm>');
  return out;
}

describe('progress with no size hint', () => {
  it('is a single terminal report, not an invented rising trace', async () => {
    const seen: number[] = [];
    await parseOsmXmlStream(chunksOf(40), (p) => seen.push(p));
    expect(seen, 'one report, because nothing knows the denominator').toEqual([0.5]);
  });

  it('is still exactly one when the document ends on a boundary', async () => {
    // The other tail case: `carry` empty, so the final report comes from the `else`
    // rather than from `flush`. Same shape of answer either way.
    const seen: number[] = [];
    await parseOsmXmlStream(chunksOf(10), (p) => seen.push(p));
    expect(seen).toEqual([0.5]);
  });

  it('leaves no progress state behind', () => {
    // The dead `high` variable, asserted absent. A reviewer finding it again would
    // reasonably try to wire it up, and §14.16 explains why that would be wrong.
    const src = read('src/osm/engine.worker.ts');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code, 'no dead high-water-mark variable').not.toMatch(/\bhigh\b/);
  });

  it('says why a single report is the honest answer', () => {
    // The reasoning is what stops the next person "fixing" it into an invention.
    const src = read('src/osm/engine.worker.ts');
    expect(src).toMatch(/1\.0\)?\*{0,2} the moment the first boundary is cut/);
    expect(src).toMatch(/would claim the parse is 40% done when nothing knows that/);
  });

  it('reports a real trace when a size hint is supplied', async () => {
    // The branch the app actually takes, so the removal of the dead state cannot have
    // cost it anything.
    const chunks = chunksOf(40);
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const seen: number[] = [];
    await parseOsmXmlStream(chunks, (p) => seen.push(p), total);
    expect(seen.length, 'more than one report').toBeGreaterThan(2);
    expect(seen[seen.length - 1]).toBeCloseTo(0.5, 5);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i], `monotonic at ${i}`).toBeGreaterThanOrEqual(seen[i - 1]);
    }
  });

  it('the app always supplies a hint, so the honest branch is the rare one', () => {
    // Why this defect survived at all: production is on the `totalChars` path.
    const engine = read('src/osm/engine.ts');
    expect(engine, 'the caller passes a size hint').toMatch(/totalChars|parseOsmXmlStream\([^)]*,\s*[^,]+,\s*(?:file\.size|total)/);
  });
});

describe('three comments that had drifted', () => {
  it('names a test that exists', () => {
    // `App.tsx` cited `test/search-debounce.spec.ts`, which has never existed — so the
    // comment named the mechanism keeping an invariant true, and the mechanism was not
    // there to be found.
    const app = read('src/App.tsx');
    expect(app).not.toMatch(/test\/search-debounce\.spec\.ts/);
    const cited = [...app.matchAll(/`(test\/[\w.-]+\.spec\.ts)`/g)].map((m) => m[1]);
    for (const f of cited) {
      expect(existsSync(join(ROOT, f)), `${f} is cited but does not exist`).toBe(true);
    }
  });

  it('does not put the progress-reset obligation on the guidance memo', () => {
    // `guidance` is a read-only derivation. It carried a verbatim copy of
    // `beginRouteProgress`'s comment, so a reader could conclude it owned the reset and
    // add one — reintroducing the monotonic-clamp bug the first copy warns about.
    const app = read('src/App.tsx');
    const at = app.indexOf('const guidance = useMemo');
    expect(at, 'guidance memo found').toBeGreaterThan(-1);
    // The memo's *own* comment block, not a fixed window: a 900-character lookback
    // reached past it into `beginRouteProgress`, which legitimately carries the phrase,
    // and the assertion failed for the right reason on the wrong text.
    const own = app.slice(app.lastIndexOf('/**', at), at);
    // The memo's comment quotes the phrase in order to say it does *not* apply here, so
    // `not.toMatch` cannot be the instrument. What matters is that the quote is marked
    // as a quote of somebody else's claim rather than stated as this memo's rule.
    expect(own, 'the obligation is quoted, not asserted').toMatch(
      /"the placement in metres has to be cleared \*with\* the fraction" — which reads, on/,
    );
    expect(own).toMatch(/obligation belongs to `beginRouteProgress`/);
    expect(own).toMatch(/read-only derivation/);
  });

  it('states that the PBF reader differs from the XML path, which streams', () => {
    // `pbf.ts` said PBF needs the whole file in memory "exactly like the XML path". The
    // XML path streams in a bounded window and is what production uses; PBF is the
    // normal format and was always held whole.
    //
    // **This assertion was correct and is now wrong, because the defect it described
    // has been fixed.** PBF streams too (`parseOsmPbfStream`), so the sentence it was
    // pinning no longer describes the code. Left asserting the old wording it would
    // fail; left deleted it would lose the record of why. So it now asserts the
    // *shape* of the relationship — PBF streams, and names which entry point is
    // production — which is the part that stays true across future changes.
    const pbf = read('src/osm/pbf.ts');
    expect(pbf).toMatch(/parseOsmPbfStream`? is the production entry point/);
    // The streaming reader exists and is not the one holding whole files.
    expect(pbf).toMatch(/export async function parseOsmPbfStream/);
    // The whole-file reader survives only for callers that hold the bytes.
    expect(pbf).toMatch(/Prefer `parseOsmPbfStream`/);

    // **What this cannot catch, stated plainly:** a stale sentence added *alongside* the
    // correction. Two attempts at a positional check for that both passed with the stale
    // text restored, because the correction and the stale claim are both present and
    // nothing here distinguishes them. So this pins that the correction is there, and
    // nothing more. A check that looks stronger than it is worse than none, and this
    // file has already produced two of those today.
  });

  it('does not re-claim anywhere that PBF is held whole', () => {
    // The specific regression: a comment restored by a merge or a careless edit.
    // STATUS.md §14.16 called this the largest single piece of engineering left in
    // the app, so it is the sentence most likely to be copied around.
    const pbf = read('src/osm/pbf.ts');
    expect(pbf).not.toMatch(/the whole file must be in memory/i);
    expect(pbf).not.toMatch(/PBF is the normal format and is always held whole/);

    const worker = read('src/osm/engine.worker.ts');
    // The worker must not concatenate the stream into one buffer before parsing.
    expect(worker).not.toMatch(/const joined = new Uint8Array\(total\)/);

    const engine = read('src/osm/engine.ts');
    // `engine.ts` must not call `arrayBuffer()` on the PBF path unconditionally.
    const pbfBranch = engine.slice(engine.indexOf("format: 'pbf'") - 600, engine.indexOf("format: 'pbf'") + 400);
    expect(pbfBranch, 'PBF should prefer stream() over arrayBuffer()').toMatch(/file\.stream\(\)/);
  });
});