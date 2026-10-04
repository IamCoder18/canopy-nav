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
import { fileURLToPath } from 'node:url';

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

if (!existsSync(join(ROOT, 'index.html'))) {
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

createServer((req, res) => {
  const raw = (req.url || '/').split('?')[0];

  if (raw === '/dl/canopy-nav.apk') {
    if (!existsSync(APK)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('No APK built. Run `npm run apk`.');
    }
    return send(res, APK);
  }

  const file = resolveRequestPath(ROOT, raw);
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
      return send(res, join(ROOT, 'index.html'));
    } catch {
      res.writeHead(404);
      return res.end('not found');
    }
  }

  if (st.isDirectory()) return send(res, join(file, 'index.html'));
  return send(res, file);
}).listen(PORT, HOST, () => {
  const nets = Object.values(networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
  console.log(`serving ${ROOT}`);
  console.log(`  local    http://localhost:${PORT}`);
  for (const a of nets) console.log(`  network  http://${a}:${PORT}`);
  console.log(`  apk      ${existsSync(APK) ? 'http://HOST:' + PORT + '/dl/canopy-nav.apk' : 'not built (npm run apk)'}`);
});