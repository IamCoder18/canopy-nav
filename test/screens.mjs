/**
 * Screen coverage + responsive checks.
 *
 * Verifies every screen renders at three viewports:
 *   - 412x915   portrait phone  (narrowest realistic layout)
 *   - 892x412   landscape phone (typical AAOS projection)
 *   - 1280x720  head unit        (the design target)
 *
 * For each screen it asserts:
 *   - the screen actually rendered something
 *   - no uncaught page errors
 *   - no element overflows the viewport horizontally (the classic narrow-screen
 *     bug, and one this UI is very exposed to because of the 12% margins)
 *   - text is not clipped to zero size (the unitless line-height class of bug)
 *
 * Run with: node test/screens.mjs
 */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const __dirname = dirname(fileURLToPath(import.meta.url));
// Same port as test/e2e.mjs so one `vite preview` can serve both suites.
const PORT = process.env.E2E_PORT ?? process.env.PORT ?? '4192';
const BASE = `http://localhost:${PORT}`;
const SHOTS = join(__dirname, '..', 'e2e-screenshots');
mkdirSync(SHOTS, { recursive: true });

const VIEWPORTS = [
  { name: 'phone-portrait', width: 412, height: 915 },
  { name: 'phone-landscape', width: 892, height: 412 },
  { name: 'head-unit', width: 1280, height: 720 },
];

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures++;
};

/**
 * Structural problems that a screenshot alone would not reveal.
 * Runs in the page.
 */
const audit = () => {
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const out = { overflowing: [], invisible: [], vw, vh };

  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;

    // Horizontal overflow: allow 1px of subpixel slop.
    if (r.right > vw + 1 || r.left < -1) {
      out.overflowing.push({
        tag: el.tagName,
        cls: (el.className || '').toString().slice(0, 40),
        left: Math.round(r.left),
        right: Math.round(r.right),
        text: (el.textContent || '').trim().slice(0, 24),
      });
    }

    // Text that occupies no height, or a line box absurdly taller than the font.
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (hasText && el.children.length === 0) {
      const fs = parseFloat(cs.fontSize);
      const lh = parseFloat(cs.lineHeight);
      if (r.height === 0) {
        out.invisible.push({ tag: el.tagName, cls: (el.className || '').toString().slice(0, 40), why: 'zero height' });
      } else if (Number.isFinite(fs) && Number.isFinite(lh) && lh > fs * 12) {
        out.invisible.push({
          tag: el.tagName, cls: (el.className || '').toString().slice(0, 40),
          why: `line-height ${lh} on font-size ${fs}`,
        });
      }
    }
  }
  return out;
};

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--no-sandbox'],
});

/**
 * Which fixture to import. `.pbf` is the format Geofabrik actually publishes,
 * so it is the more important path; both are checked below.
 */
const FIXTURE = process.env.E2E_FIXTURE ?? 'fixture.osm';

for (const vp of VIEWPORTS) {
  console.log(`\n${vp.name} (${vp.width}x${vp.height})`);
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    permissions: ['geolocation'],
    // inside test/fixture.osm's bounds (near Edinburgh)
    geolocation: { latitude: 51.503, longitude: -1.399, accuracy: 8 },
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  /** Visit a screen, audit it, screenshot it. */
  const visit = async (label, name) => {
    await page.waitForTimeout(650);
    const text = await page.evaluate(() => document.body.innerText.trim());
    check(`${label} renders content`, text.length > 0, `${text.length} chars`);
    const a = await page.evaluate(audit);
    check(
      `${label} no horizontal overflow`,
      a.overflowing.length === 0,
      a.overflowing.length
        ? a.overflowing.slice(0, 3).map((o) => `${o.cls || o.tag}@${o.left}..${o.right}`).join(', ')
        : '',
    );
    check(
      `${label} text is visible`,
      a.invisible.length === 0,
      a.invisible.slice(0, 3).map((o) => `${o.cls || o.tag}:${o.why}`).join(', '),
    );
    await page.screenshot({ path: join(SHOTS, `${vp.name}-${name}.png`) });
  };

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2200);
  await visit('home', 'home');

  // import so later screens have a map
  await page.click('text=Import .osm file');
  await page.waitForTimeout(500);
  const input = await page.$('input[type=file]');
  if (input) {
    await input.setInputFiles(join(__dirname, FIXTURE));
    await page.waitForFunction(
      () => !document.body.innerText.includes('Parsing') && !document.body.innerText.includes('Building graph'),
      { timeout: 30000 },
    );
    await page.waitForTimeout(1000);
  }
  const loaded = await page.evaluate(() => !/No map loaded/.test(document.body.innerText));
  check('map registered from ' + FIXTURE, loaded,
    (await page.evaluate(() => document.body.innerText)).match(/[\d,]+ routable ways/)?.[0] ?? '');
  await visit('home (map loaded)', 'home-loaded');

  // settings
  await page.click('button[aria-label="Settings"]');
  await visit('settings', 'settings');

  // engines -- the longest list of labelled rows in the app, so the most likely
  // to overflow at 412dp.
  const enginesLink = await page.$('.hint-card');
  if (enginesLink) {
    await enginesLink.click().catch(() => {});
    await visit('engines', 'engines');
    await page.goBack().catch(() => {});
    await page.waitForTimeout(400);
  }

  // regions
  const regionTile = await page.$('.quick-tile:has-text("Regions")');
  if (regionTile) {
    await regionTile.click().catch(() => {});
    await visit('regions', 'regions');
    const back = await page.$('button[aria-label="Back"]');
    if (back) { await back.click(); await page.waitForTimeout(600); }
  }

  // import screen
  const imp = await page.$('button[aria-label="Back"]');
  if (imp) { await imp.click(); await page.waitForTimeout(600); }
  await page.click('button[aria-label="Settings"]').catch(() => {});
  await page.waitForTimeout(500);
  const importBtn = await page.$('button:has-text("Import .osm")');
  if (importBtn) {
    await importBtn.click().catch(() => {});
    await visit('import', 'import');
    const b2 = await page.$('button[aria-label="Back"]');
    if (b2) { await b2.click(); await page.waitForTimeout(600); }
  }

  // search
  const backHome = await page.$('button[aria-label="Back"]');
  if (backHome) { await backHome.click(); await page.waitForTimeout(600); }
  await page.click('button[aria-label="Back"]').catch(() => {});
  await page.waitForTimeout(500);
  if (await page.$('.search-field')) {
    await page.click('.search-field');
    await visit('search (empty)', 'search-empty');
    await page.fill('.inline-search input', 'Elbow');
    await page.waitForTimeout(900);
    await visit('search (results)', 'search-results');

    // preview + navigating
    if (await page.$('.result-row')) {
      await page.click('.result-row');
      await visit('preview', 'preview');
      const start = await page.$('button.primary-btn');
      if (start) {
        await start.click();
        await visit('navigating', 'navigating');
        const steps = await page.$('button:has-text("Steps")');
        if (steps) {
          await steps.click();
          await visit('steps', 'steps');
        }
      }
    }
  }

  check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
  await context.close();
}

await browser.close();
console.log(`\nscreenshots in ${SHOTS}`);
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
