/**
 * Overlap and reflow measurement, at text sizes the design system never intended.
 *
 * ## Why this exists
 *
 * `html, body` carry `overflow: hidden` and `.app` is `position: fixed`, so
 * nothing in this app scrolls at page level. The list screens compensate with
 * their own scroll containers. **The navigation screen does not** — its ETA bar,
 * maneuver banner, off-route notice, control column and bottom bar are all
 * `position: absolute` against `inset: 0`.
 *
 * That means at a large system font size — a driver who has bumped text because
 * they read the display at a glance and it is not big enough — the banner text
 * grows, the banner grows with it, and it grows *over the control column* and
 * *under the bottom bar*, with no way to scroll any of it into view. The
 * instruction, which is the only thing on that screen, becomes unreadable.
 *
 * `test/screens.mjs` cannot see this: it renders at three viewports with the
 * design system's own sizes, where nothing overlaps.
 *
 * So this drives the navigation screen at 100%, 175% and 200% text — the last
 * two being what Android's largest font settings produce — and asserts that no two
 * pieces of chrome intersect, and that each is inside the viewport.
 *
 *   node tools/reflow.mjs
 */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.REFLOW_BASE ?? 'http://127.0.0.1:8080';
const FIXTURE = join(here, '..', 'test', 'fixture.osm');
const SHOTS = join(here, '..', 'canopy-shots');
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures++;
};

/**
 * Multiply every text element's rendered font size.
 *
 * ## Why not `:root { font-size: … }`
 *
 * Because it does nothing here, and measuring "nothing happens" is how this check
 * would have passed while proving nothing. Every piece of type in this app is
 * set inline from a `T.*` token as an absolute pixel value — `fontSize: '24px'`
 * — so the first version of this harness scaled the root, changed no visible
 * size, and reported "chrome does not overlap itself" three times over. A green
 * result from a stimulus that never arrived.
 *
 * This walks the elements, reads what each one actually resolved to, and writes
 * the scaled value back. That is what the platform's own font setting does to
 * the rendered result, and it is the thing the layout has to survive.
 */

/**
 * The chrome that must never overlap itself.
 *
 * `banner-stack` and `maneuver-banner` are deliberately excluded as a pair: the
 * stack *contains* the banner, so their boxes always intersect and that is the
 * layout working.
 */
const PIECES = [
  ['.eta-bar', 'ETA bar'],
  ['.banner-stack', 'banner stack'],
  ['.offroute-banner', 'off-route notice'],
  ['.nav-controls', 'control column'],
  ['.nav-bottom', 'bottom bar'],
];

/** Runs in the page: find chrome that intersects other chrome, or leaves the viewport. */
const MEASURE = (pieces) => {
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;

  /**
   * The box as the driver can actually see it.
   *
   * `getBoundingClientRect` reports the layout box, which for a child of a
   * scrolling container extends past that container's clip. The off-route notice
   * at 200% is exactly that case: `.banner-stack` has `overflow-y: auto`, so the
   * notice's lower 20px is *clipped* — not painted over the bottom bar — and the
   * probe was reporting it as a collision. It also meant the notice counted as
   * on-screen when it was partly scrolled out of reach, which is the opposite
   * failure and the more dangerous one.
   *
   * Intersecting with every clipping ancestor's box is the honest measurement, and
   * it makes the two claims separable: something clipped by a scroll container is
   * reported as *clipped*, and only genuinely painted overlap counts as overlap.
   */
  const visibleRect = (el) => {
    let r = el.getBoundingClientRect();
    let x0 = r.x, y0 = r.y, x1 = r.right, y1 = r.bottom;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (!/auto|scroll|hidden/.test(cs.overflow + cs.overflowX + cs.overflowY)) continue;
      const pr = p.getBoundingClientRect();
      x0 = Math.max(x0, pr.x); y0 = Math.max(y0, pr.y);
      x1 = Math.min(x1, pr.right); y1 = Math.min(y1, pr.bottom);
    }
    return { x: x0, y: y0, right: x1, bottom: y1, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
  };

  const boxes = [];
  for (const [sel, label] of pieces) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const layout = el.getBoundingClientRect();
    if (layout.width === 0 || layout.height === 0) continue;
    const v = visibleRect(el);
    boxes.push({ label, sel, x: v.x, y: v.y, w: v.w, h: v.h, bottom: v.bottom, right: v.right });
  }
  const overlaps = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      // Containment is layout, not overlap: `.banner-stack` holds the notice and
      // the maneuver card by design.
      const nested =
        (a.sel.includes('banner-stack') && b.sel.includes('banner')) ||
        (b.sel.includes('banner-stack') && a.sel.includes('banner'));
      if (nested) continue;
      const ox = Math.min(a.right, b.right) - Math.max(a.x, b.x);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
      if (ox > 1 && oy > 1) {
        overlaps.push(`${a.label} x ${b.label} (${Math.round(ox)}x${Math.round(oy)}px)`);
      }
    }
  }
  const offscreen = boxes
    .filter((b) => b.right > vw + 1 || b.bottom > vh + 1 || b.x < -1 || b.y < -1)
    .map((b) => `${b.label} (${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.w)}x${Math.round(b.h)} in ${vw}x${vh})`);
  // Any control whose text is clipped by its own box.
  const clipped = [...document.querySelectorAll('.maneuver-instr, .maneuver-dist, .eta-value, .nav-bottom-btn span')]
    .filter((el) => el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2)
    .map((el) => `"${(el.textContent || '').trim().slice(0, 24)}"`);
  /**
   * Content pushed out of a scrolling container.
   *
   * Distinct from the clipping above: that is a control too small for its own text,
   * this is a card scrolled out of the region the driver can see. Both mean "not
   * readable", and reporting them as one number hides which is which.
   */
  const scrolledOut = [];
  for (const [sel, label] of pieces) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const layout = el.getBoundingClientRect();
    const vis = visibleRect(el);
    if (layout.height > 0 && vis.h + 2 < layout.height) {
      scrolledOut.push(`${label} (${Math.round(layout.height - vis.h)}px out of view)`);
    }
  }
  return { overlaps, offscreen, clipped, scrolledOut, count: boxes.length };
};

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });

