/**
 * Keyboard and focus verification, in a real browser.
 *
 * `test/e2e.mjs` drives the app by clicking. This drives it by keyboard and then
 * asks the one question the unit suite structurally cannot: **where is the focus
 * now, and does pressing Tab actually continue from here?**
 *
 * The defects this catches are a family. Screens swap React state, which unmounts
 * the control that was activated; focus falls to `<body>`; the next Tab restarts
 * from the top of the document. On the Regions screen that is sixty catalogue
 * rows. On a head unit driven by a switch it is losing the app. Every test in
 * `test/*.spec.ts` passed throughout.
 *
 *   node tools/focus.mjs
 */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.FOCUS_BASE ?? 'http://127.0.0.1:8080';
const FIXTURE = join(here, '..', 'test', 'fixture.osm');
const SHOTS = join(here, '..', 'canopy-shots');
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures++;
};

/** A readable description of wherever focus currently is. */
const FOCUS_INFO = () => {
  const el = document.activeElement;
  if (!el || el === document.body) {
    return { where: 'body', tag: 'BODY', name: '(none — focus is nowhere)' };
  }
  const label = el.getAttribute('aria-label')
    || (el.textContent || '').trim().slice(0, 40)
    || el.getAttribute('placeholder')
    || '';
  return {
    where: el.className || el.tagName,
    tag: el.tagName,
    name: label,
    heading: (() => {
      // Is focus on the screen's own heading?
      const h = document.activeElement?.closest('main')?.querySelector('h1');
      return h && el === h ? h.textContent.trim().slice(0, 30) : null;
    })(),
  };
};

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  permissions: ['geolocation'],
  geolocation: { latitude: 51.5215, longitude: -1.4175 },
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));

console.log('\n=== keyboard ===');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

// Load a map so the launcher is in its everyday state.
const importBtn = await page.$('button:has-text("Import .osm file")');
if (importBtn) await importBtn.click();
await page.waitForTimeout(400);
const input = await page.$('input[type=file]');
if (input) {
  await input.setInputFiles(FIXTURE);
  await page.waitForFunction(
    () => !document.body.innerText.includes('Parsing') && !document.body.innerText.includes('Building graph'),
    { timeout: 40000 },
  );
  await page.waitForTimeout(1200);
}

/* ---------------- typing an m, which the mute shortcut used to eat -------- */
console.log('\ntyping');
await page.click('.search-field');
await page.waitForTimeout(500);
await page.keyboard.press('Backspace');   // clear the autoFocus field
await page.keyboard.type('Museum', { delay: 40 });
await page.waitForTimeout(600);
const typed = await page.evaluate(() => document.querySelector('.inline-search input')?.value ?? '');
check('the letter m reaches the search field', /museum/i.test(typed), `field holds "${typed}"`);

const muteAfterTyping = await page.evaluate(
  () => document.querySelector('button[aria-label*="ute voice"], button[aria-label="Unmute voice guidance"]') !== null
    || document.body.innerText.includes('Unmute'),
);
// If mute had fired on each `m`, the control's label would have flipped to "Unmute".
check('typing m does not toggle mute', !muteAfterTyping);

/* ---------------- a bare letter must not overwrite an existing query ------- */
await page.fill('.inline-search input', 'Memorial Library');
await page.waitForTimeout(700);
// Move focus off the field, which is what tapping a result does.
await page.evaluate(() => (document.activeElement)?.blur());
await page.keyboard.press('s');
await page.waitForTimeout(500);
const afterLetter = await page.evaluate(() => ({
  value: document.querySelector('.inline-search input')?.value ?? null,
  screen: document.querySelector('main')?.getAttribute('aria-label') ?? '',
}));
check(
  'a letter does not replace the query while search is open',
  afterLetter.value === null || afterLetter.value === 'Memorial Library',
  `field is "${afterLetter.value}", screen "${afterLetter.screen}"`,
);

/* ---------------- focus follows a screen change --------------------------- */
console.log('\nfocus');
await page.keyboard.press('Escape');
await page.waitForTimeout(600);
await page.evaluate(() => (document.activeElement)?.blur());
// Tab to the Settings control and activate it with the keyboard alone.
await page.evaluate(() => {
  const b = document.querySelector('button[aria-label="Settings"]');
  b?.focus();
});
await page.keyboard.press('Enter');
await page.waitForTimeout(700);
const onSettings = await page.evaluate(FOCUS_INFO);
check(
  'focus lands on the Settings heading',
  onSettings.heading === 'Settings',
  `focus is on ${onSettings.tag}.${onSettings.where} (${onSettings.name})`,
);
check(
  'focus is not on the document body after a screen change',
  onSettings.tag !== 'BODY',
  onSettings.where,
);
await page.screenshot({ path: join(SHOTS, 'focus-settings.png') });

/* ---------------- Tab continues from the new screen ------------------------ */
// On the launcher, Tab from the top reaches Settings within a few stops. On
// Settings it must reach the *settings* controls, not the launcher's.
// Real Tab presses. A synthetic `KeyboardEvent` dispatched from the page does
// not move focus — the browser's own key handling is what implements it — so this
// has to go through the input pipeline.
const seen = [];
for (let i = 0; i < 6; i++) {
  seen.push(await page.evaluate(() => {
    const el = document.activeElement;
    return ((el?.getAttribute?.('aria-label') || el?.textContent) || '').trim().slice(0, 28);
  }));
  await page.keyboard.press('Tab');
  await page.waitForTimeout(60);
}
check(
  'Tab moves through distinct controls on the new screen',
  new Set(seen).size >= 4,
  seen.slice(0, 4).join(' | '),
);

