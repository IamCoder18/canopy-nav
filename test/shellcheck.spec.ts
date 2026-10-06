/**
 * The service worker's shell check.
 *
 * The bug this pins is the worst kind this project has: the app's central claim
 * is that it works with no network, and the one thing that could break that claim
 * *permanently* was an unhandled network state.
 *
 * A captive portal answers a navigation with HTTP 200 and `text/html` — a login
 * form. The worker's fetch handler cached **any** 200 over `./index.html`. From
 * that moment the portal's login page was the app shell: every later offline load
 * served it, the app never opened, and there was nothing the user could do about
 * it from inside the app, because the app was not running. Strictly worse than
 * the `ERR_INTERNET_DISCONNECTED` page the worker exists to prevent.
 *
 * Verified by reading the fetch handler rather than by unplugging a network,
 * which is why the predicate is a plain function with a probe object: no browser,
 * no worker, no timing.
 */

import { describe, it, expect } from 'vitest';
import { looksLikeAppShell, type ShellProbe } from '../src/shellcheck';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGIN = 'https://localhost';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The built document, which is the shape the check has to accept. */
const REAL_HTML = readFileSync(join(ROOT, 'dist', 'index.html'), 'utf8');

function probe(patch: Partial<ShellProbe> = {}): ShellProbe {
  return {
    origin: ORIGIN,
    url: `${ORIGIN}/`,
    status: 200,
    redirected: false,
    contentType: 'text/html; charset=utf-8',
    body: REAL_HTML,
    ...patch,
  };
}

/** A hotel captive portal: HTTP 200, HTML, a login form, same URL. */
const CAPTIVE_PORTAL = `<!doctype html>
<html><head><title>Sign in to Guest WiFi</title></head>
<body><form action="/login" method="post">
  <h1>Welcome</h1><label>Room number<input name="room"></label>
  <button>Connect</button>
</form>
<script>window.location='/portal';</script>
</body></html>`;

/** A carrier interstitial: HTML with a module script, but no mount point. */
const CARRIER_PAGE = `<!doctype html><html><head><title>Session expired</title></head>
<body><p>Your session has expired.</p><script type="module" src="/reauth.js"></script></body></html>`;

