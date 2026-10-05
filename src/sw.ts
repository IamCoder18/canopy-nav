/**
 * Offline shell service worker.
 *
 * The app's headline claim is that it works with no network. That was true until
 * you reloaded: a cold start with no connection never reached the app at all —
 * Chromium served its own `ERR_INTERNET_DISCONNECTED` page, because the built
 * bundle lives at a real origin and nothing had cached it.
 *
 * On a phone that is the *common* case, not an edge case. A driver who opens the
 * app in a tunnel before the WebView has ever cached it gets a browser error page
 * with no way forward.
 *
 * The strategy is deliberately minimal — this is a cache-first shell, not a
 * build tool:
 *
 *  - Precache the app shell on install: `index.html`, the entry JS and CSS, and
 *    the lazily-loaded map and region chunks. Those are the assets that decide
 *    whether the app starts at all.
 *  - Navigation requests fall back to the cached `index.html`, so any URL in the
 *    app opens offline.
 *  - Map **tiles** are never touched. They are cross-origin, huge, and the app
 *    already degrades to its own offline style without them; intercepting them
 *    here would add quota pressure for no benefit.
 *  - Everything else is cache-first with a background refresh, which suits
 *    content-hashed filenames: a changed asset has a changed name, so a stale hit
 *    is impossible.
 *
 * Version is derived from the build, so a new release drops the old caches.
 */

/// <reference lib="webworker" />

/**
 * Build identity, substituted at compile time by Vite's `define`.
 *
 * It has to differ per release: a worker that keeps the same cache name keeps
 * serving the previous release's hashed assets forever, which is the standard way
 * an offline shell rots.
 */
declare const __CANOPY_BUILD__: string | undefined;

/**
 * The worker global, reached through a cast.
 *
 * `tsconfig.json` puts both `DOM` and `WebWorker` in `lib`, which it must because
 * the app is DOM code and this file is worker code in one project. The two
 * disagree about `self` and about event types, and `declare const self` collides
 * outright with the DOM declaration. Typing the boundary once, here, is less
 * fragile than threading a third lib setting through the build.
 */
const sw = globalThis as unknown as ServiceWorkerGlobalScope;

const VERSION = typeof __CANOPY_BUILD__ === 'string' ? __CANOPY_BUILD__ : 'dev';
const CACHE = `canopy-shell-${VERSION}`;

/**
 * The shell, minus the hashed assets.
 *
 * Only the document is listed literally. The JavaScript and CSS filenames are
 * content-hashed by the build, so they are read out of the built `index.html` at
 * install time — hard-coding them here meant the cache held `index.html` and
 * nothing else, and an offline reload then 404'd on every module script and
 * rendered a blank page.
 */
const SHELL = ['./', './index.html'];

/** Every same-origin script or stylesheet the document references. */
function assetUrlsFrom(html: string, base: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /<script[^>]+src="([^"]+)"/g,
    /<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g,
  ];
  for (const re of patterns) {
    for (const m of html.matchAll(re)) {
      const url = new URL(m[1]!, base);
      if (url.origin === sw.location.origin) out.add(url.href);
    }
  }
  return [...out];
}

sw.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);

      const put = async (url: string) => {
        try {
          const res = await fetch(url, { cache: 'reload' });
          if (res.ok) await cache.put(url, res);
        } catch {
          // Skipped rather than failing the install: a partially-cached app that
          // still starts beats a failed registration.
        }
      };

      await Promise.allSettled(SHELL.map(put));

      // Then the assets the document references...
      try {
        const res = await fetch('./index.html', { cache: 'reload' });
        const html = await res.text();
        await Promise.allSettled(assetUrlsFrom(html, sw.location.href).map(put));
      } catch {
        // Document unavailable at install; the fetch handler caches on the first
        // successful load instead.
      }

      // ...and then everything the build emitted, which is the only way to reach
      // the dynamically-imported chunks. The map's stylesheet is the important
      // one: without it an offline cold start threw on the first render, which
      // the error boundary caught and reported — better than a blank screen, but
      // still an app that did not open.
      try {
        const res = await fetch('./precache-manifest.json', { cache: 'reload' });
        if (res.ok) {
          const files = (await res.json()) as string[];
          await Promise.allSettled(
            files.map((f) => put(new URL(f, sw.location.href).href)),
          );
        }
      } catch {
        // No manifest: the app still starts online and caches on first use.
      }

      // Take over immediately: a waiting worker means the next load uses the new
      // shell, which is what someone updating the app expects.
      await sw.skipWaiting();
    })(),
  );
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n.startsWith('canopy-shell-') && n !== CACHE).map((n) => caches.delete(n)),
      );
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Cross-origin: tiles, glyphs, sprite, and the routing/geocoding APIs. None of
  // these belong in the shell cache — the API responses in particular must never
  // be served stale, because a cached route would be presented as current.
  if (url.origin !== sw.location.origin) return;

  /**
   * Look a request up by URL alone.
   *
   * `cache.match(req)` honours the stored response's `Vary` header, and the
   * install-time `put` used a plain `fetch(url)` while the page's module scripts
   * are requested with `crossorigin`. Every lookup missed, the handler fell
   * through to the network, and the offline reload failed with `ERR_FAILED` on
   * the entry script even though the bytes were sitting in the cache — which is
   * why the shell appeared precached and still did not boot.
   *
   * `ignoreSearch` for the same class of reason: a cache-busting query on an
   * asset still wants the cached bytes.
   */
  const lookup = (cache: Cache) => cache.match(req, { ignoreVary: true, ignoreSearch: true });

  // A navigation offline with nothing cached is the failure this file exists to
  // prevent, so the cached shell answers it rather than letting the request fail.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(CACHE);
          void cache.put('./index.html', fresh.clone());
          return fresh;
        } catch {
          const cache = await caches.open(CACHE);
          const cached = await cache.match('./index.html', { ignoreVary: true })
            ?? await cache.match('./', { ignoreVary: true });
          if (cached) return cached;
          return new Response(
            '<!doctype html><meta charset="utf-8"><title>Canopy Nav</title>' +
            '<body style="background:#0E1013;color:#E8EAED;font:16px system-ui;padding:24px">' +
            '<p>Canopy Nav has not been opened on this device yet, so there is nothing ' +
            'cached to run offline. Reconnect once and it will work without a network from then on.</p>',
            { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
          );
        }
      })(),
    );
    return;
  }

  // Same-origin assets: cache-first, refreshed in the background. Filenames are
  // content-hashed by the build, so a cached hit can never be stale.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await lookup(cache);
      if (hit) {
        void fetch(req)
          .then((res) => { if (res.ok) return cache.put(req, res); })
          .catch(() => { /* offline: the cached copy stands */ });
        return hit;
      }
      // No cached copy and no network. Reporting the miss is correct: the
      // alternative — returning anything else — would be serving the wrong bytes
      // for the URL, which is worse than an honest failure.
      const res = await fetch(req);
      if (res.ok) await cache.put(req, res.clone());
      return res;
    })(),
  );
});