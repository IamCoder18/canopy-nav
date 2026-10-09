/**
 * Static server for manual testing from a real device.
 *
 * Requirement #20 wants the app reachable on the LAN so it can be exercised on a
 * phone. This used to live at `/tmp/opencode/serve/serve.mjs`, which meant the
 * testing setup was unversioned, unreviewed and silently destroyed by a `/tmp`
 * cleanup — while being the only way to satisfy the requirement. It is now in
 * the repo with an npm script.
 *
 * Serves `dist/` plus, when present, the debug APK at `/dl/canopy-nav.apk`.
 * Binds 0.0.0.0 because a loopback-only server is invisible to the phone.
 *
 * Run with `npm run serve` (after `npm run build`).
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { networkInterfaces } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.SERVE_ROOT
  ? resolve(process.env.SERVE_ROOT)
  : resolve(here, '..', 'dist');
const APK = resolve(here, '..', 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.pbf': 'application/octet-stream',
  '.osm': 'application/xml',
  '.apk': 'application/vnd.android.package-archive',
};

/**
 * The one upstream this server will fetch on a client's behalf, and the only
 * path shape it will fetch it at.
 *
 * ## Why a mirror exists at all
 *
 * Geofabrik serves `*-latest.osm.pbf` as a **307** to a dated filename, and it
 * sends **no `Access-Control-Allow-Origin` header on either the redirect or the
 * 200** — verified with and without an `Origin` request header. A browser
 * therefore cannot `fetch()` these from a web page at all, and no client-side
 * change can fix that: the header is the only thing that permits the read, and
 * the upstream declines to send it.
 *
 * The 307 makes it worse than a plain missing header. A cross-origin redirect is
 * followed only if the *redirect response itself* carries CORS headers, so the
 * request dies at the first hop and never reaches the 200.
 *
 * So the browser needs the bytes to arrive same-origin. This endpoint is that
 * path: the app asks its own origin, and the server asks Geofabrik, where CORS
 * does not apply.
 *
 * ## Why it is this narrow
 *
 * An endpoint that fetches an arbitrary caller-supplied URL is an open proxy and
 * an SSRF hole: it can reach anything the server can reach, including loopback
 * and link-local addresses, and it would do so on unauthenticated requests from
 * anyone who can load the page.
 *
 * So the URL is **not** taken from the query string. The caller sends only the
 * path it wants under one hard-coded prefix, and it is matched against an
 * allowlist of exact Geofabrik paths *and* re-checked after resolution, so a
 * traversal or an encoded variant cannot widen it. Anything else is a 403.
 */
const MIRROR_PREFIX = '/mirror/geofabrik/';
const MIRROR_ORIGIN = 'https://download.geofabrik.de';

/**
 * Resolve a mirror request to an absolute upstream URL, or null.
 *
 * Exported so the containment property is testable directly — this is the same
 * reasoning as `resolveRequestPath` below, and the allowlist is the part that
 * has to not be wrong.
 */
export function resolveMirrorUrl(requestUrl) {
  const raw = (requestUrl || '').split('?')[0];
  if (!raw.startsWith(MIRROR_PREFIX)) return null;

  const rest = raw.slice(MIRROR_PREFIX.length);
  if (!rest || rest.includes('..') || rest.includes('\\')) return null;

  /*
   * The accepted shape, in two parts.
   *
   * Geofabrik's own layout is `region[/subregion…]/name-latest.osm.pbf`, where the
   * directory names are plain lowercase words with hyphens (`north-america`,
   * `canada`, `great-britain`) and only the final segment has dots and an
   * extension. Saying so is what makes this an allowlist rather than a guess:
   *
   *  - Every segment is `[a-z0-9]`-led and made only of `[a-z0-9._-]`, so there is
   *    no room for a scheme, an authority, a port, a backslash, a NUL, or any
   *    character that means something to a URL parser. The leading-character rule
   *    is what stops a segment like `-x` being read as a flag or an option.
   *  - Every *directory* segment additionally forbids a dot. That is the check
   *    that turns away `127.0.0.1/x-latest.osm.pbf` and
   *    `evil.example.com/x-latest.osm.pbf` — inputs which, allowed through, would
   *    still have landed on the allowed origin (so they were never an SSRF) but
   *    which are unmistakably attempts to name a host, and a host is never a
   *    directory in this layout.
   *  - The final segment must be an extract: `.osm.pbf`, optionally `.gz`.
   */
  const segments = rest.split('/');
  const file = segments.pop();
  if (!file || segments.some((s) => !/^[a-z0-9][a-z0-9_-]*$/i.test(s))) return null;
  if (!/^[a-z0-9][a-z0-9._-]*\.osm\.pbf(\.gz)?$/i.test(file)) return null;

  const url = new URL(rest, MIRROR_ORIGIN + '/');
  // Belt and braces: the shape check above should make this unreachable, but the
  // invariant that matters is that the *resolved* URL is on the one origin we
  // are willing to talk to, so it is asserted rather than assumed.
  if (url.origin !== MIRROR_ORIGIN) return null;
  if (url.protocol !== 'https:') return null;
  return url;
}

const MIRROR_TYPES = {
  '.pbf': 'application/octet-stream',
  '.gz': 'application/gzip',
};

/**
 * Stream a mirrored file through, without buffering it.
 *
 * A province extract is 100–900 MB. Buffering one would hold it in the server's
 * heap, so the body is piped with backpressure and the client's disconnect tears
 * the upstream request down rather than leaving it running.
 */
