#!/usr/bin/env node
/**
 * build-pack — build a Valhalla routing-pack `.tar` from an OSM extract.
 *
 * The offline Valhalla engine (`src/nav/valhalla-local/`) routes over *tiles*,
 * not over raw OSM, and tiles are built by Valhalla's own `valhalla_build_tiles`
 * — a native tool that is deliberately not part of the app (see
 * `research/valhalla-local-feasibility.md`, §6: prebuilt packs are the supply
 * chain; on-device building is the fallback nobody wants). This script is that
 * supply chain's smallest possible instance: one extract in, one pack out.
 *
 * Usage:
 *   node tools/build-pack.mjs [input.osm.pbf] [output.tar]
 *
 * Defaults produce `test/fixture.valhalla.tar` from `test/fixture.osm`, which
 * is what the test suite routes against. `valhalla_build_tiles` must be on PATH
 * (or in $VALHALLA_BIN), e.g.:
 *
 *   python3 -m venv venv && venv/bin/pip install pyvalhalla
 *   VALHALLA_BIN=venv/lib/python3.X/site-packages/valhalla/bin node tools/build-pack.mjs
 *
 * The input is re-encoded through `tools/osm2pbf.mjs`'s type-sorted encoder
 * first: `valhalla_build_tiles` refuses interleaved node/way blocks ("Detected
 * unsorted input data"), and hand-written fixtures are never sorted. Real
 * Geofabrik extracts pass through unchanged only if already `.osm.pbf`; any
 * `.osm` XML is sorted here, which is harmless for real data too.
 *
 * The tar is assembled with the system `tar` (GNU flags for byte-stable
 * output: fixed mtime/owner, name-sorted entries), so the committed fixture is
 * reproducible and the app's tar reader is tested against a real archiver
 * rather than against itself.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseOsmXml, encodeSorted } from './osm2pbf.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

function findBin(name) {
  const dir = process.env.VALHALLA_BIN;
  const candidate = dir ? join(dir, name) : name;
  try {
    execFileSync(candidate, ['--version'], { stdio: 'ignore' });
    return candidate;
  } catch {
    throw new Error(
      `${name} not found${dir ? ` in ${dir}` : ' on PATH'}.\n` +
      'Install the Valhalla tools (e.g. `pip install pyvalhalla`) and set VALHALLA_BIN.',
    );
  }
}

/** Every `.gph` under dir, as paths relative to dir, sorted. */
function tileFiles(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tileFiles(p, base));
    else if (name.endsWith('.gph')) out.push(p.slice(base.length + 1));
  }
  return out;
}

async function main() {
  const input = resolve(process.argv[2] ?? join(ROOT, 'test', 'fixture.osm'));
  const output = resolve(process.argv[3] ?? join(ROOT, 'test', 'fixture.valhalla.tar'));

  const work = mkdtempSync(join(tmpdir(), 'canopy-pack-'));
  try {
    // 1. Type-sorted PBF from the input, whichever format it arrived in.
    const pbf = join(work, 'input.osm.pbf');
    if (input.endsWith('.osm.pbf')) {
      // Geofabrik extracts are already type-sorted; trust but verify cheaply by
      // passing them through untouched (rewriting a 300 MB extract to re-encode
      // it would be pure cost).
      writeFileSync(pbf, readFileSync(input));
    } else {
      const { nodes, ways } = parseOsmXml(readFileSync(input, 'utf8'));
      writeFileSync(pbf, await encodeSorted(nodes, ways));
    }

    // 2. Build tiles. The config is the minimal shape `valhalla_build_tiles`
    //    needs (tile_dir + logging off): the Python `valhalla_build_config`
    //    wrapper is not present in every distribution of the native tools, and
    //    a tool that needs two of them is a tool half the users cannot run.
    const tileDir = join(work, 'tiles');
    mkdirSync(tileDir);
    const config = join(work, 'valhalla.json');
    writeFileSync(config, JSON.stringify({ mjolnir: { tile_dir: tileDir }, logging: { type: '' } }));
    execFileSync(findBin('valhalla_build_tiles'), ['--config', config, '-j', '2', pbf], {
      stdio: 'inherit',
    });

    const tiles = tileFiles(tileDir);
    if (!tiles.length) throw new Error('valhalla_build_tiles produced no .gph tiles');

    // 3. Deterministic tar: name-sorted entries, fixed metadata. No directories
    //    — the app's tar index reads file entries and nothing else.
    mkdirSync(join(work, 'out'), { recursive: true });
    execFileSync('tar', [
      '--create',
      '--format=ustar',
      '--mode=644',
      '--file', join(work, 'out', 'pack.tar'),
      '--directory', tileDir,
      '--no-recursion',
      '--sort=name',
      '--mtime=@0',
      '--owner=0', '--group=0', '--numeric-owner',
      ...tiles,
    ], { stdio: 'inherit' });

    mkdirSync(resolve(output, '..'), { recursive: true });
    writeFileSync(output, readFileSync(join(work, 'out', 'pack.tar')));
    const size = statSync(output).size;
    console.log(`${basename(input)} -> ${basename(output)}: ${tiles.length} tiles, ${(size / 1024).toFixed(1)} KiB`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
