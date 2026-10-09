/**
 * Measures the ETA bar's two numbers and its two buttons at every viewport shape.
 *
 * The question it answers is whether both numbers are legible *and* both buttons
 * are fully on screen — the two failure modes of this row are opposite, and
 * fixing one by shrinking the other is how a navigation screen loses the one
 * number a driver needs.
 *
 *   node tools/eta-check.mjs
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.PROBE_BASE ?? 'http://127.0.0.1:5173';
const FIXTURE = join(here, '..', 'test', 'fixture.osm');

const VIEWPORTS = [
  { width: 320, height: 568, n: 'tiny  ' },
  { width: 412, height: 915, n: 'phone ' },
  { width: 892, height: 412, n: 'land  ' },
  { width: 1280, height: 720, n: 'head  ' },
];

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
let bad = 0;

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    permissions: ['geolocation'],
    geolocation: { latitude: 51.5215, longitude: -1.4175 },
    locale: 'en-GB',
  });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1400);

  const click = async (sel, wait = 800) => {
    const el = await page.$(sel);
    if (!el) return false;
    await el.click().catch(() => {});
    await page.waitForTimeout(wait);
    return true;
  };

  if (await click('button:has-text("Import .osm file")', 350)) {
    const input = await page.$('input[type=file]');
    if (input) {
      await input.setInputFiles(FIXTURE);
      await page.waitForFunction(() => !document.body.innerText.includes('Parsing'), { timeout: 40000 });
      await page.waitForTimeout(800);
    }
  }
  if (await click('.search-field', 300)) {
    const si = await page.$('.inline-search input');
    if (si) { await si.fill('Elbow'); await page.waitForTimeout(700); }
    if (await click('.result-row', 2300)) {
      if (await click('button.primary-btn', 2100)) {
        const r = await page.evaluate(() => {
          const eta = document.querySelector('.eta-bar');
          if (!eta) return null;
          const vals = [...document.querySelectorAll('.eta-value')].map((e) => ({
            text: e.textContent,
            clipped: e.scrollWidth > e.clientWidth,
            need: e.scrollWidth,
            got: e.clientWidth,
          }));
          const btns = [...eta.querySelectorAll('.icon-btn')].map((e) => {
            const b = e.getBoundingClientRect();
            return { label: e.getAttribute('aria-label'), right: Math.round(b.right) };
          });
          return { overflow: eta.scrollWidth - eta.clientWidth, vw: innerWidth, vals, btns };
        });
        if (!r) {
          console.log(`${vp.n} ${vp.width}x${vp.height}  (not navigating)`);
        } else {
          const clipped = r.vals.filter((v) => v.clipped);
          const offscreen = r.btns.filter((b) => b.right > r.vw + 1);
          const problems = [
            ...(r.overflow > 0 ? [`bar overflows by ${r.overflow}px`] : []),
            ...clipped.map((v) => `"${v.text}" clipped (${v.need} into ${v.got})`),
            ...offscreen.map((b) => `${b.label} runs ${b.right - r.vw}px off the right edge`),
          ];
          if (problems.length) bad++;
          console.log(
            `${problems.length ? 'FAIL' : 'ok  '} ${vp.n} ${vp.width}x${vp.height}  ` +
            `values: ${r.vals.map((v) => `"${v.text}"`).join(' + ')}` +
            (problems.length ? `\n       ${problems.join('\n       ')}` : ''),
          );
        }
      }
    }
  }
  await ctx.close();
}
await browser.close();
console.log(bad ? `\n${bad} viewport(s) failing` : '\nall viewports ok');