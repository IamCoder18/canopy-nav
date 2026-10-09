/**
 * Whole-app UI audit. Measures; does not guess.
 *
 * Each check corresponds to a defect class that is invisible to a unit test and
 * obvious in a screenshot:
 *
 *   1. **Hover/press transparency.** A surface floating on the map that replaces
 *      its own opaque fill with a translucent one composites to the *backdrop's*
 *      colour, so the control disappears exactly as the pointer arrives. This is
 *      the bug that made the launcher's Search tile vanish into the basemap.
 *      Read from the composited pixel, because `getComputedStyle` cheerfully
 *      reports `rgba(255,255,255,0.06)` for a tile the driver sees as bare map.
 *   2. **No hover feedback at all** — the mirror image of (1).
 *   3. **Text contrast** against its real composited background.
 *   4. **Clipping** — content cut off by the viewport or by an overlay.
 *   5. **Overlap** — pairs of interactive elements that intersect.
 *   6. **Touch targets** below the project floor.
 *
 * Run: `node tools/ui-audit.mjs` (dev server on :5173, or set PROBE_BASE).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.PROBE_BASE ?? 'http://127.0.0.1:5173';
const OUT = join(here, '..', 'probe-shots');
const FIXTURE = join(here, '..', 'test', 'fixture.osm');
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = {
  phone: { width: 412, height: 915 },
  'phone-land': { width: 892, height: 412 },
  head: { width: 1280, height: 720 },
};

/** Injected before any page script, so `window.__audit` exists for every eval. */
const HELPERS = `
window.__audit = {
  parse(c) {
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
    if (hex) { const h = hex[1].length===3 ? hex[1].replace(/./g, x=>x+x) : hex[1];
      return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16), 1]; }
    const rgb = /^rgba?\\(\\s*([\\d.]+)\\s*,\\s*([\\d.]+)\\s*,\\s*([\\d.]+)\\s*(?:,\\s*([\\d.]+)\\s*)?\\)$/i.exec(c);
    if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4]===undefined?1:Number(rgb[4])];
    const n = (String(c).match(/[\\d.]+/g) || []).map(Number);
    return n.length >= 3 ? [n[0], n[1], n[2], n[3] === undefined ? 1 : n[3]] : [0,0,0,1];
  },
  over(f,b){ const a=f[3]; return [f[0]*a+b[0]*(1-a), f[1]*a+b[1]*(1-a), f[2]*a+b[2]*(1-a), 1]; },
  lum(c){ const ch=v=>{const s=v/255; return s<=0.04045?s/12.92:Math.pow((s+0.055)/1.055,2.4);};
    return 0.2126*ch(c[0])+0.7152*ch(c[1])+0.0722*ch(c[2]); },
  contrast(fg,bg){ const f=this.over(this.parse(fg),this.parse(bg)); const b=this.parse(bg);
    const l1=this.lum(f), l2=this.lum(b); return (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05); },
  /** Composite ancestor backgrounds down onto the root, ignoring \`el\` itself. */
  backdrop(el){
    let acc=[0,0,0,1]; const stack=[]; let n=el ? el.parentElement : null;
    while(n && n!==document.documentElement){
      const bg=getComputedStyle(n).backgroundColor;
      if(bg){ const p=this.parse(bg); if(p[3]>0){ stack.push(p); if(p[3]>=0.999) break; } }
      n=n.parentElement;
    }
    for(let i=stack.length-1;i>=0;i--) acc=this.over(stack[i],acc);
    return acc;
  },
  rgbStr(c){ return 'rgb(' + c.slice(0,3).map(v=>Math.round(v)).join(', ') + ')'; },
  textColor(el){ let n=el; while(n){ const c=getComputedStyle(n).color;
      if(c && !/rgba\\(0, 0, 0, 0\\)/.test(c)) return c; n=n.parentElement; } return '#ffffff'; },
  /**
   * The colour text in \`el\` is actually painted on.
   *
   * This starts at the element *itself* when it has an opaque background of its
   * own. An earlier version started at the parent, which is right for a label
   * inside a card and badly wrong for a label inside a filled button — and it
   * reported "Start — 1.19:1" on the preview screen, which is the near-black
   * page showing through a control that is in fact light blue. The fix is to
   * prefer the element's own fill, and fall back through ancestors only while
   * the fill is translucent.
   */
  ownBg(el){
    const bg = getComputedStyle(el).backgroundColor;
    const p = this.parse(bg);
    if (p[3] >= 0.999) return p;
    return this.backdrop(el);
  }
};
`;