async function serveMirror(req, res, target) {
  const upstreamHeaders = {};
  // `Range` and `If-Range` are what make resume work, so they are forwarded.
  // Everything else about the request is not.
  for (const h of ['range', 'if-range']) {
    const v = req.headers[h];
    if (typeof v === 'string') upstreamHeaders[h] = v;
  }

  let upstream;
  try {
    upstream = await fetch(target, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: upstreamHeaders,
      redirect: 'follow',
    });
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    return res.end(`upstream unreachable: ${e?.message ?? 'unknown error'}`);
  }

  // Deliberately no `Access-Control-Allow-Origin`.
  //
  // The app requests this same-origin — that is the entire point of the mirror,
  // and a same-origin fetch needs no such header. Sending `*` would additionally
  // let any website on the internet use this server to pull Geofabrik extracts
  // through it, turning a dev box into a public bandwidth proxy. The response
  // carries no header that grants cross-origin access.
  const out = {};
  // Pass the status and the validators through unchanged so the client's resume
  // logic sees the same 200/206/404 and the same ETag it would have seen
  // directly — which is what `If-Range` has to agree with.
  const passthrough = ['content-length', 'content-type', 'etag', 'last-modified', 'content-range', 'accept-ranges'];
  for (const h of passthrough) {
    const v = upstream.headers.get(h);
    if (v !== null) out[h] = v;
  }
  if (!out['content-type']) out['content-type'] = MIRROR_TYPES['.gz'] ?? 'application/octet-stream';

  res.writeHead(upstream.status, out);
  if (req.method === 'HEAD' || !upstream.body) {
    upstream.body?.cancel?.().catch(() => {});
    return res.end();
  }

  const nodeStream = Readable.fromWeb(upstream.body);
  // If the browser walks away mid-download — which it does on every navigation
  // and every cancelled region — destroy the upstream request too. Otherwise the
  // server keeps pulling 900 MB for nobody.
  const abort = () => {
    nodeStream.destroy();
    upstream.body?.cancel?.().catch(() => {});
  };
  res.on('close', abort);
  nodeStream.on('error', () => res.destroy());
  nodeStream.pipe(res);
}

/**
 * Map a request path to a file inside ROOT, or null if it escapes.
 *
 * Exported so the containment property can be tested directly. Stripping leading
 * `../` before `join` is not sufficient on its own — `join` resolves what is
 * left, so the check that matters is that the *result* is still under ROOT.
 */
export function resolveRequestPath(root, urlPath) {
  const decoded = decodeURIComponent((urlPath || '/').split('?')[0]);
  const p = decoded === '/' ? '/index.html' : decoded;
  const file = resolve(root, '.' + normalize(p).replace(/^(\.\.[/\\])+/, ''));
  return file.startsWith(root + '/') || file === root ? file : null;
}

/**
 * Only when run as a program.
 *
 * The `import.meta.url === pathToFileURL(process.argv[1]).href` guard matters
 * because `test/serve.spec.ts` imports `resolveRequestPath` from this module. The
 * start-up check below used to run on import, and since the unit tests run before
 * `npm run build` in CI it found no `dist/index.html` and called `process.exit(1)`
 * -- killing the whole test run. 511 tests passed and then the process died with
 * "process.exit unexpectedly called with 1".
 */
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain && !existsSync(join(ROOT, 'index.html'))) {
  console.error(`No build found at ${ROOT}. Run \`npm run build\` first.`);
  process.exit(1);
}

function send(res, path) {
  res.writeHead(200, {
    'Content-Type': TYPES[extname(path)] || 'application/octet-stream',
    'Content-Length': statSync(path).size,
    // No caching: a stale bundle on a phone reads as "my fix did not land",
    // which has already cost debugging time twice in this project (§4.5).
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  createReadStream(path).pipe(res);
}

/**
 * Build the request handler.
 *
 * Exported so a test can drive it without binding a port, which is what let the
 * `process.exit` bug above be caught by a unit test rather than only by CI.
 */
export function createRequestHandler(root = ROOT, apk = APK) {
  return (req, res) => {
    const raw = (req.url || '/').split('?')[0];

    // Before the filesystem: the mirror is not a file, and its path must not be
    // allowed to fall through to the static handler and become an index.html.
    if (raw.startsWith(MIRROR_PREFIX)) {
      const target = resolveMirrorUrl(raw);
      if (!target) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        return res.end('forbidden');
      }
      return serveMirror(req, res, target);
    }

    if (raw === '/dl/canopy-nav.apk') {
      if (!existsSync(apk)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('No APK built. Run `npm run apk`.');
      }
      return send(res, apk);
    }

    const file = resolveRequestPath(root, raw);
    if (!file) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('forbidden');
    }

    let st;
    try {
      st = statSync(file);
    } catch {
      // Single-page app: unknown paths fall back to the shell.
      try {
        return send(res, join(root, 'index.html'));
      } catch {
        res.writeHead(404);
        return res.end('not found');
      }
    }

    if (st.isDirectory()) return send(res, join(file, 'index.html'));
    return send(res, file);
  };
}

if (isMain) {
  createServer(createRequestHandler()).listen(PORT, HOST, () => {
    const nets = Object.values(networkInterfaces())
      .flat()
      .filter((n) => n && n.family === 'IPv4' && !n.internal)
      .map((n) => n.address);
    console.log(`serving ${ROOT}`);
    console.log(`  local    http://localhost:${PORT}`);
    for (const a of nets) console.log(`  network  http://${a}:${PORT}`);
    console.log(`  apk      ${existsSync(APK) ? 'http://HOST:' + PORT + '/dl/canopy-nav.apk' : 'not built (npm run apk)'}`);
  });
}