describe('looksLikeAppShell', () => {
  it('accepts the real built document', () => {
    expect(looksLikeAppShell(probe())).toBe(true);
  });

  it('rejects a captive portal login page served with 200', () => {
    // The exact shape that broke offline boot permanently: correct status,
    // correct content type, same origin, same URL.
    expect(looksLikeAppShell(probe({ body: CAPTIVE_PORTAL }))).toBe(false);
  });

  it('rejects a carrier interstitial that does have a module script', () => {
    // Proves the `#root` half is doing work: this passes a module-script-only
    // check, and a modern page would pass it too.
    expect(/type=["']module["']/.test(CARRIER_PAGE)).toBe(true);
    expect(looksLikeAppShell(probe({ body: CARRIER_PAGE }))).toBe(false);
  });

  it('rejects a page that has the mount point but no module script', () => {
    // The other half: `#root` alone is a common element name.
    expect(looksLikeAppShell(probe({
      body: '<html><body><div id="root"></div><p>Under maintenance</p></body></html>',
    }))).toBe(false);
  });

  it('rejects a redirect that left the origin', () => {
    expect(looksLikeAppShell(probe({
      redirected: true,
      url: 'https://wifi.captive-portal.test/login',
      // The body is the *real* app document: the redirect is the only evidence,
      // which is exactly why it has to be checked rather than trusted away.
      body: REAL_HTML,
    }))).toBe(false);
  });

  it('accepts a redirect that stayed on the origin', () => {
    // `/` -> `/index.html` is a normal same-origin redirect and must not be
    // treated as a captive portal.
    expect(looksLikeAppShell(probe({
      redirected: true,
      url: `${ORIGIN}/index.html`,
    }))).toBe(true);
  });

  it('rejects a non-HTML content type', () => {
    // A mislabelled response must not be cached as the document.
    expect(looksLikeAppShell(probe({ contentType: 'application/json' }))).toBe(false);
    expect(looksLikeAppShell(probe({ contentType: null }))).toBe(false);
  });

  it('accepts a content type with parameters and odd casing', () => {
    expect(looksLikeAppShell(probe({ contentType: 'TEXT/HTML;charset=UTF-8' }))).toBe(true);
  });

  it('rejects a non-2xx status even with a valid-looking body', () => {
    // A 404 page that happens to contain a `#root` div, or a portal answering 503.
    for (const status of [301, 400, 404, 500, 503]) {
      expect(looksLikeAppShell(probe({ status }))).toBe(false);
    }
  });

  it('rejects an opaque response', () => {
    // `no-cors` responses report status 0 with no readable body. Must fail closed.
    expect(looksLikeAppShell(probe({ status: 0, contentType: null, body: '' }))).toBe(false);
  });

  it('rejects an unparseable redirect URL rather than throwing', () => {
    expect(looksLikeAppShell(probe({ redirected: true, url: 'not a url' }))).toBe(false);
  });

  it('accepts attribute reordering and either quote style', () => {
    // The build could reasonably emit either, and a check that only accepts one
    // would silently stop precaching on the next toolchain bump — the failure
    // being invisible until somebody opened the app with no network.
    const shapes = [
      '<div class="x" id=\'root\'></div>',
      '<div id=\'root\' class="x"></div>',
      '<div   id="root"  ></div>',
      '<div id="root"></div>',
    ];
    for (const mount of shapes) {
      expect(looksLikeAppShell(probe({
        body: `<html><head><script type="module" src="/a.js"></script></head><body>${mount}</body></html>`,
      }))).toBe(true);
    }
  });

  it('fails closed on an empty body', () => {
    expect(looksLikeAppShell(probe({ body: '' }))).toBe(false);
  });
});

/**
 * The handler has to actually call it.
 *
 * A predicate nothing consults is decoration, and the handler is where the
 * captive portal reached the cache in the first place.
 */
describe('the fetch handler consults the check before caching', () => {
  const sw = readFileSync(join(ROOT, 'src', 'sw.ts'), 'utf8');

  it('guards the navigation cache write', () => {
    // Both spellings: the `await` is required (the predicate is async) and the
    // condition is required. Testing for the call alone would pass while the
    // result was ignored, which is the shape of the original defect.
    expect(sw).toMatch(/if\s*\(\s*await isAppShell\(fresh\)\s*\)/);
    // And the unguarded sequence — a cache write straight after the fetch — must
    // be gone. This is the assertion that fails when the guard is deleted.
    expect(sw).not.toMatch(
      /await fetch\(req\);[^\n]*\n\s*const cache = await caches\.open\(CACHE\);[^\n]*\n\s*void cache\.put\('\.\/index\.html'/,
    );
  });

  it('awaits the predicate, rather than testing a Promise for truthiness', () => {
    // A `Promise` is always truthy, so a missing `await` compiles, runs, and
    // caches *every* 200 — the exact bug, restored by a one-character edit.
    expect(sw).not.toMatch(/if\s*\(\s*isAppShell\(fresh\)\s*\)/);
  });

  it('still returns the network response to the page', () => {
    // Refusing to cache is not refusing to serve. Someone on a captive portal
    // should get whatever the network gave them, not an error page.
    expect(sw).toMatch(/return fresh;/);
  });

  it('does not cache a navigation response before the check has run', () => {
    // Ordering, stated separately because it is the one way to have the check in
    // the file and still cache the portal: write the cache, then ask.
    const fetchAt = sw.indexOf('const fresh = await fetch(req);');
    const guardAt = sw.indexOf('await isAppShell(fresh)');
    const putAt = sw.indexOf("cache.put('./index.html'", fetchAt);
    expect(fetchAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(fetchAt);
    expect(putAt).toBeGreaterThan(guardAt);
  });

  it('keeps the honest offline fallback when nothing is cached', () => {
    // The 503 page explaining that the app has not been opened on this device
    // is the case the worker exists for, and it must survive the change.
    expect(sw).toMatch(/has not been opened on this device yet/);
  });
});