const findings = [];
const seen = new Set();

function add(viewport, screen, severity, kind, msg) {
  const key = `${kind}|${msg}`;
  if (seen.has(key)) return;
  seen.add(key);
  findings.push({ viewport, screen, severity, kind, msg });
}

/* --------------------------------------------------------------- sampling */

async function sampler(page) {
  return async (x, y) => {
    const buf = await page.screenshot({ clip: { x, y, width: 1, height: 1 } });
    return page.evaluate(async (b64) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = 1; c.height = 1;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2]];
    }, buf.toString('base64'));
  };
}

const d3 = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
const str = (a) => `${a[0]}, ${a[1]}, ${a[2]}`;

/* ----------------------------------------------------------------- checks */

async function auditScreen(page, sample, vpName, screenName) {
  const add_ = (sev, kind, msg) => add(vpName, screenName, sev, kind, msg);

  /* 1 & 2 — hover transparency and missing hover feedback. */
  const hoverables = await page.$$('button, [role="button"], a[href], [role="radio"], [role="option"]');
  for (const el of hoverables) {
    const info = await el.evaluate(function (e) {
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      if (r.width < 8 || r.height < 8) return null;
      if (cs.visibility === 'hidden' || cs.display === 'none') return null;
      if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return null;

      // A point on the element's own surface, not on a descendant's glyph.
      let px = null;
      outer:
      for (let fy = 0.14; fy <= 0.86; fy += 0.18) {
        for (let fx = 0.14; fx <= 0.86; fx += 0.18) {
          const x = r.x + r.width * fx, y = r.y + r.height * fy;
          if (document.elementFromPoint(x, y) === e) { px = { x: Math.round(x), y: Math.round(y) }; break outer; }
        }
      }
      if (!px) return null;

      return {
        ...px,
        label: (e.getAttribute('aria-label') || e.textContent || e.className || e.tagName)
          .trim().replace(/\s+/g, ' ').slice(0, 40),
        cls: (e.className && typeof e.className === 'string' ? e.className : '').trim(),
        restDeclared: getComputedStyle(e).backgroundColor,
        restBackdrop: window.__audit.rgbStr(window.__audit.backdrop(e)),
      };
    });
    if (!info) continue;

    const alphaOf = (c) => {
      const n = (String(c).match(/[\d.]+/g) || []).map(Number);
      if (n.length < 4) return 1;
      return n[3];
    };
    const backdrop = await page.evaluate((c) => window.__audit.parse(c), info.restBackdrop);

    await page.mouse.move(1, 1);
    await page.waitForTimeout(90);
    const restPix = await sample(info.x, info.y);
    await page.mouse.move(info.x, info.y);
    await page.waitForTimeout(190);
    // Read the *hover* declaration while the pointer is genuinely on it.
    const hoverDeclared = await page.evaluate(
      ([x, y]) => getComputedStyle(document.elementFromPoint(x, y)).backgroundColor,
      [info.x, info.y],
    );
    const hovPix = await sample(info.x, info.y);
    await page.mouse.move(1, 1);

    const restVsBack = d3(restPix, backdrop);
    const hovVsBack = d3(hovPix, backdrop);

    /*
     * The invariant, checked on the declarations rather than inferred from a
     * backdrop sample.
     *
     * A first version compared pixels against a composited backdrop, and
     * reported the launcher's tiles as clean while the bug was live. The
     * backdrop helper walks *ancestors*, and the tiles' ancestors are all
     * transparent — the map is a sibling canvas, not a parent — so every
     * comparison was against black instead of against the basemap.
     *
     * `background` replaces the previous declaration; it does not composite the
     * new colour over the old one. So a control whose resting fill is opaque and
     * whose hover fill is translucent has, by construction, thrown its own
     * surface away and replaced it with a window onto whatever is behind it.
     * That holds whatever the backdrop happens to be, so it is testable without
     * knowing it.
     */
    const restOpaque = alphaOf(info.restDeclared) >= 0.99;
    const hoverTranslucent = alphaOf(hoverDeclared) < 0.5;

    if (restOpaque && hoverTranslucent) {
      add_('critical', 'hover-transparency',
        `"${info.label}" (.${(info.cls.split(/\s+/)[0]) || '?'}) has an opaque resting fill ` +
        `(${info.restDeclared}) but ${hoverDeclared} on hover. \`background\` replaces rather than ` +
        `composites, so hovering discards the surface: it renders ${str(restPix)} at rest and ` +
        `${str(hovPix)} under the pointer${restVsBack > 40 ? `, against a backdrop of ${str(backdrop)}` : ''}. ` +
        `Hover states on a surface that sits on the map must be opaque.`);
    } else if (restVsBack > 60 && hovVsBack <= Math.max(24, restVsBack * 0.35)) {
      // Still worth catching: the resting fill was translucent too, and hovering
      // takes it to the backdrop regardless of what it started as.
      add_('critical', 'hover-transparency',
        `"${info.label}" (.${(info.cls.split(/\s+/)[0]) || '?'}) renders ${str(restPix)} at rest — clearly its own ` +
        `surface — but ${str(hovPix)} on hover, which is its backdrop (${str(backdrop)}).`);
    } else if (d3(restPix, hovPix) <= 6 && /quick-tile|chip|choice|pill-btn|round-btn|floating-back|icon-btn|seg/.test(info.cls)) {
      add_('major', 'no-hover-feedback',
        `"${info.label}" (.${(info.cls.split(/\s+/)[0]) || '?'}) does not change at all on hover.`);
    }
  }

  /* 3 — text contrast against the real composited background. */
  const texts = await page.$$('p, span, div, button, h1, h2, h3, label, li, strong, code, input');
  for (const el of texts) {
    const t = await el.evaluate(function (e) {
      const own = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
      if (!own) return null;
      const r = e.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return null;
      if (r.bottom < 0 || r.top > innerHeight) return null;
      const cs = getComputedStyle(e);
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.1) return null;
      const fs = parseFloat(cs.fontSize);
      const fw = Number(cs.fontWeight) || 400;
      return {
        text: e.textContent.trim().replace(/\s+/g, ' ').slice(0, 34),
        color: window.__audit.textColor(e),
        bg: window.__audit.rgbStr(window.__audit.ownBg(e)),
        fontSize: fs,
        min: (fs >= 24 || (fs >= 18.66 && fw >= 700)) ? 3 : 4.5,
      };
    });
    if (!t) continue;
    const ratio = await page.evaluate(([c, b]) => window.__audit.contrast(c, b), [t.color, t.bg]);
    if (ratio < t.min) {
      add_(ratio < t.min - 1 ? 'critical' : 'major', 'contrast',
        `"${t.text}" — ${ratio.toFixed(2)}:1 on ${t.bg} at ${t.fontSize}px (needs ${t.min}:1).`);
    }
  }

  /* 4 — clipping at the viewport edge. */
  const clipped = await page.evaluate(() => {
    const out = [];
    const vw = innerWidth, vh = innerHeight;
    for (const e of document.querySelectorAll('*')) {
      const r = e.getBoundingClientRect();
      if (r.width < 3 || r.height < 3) continue;
      const cs = getComputedStyle(e);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      let p = e.parentElement, scrolls = false;
      while (p && p !== document.body) {
        const pcs = getComputedStyle(p);
        if (/(auto|scroll)/.test(pcs.overflowY + pcs.overflowX)) { scrolls = true; break; }
        p = p.parentElement;
      }
      if (scrolls) continue;
      const cb = r.bottom > vh + 1, cr = r.right > vw + 1;
      if (cb || cr) {
        const own = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
        if (!own && e.children.length) continue;
        out.push({
          cls: typeof e.className === 'string' ? e.className : e.tagName.toLowerCase(),
          text: (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40),
          over: Math.round(Math.max(r.bottom - vh, r.right - vw)),
          side: cb ? 'bottom' : 'right',
          y: Math.round(r.y), h: Math.round(r.height),
        });
      }
    }
    return out.slice(0, 10);
  });
  for (const c of clipped) {
    add_('critical', 'clipping',
      `.${(c.cls || '').split(/\s+/).slice(0, 2).join('.')} "${c.text}" runs ${c.over}px past the ${c.side} edge (y=${c.y}, h=${c.h}).`);
  }

  /* 4b — content clipped *inside* its own box.
   *
   * This is a separate failure from (4) and the audit missed it for a while: an
   * element can sit comfortably inside the viewport while clipping its own
   * children. A launcher tile with a fixed height and a two-line label measured
   * `scrollHeight - clientHeight === 10` and quietly ate the bottom of its own
   * "Not set" hint, while every viewport-edge check passed.
   *
   * `overflow: hidden` is what turns this from "content is taller than the box"
   * into "content is invisible", so it is the case worth reporting. Scrollable
   * containers are excluded: scrolling is the declared answer to tall content.
   */
  const selfClipped = await page.evaluate(() => {
    const out = [];
    for (const e of document.querySelectorAll('*')) {
      const cs = getComputedStyle(e);
      if (!/hidden|clip/.test(cs.overflowX + cs.overflowY)) continue;
      if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') continue;
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      // An element that ellipsises is *declaring* that it truncates, and the
      // truncation is visible to the reader as "…". `scrollWidth > clientWidth` is
      // simply how that is implemented, so reporting it flags the mechanism
      // rather than a defect — and the first run of this check was nothing but
      // ellipsised labels. Only *undeclared* clipping is a defect.
      const declares = cs.textOverflow === 'ellipsis';
      const overY = declares ? 0 : e.scrollHeight - e.clientHeight;
      const overX = declares ? 0 : e.scrollWidth - e.clientWidth;
      if (overY < 2 && overX < 2) continue;
      if (e.clientHeight < 8 || e.clientWidth < 8) continue;
      out.push({
        cls: typeof e.className === 'string' && e.className ? e.className : e.tagName.toLowerCase(),
        text: (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40),
        overY, overX,
      });
    }
    return out.slice(0, 10);
  });
  for (const c of selfClipped) {
    add_('critical', 'self-clipping',
      `.${c.cls.split(/\s+/)[0]} "${c.text}" clips its own content: ${c.overY}px vertically` +
      `${c.overX > 1 ? `, ${c.overX}px horizontally` : ''} — the box is \`overflow: hidden\`, so that content is invisible rather than scrollable.`);
  }

  /* 5 — overlapping interactive elements. */
  const overlaps = await page.evaluate(() => {
    const out = [];
    const items = [...document.querySelectorAll('button, input, [role="button"], [role="radio"], [role="option"]')]
      .map((e) => ({ e, r: e.getBoundingClientRect(), cs: getComputedStyle(e) }))
      .filter(({ r, cs }) => r.width > 3 && r.height > 3 && cs.visibility !== 'hidden' && cs.display !== 'none');
    const name = (e) => (e.getAttribute('aria-label') || e.textContent || e.className || e.tagName)
      .trim().replace(/\s+/g, ' ').slice(0, 26);
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        if (a.e.contains(b.e) || b.e.contains(a.e)) continue;
        const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (w > 4 && h > 4) out.push({ a: name(a.e), b: name(b.e), w: Math.round(w), h: Math.round(h) });
      }
    }
    return out.slice(0, 8);
  });
  for (const o of overlaps) add_('critical', 'overlap', `"${o.a}" overlaps "${o.b}" by ${o.w}x${o.h}px.`);

  /* 6 — touch targets below the floor. */
  const small = await page.evaluate(() => {
    const out = [];
    for (const e of document.querySelectorAll('button, [role="button"], [role="radio"], [role="option"]')) {
      const r = e.getBoundingClientRect();
      if (r.width < 3 || r.height < 3) continue;
      const cs = getComputedStyle(e);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      // Inline links inside prose are not controls.
      if (cs.backgroundColor === 'rgba(0, 0, 0, 0)' && Number(cs.paddingLeft) < 8) continue;
      if (r.height < 56 || r.width < 32) {
        out.push({
          label: (e.getAttribute('aria-label') || e.textContent || e.className).trim().replace(/\s+/g, ' ').slice(0, 30),
          cls: typeof e.className === 'string' ? (e.className.split(/\s+/)[0] || e.tagName) : e.tagName,
          w: Math.round(r.width), h: Math.round(r.height),
        });
      }
    }
    return out.slice(0, 10);
  });
  for (const s of small) add_('minor', 'touch-target', `.${s.cls} "${s.label}" is ${s.w}x${s.h}px (project floor is 76dp tall).`);
}

