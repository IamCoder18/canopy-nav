/**
 * Confirms one specific defect is gone, by sampling composited pixels on the
 * *deployed* site rather than a local build.
 *
 * The bug: `.quick-tile:hover` declared a translucent fill, which *replaced* the
 * tile's opaque one, so hovering composited the tile into the near-white basemap
 * underneath it. The declaration still said `rgba(255,255,255,0.06)`; only the
 * rendered pixel told the truth, which is why this samples pixels.
 *
 *   PROBE_BASE=https://canopydev.aaravlabs.com node tools/verify-hover.mjs
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const BASE = process.env.PROBE_BASE ?? 'http://127.0.0.1:8137';

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  permissions: ['geolocation'],
  geolocation: { latitude: 51.5215, longitude: -1.4175 },
  locale: 'en-GB',
  /*
   * `httpCredentials`, not `extraHTTPHeaders: { Authorization }` — see
   * `tools/regions-check.mjs` for why that matters. `extraHTTPHeaders` would
   * attach the credential to every cross-origin request the page makes, leaking
   * it to third parties and making those requests non-simple.
   */
  ...(process.env.PROBE_USER
    ? { httpCredentials: { username: process.env.PROBE_USER, password: process.env.PROBE_PASS ?? '' } }
    : {}),
});
const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

/** Sample the composited pixel at one point. */
async function pixel(x, y) {
  const buf = await page.screenshot({ clip: { x, y, width: 1, height: 1 } });
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 1; c.height = 1;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]];
  }, buf.toString('base64'));
}

const tiles = await page.$$('.quick-tile');
console.log(`probing ${tiles.length} launcher tiles on ${BASE}\n`);

let failures = 0;
for (let i = 0; i < tiles.length; i++) {
  const info = await tiles[i].evaluate((e) => {
    const r = e.getBoundingClientRect();
    // A point on the tile's own surface, not on a descendant glyph.
    let p = null;
    for (let fy = 0.14; fy <= 0.86 && !p; fy += 0.18) {
      for (let fx = 0.14; fx <= 0.86; fx += 0.18) {
        const x = r.x + r.width * fx, y = r.y + r.height * fy;
        if (document.elementFromPoint(x, y) === e) { p = { x: Math.round(x), y: Math.round(y) }; break; }
      }
    }
    return p && {
      ...p,
      label: e.textContent.trim().replace(/\s+/g, ' ').slice(0, 14),
      restBg: getComputedStyle(e).backgroundColor,
    };
  });
  if (!info) continue;

  await page.mouse.move(1, 1);
  await page.waitForTimeout(120);
  const rest = await pixel(info.x, info.y);
  await page.mouse.move(info.x, info.y);
  await page.waitForTimeout(220);
  const hover = await pixel(info.x, info.y);
  const hoverDeclared = await page.evaluate(
    ([x, y]) => getComputedStyle(document.elementFromPoint(x, y)).backgroundColor,
    [info.x, info.y],
  );

  const restOpaque = !/rgba\(.*0\.\d+\)/.test(info.restBg);
  const hoverTranslucent = /rgba\(.*0\.\d+\)/.test(hoverDeclared);
  const turnedWhite = (rest[0] + hover[0]) / 2 > 150;
  const changed = Math.abs(rest[0] - hover[0]) + Math.abs(rest[1] - hover[1]) + Math.abs(rest[2] - hover[2]);

  // Two things must hold: the surface must survive the hover, and it must
  // actually respond to one.
  const survives = !(restOpaque && hoverTranslucent) && !turnedWhite;
  const responds = changed > 6;
  const ok = survives && responds;
  if (!ok) failures++;

  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'} "${info.label}"` +
    `\n        at rest   rgb(${rest})   (${info.restBg})` +
    `\n        on hover  rgb(${hover})   (${hoverDeclared})   changed by ${changed}` +
    `\n        surface survives hover: ${survives ? 'yes' : 'NO — dissolves into the basemap'}` +
    `\n        responds to pointer:    ${responds ? 'yes' : 'NO — no visible feedback'}`,
  );
}

await browser.close();
console.log(failures ? `\n${failures} tile(s) still defective` : '\nall launcher tiles correct');
process.exit(failures ? 1 : 0);