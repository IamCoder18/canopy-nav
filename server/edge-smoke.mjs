#!/usr/bin/env node
// Test the shipped Caddy configuration against an already-running packserver.
// Public DNS/ACME are deliberately not changed by this loopback-only test.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const key = process.env.PACKSERVER_API_KEY;
if (!key) throw new Error('Set PACKSERVER_API_KEY');
const backend = new URL(process.env.PACKSERVER_BACKEND_URL ?? 'http://[::1]:8787');
if (backend.protocol !== 'http:' || backend.pathname !== '/' || backend.username || backend.password) throw new Error('Use the private HTTP backend origin, for example http://[::1]:8787');
const probe = createServer();
await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '::1', resolve); });
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const url = `http://[::1]:${port}`;
const dir = await mkdtemp('/tmp/opencode/canopy-edge-');
const config = (await readFile(new URL('./Caddyfile', import.meta.url), 'utf8'))
  // A test-only unavailable upstream forces an error log containing the
  // authenticated original request, proving the credential filter actually ran.
  .replace('    reverse_proxy [::1]:8787 {', '    reverse_proxy /__edge_error_probe [::1]:1\n    reverse_proxy [::1]:8787 {')
  .replace('{$PACKSERVER_HOST:packs.example.org}', url)
  .replaceAll('[::1]:8787', backend.host)
  .replace('\n{\n', '\n{\n    admin off\n    auto_https off\n');
const path = join(dir, 'Caddyfile');
await writeFile(path, config);
const caddy = spawn(process.env.CADDY_BIN ?? 'caddy', ['run', '--config', path, '--adapter', 'caddyfile'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, XDG_CONFIG_HOME: join(dir,'config'), XDG_DATA_HOME: join(dir,'data'), XDG_CACHE_HOME: join(dir,'cache') },
});
let logs = ''; let startupError;
caddy.once('error', (error) => { startupError = error; });
for (const stream of [caddy.stdout, caddy.stderr]) stream.on('data', (chunk) => { logs = (logs + chunk).slice(-1024 * 1024); });
try {
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (startupError) throw startupError;
    if (caddy.exitCode != null) throw new Error('Caddy exited before readiness');
    try { if ((await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* startup */ }
    if (Date.now() > deadline) throw new Error('Caddy startup timed out');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./smoke.mjs', import.meta.url))], {
      env: { ...process.env, PACKSERVER_URL: url }, stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Edge smoke exited ${code}`)));
  });
  const error = await fetch(`${url}/__edge_error_probe`, { headers: { 'X-API-Key':key } });
  await error.arrayBuffer();
  if (error.status !== 502) throw new Error('Expected a test upstream failure');
  const logDeadline = Date.now() + 3000;
  while (!logs.includes('/__edge_error_probe') && Date.now() < logDeadline) await new Promise((resolve) => setTimeout(resolve,20));
  if (!logs.includes('/__edge_error_probe')) throw new Error('Expected the proxy error to be logged');
  if (logs.includes(key)) throw new Error('A credential appeared in Caddy logs');
  console.log('PASS shipped Caddy config over IPv6: auth-first, 413 precheck, real build/download, no credential in logs');
} finally {
  caddy.kill('SIGTERM');
  await new Promise((resolve) => { if (caddy.exitCode != null || startupError) resolve(); else caddy.once('exit', resolve); });
  await rm(dir, { recursive: true, force: true });
}
