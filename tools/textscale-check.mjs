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
 * Harness failures, kept apart from product failures.
 *
 * A gate that cannot say *which* of the two went wrong teaches people to re-run it, which
 * is the fate §12.7 predicts for `tools/reflow.mjs` and the reason that one is
 * deliberately not in `npm run check`. This one is a gate, so it has to be trustworthy:
 * a missed precondition is reported once, by name, and the checks that depended on it are
 * skipped rather than reported as failures of the app.
 */
const harnessFailures = [];
let currentBlockIsVoid = false;

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

/**
 * Did we actually reach the navigation screen?
 *
 * Measured, because the gate was flaky: **3 of 12 runs failed**, with
 * `eta-value is (none)` and `eta-bar flex-wrap: (no navigation screen)` — the checks
 * that read those elements reporting that they are absent.
 *
 * The cause is that `openNavigating` drove the app with a chain of fixed
 * `waitForTimeout`s and best-effort `.catch(() => {})` on every step, then returned
 * whatever page it had. If the search box, the result row or the Start button had not
 * appeared yet, it returned a page that was *not* navigating, and the three checks
 * below it reported the absence of the navigation screen as though the app had failed to
 * apply its large-text layout. A harness failure wearing a product failure's name is
 * worse than no check: it says the thing under test is broken when the thing under test
 * was never reached.
 *
 * So the harness now *asserts* its own precondition, and a failure to meet it is
 * reported once, as a harness failure, separately from the product checks. That is
 * §13.7's subject — a harness failure and a product failure must be distinguishable from
 * outside — and this file cites §13.7 while breaking it.
 */
const ON_NAVIGATION = '.eta-bar, .eta-value';

