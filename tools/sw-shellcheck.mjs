/**
 * Does a captive portal break offline boot?
 *
 * The defect this reproduces cannot be seen by the unit suite or by reading code:
 * it needs a network that answers navigations with a login page, a service worker
 * that has already precached the real shell, and then the network removed. Run it
 * and it reports three numbers:
 *
 *   1. what the worker precached on first load
 *   2. what the page shows while the portal is answering
 *   3. whether the app still boots with the network off
 *
 * Step 3 is the one that matters. Before the fix it printed
 * `looks like a portal login page: true` and zero launcher tiles: the portal's
 * HTML had become the cached shell, so the app could never open offline again,
 * with nothing the user could do about it from inside an app that never started.
 *
 * A real browser and a real service worker, because the defect is in the
 * interaction between the two. Everything it needs is built into `dist/`, so run
 * `npm run build` first. It starts its own server on port 4321 and exits with a
 * non-zero status if the app does not boot offline.
 *
 *   node tools/sw-shellcheck.mjs
 */
// End-to-end proof: a captive-portal HTML body must not become the cached shell,
// and the real shell must still boot offline. Runs a real browser + real SW.
import { createRequire } from 'node:module';
const require = createRequire('/home/aarav/apps/canopy/test/');
const { chromium } = require('playwright-core');
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = '/home/aarav/apps/canopy/dist';
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.svg':'image/svg+xml', '.webmanifest':'application/manifest+json' };

// A portal that answers EVERY navigation with a login page, 200 text/html.
let portalMode = false;
const server = createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (portalMode && (req.headers.accept || '').includes('text/html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>Sign in to Guest WiFi</title></head><body><h1>Login</h1><form action="/login"><input name="room"><button>Connect</button></form></body></html>');
    return;
  }
  const p = join(ROOT, url === '/' ? 'index.html' : url);
  if (!existsSync(p)) { res.writeHead(404); res.end('nope'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[extname(p)] || 'application/octet-stream' });
  res.end(readFileSync(p));
});
await new Promise(r => server.listen(4321, r));
const BASE = 'http://localhost:4321';

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext();
const page = await ctx.newPage();

const cacheState = async () => page.evaluate(async () => {
  const names = await caches.keys();
  const out = {};
  for (const n of names) {
    const c = await caches.open(n);
    out[n] = (await c.keys()).map(r => new URL(r.url).pathname).sort();
  }
  return out;
});

// 1. Online: the app boots and precaches the real shell.
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
console.log('1. cached after first load:', JSON.stringify(await cacheState()));

// 2. A captive portal takes over. The app must still be able to boot offline.
portalMode = true;
await page.reload({ waitUntil: 'networkidle' }).catch(() => {});
await page.waitForTimeout(2000);
console.log('2. online under a portal, page shows:', JSON.stringify((await page.evaluate(() => document.body.innerText)).slice(0, 60)));

// 3. Network off. Does the app boot, or does the portal own the shell?
await ctx.setOffline(true);
const p2 = await ctx.newPage();
await p2.goto(BASE, { waitUntil: 'domcontentloaded' }).catch(e => console.log('goto threw:', e.message));
await p2.waitForTimeout(2500);
const offlineText = await p2.evaluate(() => document.body.innerText);
const tiles = await p2.locator('.quick-tile').count();
console.log('3. OFFLINE launcher tiles:', tiles);
console.log('   offline text head:', JSON.stringify(offlineText.slice(0, 120)));
console.log('   looks like a portal login page:', /Guest WiFi|WiFi|Login|Connect/i.test(offlineText));
console.log('   cached shell now:', JSON.stringify(await cacheState()));

const pass = tiles > 0 && !/Guest WiFi|WiFi|Login|Connect/i.test(offlineText);
console.log(pass
  ? '\nPASS  the app still boots offline after a captive portal answered navigations'
  : '\nFAIL  the captive portal owns the cached shell: the app can never open offline again');

await browser.close();
server.close();
process.exit(pass ? 0 : 1);
