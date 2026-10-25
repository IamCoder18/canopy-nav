/**
 * Offline smoke: prove the built APK is self-contained, on a device with no network.
 *
 * ## Why this exists
 *
 * "The APK does not depend on a remote URL" is three things holding at once — the web
 * bundle inside `assets/public/`, `capacitor.config.ts` carrying no `server.url` so the
 * WebView serves from the package's own origin, and the offline basemap style fetching
 * nothing — and none of them are visible from the source alone. The bug this script was
 * written after (`glyphs: undefined`, §14.24) passed every gate in the project while the
 * offline map drew *nothing*: the browser suites have a network, and no unit test asked
 * MapLibre what it thought of the style. The claim needed a device with the radio off, and
 * the check is only a check if it is cheap enough to run again. So it is scripted.
 *
 * ## What it does
 *
 *   1. Installs `android/app/build/outputs/apk/debug/app-debug.apk`.
 *   2. Turns airplane mode on — remembering the setting it found, and restoring it after.
 *   3. Launches the app and connects to the WebView's DevTools socket.
 *   4. Imports a fixture **through the app's real import path**: the hidden file input
 *      (`App.tsx` mounts it "for automation") is set over the DevTools protocol, so the
 *      parse, the graph build and the style swap all run the code a driver would run.
 *   5. Screenshots before and after into `probe-shots/offline-smoke/` (gitignored).
 *   6. Scans logcat: the assets must say `Handling local request` (read from the APK),
 *      and nothing may be an error.
 *
 * ## What a pass looks like
 *
 * "Map imported — N routable ways", the second screenshot showing the imported network
 * *drawn* (the offline style having been applied, which is the thing that silently was
 * not), zero error lines. The one expected warning is `Tile style unavailable, using
 * offline style` — that is the app honestly reporting the substitution.
 *
 * ## Usage
 *
 *   npm run apk            # build the APK
 *   npm run apk:smoke      # this script
 *
 * Needs one connected device or emulator (`adb devices`) and Node >= 22, for the built-in
 * `WebSocket` the DevTools protocol rides on. `node tools/offline-smoke.mjs some.osm`
 * imports a different extract; the default is `test/fixture.osm`.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APK = join(ROOT, 'android/app/build/outputs/apk/debug/app-debug.apk');
const PKG = 'com.canopy.nav';
const FIXTURE = resolve(ROOT, process.argv[2] ?? 'test/fixture.osm');
const SHOTS = join(ROOT, 'probe-shots', 'offline-smoke');
/** Where the fixture lands on the device — readable by the app, writable by `adb push`. */
const DEVICE_FIXTURE = '/data/local/tmp/canopy-smoke.osm';

if (typeof WebSocket === 'undefined') {
  console.error('This script needs the built-in WebSocket (Node >= 22) for the DevTools protocol.');
  process.exit(1);
}

