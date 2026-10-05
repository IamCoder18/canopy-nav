/**
 * Throwaway diagnostic: import the fixture, search, click a result, and print
 * what the page actually says plus any console/page errors. Not a test — this
 * exists so a failing e2e check can be read rather than guessed at.
 */
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, server: { port: 5199 }, logLevel: 'error' });
await server.listen();

const browser = await chromium.launch();
// Must match test/e2e.mjs: the fixture sits near Edinburgh, and without a real fix
// inside its bounds the app falls back to a simulated Calgary position, which is
// (correctly) a cross-ocean route the offline engine refuses.
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  permissions: ['geolocation'],
  geolocation: { latitude: 51.503, longitude: -1.399, accuracy: 8 },
});
const page = await context.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}\n${e.stack}`));

await page.goto('http://localhost:5199/', { waitUntil: 'networkidle' });
await page.click('text=Import .osm file');
await page.waitForTimeout(600);
const input = await page.$('input[type=file]');
await input.setInputFiles(join(root, 'test/fixture.osm'));
await page.waitForFunction(
  () => !document.body.innerText.includes('Parsing') && !document.body.innerText.includes('Building graph'),
  { timeout: 30000 },
);
await page.waitForTimeout(1500);

await page.click('.search-field');
await page.waitForTimeout(400);
await page.fill('.inline-search input', 'Elbow');
await page.waitForTimeout(900);
const results = await page.$$('.result-row');
console.log('results:', results.length);
await page.click('.result-row');
await page.waitForTimeout(2500);

console.log('\n--- PAGE TEXT ---\n' + (await page.evaluate(() => document.body.innerText)));
console.log('\n--- ERRORS ---');
for (const e of errors) console.log(e);
if (!errors.length) console.log('(none)');

await browser.close();
await server.close();
