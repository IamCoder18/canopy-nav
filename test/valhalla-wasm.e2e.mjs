/**
 * valhalla-wasm.e2e — the offline Valhalla engine's *worker transport*, in a
 * real browser.
 *
 * `test/valhalla-local.spec.ts` runs the engine in-process (Node); this runs
 * the other half: `WorkerClient` → real `Worker` → `worker.ts` → WASM →
 * routing pack, through the dev server's module graph exactly as the app
 * serves it. The two together cover both transports behind `LocalValhallaClient`.
 *
 * Contract (same as `test/e2e.mjs`'s): run against the Vite dev server. This
 * script starts its own on E2E_WASM_PORT (default 5178) and cleans it up.
 *
 *   node test/valhalla-wasm.e2e.mjs
 *
 * The assertions are the ones that must hold in a browser *and* in Node — the
 * same fixture pack must produce the same route: same length, same maneuver
 * count, same offline failure sentences. A divergence between the two hosts is
 * exactly the class of bug this pair of files exists to catch.
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.E2E_WASM_PORT ?? '5178';
const BASE = `http://localhost:${PORT}`;

/* ------------------------------ check book ------------------------------ */

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/* ------------------------------ the drive ------------------------------- */

async function waitForServer(url, ms = 30_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() - t0 > ms) throw new Error(`dev server did not start on ${url}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function main() {
  // Vite dev: the same module graph the app develops against. Its worker
  // handling is part of what is under test (module workers, `?url` assets).
  const server = spawn('npx', ['vite', '--port', PORT, '--strictPort'], {
    cwd: join(__dirname, '..'),
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  let browser;
  try {
    await waitForServer(BASE);
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });

    // The engine, through its public client. In a browser `createLocalValhalla`
    // picks the worker transport — the thing Node cannot exercise.
    const out = await page.evaluate(async () => {
      const { createLocalValhalla } = await import('/src/nav/valhalla-local/index.ts');
      const client = createLocalValhalla();
      const record = { kind: client.constructor.name, steps: {} };

      const bytes = await (await fetch('/test/fixture.valhalla.tar')).arrayBuffer();
      await client.mount('fixture', bytes);
      record.steps.mounted = { ready: client.ready(), regions: client.regions() };

      const sw = [-1.4, 51.5];
      const ne = [-1.3232, 51.506];
      const t0 = performance.now();
      const route = await client.route({ from: sw, to: ne, units: 'km' });
      record.steps.cold = { ms: Math.round(performance.now() - t0) };

      const t1 = performance.now();
      const warm = await client.route({ from: sw, to: ne, units: 'km' });
      record.steps.warm = { ms: Math.round(performance.now() - t1) };

      record.steps.route = {
        engine: route.engine,
        units: route.units,
        length: route.summary.length,
        time: route.summary.time,
        points: route.geometry.length,
        maneuvers: route.maneuvers.length,
        lastEndsAtGeometryEnd:
          route.maneuvers[route.maneuvers.length - 1].end_shape_index === route.geometry.length - 1,
        instructions: route.maneuvers.every((m) => typeof m.instruction === 'string' && m.instruction.length > 0),
        sameAsWarm: Math.abs(route.summary.length - warm.summary.length) < 0.5,
      };

      const failure = await client.route({ from: [0, 0], to: [0.01, 0], units: 'km' })
        .then(() => ({ ok: true }), (e) => ({ ok: false, message: String(e?.message ?? e) }));
      record.steps.failure = failure;

      await client.unmount('fixture');
      record.steps.afterUnmount = { ready: client.ready(), regions: client.regions() };
      client.dispose();

      // Phase 2: the store layer in a real browser — the app's own singleton
      // engine, real IndexedDB persistence, and the removal lifecycle. This is
      // the path `importPackFile` takes when the Regions screen picks a file.
      const store = await import('/src/regions/store.ts');
      const { getLocalValhalla } = await import('/src/nav/valhalla-local/index.ts');
      // Fresh fetch: the phase-1 buffer was *transferred* to the worker and is
      // detached — the same reason `importPackFile` saves before it mounts.
      const packBytes = await (await fetch('/test/fixture.valhalla.tar')).arrayBuffer();
      const packFile = new File([packBytes], 'fixture.valhalla.tar');
      record.steps.storeImportError = null;
      const info = await store.importPackFile({
        file: packFile,
        onError: (m) => { record.steps.storeImportError = m; },
      });
      record.steps.storeImport = {
        info,
        pack: store.regionLib.packFor('local-fixture'),
        engineReady: getLocalValhalla().ready(),
      };
      await store.removeRegion('local-fixture');
      record.steps.storeRemoval = {
        pack: store.regionLib.packFor('local-fixture'),
        engineReady: getLocalValhalla().ready(),
      };
      getLocalValhalla().dispose();
      return record;
    });

    const r = out.steps;
    check('client is the worker transport', out.kind === 'WorkerClient', out.kind);
    check('mounts the fixture pack', r.mounted.ready && r.mounted.regions.includes('fixture'));
    check('routes in a browser worker', r.route.engine === 'valhalla-local');
    check(
      'length matches the in-process engine (5988 m ±5%)',
      Math.abs(r.route.length - 5988) / 5988 < 0.05,
      `${Math.round(r.route.length)} m`,
    );
    check('time is present and plausible', r.route.time > 60 && r.route.time < 3600, `${Math.round(r.route.time)} s`);
    check('geometry has the grid run in it', r.route.points > 5, `${r.route.points} points`);
    check('carries maneuvers with instructions', r.route.maneuvers >= 2 && r.route.instructions, `${r.route.maneuvers} maneuvers`);
    check('the last maneuver is the arrival', r.route.lastEndsAtGeometryEnd);
    check('a repeat route agrees with the first', r.route.sameAsWarm);
    check('warm route is interactive', r.warm.ms < 2000, `${r.warm.ms} ms (cold ${r.cold.ms} ms)`);
    check('a point off the map fails with an offline sentence', !r.failure.ok && /offline|no road near/i.test(r.failure.message ?? ''), r.failure.message ?? '');
    check('the failure never blames a server', !/server/i.test(r.failure.message ?? ''));
    check('unmount takes the engine out of service', r.afterUnmount.ready === false, JSON.stringify(r.afterUnmount));
    check(
      'the store imports a pack and mounts the app engine',
      r.storeImport.info?.tiles === 3 && r.storeImport.pack?.tiles === 3 && r.storeImport.engineReady === true,
      `${JSON.stringify(r.storeImport)} err=${JSON.stringify(r.storeImportError)}`,
    );
    check(
      'removing the region takes the pack and the mount with it',
      r.storeRemoval.pack === null && r.storeRemoval.engineReady === false,
      JSON.stringify(r.storeRemoval),
    );
  } finally {
    await browser?.close();
    server.kill('SIGTERM');
  }

  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