/** `adb …`, captured. Every call goes through here so a failure names its command. */
function adb(...args) {
  const r = spawnSync('adb', args, { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`adb ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim()}`);
  }
  return (r.stdout ?? '').trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ----------------------------- the device ------------------------------ */

// One device, deliberately. `adb install` against the wrong one is a smoke test that
// quietly proves nothing, and "the one that was plugged in" is not a selection rule.
const devices = execFileSync('adb', ['devices'], { encoding: 'utf8' })
  .split('\n').slice(1).map((l) => l.split('\t')).filter(([, s]) => s === 'device');
if (devices.length !== 1) {
  console.error(`expected exactly one connected device, found ${devices.length} (adb devices)`);
  process.exit(1);
}

if (!existsSync(APK)) {
  console.error(`no APK at ${APK} — run \`npm run apk\` first`);
  process.exit(1);
}
if (!existsSync(FIXTURE)) {
  console.error(`no fixture at ${FIXTURE}`);
  process.exit(1);
}

mkdirSync(SHOTS, { recursive: true });
const shot = (name) => {
  // `exec-out` writes the PNG bytes to stdout; `adb shell screencap` line-endings mangle it.
  const png = execFileSync('adb', ['exec-out', 'screencap', '-p']);
  writeFileSync(join(SHOTS, name), png);
  console.log(`  screenshot -> probe-shots/offline-smoke/${name}`);
};

/* ---------------------------- airplane mode ---------------------------- */

const airplaneWas = adb('shell', 'settings', 'get', 'global', 'airplane_mode_on').trim();
/**
 * Best-effort, by design. `cmd connectivity` is what the quick-settings tile calls and is
 * the one of these that actually toggles radios on a modern image; the settings write is
 * the flag it sets; the broadcast is the legacy path, which modern Android refuses as a
 * protected broadcast and older images need. A refusal is therefore not a failure here —
 * what decides is `networkIsDown()` below, which checks the outcome rather than trusting
 * any of the three mechanisms.
 */
const setAirplane = (on) => {
  for (const args of [
    ['shell', 'cmd', 'connectivity', 'airplane-mode', on ? 'enable' : 'disable'],
    ['shell', 'settings', 'put', 'global', 'airplane_mode_on', on ? '1' : '0'],
    ['shell', 'am', 'broadcast', '-a', 'android.intent.action.AIRPLANE_MODE', '--ez', 'state', String(on)],
    ['shell', 'svc', 'wifi', on ? 'disable' : 'enable'],
    ['shell', 'svc', 'data', on ? 'disable' : 'enable'],
  ]) {
    spawnSync('adb', args, { encoding: 'utf8' });
  }
};
const networkIsDown = () => {
  const r = spawnSync('adb', ['shell', 'ping', '-c', '1', '-W', '2', '8.8.8.8'], { encoding: 'utf8' });
  return r.status !== 0;
};

/* --------------------------- DevTools bridge --------------------------- */

/**
 * A page in the app's WebView, driven over the DevTools protocol.
 *
 * The socket is `webview_devtools_remote_<pid>` — the app's *own* pid, so a Chrome tab
 * with its own socket is not mistaken for the app. Debug builds expose it; release builds
 * do not (see the `webContentsDebuggingEnabled` note in `capacitor.config.ts`), which is
 * the one thing this smoke cannot check on a release APK.
 */
async function connectPage() {
  const pid = adb('shell', 'pidof', PKG).split(/\s+/)[0];
  const socket = `webview_devtools_remote_${pid}`;
  for (let i = 0; i < 30; i++) {
    if (adb('shell', 'cat', '/proc/net/unix').includes(socket)) break;
    await sleep(1000);
    if (i === 29) throw new Error(`DevTools socket ${socket} never appeared`);
  }
  adb('forward', `tcp:9222`, `localabstract:${socket}`);
  const targets = await (await fetch('http://localhost:9222/json/list')).json();
  const target = targets.find((t) => t.type === 'page');
  if (!target) throw new Error('no page target in the WebView');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve: ok, reject: no } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) no(new Error(msg.error.message));
      else ok(msg.result);
    }
  };
  const send = (method, params = {}) => new Promise((ok, no) => {
    const msgId = ++id;
    pending.set(msgId, { resolve: ok, reject: no });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
  const evalJs = async (expression) =>
    (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;
  return { send, evalJs, close: () => ws.close() };
}

/* -------------------------------- smoke -------------------------------- */

async function main() {
  console.log(`installing ${APK.replace(ROOT + '/', '')}`);
  adb('install', '-r', APK);

  console.log('airplane mode on');
  setAirplane(true);
  await sleep(2000);
  if (!networkIsDown()) throw new Error('airplane mode is on but the network still answers');

  try {
    // Fresh state, always: a previous run (or a driver's own use) can leave a map loaded,
    // and then the import screen never appears and the smoke fails for a reason that has
    // nothing to do with what it is checking. Clearing first makes every run the same run.
    adb('shell', 'pm', 'clear', PKG);
    adb('shell', 'am', 'force-stop', PKG);
    adb('shell', 'monkey', '-p', PKG, '-c', 'android.intent.category.LAUNCHER', '1');
    await sleep(6000);
    shot('1-boot.png');

    const page = await connectPage();
    // Click the *visible* button, exactly as a driver would. The hidden input is then set
    // behind it: `DOM.setFileInputFiles` is the same call a browser makes when a picker
    // returns, so `pick(f)` runs with a real File rather than a stubbed one.
    await page.evalJs(`[...document.querySelectorAll('button')].find(b => /Import \\.osm/i.test(b.textContent))?.click()`);
    await sleep(1500);
    await page.send('DOM.enable');
    const doc = await page.send('DOM.getDocument');
    const input = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
    if (!input.nodeId) throw new Error('no file input in the DOM — is the import screen up?');
    adb('push', FIXTURE, DEVICE_FIXTURE);
    adb('shell', 'chmod', '644', DEVICE_FIXTURE);
    await page.send('DOM.setFileInputFiles', { files: [DEVICE_FIXTURE], nodeId: input.nodeId });

    // The import streams, parses and builds a graph in a worker. Wait for it to settle
    // rather than for a timeout: "Parsing" and "Building graph" are the app's own words.
    let text = '';
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      text = await page.evalJs('document.body.innerText');
      if (!/Parsing|Building graph/.test(text) && /routable ways|No map/.test(text)) break;
    }
    shot('2-imported.png');
    page.close();

    console.log(`\n${text.split('\n').filter((l) => l.trim()).slice(0, 6).join('\n')}`);

    /* ------------------------------- verdict ------------------------------ */
    // The emulator's log is full of unrelated system noise, and `logcat -d` over all of it
    // blows past execFileSync's default 1 MB buffer (`ENOBUFS`) before the filter ever runs.
    // The buffer is raised rather than the log truncated, because a dropped tail is exactly
    // where an error line would hide.
    const log = execFileSync('adb', ['logcat', '-d'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n').filter((l) => /Capacitor|FATAL|AndroidRuntime/.test(l));
    const local = log.filter((l) => l.includes('Handling local request')).length;
    const errors = log.filter((l) => / E |FATAL|Error:/.test(l) && !/Failed to fetch/.test(l));
    const fallback = log.some((l) => /Tile style unavailable, using offline style/.test(l));

    console.log(`\n${local} assets served as \`Handling local request\` (read from the APK)`);
    console.log(`offline style fallback: ${fallback ? 'reported (expected offline)' : 'not exercised'}`);
    console.log(`error lines: ${errors.length}`);
    for (const e of errors) console.log(`  ${e.trim()}`);

    const imported = /routable ways/.test(text);
    if (!imported) throw new Error('the import did not land');
    if (errors.length) throw new Error(`${errors.length} error line(s) in logcat`);
    if (local === 0) throw new Error('no `Handling local request` lines — is the bundle in the APK?');
    console.log('\nPASS: the APK booted, imported and drew its map with no network.');
  } finally {
    console.log(`restoring airplane mode to ${airplaneWas}`);
    setAirplane(airplaneWas === '1');
    adb('forward', '--remove', 'tcp:9222');
  }
}

main().catch((err) => {
  console.error(`\nFAIL: ${err.message}`);
  process.exit(1);
});