/* ------------------------------------------------------------------- main */

for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({
    viewport: vp,
    permissions: ['geolocation'],
    geolocation: { latitude: 51.5215, longitude: -1.4175 },
    locale: 'en-GB',
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });
  await page.addInitScript(HELPERS);
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1800);
  const sample = await sampler(page);

  const log = [];
  const visit = async (name) => {
    const before = findings.length;
    await auditScreen(page, sample, vpName, name);
    await page.mouse.move(1, 1);
    await page.screenshot({ path: join(OUT, `audit-${vpName}-${name}.png`) });
    const n = findings.length - before;
    log.push(`  ${name.padEnd(15)} ${n ? `${n} finding(s)` : 'clean'}`);
    return n;
  };
  const goHome = async () => {
    // Back walks out of nested screens, but the navigation screen has no Back
    // control — it has Exit. Without that fallback the walk stopped on the
    // navigation screen and every later lookup for "Settings" silently missed,
    // so settings, engines and regions were never audited at all.
    for (let i = 0; i < 6; i++) {
      const exit = await page.$('button[aria-label="Exit navigation"]');
      if (exit) { await exit.click().catch(() => {}); await page.waitForTimeout(700); continue; }
      const b = await page.$('button[aria-label="Back"]');
      if (!b) break;
      await b.click().catch(() => {});
      await page.waitForTimeout(400);
    }
    await page.waitForTimeout(400);
  };
  const click = async (sel, wait = 900) => {
    const el = await page.$(sel);
    if (!el) return false;
    await el.click().catch(() => {});
    await page.waitForTimeout(wait);
    return true;
  };

  await visit('home');

  // Import a map so the "loaded" variants and search are reachable.
  if (await click('button:has-text("Import .osm file")', 500)) {
    const input = await page.$('input[type=file]');
    if (input) {
      await input.setInputFiles(FIXTURE);
      await page.waitForFunction(
        () => !document.body.innerText.includes('Parsing') && !document.body.innerText.includes('Building graph'),
        { timeout: 40000 },
      );
      await page.waitForTimeout(1300);
    }
  }
  await goHome();
  await visit('home-loaded');

  if (await click('.search-field', 500)) {
    await visit('search-empty');
    const si = await page.$('.inline-search input');
    if (si) { await si.fill('Elbow'); await page.waitForTimeout(1000); }
    await visit('search-results');

    if (await click('.result-row', 2600)) {
      await visit('preview');
      if (await click('button.primary-btn', 2400)) {
        await visit('navigating');
        if (await click('button[aria-label="Map layers"]', 600)) {
          await visit('layers');
          await page.keyboard.press('Escape');
          await page.waitForTimeout(400);
        }
        if (await click('button:has-text("Steps")', 800)) {
          await visit('steps');
          await goHome();
        } else {
          await goHome();
        }
      } else {
        await goHome();
      }
    } else {
      await goHome();
    }
  } else {
    await goHome();
  }

  if (await click('button[aria-label="Settings"]', 700)) {
    await visit('settings');
    if (await click('.hint-card', 800)) await visit('engines');
    await goHome();
  }
  if (await click('button[aria-label="Regions"]', 1500)) {
    await visit('regions');
    await goHome();
  }

  console.log(`\n########## ${vpName} (${vp.width}x${vp.height}) ##########`);
  console.log(log.join('\n'));
  if (errs.length) console.log('  page errors:', errs.slice(0, 5));
  await browser.close();
}

writeFileSync(join(OUT, 'audit.json'), JSON.stringify(findings, null, 2));

const sev = { critical: [], major: [], minor: [] };
for (const f of findings) sev[f.severity].push(f);
console.log(`\n================ ${findings.length} distinct findings ================`);
for (const s of ['critical', 'major', 'minor']) {
  if (!sev[s].length) continue;
  console.log(`\n--- ${s.toUpperCase()} (${sev[s].length}) ---`);
  for (const f of sev[s]) console.log(`  [${f.kind}] (${f.screen}) ${f.msg}`);
}
console.log(`\nfull report: ${join(OUT, 'audit.json')}`);