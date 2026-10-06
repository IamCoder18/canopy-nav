/**
 * Does the app notice a text scale that leaves the root font size alone?
 *
 * ## Why this gate exists
 *
 * `src/textscale.ts` decides whether the entire large-text layout is switched on. It
 * did so by reading the resolved **root** font size, on a stated assumption about how
 * Android delivers the system font setting — an assumption that could not be checked,
 * because §7 gap 1 is that this app has never run on physical hardware.
 *
 * Measuring the alternatives in Chromium showed the assumption only covers one of them:
 *
 * | platform behaviour | root font size | a 16px probe's rendered height | `data-textsize` |
 * |---|---|---|---|
 * | nothing | 16px | 19px | `normal` |
 * | the root font size is enlarged | 28px | 19px | `large` |
 * | rendered text is scaled, root untouched | 16px | **33px** | **`normal`** — missed |
 * | the page is zoomed | 16px | **33px** | **`normal`** — missed |
 *
 * The third row is `WebSettings.setTextZoom`, which is how Android WebView applies a
 * text scale. Under it the app rendered at 175% type with every large-text rule off —
 * which is precisely the collision §12.7 measured and §14.1 fixed.
 *
 * So the detector now reads both signals. **This gate is what proves that works**, and
 * it is the only place in the project that can: everything else either reads the source
 * or trusts the detector's own decision function.
 *
 * ## What it does *not* do
 *
 * It does not verify what a real device does — nothing here can, and §7 gap 1 stands.
 * It verifies that the app responds correctly to each way a platform *could* deliver a
 * scale, so that whichever one the device uses, the layout turns on.
 *
 * Run with `npm run textscale`.
 */

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.E2E_PORT ?? '4192';
const BASE = `http://localhost:${PORT}`;
const SHOTS = join(ROOT, 'e2e-screenshots');
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures++;
};

/**
 * Wait for the app's own detector, which polls every 2 s.
 *
 * Returns whether it arrived rather than throwing. A timeout here means the app never
 * noticed the scale, which is the *product* failure this gate exists to catch — and
 * letting it propagate would kill the process and lose every later block, so one
 * undetected mechanism would hide the state of the other three. A harness failure and a
 * product failure must be distinguishable from outside, which is §13.7's whole subject.
 */
const waitForVerdict = (want) => async (page) => {
  try {
    await page.waitForFunction(
      (expected) => document.documentElement.dataset.textsize === expected,
      want,
      // Same signature as the e2e suite's: options are the *third* argument. Passing
      // them as the second silently reverts to Playwright's 30 s default — the bug
      // recorded in §13.12.
      { timeout: 15000, polling: 400 },
    );
    return true;
  } catch {
    return false;
  }
};

/**
 * Scale every text element by a factor, leaving the root font size alone.
 *
 * Each element's font size is multiplied **from its own original**, so nothing
 * compounds: an `em`-based rule applied to `html, body, body *` compounds once per
 * ancestor and put the root at 28px and a single ETA value at 1407px, which is not
 * what any platform does. Taking each original and writing a fixed px size back is what
 * a user-agent text scale amounts to, and it is also what `tools/reflow.mjs` does.
 *
 * Reversible: the originals are kept so the "back to normal" block can restore them.
 */
const SCALE_TEXT_ONLY = (factor) => `(() => {
  window.__originals = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    // Deliberately NOT skipping invisible or undisplayed elements: a platform text
    // scale applies to every glyph, and skipping them is a property of the loop in
    // tools/reflow.mjs rather than of the platform. Skipping them here is what made
    // this check miss the app's own probe, which is invisible by design.
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const px = parseFloat(cs.fontSize);
    if (!Number.isFinite(px) || px <= 0) continue;
    window.__originals.push([el, px]);
    el.style.setProperty('font-size', (px * ${factor}).toFixed(2) + 'px', 'important');
  }
  return window.__originals.length;
})()`;

const RESTORE_TEXT = `(() => {
  for (const [el, px] of window.__originals ?? []) el.style.removeProperty('font-size');
  window.__originals = [];
})()`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });

/** Load the app onto the navigation screen, where the large-text layout matters. */
async function openNavigating(ctx) {
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const input = await page.$('input[type=file]');
  if (input) {
    await input.setInputFiles(join(ROOT, 'test', 'fixture.osm'));
    await page.waitForFunction(
      () => /[\d,]+ routable ways/.test(document.body.innerText),
      undefined,
      { timeout: 40000 },
    );
    await page.waitForTimeout(600);
  }
  await page.click('.search-field').catch(() => {});
  await page.waitForTimeout(400);
  await page.fill('.inline-search input', 'Elbow');
  await page.waitForTimeout(1000);
  const row = await page.$('.result-row');
  if (row) {
    await row.click();
    await page.waitForTimeout(2000);
    const start = await page.$('button.primary-btn');
    if (start) {
      await start.click();
      await page.waitForTimeout(1200);
    }
  }
  return page;
}

const rootPx = (page) => page.evaluate(
  () => parseFloat(getComputedStyle(document.documentElement).fontSize),
);

/** Has the large-text layout actually taken effect? */
const largeLayoutApplied = (page) => page.evaluate(() => {
  const bar = document.querySelector('.eta-bar');
  return bar ? getComputedStyle(bar).getPropertyValue('flex-wrap').trim() : '(no navigation screen)';
});

