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