async function waitForNavigationScreen(page, timeout = 20000) {
  try {
    await page.waitForSelector(ON_NAVIGATION, { timeout, state: 'attached' });
    // Attached is not enough: both elements have to be laid out, or a computed style
    // read on a zero-size box is not the value the gate means to compare.
    await page.waitForFunction(
      () => [...document.querySelectorAll('.eta-bar, .eta-value')]
        .some((el) => el.getBoundingClientRect().width > 0),
      undefined,
      { timeout, polling: 200 },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Load the app onto the navigation screen, where the large-text layout matters.
 *
 * Every wait below is a *wait*, not a sleep. The original used fixed
 * `waitForTimeout`s — 400 ms after opening search, 1000 ms after typing, 2000 ms after
 * picking a result — and that is why the gate failed 3 of 12 runs: on a loaded machine
 * the search screen was not open yet at 400 ms, and the run continued down a path that
 * silently did nothing.
 *
 * Each step now waits for the thing it needs and reports **which** step ran out, because
 * "the navigation screen was not reached" is a symptom and "the result row never appeared
 * for 'Elbow'" is a diagnosis. A harness failure you cannot localise gets re-run instead
 * of read.
 */
async function openNavigating(ctx, label) {
  const page = await ctx.newPage();
  const step = async (what, fn) => {
    try {
      await fn();
      return true;
    } catch {
      harnessFailures.push(`${label}: ${what}`);
      return false;
    }
  };

  await step('the app never loaded', () => page.goto(BASE, { waitUntil: 'networkidle' }));
  const input = await page.$('input[type=file]');
  if (input) {
    await step('the fixture never imported', async () => {
      await input.setInputFiles(join(ROOT, 'test', 'fixture.osm'));
      await page.waitForFunction(
        () => /[\d,]+ routable ways/.test(document.body.innerText),
        undefined,
        { timeout: 40000 },
      );
    });
  }

  await step('the search screen never opened', async () => {
    await page.click('.search-field');
    await page.waitForSelector('.inline-search input', { timeout: 10000 });
  });
  if (!harnessFailures.length) {
    await step(`no result row appeared for "Elbow"`, async () => {
      await page.fill('.inline-search input', 'Elbow');
      await page.waitForSelector('.result-row', { timeout: 10000 });
    });
    await step('the preview never offered a Start button', async () => {
      await page.click('.result-row');
      await page.waitForSelector('button.primary-btn', { timeout: 10000 });
    });
    await step('navigation never started', async () => {
      await page.click('button.primary-btn');
    });
  }

  // The assertion the sleeps were standing in for. Each step above is now checked, so
  // this only has to answer one question: are we on the navigation screen?
  if (!harnessFailures.length && !(await waitForNavigationScreen(page))) {
    harnessFailures.push(`${label}: Start was pressed but no navigation chrome appeared`);
  }
  return page;
}

const rootPx = (page) => page.evaluate(
  () => parseFloat(getComputedStyle(document.documentElement).fontSize),
);

/**
 * Has the large-text layout actually taken effect?
 *
 * `(absent)` rather than `(no navigation screen)`: the latter reads as a diagnosis, and
 * the two things it could mean — the app did not apply the layout, or the harness never
 * got to the screen — are exactly the distinction this file now enforces.
 */
const largeLayoutApplied = (page) => page.evaluate(() => {
  const bar = document.querySelector('.eta-bar');
  return bar ? getComputedStyle(bar).getPropertyValue('flex-wrap').trim() : '(absent)';
});

/**
 * A check that is meaningless unless the harness reached the navigation screen.
 *
 * **Applied to every check in a block, not just the three that read navigation chrome.**
 * An earlier version used it only for those three, which left nine others reporting a
 * harness miss as a product failure — §2.3's own defect, in the file §2.3 says fixed it.
 * So each block declares which checks are independent of the screen, and everything else
 * goes through this.
 *
 * The exemptions are two per block and are genuinely independent: the detector's verdict is
 * a `data-` attribute on `<html>`, and the root font size is read off the document, neither
 * of which needs the navigation screen to exist.
 */
const SCREEN_INDEPENDENT = new Set([
  'an unscaled app is marked normal',
  'a platform that enlarges the root font size is detected',
  'a platform that scales rendered text is detected',
  'a platform that zooms the rendered text is detected',
  'the setting can be turned up mid-session',
  'lowering the setting again turns the large layout back off',
  'the text was scaled without compounding',
  'the root font size is genuinely untouched',
]);

const navCheck = (name, ok, detail = '') => {
  if (currentBlockIsVoid && !SCREEN_INDEPENDENT.has(name)) {
    console.log(`  SKIP  ${name} - the navigation screen was never reached`);
    return;
  }
  check(name, ok, detail);
};

/**
 * Open a fresh context and drive it to the navigation screen, recording whether the
 * harness managed it. Returns the context so the block can close it — an earlier draft
 * returned only the page and left every block holding a `ctx` it could no longer see.
 */
const newNavContext = async (browser, label) => {
  const ctx = await browser.newContext({
    viewport: { width: 892, height: 412 }, deviceScaleFactor: 1,
    permissions: ['geolocation'], geolocation: { latitude: 51.5215, longitude: -1.4175 },
  });
  const before = harnessFailures.length;
  const page = await openNavigating(ctx, label);
  currentBlockIsVoid = harnessFailures.length > before;
  return { ctx, page };
};

console.log('\ntext scaling the root font size only');
{
  const { ctx, page } = await newNavContext(browser, 'root font size');
    navCheck('an unscaled app is marked normal', await page.evaluate(
    () => document.documentElement.dataset.textsize === 'normal',
  ));

  await page.evaluate(() => {
    document.documentElement.style.setProperty('font-size', '28px', 'important');
  });
  const sawRoot = await waitForVerdict('large')(page);
    navCheck('a platform that enlarges the root font size is detected', sawRoot,
    sawRoot ? '' : `data-textsize stayed "${await page.evaluate(() => document.documentElement.dataset.textsize)}"`);
    navCheck('and the large-text layout is applied',
      (await largeLayoutApplied(page)) === 'wrap',
      `eta-bar flex-wrap: ${await largeLayoutApplied(page)}`);
  await page.screenshot({ path: join(SHOTS, 'textscale-root.png') });
  await ctx.close();
}

console.log('\ntext scaling the rendered text, root untouched');
{
  const { ctx, page } = await newNavContext(browser, 'rendered text');

  const scaled = await page.evaluate(SCALE_TEXT_ONLY(1.75));
  // The precondition this whole block exists for: the root really is still 16px, so
  // the root-only detector could not possibly have seen this.
    navCheck('the text was scaled without compounding', scaled > 0, `${scaled} text elements`);
    navCheck('the root font size is genuinely untouched',
    Math.abs(await rootPx(page) - 16) < 0.01,
    `root is ${await rootPx(page)}px`);
  navCheck('the rendered text really did grow', await page.evaluate(
    () => {
      const v = document.querySelector('.eta-value');
      return v ? parseFloat(getComputedStyle(v).fontSize) > 40 : false;
    },
  ), `eta-value is ${await page.evaluate(() => document.querySelector('.eta-value') ? getComputedStyle(document.querySelector('.eta-value')).fontSize : '(none)')}`);

  const sawText = await waitForVerdict('large')(page);
    navCheck('a platform that scales rendered text is detected', sawText,
    sawText ? 'this is the case the root-only detector missed'
            : `the app never noticed 1.75x type: data-textsize stayed "${await page.evaluate(() => document.documentElement.dataset.textsize)}"`);
  navCheck('and the large-text layout is applied',
    (await largeLayoutApplied(page)) === 'wrap',
    `eta-bar flex-wrap: ${await largeLayoutApplied(page)}`);
  await page.screenshot({ path: join(SHOTS, 'textscale-rendered.png') });
  await ctx.close();
}

console.log('\ntext scaling by zoom, root untouched');
{
  const { ctx, page } = await newNavContext(browser, 'zoom');

  // `zoom` on the body is the closest a browser gets to WebView text zoom: the root's
  // computed size is unchanged and only rendering is scaled.
  await page.evaluate(() => { document.body.style.zoom = '1.75'; });
    navCheck('the root font size is genuinely untouched',
    Math.abs(await rootPx(page) - 16) < 0.01,
    `root is ${await rootPx(page)}px`);

  const sawZoom = await waitForVerdict('large')(page);
    navCheck('a platform that zooms the rendered text is detected', sawZoom,
    sawZoom ? '' : `data-textsize stayed "${await page.evaluate(() => document.documentElement.dataset.textsize)}"`);
  await ctx.close();
}

console.log('\nunscaled again, after scaling');
{
  // The setting can change back while the app is open, and a WebView does not reload.
  const { ctx, page } = await newNavContext(browser, 'scaled back down');
  await page.evaluate(SCALE_TEXT_ONLY(1.75));
  const scaledUp = await waitForVerdict('large')(page);
    navCheck('the setting can be turned up mid-session', scaledUp,
    scaledUp ? '' : `data-textsize stayed "${await page.evaluate(() => document.documentElement.dataset.textsize)}"`);

  await page.evaluate(RESTORE_TEXT);
  const scaledDown = await waitForVerdict('normal')(page);
    navCheck('lowering the setting again turns the large layout back off', scaledDown,
    scaledDown ? '' : `data-textsize stayed "${await page.evaluate(() => document.documentElement.dataset.textsize)}"`);
  navCheck('and normal type really is back',
    await page.evaluate(() => {
      const v = document.querySelector('.eta-value');
      return v ? parseFloat(getComputedStyle(v).fontSize) <= 34 : false;
    }));
  await ctx.close();
}

await browser.close();

console.log('\n=== result ===');
// Harness failures first and unmissably: if the precondition was missed, the product
// checks below it were never run, and reporting "all checks passed" for that would be
// the worst outcome available — a green gate that measured nothing.
if (harnessFailures.length) {
  console.log(`${harnessFailures.length} HARNESS failure(s) - the app was not exercised at all:`);
  for (const f of harnessFailures) console.log(`  HARNESS  ${f}`);
}
if (failures === 0 && harnessFailures.length === 0) {
  console.log('all checks passed');
} else {
  if (failures) console.log(`${failures} check(s) FAILED`);
  process.exitCode = 1;
}