for (const zoom of [1, 1.75, 2]) {
  const ctx = await browser.newContext({
    viewport: { width: 892, height: 412 },
    deviceScaleFactor: 1,
    permissions: ['geolocation'],
    geolocation: { latitude: 51.5215, longitude: -1.4175 },
    // `reducedMotion` is irrelevant here; what matters is a text size the design
    // system never contemplated.
    reducedMotion: 'no-preference',
  });
  const page = await ctx.newPage();
  console.log(`\n=== text ${Math.round(zoom * 100)}%  (892x412, landscape phone) ===`);

  await page.goto(BASE, { waitUntil: 'networkidle' });
  /*
   * Scale the way the platform does: the root font size, set *before* load so
   * `textscale.ts` measures it on mount rather than polling into it.
   *
   * Two earlier attempts, both of which measured nothing:
   *
   *   - `:root { font-size: … }` added *after* the app had rendered. Every token
   *     emits an absolute `px`, so no visible size changed and the run reported
   *     "chrome does not overlap itself" three times over.
   *   - Writing a scaled `font-size` onto each text element directly. That *did*
   *     scale, and it found the collision — but it bypassed the app's own
   *     detection, so it was testing a condition the app had no chance to notice.
   *
   * Setting the root size through Playwright's `addInitScript` is what an Android
   * WebView does when the system font setting changes, and it exercises the real
   * path: `textscale.ts` measures the resolved root, sets `data-textsize`, and
   * the stylesheet reflows.
   */
  const importBtn = await page.$('button:has-text("Import .osm file")');
  if (importBtn) await importBtn.click();
  await page.waitForTimeout(400);
  const input = await page.$('input[type=file]');
  if (input) {
    await input.setInputFiles(FIXTURE);
    await page.waitForFunction(
      () => /[\d,]+ routable ways/.test(document.body.innerText),
      { timeout: 40000 },
    );
  }

  await page.click('.search-field');
  await page.waitForTimeout(500);
  await page.fill('.inline-search input', 'Elbow');
  await page.waitForTimeout(1200);
  const row = await page.$('.result-row');
  if (row) {
    await row.click();
    await page.waitForTimeout(3000);
    const start = await page.$('button.primary-btn');
    if (start) {
      await start.click();
      await page.waitForTimeout(2500);
    }
  }

  // Scale the way the app experiences a large font setting, and mark the document
  // the way `textscale.ts` marks it — the two halves of the same mechanism.
  //
  // Setting the root size from an init script did not stick in this Chromium
  // build (the inline property came back empty), so the root half is simulated by
  // setting the attribute the app would have set. The *per-element* half is real:
  // it is exactly what happens to a `font-size` token when the platform scales
  // text, and it is what the reflow below has to survive.
  const scaled = await page.evaluate(({ factor, threshold }) => {
    // Set the *root* size, then let the app's own detection mark the document.
    //
    // Setting `data-textsize` directly does not work: `textscale.ts` re-measures
    // every two seconds and correctly resets it to "normal", because the root
    // size really was 16px. Forcing the attribute fights the app and measures a
    // state it would never be in.
    //
    // So this reproduces the platform's actual mechanism — the root font size —
    // after load, where it is known to stick, and then waits for the app to notice
    // on its own. The reflow under test is then reached the way it is reached in
    // production.
    if (factor > 1) {
      document.documentElement.style.setProperty('font-size', `${16 * factor}px`, 'important');
    }
    let n = 0;
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const ownsText = [...el.childNodes].some((x) => x.nodeType === 3 && x.textContent.trim());
      if (!ownsText) continue;
      const px = parseFloat(cs.fontSize);
      if (!Number.isFinite(px) || px === 0) continue;
      el.style.setProperty('font-size', `${(px * factor).toFixed(2)}px`, 'important');
      n++;
    }
    return { n, threshold };
  }, { factor: zoom, threshold: 20 });
  // Wait for the app's own detector to see the new root size.
  //
  // The condition is the *attribute*, not the root size. Both of the original
  // alternatives measured a state the app is never in: waiting only for the root
  // size is satisfied the instant the probe writes it, before the app has run its
  // detection, so the reflow was then measured against `data-textsize="normal"` —
  // a layout the app is in for at most one poll interval and never on a device
  // whose font size is genuinely large. The app notices on `resize` or within its
  // 2 s poll, so the budget is generous on purpose.
  try {
    await page.waitForFunction(
      (large) => (document.documentElement.dataset.textsize === 'large') === large,
      zoom > 1,
      // Above the 2 s poll interval plus slack, because that is the slowest path
      // the app has to notice.
      { timeout: 6000, polling: 200 },
    );
  } catch { /* reported below */ }
  await page.waitForTimeout(600);
  const state = await page.evaluate(() => document.documentElement.dataset.textsize ?? '(unset)');
  console.log(`  root ${await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)}, scaled ${scaled.n} tokens, data-textsize="${state}"`);

  const applied = await page.evaluate(() => {
    const el = document.querySelector('.banner-stack');
    if (!el) return { found: false };
    const cs = getComputedStyle(el);
    /**
     * The bound the stack uses versus the bar it has to clear.
     *
     * `--navbot` is a fixed token while `.nav-bottom` grows when its labels wrap,
     * so at large text the two drift apart and the stack's lower bound ends up
     * *inside* the bar. Reported so that is visible rather than inferred.
     */
    const bar = document.querySelector('.nav-bottom');
    const barBox = bar?.getBoundingClientRect();
    const stackBox = el.getBoundingClientRect();
    const boundPx = Number.parseFloat(cs.bottom);
    return {
      found: true,
      attr: document.documentElement.dataset.textsize,
      overflowY: cs.overflowY,
      bottom: cs.bottom,
      height: Math.round(stackBox.height),
      navbot: getComputedStyle(document.documentElement).getPropertyValue('--navbot').trim(),
      barTop: barBox ? Math.round(barBox.top) : null,
      // The bound the stack was told to keep, and how far it actually kept it.
      // A large difference means the token is not describing the bar it names.
      boundPx: Number.isFinite(boundPx) ? Math.round(boundPx) : null,
      // Positive means the stack reaches below the top of the bar.
      overlapBy: barBox ? Math.round(stackBox.bottom - barBox.top) : null,
    };
  });
  console.log('  banner-stack:', JSON.stringify(applied));

  const m = await page.evaluate(MEASURE, PIECES);
  await page.screenshot({ path: join(SHOTS, `reflow-${Math.round(zoom * 100)}pct.png`) });

  if (m.count === 0) {
    check(`text ${Math.round(zoom * 100)}%: the navigation screen rendered`, false, 'no chrome found');
  } else {
    check(`text ${Math.round(zoom * 100)}%: chrome does not overlap itself`,
      m.overlaps.length === 0, m.overlaps.join('; ') || `${m.count} pieces, clear`);
    check(`text ${Math.round(zoom * 100)}%: chrome stays on screen`,
      m.offscreen.length === 0, m.offscreen.join('; ') || 'all within the viewport');
    check(`text ${Math.round(zoom * 100)}%: no instruction text is clipped`,
      m.clipped.length === 0, m.clipped.join(', ') || 'none clipped');
    // Scrollable is not the same as readable. Reported separately, because a card
    // scrolled out of the visible region is a different defect from a control too
    // small for its own text, and folding them into one number hid this one.
    check(`text ${Math.round(zoom * 100)}%: nothing is scrolled out of reach`,
      m.scrolledOut.length === 0, m.scrolledOut.join('; ') || 'all in view');
  }
  await ctx.close();
}

console.log('\n=== result ===');
console.log(failures === 0 ? 'all checks passed' : `${failures} check(s) failed`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);