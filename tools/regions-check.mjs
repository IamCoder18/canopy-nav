/**
 * Drives the Regions screen on the deployed site and reports every console error.
 *
 * This is the check that shows the CORS failures are gone. It opens the screen,
 * which is what triggers the catalogue availability probes, and collects the
 * console output — so "no errors" here means the browser stopped refusing the
 * requests, not merely that the page loaded.
 *
 *   PROBE_BASE=https://canopydev.aaravlabs.com \
 *   PROBE_AUTH=$(printf 'canopy:%s' "$PW" | base64 -w0) \
 *     node tools/regions-check.mjs
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const BASE = process.env.PROBE_BASE ?? 'http://127.0.0.1:8137';

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  /*
   * `httpCredentials`, never `extraHTTPHeaders: { Authorization }`.
   *
   * `extraHTTPHeaders` is applied to *every* request the page makes, including
   * cross-origin ones — so it attached this site's basic-auth header to requests
   * for tiles.openfreemap.org and to every Geofabrik URL. That both leaks the
   * credential to third parties and makes those requests non-simple, triggering a
   * preflight which OpenFreeMap answers with 405. It produced a CORS error a real
   * user would never see, because a browser scopes basic-auth to the origin that
   * challenged it.
   *
   * `httpCredentials` answers the 401 the way a browser does, on the origin that
   * asked, and touches nothing else.
   */
  ...(process.env.PROBE_USER
    ? { httpCredentials: { username: process.env.PROBE_USER, password: process.env.PROBE_PASS ?? '' } }
    : {}),
});
const page = await ctx.newPage();

const errors = [];
const corsBlocked = [];
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  /*
   * The first request to a site behind HTTP basic auth is answered with a 401,
   * and the browser then re-issues it with credentials. Chromium logs that first
   * 401 to the console, so it appears here for every load of a protected
   * deployment. It is the auth handshake, not a fault in the app, and counting it
   * would make this check useless for exactly the deployment it is aimed at.
   */
  if (/401/.test(t) && /HTTP response code/i.test(t)) return;
  errors.push(t);
  if (/CORS policy|Access-Control-Allow-Origin/i.test(t)) corsBlocked.push(t);
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

// Count the mirror requests the page actually makes.
let mirrored = 0;
page.on('request', (r) => {
  if (r.url().includes('/mirror/geofabrik/')) mirrored++;
});

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

const regions = await page.$('button[aria-label="Regions"]');
if (!regions) {
  console.log('could not reach the Regions screen');
  await browser.close();
  process.exit(1);
}
await regions.click();
await page.waitForTimeout(6000);

console.log(`origin            ${BASE}`);
console.log(`mirror requests   ${mirrored}`);
console.log(`console errors    ${errors.length}`);
console.log(`of which CORS     ${corsBlocked.length}`);

// What the catalogue rows say about their own availability.
const rows = await page.$$eval('.result-row', (els) =>
  els.map((e) => e.textContent.trim().replace(/\s+/g, ' ').slice(0, 70)),
);
console.log(`\ncatalogue rows (${rows.length}):`);
for (const r of rows.slice(0, 12)) console.log(`  ${r}`);

const failing = rows.filter((r) => /Unavailable|could not/i.test(r));
console.log(`\nrows reporting a problem: ${failing.length}`);
for (const f of failing) console.log(`  ${f}`);

if (corsBlocked.length) {
  console.log('\nsample CORS errors:');
  for (const e of corsBlocked.slice(0, 3)) console.log(`  ${e.slice(0, 160)}`);
}

await browser.close();
const ok = corsBlocked.length === 0 && errors.length === 0 && mirrored > 0;
console.log(ok ? '\nOK — downloads are same-origin and nothing is blocked' : '\nPROBLEMS REMAIN');
process.exit(ok ? 0 : 1);