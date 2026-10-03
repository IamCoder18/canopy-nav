/**
 * End-to-end smoke test.
 *
 * Drives the real built app in a browser: imports an .osm file, searches the
 * offline gazetteer, computes an offline route, and starts navigation. This is
 * the only test that exercises the worker, the region store, the router and the
 * React screens together — unit tests can't catch a wiring regression between
 * them.
 *
 * Run with: node test/e2e.mjs
 * Requires `npm run build` first and the preview server running on E2E_PORT.
 */

import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.E2E_PORT ?? '4192';
const BASE = `http://localhost:${PORT}`;
const SHOTS = join(__dirname, '..', 'e2e-screenshots');
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({
  // Prefer a Playwright-managed Chromium so this works in CI, but fall back to
  // a system Chrome for local runs where nothing has been downloaded.
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--no-sandbox'],
});
// The fixture sits at lon -1.4 / lat 51.5 (near Edinburgh). Without this the
// app falls back to a simulated Calgary fix and a cross-ocean route is
// correctly refused, so pin the "device" inside the fixture's bounds. This
// also exercises the real geolocation path rather than the fallback.
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  permissions: ['geolocation'],
  geolocation: { latitude: 51.503, longitude: -1.399, accuracy: 8 },
});
const page = await context.newPage();

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  /* ---------------- import an .osm file ---------------- */
  console.log('\nimport');
  await page.click('text=Import .osm file');
  await page.waitForTimeout(600);
  const input = await page.$('input[type=file]');
  check('file input present', !!input);
  await input.setInputFiles(join(__dirname, 'fixture.osm'));

  // The worker parses and builds the graph; wait for the region count to land.
  await page.waitForFunction(
    () => !document.body.innerText.includes('Parsing') &&
          !document.body.innerText.includes('Building graph'),
    { timeout: 30000 },
  );
  await page.waitForTimeout(1200);
  const afterImport = await page.evaluate(() => document.body.innerText);
  check('map registered after import', !/No map loaded/.test(afterImport), afterImport.match(/[\d,]+ routable ways/)?.[0] ?? '');
  await page.screenshot({ path: join(SHOTS, '1-imported.png') });

  /* ---------------- offline search ---------------- */
  console.log('\nsearch (offline gazetteer)');
  await page.click('.search-field');
  await page.waitForTimeout(500);
  await page.fill('.inline-search input', 'Elbow');
  await page.waitForTimeout(900);
  const results = await page.evaluate(() =>
    [...document.querySelectorAll('.result-row')].map((r) => r.innerText.split('\n')[0]),
  );
  check('gazetteer returns offline hits', results.length > 0, results.join(', '));
  await page.screenshot({ path: join(SHOTS, '2-search.png') });

  /* ---------------- route + navigate ---------------- */
  console.log('\nroute');
  if (results.length) {
    await page.click('.result-row');
    await page.waitForTimeout(2500);
    const preview = await page.evaluate(() => document.body.innerText);
    check('route preview shown', /Start/.test(preview));
    check('preview reports engine', /Offline \.osm/.test(preview), preview.match(/Engine\s*(\w[\w .-]*)/)?.[1] ?? '');
    check('preview reports a distance', /\d+\s*(m|km|ft|mi)/.test(preview));
    await page.screenshot({ path: join(SHOTS, '3-preview.png') });

    await page.click('button.primary-btn');
    await page.waitForTimeout(2000);
    const nav = await page.evaluate(() => document.body.innerText);
    check('navigation screen active', /Steps/.test(nav) && /Exit/.test(nav));
    check('ETA bar shows duration', /\d+\s*(min|hr)/.test(nav), nav.match(/\d+\s*(min|hr)[^\n]*/)?.[0] ?? '');
    await page.screenshot({ path: join(SHOTS, '4-navigating.png') });

    // steps list
    const stepsBtn = await page.$('button:has-text("Steps")');
    if (stepsBtn) {
      await stepsBtn.click();
      await page.waitForTimeout(900);
      const steps = await page.evaluate(() => document.body.innerText);
      check('steps list renders', /Route steps/i.test(steps));
      await page.screenshot({ path: join(SHOTS, '5-steps.png') });
    }
  }

  /* ---------------- search after a loaded region ---------------- */
  console.log('\nsearch with a loaded region');
  // Back out to home. The stack is steps -> navigating -> home, and each screen
  // exposes a different control, so unwind it rather than assuming one button.
  for (let i = 0; i < 4; i++) {
    if (await page.$('.search-field')) break;
    const exit = await page.$('button[aria-label="Exit navigation"]');
    const back = await page.$('button[aria-label="Back"]');
    if (exit) await exit.click();
    else if (back) await back.click();
    else break;
    await page.waitForTimeout(700);
  }
  await page.waitForSelector('.search-field', { timeout: 10000 });
  await page.click('.search-field');
  await page.waitForTimeout(400);
  await page.fill('.inline-search input', 'Elbow');
  await page.waitForTimeout(900);
  const multi = await page.evaluate(() => document.body.innerText);
  check('search works with a loaded region', /Elbow St/.test(multi));
  const stillOnSearch = await page.evaluate(() => !!document.querySelector('.inline-search'));
  check('still on the search screen', stillOnSearch);
  // leave the search screen so the regions block starts from home
  const backBtn = await page.$('button[aria-label="Back"]');
  if (backBtn) await backBtn.click();
  await page.waitForTimeout(700);

  /* ---------------- regions ---------------- */
  console.log('\nregions');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  const regionTile = await page.$('.quick-tile:has-text("Regions")');
  check('regions tile on home', !!regionTile);
  if (regionTile) {
    await regionTile.click();
    await page.waitForTimeout(1200);
    const regionsText = await page.evaluate(() => document.body.innerText);
    check('regions screen lists a catalogue', /Alberta/.test(regionsText) && /British Columbia/.test(regionsText));
    await page.screenshot({ path: join(SHOTS, '6-regions.png') });
  }

  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
} catch (err) {
  check('harness completed', false, err.message);
  await page.screenshot({ path: join(SHOTS, 'error.png') }).catch(() => {});
} finally {
  await browser.close();
}

console.log(`\nscreenshots in ${SHOTS}`);
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
