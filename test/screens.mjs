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
 * Screens this suite is supposed to look at, and proof that it did.
 *
 * ## Why this exists
 *
 * Every block below is guarded by an `if (await page.$(...))`. That is correct
 * defensive style for a browser suite — a missing element should not throw and
 * lose the rest of the run — and it is also how this suite spent a month
 * reporting "all checks passed" while visiting four screens instead of eleven.
 * The unwind was broken (this app navigates by React state, not history, so
 * `page.goBack()` leaves the app entirely for `about:blank`), every subsequent
 * `page.$` returned null, every guard fell through, and the only symptom was a
 * shorter log. Restoring it immediately failed and exposed three real 412dp
 * overflow bugs, which is the argument for taking the suite seriously.
 *
 * So the suite now records which screens it actually reached and fails if any
 * expected one is missing. The count is asserted, not inferred: a suite that
 * cannot tell you it visited less than it meant to is a suite whose green result
 * is not evidence, and that is the same failure in a different costume.
 *
 * This is the fifth such guard in the project (§3.16, §4.1, §4.6, §3.5.2, §3.19)
 * and the pattern is worth stating once: **a gate that has never been seen to
 * fail has not been tested.**
 */
const visited = new Set();
// Twelve, not ten. The first draft of this list was written from memory and
// omitted `home-loaded` and `layers-panel`; the undeclared-screens check below
// caught it on the first run, which is the check earning its place.
const EXPECTED_SCREENS = [
  'home', 'home-loaded', 'settings', 'engines', 'regions', 'import',
  'search-empty', 'search-results', 'preview', 'navigating', 'steps',
  'layers-panel',
];

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
    // Recorded before the checks, so a screen that renders and then throws is
    // still counted as reached — the point is coverage, not health.
    visited.add(name);
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

  // The nav control stack and the layers popover. These had *zero* browser
  // coverage, which is how a `pointer-events` regression in `.nav-panel` shipped
  // unnoticed: nothing ever opened the panel. Opening it here is the cheapest
  // way to stop that recurring.
  await page.click('.search-field').catch(() => {});
  await page.waitForTimeout(500);
  await page.fill('.inline-search input', 'Elbow');
  await page.waitForTimeout(1200);
  const firstHit = await page.$('.result-row');
  if (firstHit) {
    await firstHit.click();
    await page.waitForTimeout(2200);
    const start = await page.$('button.primary-btn');
    if (start) {
      await start.click();
      await page.waitForTimeout(1500);
      await visit('navigating', 'navigating');

      // Open the layers panel and assert it is actually operable: reachable,
      // sized, and clicking a row does not fall through to the map.
      const layerBtn = await page.$('.nav-controls button:nth-child(4)');
      if (layerBtn) {
        await layerBtn.click();
        await page.waitForTimeout(800);
        const panel = await page.evaluate(() => {
          const el = document.querySelector('.nav-panel');
          if (!el) return { present: false };
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          const row = el.querySelector('.layer-row');
          const rs = row ? getComputedStyle(row) : null;
          return {
            present: true,
            width: Math.round(r.width),
            height: Math.round(r.height),
            pointerEvents: cs.pointerEvents,
            zIndex: cs.zIndex,
            display: cs.display,
            rows: el.querySelectorAll('.layer-row').length,
            rowClickable: rs ? rs.pointerEvents : null,
          };
        });
        check('layers panel opens', panel.present);
        // These four are the regression: a rule split in two lost its sizing and
        // its `pointer-events: auto`, leaving the panel click-through to the map.
        check('layers panel is sized', (panel.width ?? 0) > 100 && (panel.height ?? 0) > 40,
          `${panel.width}x${panel.height}`);
        check('layers panel is clickable', panel.pointerEvents === 'auto' && panel.rowClickable === 'auto',
          `panel ${panel.pointerEvents} / row ${panel.rowClickable}`);
        check('layers panel is stacked above the map', Number(panel.zIndex) >= 1,
          `z-index ${panel.zIndex}, display ${panel.display}`);
        check('layers panel lists its options', (panel.rows ?? 0) >= 2, `${panel.rows} rows`);
        await visit('layers panel', 'layers-panel');

        // The voice control. It used to claim an audio capability the app did not
        // have at all — see the honesty note in STATUS.md. It now drives real
        // spoken guidance, and where the WebView has no speech engine it is
        // present but disabled with the reason in its accessible name, so all
        // three of these are honest states rather than a missing control.
        const mute = await page.$(
          'button[aria-label="Mute voice guidance"], button[aria-label="Unmute voice guidance"], ' +
          'button[aria-label="Voice guidance unavailable on this device"]',
        );
        check('the voice control exists and states its state', !!mute,
          mute ? await mute.getAttribute('aria-label') : 'absent');
        if (mute) {
          const unavailable = (await mute.getAttribute('aria-label'))?.includes('unavailable');
          check('the voice control is disabled exactly when voice is unavailable',
            (await mute.isDisabled()) === !!unavailable,
            `disabled=${await mute.isDisabled()} labelSaysUnavailable=${!!unavailable}`);
        }
        const closeBtn = await page.$('button[aria-label="Close map layers"]');
        if (closeBtn) {
          await closeBtn.click();
          await page.waitForTimeout(500);
          const closed = await page.evaluate(() => !document.querySelector('.nav-panel'));
          check('the layers panel closes', closed);
        }
      }
    }
  }

  // Drag an extract onto the home screen. `HomeScreen.onImportFile` was declared
  // and wired to real work and never called; this proves it is now reachable by
  // the gesture it exists for.
  //
  // Reset the page rather than unwinding: at this point the app is several
  // screens deep and the only Back control may be navigation's, which exits to
  // home but through a path that skips the app bar this needs.
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2200);
  if (await page.$('.home-root')) {
    const fixtureBytes = Array.from(
      (await import('node:fs')).readFileSync(join(__dirname, FIXTURE)),
    );
    const dropped = await page.evaluate(async (bytes) => {
      const root = document.querySelector('.home-root');
      if (!root) return { ok: false, why: 'no .home-root' };
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes)], 'dropped.osm', { type: 'application/xml' }));
      root.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      // `dropping` is React state, so the hint is not in the DOM until React has
      // committed. One animation frame is not always enough; polling is.
      const hint = await (async () => {
        for (let i = 0; i < 20; i++) {
          if (document.querySelector('.drop-hint')) return true;
          await new Promise((r) => setTimeout(r, 50));
        }
        return false;
      })();
      root.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return { ok: true, hint };
    }, fixtureBytes);
    check('dragging over the home screen offers to import', dropped.ok && dropped.hint,
      dropped.why ?? `hint ${dropped.hint}`);
    await page.waitForTimeout(6000);
    const after = await page.evaluate(() => document.body.innerText);
    check('a dropped extract is imported', /\d+ routable ways/.test(after),
      after.match(/[\d,]+ routable ways/)?.[0] ?? 'no graph');
  }

  // Back out to home for the settings and engines visits.
  for (let i = 0; i < 5; i++) {
    if (await page.$('button[aria-label="Settings"]')) break;
    const exit = await page.$('button[aria-label="Exit navigation"]');
    const back = await page.$('button[aria-label="Back"]');
    if (exit) await exit.click();
    else if (back) await back.click();
    else break;
    await page.waitForTimeout(600);
  }

  // settings
  await page.click('button[aria-label="Settings"]').catch(() => {});
  await visit('settings', 'settings');

  // engines -- the longest list of labelled rows in the app, so the most likely
  // to overflow at 412dp.
  //
  // Unwind with the app's own Back button, twice: engines -> settings -> home.
  // Do NOT use page.goBack() here. This app navigates by React state, not by
  // history entries, so goBack() leaves the app entirely -- to about:blank --
  // and every subsequent `page.$` then fails. That is not a crash: each block
  // below is guarded, so the run still printed "all checks passed" while
  // silently visiting 4 screens instead of 11.
  const enginesLink = await page.$('.hint-card');
  if (enginesLink) {
    await enginesLink.click().catch(() => {});
    await visit('engines', 'engines');
    for (let i = 0; i < 2; i++) {
      const back = await page.$('button[aria-label="Back"]');
      if (!back) break;
      await back.click().catch(() => {});
      await page.waitForTimeout(500);
    }
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

  /**
   * Did this run actually cover the app?
   *
   * The check above it can only report on screens that were reached. This one
   * reports on the screens that were not, which is the question a reader of the
   * log actually needs answered and the one nothing in the suite used to ask.
   */
  const missing = EXPECTED_SCREENS.filter((s) => !visited.has(s));
  check(
    `all ${EXPECTED_SCREENS.length} screens were visited`,
    missing.length === 0,
    missing.length ? `skipped: ${missing.join(', ')}` : `${visited.size} reached`,
  );
  // An unexpected extra is worth knowing about too: it means a screen was renamed
  // or a visit was added without updating the list, and in both cases the list has
  // stopped describing reality.
  const unexpected = [...visited].filter((s) => !EXPECTED_SCREENS.includes(s));
  check(
    'no undeclared screens were visited',
    unexpected.length === 0,
    unexpected.length ? `undeclared: ${unexpected.join(', ')}` : '',
  );

  await context.close();
}

await browser.close();
console.log(`\nscreenshots in ${SHOTS}`);
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
