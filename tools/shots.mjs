/**
 * Visual + interaction verification harness.
 *
 * `test/screens.mjs` asserts structure (overflow, zero-size text, which screens
 * were reached). This drives the same app and captures *pixels* plus computed
 * style, because the two defect classes the suite keeps missing are both
 * invisible to a bounding box:
 *
 *   - a rule whose declarations were discarded by CSS error recovery, and
 *   - a colour or padding that resolves to something nobody intended.
 *
 * So each shot records the computed style of the named element alongside the
 * image, which turns "the turn arrow looks flat" into an assertion.
 *
 *   node tools/shots.mjs                  # all viewports, default set
 *   SHOTS_VIEWPORT=phone-portrait …       # one viewport
 *   SHOTS_SET=navigation …                # one scenario
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SHOTS_BASE ?? 'http://127.0.0.1:8080';
const OUT = join(here, '..', '..', 'canopy-shots');
const FIXTURE = join(here, '..', 'test', 'fixture.osm');
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = {
  'phone-portrait': { width: 412, height: 915 },
  'phone-landscape': { width: 892, height: 412 },
  'head-unit': { width: 1280, height: 720 },
};
const vpNames = (process.env.SHOTS_VIEWPORT ?? 'phone-portrait,phone-landscape,head-unit').split(',');

/** Reads computed style for a selector, in the page. */
const readStyle = (sels) => {
  const out = {};
  for (const s of sels) {
    const el = document.querySelector(s);
    if (!el) { out[s] = null; continue; }
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    out[s] = {
      background: cs.backgroundColor,
      color: cs.color,
      padding: cs.padding,
      opacity: cs.opacity,
      display: cs.display,
      position: cs.position,
      zIndex: cs.zIndex,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    };
  }
  // A truncated label is the single most common polish defect in a responsive
  // audit, and it is invisible in a screenshot at a glance — so measure it:
  // `scrollWidth > clientWidth` on a text element means an ellipsis is showing.
  out.__clipped = [...document.querySelectorAll('.brand-title, .pill-label, .quick-label > span, .screen-title')]
    .filter((el) => el.scrollWidth > el.clientWidth + 1)
    .map((el) => `${el.className || el.tagName}: "${(el.textContent || '').trim()}" (${el.scrollWidth} > ${el.clientWidth})`);
  return out;
};

const report = { generatedAt: new Date().toISOString(), shots: [] };

for (const vpName of vpNames) {
  const vp = VIEWPORTS[vpName.trim()];
  if (!vp) { console.log(`unknown viewport ${vpName}`); continue; }

  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  const shot = async (name, sels = []) => {
    const styles = sels.length ? await page.evaluate(readStyle, sels) : {};
    const file = `${vpName}--${name}.png`;
    await page.screenshot({ path: join(OUT, file) });
    report.shots.push({ viewport: vpName, name, file, styles, errors: [...errors] });
    console.log(`  ${vpName}/${name}${errors.length ? `  (${errors.length} err)` : ''}`);
  };

  console.log(`\n=== ${vpName} (${vp.width}x${vp.height}) ===`);
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2200);
  await shot('01-home', ['.quick-tile', '.search-field', '.brand-title', '.status-pill', '.icon-btn']);

  // import the fixture so the map has a graph
  const importBtn = await page.$('button:has-text("Import .osm file")') ?? await page.$('text=Import .osm file');
  if (importBtn) { await importBtn.click(); await page.waitForTimeout(500); }
  const input = await page.$('input[type=file]');
  if (input) {
    await input.setInputFiles(FIXTURE);
    await page.waitForFunction(
      () => !document.body.innerText.includes('Parsing') && !document.body.innerText.includes('Building graph'),
      { timeout: 40000 },
    );
    await page.waitForTimeout(1500);
    await shot('02-home-loaded', ['.quick-tile', '.home-search', '.continue-row']);

    // search
    await page.click('.search-field');
    await page.waitForTimeout(400);
    await page.fill('.inline-search input', 'Elbow');
    await page.waitForTimeout(900);
    await shot('03-search', ['.result-row', '.inline-search']);

    // route
    const row = await page.$('.result-row');
    if (row) {
      await row.click();
      await page.waitForTimeout(2600);
      await shot('04-preview', ['.preview-card', '.eta-bar', '.error-card']);

      const start = await page.$('button.primary-btn');
      if (start) {
        await start.click();
        await page.waitForTimeout(2400);
        await shot('05-navigating', [
          '.maneuver-icon', '.maneuver-instr', '.maneuver-dist',
          '.eta-bar', '.nav-bottom', '.nav-bottom-btn', '.nav-status',
          '.maplibregl-ctrl-attrib', '.control-column',
        ]);

        const steps = await page.$('button:has-text("Steps")');
        if (steps) {
          await steps.click();
          await page.waitForTimeout(800);
          await shot('06-steps', ['.step-row']);
          const back = await page.$('button[aria-label="Back"]');
          if (back) { await back.click(); await page.waitForTimeout(700); }
        }
        const layers = await page.$('button[aria-label="Map layers"]');
        if (layers) {
          await layers.click();
          await page.waitForTimeout(600);
          await shot('07-layers', ['.nav-panel', '.layer-row']);
          await page.keyboard.press('Escape');
          await page.waitForTimeout(400);
        }
        const exit = await page.$('button[aria-label="Exit navigation"]');
        if (exit) { await exit.click(); await page.waitForTimeout(900); }
      }
    }
  }

  // settings + engines + regions
  const gear = await page.$('button[aria-label="Settings"]');
  if (gear) {
    await gear.click();
    await page.waitForTimeout(700);
    await shot('08-settings', ['.seg', '.app-bar']);
    const hint = await page.$('.hint-card');
    if (hint) { await hint.click(); await page.waitForTimeout(700); await shot('09-engines', ['.provider-row']); }
  }
  const regionsLink = await page.$('button[aria-label="Regions"]') ?? await page.$('text=Regions');
  if (regionsLink) {
    await regionsLink.click().catch(() => {});
    await page.waitForTimeout(1400);
    await shot('10-regions', ['.region-row', '.progress-card']);
  }

  await browser.close();
}

writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(`\nwrote ${report.shots.length} shots + report.json to ${OUT}`);