console.log('\ntext scaling the root font size only');
{
  const ctx = await browser.newContext({
    viewport: { width: 892, height: 412 }, deviceScaleFactor: 1,
    permissions: ['geolocation'], geolocation: { latitude: 51.5215, longitude: -1.4175 },
  });
  const page = await openNavigating(ctx);
  check('an unscaled app is marked normal', await page.evaluate(
    () => document.documentElement.dataset.textsize === 'normal',
  ));

  await page.evaluate(() => {
    document.documentElement.style.setProperty('font-size', '28px', 'important');
  });
  const sawRoot = await waitForVerdict('large')(page);
  check('a platform that enlarges the root font size is detected', sawRoot,
    sawRoot ? '' : `data-textsize stayed "${await page.evaluate(() => document.documentElement.dataset.textsize)}"`);
  check('and the large-text layout is applied',
    (await largeLayoutApplied(page)) === 'wrap',
    `eta-bar flex-wrap: ${await largeLayoutApplied(page)}`);
  await page.screenshot({ path: join(SHOTS, 'textscale-root.png') });
  await ctx.close();
}

console.log('\ntext scaling the rendered text, root untouched');
{
  const ctx = await browser.newContext({
    viewport: { width: 892, height: 412 }, deviceScaleFactor: 1,
    permissions: ['geolocation'], geolocation: { latitude: 51.5215, longitude: -1.4175 },
  });
  const page = await openNavigating(ctx);

  const scaled = await page.evaluate(SCALE_TEXT_ONLY(1.75));
  // The precondition this whole block exists for: the root really is still 16px, so
  // the root-only detector could not possibly have seen this.
  check('the text was scaled without compounding', scaled > 0, `${scaled} text elements`);
  check('the root font size is genuinely untouched',
    Math.abs(await rootPx(page) - 16) < 0.01,
    `root is ${await rootPx(page)}px`);
  check('the rendered text really did grow', await page.evaluate(
    () => {
      const v = document.querySelector('.eta-value');
      return v ? parseFloat(getComputedStyle(v).fontSize) > 40 : false;
    },
  ), `eta-value is ${await page.evaluate(() => document.querySelector('.eta-value') ? getComputedStyle(document.querySelector('.eta-value')).fontSize : '(none)')}`);

  const sawText = await waitForVerdict('large')(page);
  check('a platform that scales rendered text is detected', sawText,
    sawText ? 'this is the case the root-only detector missed'
            : `the app never noticed 1.75x type: data-textsize stayed "${await page.evaluate(() => document.documentElement.dataset.textsize)}"`);
  check('and the large-text layout is applied',
    (await largeLayoutApplied(page)) === 'wrap',
    `eta-bar flex-wrap: ${await largeLayoutApplied(page)}`);
  await page.screenshot({ path: join(SHOTS, 'textscale-rendered.png') });
  await ctx.close();
}

console.log('\ntext scaling by zoom, root untouched');
{
  const ctx = await browser.newContext({
    viewport: { width: 892, height: 412 }, deviceScaleFactor: 1,
    permissions: ['geolocation'], geolocation: { latitude: 51.5215, longitude: -1.4175 },
  });
  const page = await openNavigating(ctx);

  // `zoom` on the body is the closest a browser gets to WebView text zoom: the root's
  // computed size is unchanged and only rendering is scaled.
  await page.evaluate(() => { document.body.style.zoom = '1.75'; });
  check('the root font size is genuinely untouched',
    Math.abs(await rootPx(page) - 16) < 0.01,
    `root is ${await rootPx(page)}px`);

  const sawZoom = await waitForVerdict('large')(page);
  check('a platform that zooms the rendered text is detected', sawZoom,
    sawZoom ? '' : `data-textsize stayed "${await page.evaluate(() => document.documentElement.dataset.textsize)}"`);
  await ctx.close();
}

console.log('\nunscaled again, after scaling');
{
  // The setting can change back while the app is open, and a WebView does not reload.
  const ctx = await browser.newContext({
    viewport: { width: 892, height: 412 }, deviceScaleFactor: 1,
    permissions: ['geolocation'], geolocation: { latitude: 51.5215, longitude: -1.4175 },
  });
  const page = await openNavigating(ctx);
  await page.evaluate(SCALE_TEXT_ONLY(1.75));
  const scaledUp = await waitForVerdict('large')(page);
  check('the setting can be turned up mid-session', scaledUp,
    scaledUp ? '' : `data-textsize stayed "${await page.evaluate(() => document.documentElement.dataset.textsize)}"`);

  await page.evaluate(RESTORE_TEXT);
  const scaledDown = await waitForVerdict('normal')(page);
  check('lowering the setting again turns the large layout back off', scaledDown,
    scaledDown ? '' : `data-textsize stayed "${await page.evaluate(() => document.documentElement.dataset.textsize)}"`);
  check('and normal type really is back',
    await page.evaluate(() => {
      const v = document.querySelector('.eta-value');
      return v ? parseFloat(getComputedStyle(v).fontSize) <= 34 : false;
    }));
  await ctx.close();
}

await browser.close();

console.log('\n=== result ===');
if (failures === 0) {
  console.log('all checks passed');
} else {
  console.log(`${failures} check(s) FAILED`);
  process.exitCode = 1;
}