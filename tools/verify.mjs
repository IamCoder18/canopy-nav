/**
 * Every gate, in one command: `npm run verify`.
 *
 * The gates existed before this file and were run by hand, one shell command
 * at a time — which is exactly how one of them gets skipped. A gate that is
 * convenient to skip is a gate that gets skipped; this makes skipping the
 * slower path. CI runs the same file, so "it passed on my machine" and "it
 * passed in CI" mean the same list.
 *
 * What runs, and why each is here:
 *
 *   check     typecheck, lint, the unit suite — and the suite audits STATUS.md
 *   build     the production bundle (typecheck again, per `npm run build`)
 *   bundle    the gzip budgets, which are what actually fail a build on size
 *   fixture   the .osm.pbf fixture regenerated from the .osm — deterministic —
 *             plus a check that the committed copy is current
 *   e2e       the app driven as a driver uses it, in a real browser: once on
 *             the .osm fixture and once on the .osm.pbf, which is the format
 *             Geofabrik publishes and therefore the primary path
 *   screens   every screen at three viewports, checking clipping and overlap
 *   reflow    the same layouts at 100-200% text
 *   textscale the large-text layout switch, every platform's way of scaling
 *   uiaudit   hover, focus and hit-target findings, zero expected
 *
 * The browser gates need the built app served. The server is started here and
 * stopped at the end — unless one is already listening, in which case it is
 * left exactly as it is: killing a developer's long-running server to run a
 * test is how a verify script becomes unpopular.
 *
 * Run with: npm run verify
 * Exits non-zero when any gate fails.
 */

import { spawn, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.E2E_PORT ?? '4192';
const BASE = `http://127.0.0.1:${PORT}`;

/** The gates, in the order a failure is cheapest to find in. */
const GATES = [
  { label: 'check (typecheck, lint, unit)', cmd: 'npm', args: ['run', 'check'] },
  { label: 'build', cmd: 'npm', args: ['run', 'build'] },
  { label: 'bundle budget', cmd: 'node', args: ['tools/bundle-budget.mjs'] },
  {
    // `.osm.pbf` is what Geofabrik publishes, so it is the primary path — and
    // `test/fixture.osm.pbf` is generated from `test/fixture.osm` by
    // `tools/osm2pbf.mjs`, deterministically. Rebuilding it here means the
    // gates never run against a fixture that drifted from its generator, and
    // the diff check below is what says so out loud instead of letting the
    // committed copy rot quietly.
    label: 'pbf fixture', cmd: 'node', args: ['tools/osm2pbf.mjs', 'test/fixture.osm', 'test/fixture.osm.pbf', '700'],
  },
  {
    label: 'pbf fixture is current', cmd: 'git', args: ['diff', '--quiet', 'test/fixture.osm.pbf'],
    failNote: 'test/fixture.osm.pbf is stale — regenerate it (see .gitignore) and commit the result',
  },
  { label: 'e2e (.osm)', cmd: 'node', args: ['test/e2e.mjs'] },
  { label: 'e2e (.osm.pbf)', cmd: 'node', args: ['test/e2e.mjs'], env: { E2E_FIXTURE: 'fixture.osm.pbf' } },
  { label: 'screens (3 viewports)', cmd: 'node', args: ['test/screens.mjs'] },
  { label: 'reflow (100-200% text)', cmd: 'node', args: ['tools/reflow.mjs'] },
  { label: 'textscale', cmd: 'node', args: ['tools/textscale-check.mjs'] },
  { label: 'ui audit', cmd: 'node', args: ['tools/ui-audit.mjs'], env: { PROBE_BASE: BASE } },
];

/** Something already serving the port? Then it is the server of record. */
async function alreadyServing() {
  try {
    const res = await fetch(BASE, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitUntilServing(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await alreadyServing()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const started = [];
let serverOwned = false;
if (await alreadyServing()) {
  console.log(`reusing the server already on ${BASE}`);
} else {
  const server = spawn('node', ['tools/serve.mjs'], {
    cwd: root,
    env: { ...process.env, PORT },
    stdio: 'ignore',
  });
  started.push(server);
  serverOwned = true;
  if (!(await waitUntilServing())) {
    console.error(`the serve script did not answer on ${BASE}`);
    server.kill();
    process.exit(2);
  }
}

const results = [];
const t0 = Date.now();
for (const gate of GATES) {
  const at = Date.now();
  process.stdout.write(`\n=== ${gate.label} ===\n`);
  const run = spawnSync(gate.cmd, gate.args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...(gate.env ?? {}) },
  });
  results.push({ label: gate.label, ok: run.status === 0, seconds: (Date.now() - at) / 1000, failNote: gate.failNote });
}

if (serverOwned) {
  for (const s of started) s.kill();
}

console.log('\n=== verify ===');
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.label.padEnd(30)} ${r.seconds.toFixed(0).padStart(4)}s`);
  if (!r.ok && r.failNote) console.log(`        ${r.failNote}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} gates passed in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
if (failed.length) {
  console.error(`failed: ${failed.map((f) => f.label).join(', ')}`);
  process.exit(1);
}
