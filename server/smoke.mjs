#!/usr/bin/env node
// Run against the real service/container. No admin HTTP endpoints are used.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
const base = process.env.PACKSERVER_URL ?? 'http://[::1]:8787';
const key = process.env.PACKSERVER_API_KEY;
if (!key) throw new Error('Set PACKSERVER_API_KEY (create it with the admin CLI)');
const headers = { 'X-API-Key': key };
const check = (ok, message) => { if (!ok) throw new Error(message); };
check((await fetch(`${base}/healthz`)).ok, 'healthz');
check((await fetch(`${base}/v1/builds`, { method: 'POST', body: 'rejected' })).status === 401, 'auth');
// Exercise the public edge too when PACKSERVER_URL points at Caddy. A client
// waiting for Continue must receive the final rejection without sending a body.
async function rejectBeforeContinue(apiKey, length, expected) {
  await new Promise((resolve, reject) => {
    const url = new URL(`${base}/v1/builds`);
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'POST', headers: { 'X-API-Key': apiKey, Expect: '100-continue', 'Content-Length': length },
    }, (response) => {
      response.resume();
      response.once('end', () => {
        request.destroy();
        if (response.statusCode === expected) resolve();
        else reject(new Error(`Expected ${expected}, received ${response.statusCode}`));
      });
    });
    request.once('continue', () => { request.destroy(); reject(new Error('Edge sent 100 Continue before rejecting the upload')); });
    request.once('error', reject);
    request.setTimeout(10_000, () => request.destroy(new Error('Headers-first rejection timed out')));
    request.flushHeaders();
  });
}
await rejectBeforeContinue('canopy_pk_invalid', '1000000', 401);
await rejectBeforeContinue(key, '9007199254740991', 413);
const form = new FormData();
form.append('file', new Blob([await readFile(fileURLToPath(new URL('../test/fixture.osm.pbf', import.meta.url)))]), 'fixture.osm.pbf');
form.append('region', 'Fixture');
const response = await fetch(`${base}/v1/builds`, { method: 'POST', headers, body: form });
check(response.status === 202, `submit ${response.status}: ${await response.clone().text()}`);
const { id } = await response.json();
const deadline = Date.now() + 300_000;
for (;;) {
  const status = await (await fetch(`${base}/v1/builds/${id}`, { headers })).json();
  if (status.state === 'failed') throw new Error(JSON.stringify(status.error));
  if (status.state === 'done') break;
  check(Date.now() < deadline, 'build deadline');
  await new Promise((r) => setTimeout(r, 500));
}
const manifest = await (await fetch(`${base}/v1/builds/${id}/artifacts`, { headers })).json();
check(manifest.format === 'canopy-bundle/1' && manifest.artifacts.length === 3, 'manifest');
for (const a of manifest.artifacts) {
  const r = await fetch(`${base}/v1/builds/${id}/artifacts/${a.name}`, { headers });
  const bytes = await r.arrayBuffer();
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
  check(hash === a.sha256 && bytes.byteLength === a.bytes && r.headers.get('etag') === `"${hash}"`, a.name);
}
const bundle = await (await fetch(`${base}/v1/builds/${id}/bundle`, { headers })).arrayBuffer();
check(bundle.byteLength > 0, 'bundle');
console.log(`PASS ${id}: authenticated upload, pipeline, manifest, artifacts and bundle (${bundle.byteLength} bytes)`);
// Optional cross-runtime acceptance: a Vite dev server exposes the app modules
// so the *real native builder's output* can be ingested/mounted by the real
// browser WASM worker. No fake .gph tiles or routing responses are involved.
if (process.env.PACKSERVER_APP_URL) {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const app = process.env.PACKSERVER_APP_URL;
    await page.route('**/*', (route) => new URL(route.request().url()).origin === new URL(app).origin ? route.continue() : route.abort());
    await page.goto(app, { waitUntil: 'domcontentloaded' });
    const result = await page.evaluate(async (bytes) => {
      const { importBundle } = await import('/src/regions/bundle.ts');
      const { getLocalValhalla } = await import('/src/nav/valhalla-local/index.ts');
      const region = await importBundle(new Blob([new Uint8Array(bytes)]));
      const route = await getLocalValhalla().route({ from: [-1.4,51.5], to: [-1.3232,51.506], units: 'km' });
      return { graph: !!region.dataset.graph, engine: route.engine, maneuvers: route.maneuvers.length, metres: route.summary.length };
    }, [...new Uint8Array(bundle)]);
    check(!result.graph && result.engine === 'valhalla-local' && result.maneuvers >= 2 && result.metres > 4000 && result.metres < 9000, 'native builder → app ingest → WASM routing parity');
    console.log(`PASS native builder → app ingest → WASM route: ${result.metres.toFixed(0)} m, ${result.maneuvers} maneuvers`);
  } finally { await browser.close(); }
}