/* ---------------- headings on every screen -------------------------------- */
console.log('\nheadings');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1800);
const screens = [
  ['home', null],
  ['search', '.search-field'],
];
for (const [name, click] of screens) {
  if (click) { await page.click(click); await page.waitForTimeout(500); }
  const h = await page.evaluate(() => {
    const el = document.querySelector('main h1');
    return el ? { text: el.textContent.trim(), focusable: el.tabIndex === -1 } : null;
  });
  check(`${name} has a heading that can receive focus`, !!h?.focusable, h ? `"${h.text}"` : 'no <h1>');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
}

/* ---------------- dialogs ------------------------------------------------ */
console.log('\ndialogs');
// From a fresh load: the loop above left the app on the Settings heading, and
// `.search-field` only exists on the launcher.
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1800);
const reimport = await page.$('input[type=file]');
if (reimport) {
  await reimport.setInputFiles(FIXTURE);
  await page.waitForFunction(
    () => !document.body.innerText.includes('Parsing') && !document.body.innerText.includes('Building graph'),
    { timeout: 40000 },
  );
  await page.waitForTimeout(1200);
}
await page.click('.search-field');
await page.waitForTimeout(400);
await page.fill('.inline-search input', 'Elbow');
await page.waitForTimeout(900);
const row = await page.$('.result-row');
if (row) {
  await row.click();
  await page.waitForTimeout(2500);
  const dlg = await page.evaluate(() => {
    const el = document.querySelector('[role="dialog"]');
    return el ? { modal: el.getAttribute('aria-modal'), label: el.getAttribute('aria-label') } : null;
  });
  check('the route preview is a modal dialog with a name', dlg?.modal === 'true' && !!dlg?.label,
    dlg ? `aria-modal="${dlg.modal}" label="${dlg.label}"` : 'no dialog');
  await page.screenshot({ path: join(SHOTS, 'focus-preview-dialog.png') });
}

/* ---------------- an aria-disabled control is reachable -------------------- */
console.log('\ndisabled reasons');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.click('button[aria-label="Settings"]');
await page.waitForTimeout(600);
await page.click('.hint-card');
await page.waitForTimeout(700);
const engines = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.provider-row')];
  return rows.map((r) => ({
    disabled: r.hasAttribute('disabled'),
    ariaDisabled: r.getAttribute('aria-disabled'),
    name: (r.textContent || '').trim().slice(0, 46),
  }));
});
check('engine rows are reachable (not natively disabled)', engines.length > 0 && engines.every((r) => !r.disabled),
  `${engines.filter((r) => r.ariaDisabled === 'true').length} of ${engines.length} marked aria-disabled`);
const withReason = engines.filter((r) => /unavailable|ready/i.test(r.name));
check('every engine row states its state in text', withReason.length === engines.length,
  engines[0]?.name ?? '');
await page.screenshot({ path: join(SHOTS, 'focus-engines.png') });

/* ---------------- a destructive confirmation keeps focus ----------------- */
console.log('\ndestructive confirmation');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1800);
const reimport2 = await page.$('input[type=file]');
if (reimport2) {
  await reimport2.setInputFiles(FIXTURE);
  await page.waitForFunction(
    () => /[\d,]+ routable ways/.test(document.body.innerText),
    { timeout: 40000 },
  );
  await page.waitForTimeout(1000);
}
await page.click('.quick-tile:has-text("Regions")');
await page.waitForTimeout(1200);
const removeBtn = await page.$('button[aria-label^="Remove "]');
if (removeBtn) {
  // Focus it by hand, then activate with the keyboard — the real sequence.
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button[aria-label^="Remove "]')][0];
    b?.focus();
  });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  const afterOpen = await page.evaluate(FOCUS_INFO);
  check(
    'opening a removal moves focus to Confirm, not to the document',
    /confirm/i.test(afterOpen.name) && afterOpen.tag !== 'BODY',
    `focus is on ${afterOpen.tag}.${afterOpen.where} ("${afterOpen.name}")`,
  );
  const stillMounted = await page.evaluate(() =>
    document.querySelector('button[aria-label^="Remove "]') !== null);
  check('the Remove control is still in the DOM to return focus to', stillMounted);

  // Escape-equivalent: the Cancel control takes focus back out of the dialog.
  await page.keyboard.press('Tab');
  await page.waitForTimeout(200);
  const onCancel = await page.evaluate(FOCUS_INFO);
  check('Tab reaches Cancel next', /cancel/i.test(onCancel.name) || /remove/i.test(onCancel.name),
    `focus is on "${onCancel.name}"`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const afterCancel = await page.evaluate(FOCUS_INFO);
  check(
    'cancelling returns focus rather than dropping it',
    afterCancel.tag !== 'BODY',
    `focus is on ${afterCancel.tag}.${afterCancel.where} ("${afterCancel.name}")`,
  );
  await page.screenshot({ path: join(SHOTS, 'focus-remove-confirm.png') });
} else {
  check('a removal control exists to test', false, 'no Remove button found');
}

console.log('\n=== result ===');
console.log(failures === 0 ? 'all checks passed' : `${failures} check(s) failed`);
if (errors.length) console.log(`page errors: ${errors.slice(0, 3).join(' | ')}`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);