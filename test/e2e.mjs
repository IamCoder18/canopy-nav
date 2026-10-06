/**
 * End-to-end smoke test.
 *
 * Drives the real built app in a browser: imports an .osm file, searches the
 * offline gazetteer, computes an offline route, and starts navigation. This is
 * the only test that exercises the worker, the region store, the router and the
 * React screens together — unit tests can't catch a wiring regression between
 * them.
 *
 * Run with: node test/e2e.mjs
 * Requires `npm run build` first and the preview server running on E2E_PORT.
 */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.E2E_PORT ?? '4192';
const BASE = `http://localhost:${PORT}`;
const SHOTS = join(__dirname, '..', 'e2e-screenshots');
mkdirSync(SHOTS, { recursive: true });

/**
 * Move a device, so the app sees the fix *stream* a real driver produces.
 *
 * Two measured facts make this necessary, and neither is obvious from the API.
 *
 * Chromium fires `watchPosition` exactly once per `setGeolocation` call: 0 fixes
 * before the change, 1 after one call, 9 after eight. The off-route tracker needs
 * two fixes more than `CONFIRM_WINDOW_MS` apart before it leaves `suspect`, so a
 * single call leaves the driver permanently suspect and no reroute is attempted.
 *
 * And the fix must *change*: §13.5's stale-position guard compares raw fixes and
 * holds a stationary driver at "waiting for a position update" indefinitely — which
 * is correct, since a car stopped at a red light should not be told it is off route
 * forever — so a device parked at one position never reaches `beginReroute` either.
 *
 * Each tick therefore walks a few metres, which is roughly 4 m/s.
 */
async function drive(ctx, at, each, ticks = 34) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let prev = { latitude: at.latitude, longitude: at.longitude, accuracy: 8 };
  for (let i = 0; i < ticks; i++) {
    await ctx.setGeolocation(prev);
    await sleep(500);
    await each?.();
    prev = {
      latitude: at.latitude + (i + 1) * 0.00004,
      longitude: at.longitude + (i + 1) * 0.00005,
      accuracy: 8,
    };
  }
  await ctx.setGeolocation(prev);
}

/** Which fixture to import; `.pbf` is the format Geofabrik actually publishes. */
const FIXTURE = process.env.E2E_FIXTURE ?? 'fixture.osm';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({
  // Prefer a Playwright-managed Chromium so this works in CI, but fall back to
  // a system Chrome for local runs where nothing has been downloaded.
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--no-sandbox'],
});
// The fixture sits at lon -1.4 / lat 51.5 (near Edinburgh). Without this the
// app falls back to a simulated Calgary fix and a cross-ocean route is
// correctly refused, so pin the "device" inside the fixture's bounds. This
// also exercises the real geolocation path rather than the fallback.
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  permissions: ['geolocation'],
  geolocation: { latitude: 51.503, longitude: -1.399, accuracy: 8 },
});
const page = await context.newPage();

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

/**
 * Successful tile responses.
 *
 * The only in-suite signal that the map actually drew something rather than
 * merely existing at the right size — an element can have correct geometry and
 * still be painting an empty canvas.
 */
const tileRequests = [];
page.on('response', (r) => {
  if (/tiles\.openfreemap|\/tiles\/|\.pbf$/.test(r.url()) && r.ok()) tileRequests.push(r.url());
});

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  /* ---------------- the map actually draws ---------------- */
  // This block exists because of a real regression. Splitting the bundle put
  // MapLibre's stylesheet in a lazily-loaded chunk, so it arrived after the
  // entry CSS; `.maplibregl-map { position: relative }` and
  // `.map { position: absolute; inset: 0 }` tie on specificity, so stylesheet
  // order decided the winner and the map's won. The container collapsed to 0px,
  // the canvas fell back to 412x300, and **the map rendered nothing**.
  //
  // The rest of this suite passed throughout. It asserts overflow and text
  // visibility, neither of which notices an empty div — which is the whole point:
  // a gate that cannot see the primary feature failing is not a gate.
  //
  // Two independent signals, because either alone has a way of being fooled: the
  // element geometry, and whether the tile CDN was actually asked for anything.
  console.log('\nmap');
  const mapState = await page.evaluate(() => {
    const host = document.querySelector('.map-host');
    const map = document.querySelector('.map');
    const canvas = document.querySelector('.maplibregl-canvas');
    const box = (e) => {
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    };
    return {
      host: box(host),
      map: box(map),
      canvas: box(canvas),
      backing: canvas ? { w: canvas.width, h: canvas.height } : null,
      vw: window.innerWidth,
      vh: window.innerHeight,
    };
  });
  const tiles = tileRequests.length;
  check('map container fills the viewport',
    mapState.map !== null && mapState.map.w >= mapState.vw - 1 && mapState.map.h >= mapState.vh - 1,
    JSON.stringify(mapState.map));
  check('map canvas is full size, not the 412x300 default',
    mapState.backing !== null && mapState.backing.w >= mapState.vw && mapState.backing.h >= mapState.vh,
    JSON.stringify(mapState.backing));
  check('map tiles were fetched and drawn', tiles > 0, `${tiles} tile responses`);
  check('map attribution is displayed (ODbL requires it)',
    await page.evaluate(() => {
      const a = document.querySelector('.maplibregl-ctrl-attrib');
      return !!a && /OpenStreetMap/i.test(a.textContent ?? '') && a.getBoundingClientRect().width > 0;
    }));


  /* ---------------- import an .osm file ---------------- */
  console.log('\nimport');
  await page.click('text=Import .osm file');
  await page.waitForTimeout(600);
  const input = await page.$('input[type=file]');
  check('file input present', !!input);
  await input.setInputFiles(join(__dirname, FIXTURE));

  // The worker parses and builds the graph; wait for the region count to land.
  await page.waitForFunction(
    () => !document.body.innerText.includes('Parsing') &&
          !document.body.innerText.includes('Building graph'),
    { timeout: 30000 },
  );
  await page.waitForTimeout(1200);
  const afterImport = await page.evaluate(() => document.body.innerText);
  check(`map registered from ${FIXTURE}`, !/No map loaded/.test(afterImport), afterImport.match(/[\d,]+ routable ways/)?.[0] ?? '');
  // Captured here so the streaming-import check later can compare against the
  // whole-file parse of the same fixture.
  const wholeFileWays = afterImport.match(/([\d,]+) routable ways/)?.[1] ?? '';
  await page.screenshot({ path: join(SHOTS, '1-imported.png') });

  /* ---------------- offline search ---------------- */
  console.log('\nsearch (offline gazetteer)');
  await page.click('.search-field');
  await page.waitForTimeout(500);
  await page.fill('.inline-search input', 'Elbow');
  await page.waitForTimeout(900);
  const results = await page.evaluate(() =>
    [...document.querySelectorAll('.result-row')].map((r) => r.innerText.split('\n')[0]),
  );
  check('gazetteer returns offline hits', results.length > 0, results.join(', '));
  await page.screenshot({ path: join(SHOTS, '2-search.png') });

  /* ---------------- route + navigate ---------------- */
  console.log('\nroute');
  if (results.length) {
    await page.click('.result-row');
    await page.waitForTimeout(2500);
    const preview = await page.evaluate(() => document.body.innerText);
    check('route preview shown', /Start/.test(preview));
    check('preview reports engine', /Offline \.osm/.test(preview), preview.match(/Engine\s*(\w[\w .-]*)/)?.[1] ?? '');
    check('preview reports a distance', /\d+\s*(m|km|ft|mi)/.test(preview));
    await page.screenshot({ path: join(SHOTS, '3-preview.png') });

    await page.click('button.primary-btn');
    await page.waitForTimeout(2000);
    const nav = await page.evaluate(() => document.body.innerText);
    check('navigation screen active', /Steps/.test(nav) && /Exit/.test(nav));
    check('ETA bar shows duration', /\d+\s*(min|hr)/.test(nav), nav.match(/\d+\s*(min|hr)[^\n]*/)?.[0] ?? '');
    await page.screenshot({ path: join(SHOTS, '4-navigating.png') });

    // steps list
    const stepsBtn = await page.$('button:has-text("Steps")');
    if (stepsBtn) {
      await stepsBtn.click();
      await page.waitForTimeout(900);
      const steps = await page.evaluate(() => document.body.innerText);
      check('steps list renders', /Route steps/i.test(steps));
      await page.screenshot({ path: join(SHOTS, '5-steps.png') });
    }

    /* ---- provenance: who actually answered ---- */
    // The claim under test is that the app attributes the route to the engine
    // that served it and admits the offline engine has no turn-by-turn. A route
    // from the local engine must therefore say so rather than borrowing the
    // selected engine's name.
    console.log('\nprovenance');
    for (let i = 0; i < 4; i++) {
      if (await page.$('button[aria-label="Settings"]')) break;
      const back = await page.$('button[aria-label="Back"]');
      const exit = await page.$('button[aria-label="Exit navigation"]');
      if (back) await back.click();
      else if (exit) await exit.click();
      else break;
      await page.waitForTimeout(700);
    }
    if (await page.$('button[aria-label="Settings"]')) {
      await page.click('button[aria-label="Settings"]');
      await page.waitForTimeout(400);
      const prov = await page.evaluate(() => document.body.innerText);
      check('settings reports the engine that answered', /Last route answered by/.test(prov),
        prov.match(/Last route answered by[^\n]*/)?.[0] ?? '');

      const enginesLink = await page.$('.hint-card');
      if (enginesLink) {
        await enginesLink.click();
        await page.waitForTimeout(600);
        const trace = await page.evaluate(() => document.body.innerText);
        check('trace names the answering engine', /Answered by/.test(trace),
          trace.match(/Answered by[^\n]*/)?.[0] ?? '');
        // The offline engine produces no maneuvers; claiming otherwise would be
        // the exact dishonesty this surface exists to prevent.
        check('trace admits when turn-by-turn is unavailable',
          /turn-by-turn available|no turn-by-turn from this engine/.test(trace),
          trace.match(/(no turn-by-turn from this engine|turn-by-turn available)/)?.[0] ?? '');
        check('trace shows a total time', /\d+\s*ms total/.test(trace),
          trace.match(/\d+\s*ms total/)?.[0] ?? '');
        await page.screenshot({ path: join(SHOTS, '10-engine-trace.png') });
      }
    }
  }

  /* ---------------- rerouting: the flow requirement #18 names ---------------- */
  // Requirement #18 asks for every screen and function verified, and names
  // "rerouting mid-turn" as the gap. This runs on a route of its own so the
  // navigation screen is live throughout — the reroute policy only exists while
  // `navActive`, and unwinding to home first would test nothing.
  //
  // The driver is walked off the route line by moving the geolocation fix, which
  // is the only position input the app trusts. The invariant under test is that
  // guidance survives: a lost driver cannot also be left without directions.
  console.log('\nrerouting');
  {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    const importInput = await page.$('input[type=file]');
    if (importInput) {
      await importInput.setInputFiles(join(__dirname, FIXTURE));
      await page.waitForFunction(
        () => !document.body.innerText.includes('Parsing') && !document.body.innerText.includes('Building graph'),
        { timeout: 30000 },
      );
      await page.waitForTimeout(800);
    }
    await page.click('.search-field').catch(() => {});
    await page.waitForTimeout(400);
    await page.fill('.inline-search input', 'Elbow');
    await page.waitForTimeout(1200);
    const hit = await page.$('.result-row');
    if (hit) {
      await hit.click();
      await page.waitForTimeout(2500);
      const start = await page.$('button.primary-btn');
      if (start) {
        await start.click();
        await page.waitForTimeout(1500);

        const before = await page.evaluate(() => document.body.innerText);
        check('navigation is live before the deviation', /Steps/.test(before) && /Exit/.test(before));

        // Well off the line, held there past the 6 s confirmation window.
        await context.setGeolocation({ latitude: 51.5400, longitude: -1.3990, accuracy: 8 });
        await page.waitForTimeout(10000);

        const during = await page.evaluate(() => document.body.innerText);
        // "You have left the route" replaced "6978332 m off the route": the raw
        // metre count was unformatted, seven digits, and always metric.
        check('going off-route is reported to the driver',
          /left the route|off the route|off route|new way|rejoining/i.test(during),
          during.match(/[^\n]*(left the route|off the route|off route|new way|rejoining)[^\n]*/i)?.[0] ?? '');
        check('the deviation is never a raw unrounded metre count',
          !/\d{4,}\s*m\b/.test(during),
          during.match(/\d{4,}\s*m\b/)?.[0] ?? '');
        check('guidance survives the reroute attempt',
          /Steps/.test(during) && /Exit/.test(during));
        await page.screenshot({ path: join(SHOTS, '11-offroute.png') });

        // Back on the line: the notice must clear rather than stick.
        await context.setGeolocation({ latitude: 51.503, longitude: -1.399, accuracy: 8 });
        await page.waitForTimeout(5000);
        const after = await page.evaluate(() => document.body.innerText);
        check('the notice clears once back on route',
          !/finding a new way|rejoining the route/i.test(after),
          after.match(/[^\n]*(finding a new way|rejoining)[^\n]*/i)?.[0] ?? 'clear');
      }
    }
  }

  /* ---------------- an engine that cannot route (§7 gap 5) ---------------- */
  //
  // **This block does not yet close §7 gap 5, and it is here because of why.**
  //
  // Two browser attempts preceded it, both recorded in §7 gap 5 rather than deleted.
  // Intercepting Valhalla does not work: reroutes use `enginePlan`, whose first entry
  // is the *offline* engine on the default selection, so the imported fixture answers
  // them — the four checks written that way passed with the interception **removed**,
  // because nothing had failed. And a single `setGeolocation` does not work either:
  // Chromium fires `watchPosition` once per call, so a parked device never leaves
  // `suspect` and no reroute is attempted at all. That also means the pre-existing
  // off-route checks in this file assert only that the app says "you have left the
  // route" — true, and weaker than it looks.
  //
  // What a *moving* fix stream does reach is a real reroute attempt, and that is worth
  // asserting because nothing asserted it before. What it cannot yet reach is a
  // *distinguishable failure*: a destination outside the extract and one inside it
  // produce identical notice sequences, so the failure banner is not observable from
  // outside. Only the claims that hold are checked, and none of them pretends to be
  // the failure path.
  console.log('\nrerouting from a moving device');
  {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    const importInput = await page.$('input[type=file]');
    if (importInput) {
      await importInput.setInputFiles(join(__dirname, FIXTURE));
      await page.waitForFunction(
        () => !document.body.innerText.includes('Parsing') && !document.body.innerText.includes('Building graph'),
        // Same signature as the waits above: options are the *third* argument.
        undefined,
        { timeout: 30000 },
      );
      await page.waitForTimeout(800);
    }

    await page.click('.search-field').catch(() => {});
    await page.waitForTimeout(400);
    await page.fill('.inline-search input', 'Elbow');
    await page.waitForTimeout(1200);
    const hit = await page.$('.result-row');
    if (hit) {
      await hit.click();
      await page.waitForTimeout(2500);
      const start = await page.$('button.primary-btn');
      if (start) {
        await start.click();
        await page.waitForTimeout(1500);
        check('a routable trip starts before the device is driven off it',
          /Steps/.test(await page.evaluate(() => document.body.innerText)));

        // Watch the notice while driving, so the transition is captured rather than
        // sampled once at the end -- the reroute wording exists for well under a
        // second in a healthy run and a single read misses it entirely.
        const seen = [];
        const sample = async () => {
          const n = await page.evaluate(() => {
            const el = [...document.querySelectorAll('*')].find((e) => e.children.length === 0
              && /left the route|finding a new way|rejoining|settling|no route|offline map/i
                .test(e.textContent || ''));
            return el ? el.textContent.trim().slice(0, 70) : '';
          });
          if (n && seen[seen.length - 1] !== n) seen.push(n);
        };
        await sample();
        await drive(context, { latitude: 51.5400, longitude: -1.3990 }, sample);

        // The off-route notice appears from a moving device -- which a single
        // `setGeolocation` cannot produce, and which is the reason every off-route
        // check above was passing without a reroute ever being attempted.
        check('a moving driver off the route is told, and kept their guidance',
          seen.some((s) => /left the route/i.test(s))
          && /Steps/.test(await page.evaluate(() => document.body.innerText)),
          seen.join(' -> ') || 'no notice seen');
        // The attempt reaches the backoff window: "settling" is the state between
        // confirming the deviation and the request going out. Asserting it *not* to
        // appear would be asserting a timing this suite does not own.
        check('the reroute is not reported as succeeded while the driver is off it',
          !seen.some((s) => /rejoining/i.test(s)),
          seen.join(' -> '));
        await page.screenshot({ path: join(SHOTS, '12-reroute-attempt.png') });
      }
    }
  }

  /* ---------------- search after a loaded region ---------------- */
  console.log('\nsearch with a loaded region');
  // Back out to home. The stack is steps -> navigating -> home, and each screen
  // exposes a different control, so unwind it rather than assuming one button.
  for (let i = 0; i < 4; i++) {
    if (await page.$('.search-field')) break;
    const exit = await page.$('button[aria-label="Exit navigation"]');
    const back = await page.$('button[aria-label="Back"]');
    if (exit) await exit.click();
    else if (back) await back.click();
    else break;
    await page.waitForTimeout(700);
  }
  await page.waitForSelector('.search-field', { timeout: 10000 });
  await page.click('.search-field');
  await page.waitForTimeout(400);
  await page.fill('.inline-search input', 'Elbow');
  await page.waitForTimeout(900);
  const multi = await page.evaluate(() => document.body.innerText);
  check('search works with a loaded region', /Elbow St/.test(multi));
  const stillOnSearch = await page.evaluate(() => !!document.querySelector('.inline-search'));
  check('still on the search screen', stillOnSearch);

  // category chips derived from the downloaded gazetteer
  await page.fill('.inline-search input', '');
  await page.waitForTimeout(700);
  const chips = await page.evaluate(() =>
    [...document.querySelectorAll('.chip')].map((c) => c.textContent.trim()),
  );
  check('browse chips rendered from offline data', chips.length > 0, chips.join(', '));
  if (chips.length) {
    await page.click('.chip');
    await page.waitForTimeout(900);
    const afterChip = await page.evaluate(() => document.querySelectorAll('.result-row').length);
    check('chip selects a category and returns results', afterChip > 0, `${afterChip} rows`);
  }
  await page.fill('.inline-search input', '');
  await page.waitForTimeout(400);
  // leave the search screen so the regions block starts from home
  const backBtn = await page.$('button[aria-label="Back"]');
  if (backBtn) await backBtn.click();
  await page.waitForTimeout(700);

  /* ---------------- regions ---------------- */
  console.log('\nregions');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  const regionTile = await page.$('.quick-tile:has-text("Regions")');
  check('regions tile on home', !!regionTile);
  if (regionTile) {
    await regionTile.click();
    await page.waitForTimeout(1200);
    const regionsText = await page.evaluate(() => document.body.innerText);
    check('regions screen lists a catalogue', /Alberta/.test(regionsText) && /British Columbia/.test(regionsText));
    await page.screenshot({ path: join(SHOTS, '6-regions.png') });
  }

  /* ---------------- persistence across a reload ---------------- */
  console.log('\npersistence');
  // Re-parsing a province takes tens of seconds, so imported regions are cached
  // as parsed datasets. A reload must bring it back with no re-import, and the
  // restored region must be immediately usable.
  // A region was imported earlier in this run, so it is already cached. A
  // reload must bring it back from IndexedDB with no re-import -- which is the
  // whole point of caching: re-parsing takes tens of seconds.
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  const beforeReload =
    (await page.evaluate(() => document.body.innerText)).match(/[\d,]+ routable ways/)?.[0] ?? '';
  check('a region is loaded before the reload', beforeReload !== '', beforeReload);

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(3500);
  const afterReload =
    (await page.evaluate(() => document.body.innerText)).match(/[\d,]+ routable ways/)?.[0] ?? '';
  check(
    'region survives a reload without re-importing',
    afterReload !== '' && afterReload === beforeReload,
    `${beforeReload || 'none'} -> ${afterReload || 'nothing restored'}`,
  );

  // ...and the restored gazetteer is usable
  await page.click('.search-field');
  await page.waitForTimeout(400);
  await page.fill('.inline-search input', 'Elbow');
  await page.waitForTimeout(900);
  const restoredRows = await page.evaluate(() => document.querySelectorAll('.result-row').length);
  check('restored region is searchable', restoredRows > 0, `${restoredRows} rows`);
  await page.screenshot({ path: join(SHOTS, '7-restored.png') });

  /* ---------------- streaming import ---------------- */
  // The XML path now streams the File rather than reading it whole, so this
  // exercises the code a real import takes: `File.stream()` -> transferred over
  // postMessage -> chunked element-boundary parse inside the worker. The graph
  // from the first import in this run is the control: the streamed import must
  // produce the same routable-way count.
  console.log('\nstreaming import');
  {
    // Reset to a known screen: the previous section leaves the regions screen
    // mounted, where there is no Settings button to click.
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    // Re-import through the UI: the file arrives as a real `File`, which is the
    // only thing that has `.stream()`.
    await page.click('button[aria-label="Settings"]').catch(() => {});
    await page.waitForTimeout(500);
    const importLink = await page.$('button:has-text("Import .osm")');
    if (importLink) await importLink.click().catch(() => {});
    await page.waitForTimeout(600);

    const input = await page.$('input[type=file]');
    if (input) {
      await input.setInputFiles(join(__dirname, FIXTURE)).catch(() => {});
      await page.waitForFunction(
        () => !document.body.innerText.includes('Parsing')
             && !document.body.innerText.includes('Building graph'),
        { timeout: 30000 },
      ).catch(() => {});
      await page.waitForTimeout(1500);
    }
    const after = await page.evaluate(() => ({
      ways: document.body.innerText.match(/([\d,]+) routable ways/)?.[1] ?? '',
      err: document.querySelector('.error-card')?.textContent ?? '',
    }));
    check('a streamed import builds the same graph as the whole-file one',
      after.ways !== '' && after.ways === wholeFileWays,
      `${wholeFileWays || '?'} -> ${after.ways || 'none'}`);
    check('a streamed import raises no error',
      !/error|failed|could not|cloned|transferred/i.test(after.err),
      after.err.slice(0, 80));
  }

  /* ---------------- download availability ---------------- */
  // The catalogue is probed on mount so dead URLs can be greyed out. With no
  // network this must resolve to "unavailable" rather than hanging or throwing,
  // which is the behaviour a driver on a dead link actually sees.
  console.log('\ncatalogue probe');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  const regionTile2 = await page.$('.quick-tile:has-text("Regions")');
  if (regionTile2) {
    await regionTile2.click();
    // Wait for the probe to settle, rather than sleeping — and poll for the
    // *presence* of a settled state, not its absence.
    //
    // The probe used to be one `Promise.all` over every province and state at
    // once, so a fixed 12s happened to be enough. It is now four at a time with a
    // 10s deadline each, which is the right trade — the screen no longer fires
    // dozens of parallel requests every time it opens — and the wall-clock is
    // now "however long the slow ones take".
    //
    // The first version of this polled `!/Checking…/.test(innerText)`, which
    // matched *immediately*: `RegionsScreen` is `React.lazy`, so for the first
    // few hundred milliseconds the body contains no catalogue at all and the
    // string is absent for the wrong reason. The suite then counted zero
    // download controls and reported the catalogue as empty.
    //
    // The second version polled for *decided labels* instead, which fixed the
    // empty-read but introduced a worse problem: "every catalogue row has a
    // download control" became a claim about the network. A row still reading
    // "Checking…" was counted as having no control at all, so on a slow link the
    // suite reported a UI defect it had just timed out on. Measured: the same
    // commit passed and failed across runs with nothing changed but how long
    // Geofabrik took to answer sixteen HEAD requests.
    //
    // The control check is structural — one `.pill-btn` inside each row's action
    // cluster — so it is true or false regardless of what the network does. The
    // probe settling is a separate claim, with its own check.
    try {
      // Same signature, and the same explicit `undefined`: passing the options as
      // the argument silently reverts to Playwright's 30 s default.
      await page.waitForFunction(
        () => document.querySelectorAll('.region-actions .pill-btn').length >= 16,
        undefined,
        // `polling: 500`, not the default animation-frame polling: with the OSM
        // worker and MapLibre both busy, rAF ticks are irregular enough to make a
        // 60s timeout behave unpredictably.
        { timeout: 60000, polling: 500 },
      );
    } catch {
      // Reported below by the row count, which is the more useful detail.
    }
    // Then wait for the probe itself to settle, separately and with its own budget.
    //
    // The budget is derived from the app's, not guessed: `RegionsScreen` stops
    // waiting for stragglers after 75 s and reports whatever it has, so the screen
    // cannot stay undecided longer than that by construction. 150 s is that bound
    // plus slack for a loaded machine — not a number raised until it stopped
    // happening.
    //
    // This budget was 90 s and it flaked roughly one run in four, which is worth
    // recording because the cause was not latency. `setAvailability` is called once
    // after every worker finishes, so the rows are atomic: a probe that took 95 s
    // showed sixteen "Checking…" and zero decided rows, which is indistinguishable
    // on screen from a hang. The app is now bounded; this follows from that.
    //
    // `page.waitForFunction(pageFunction, arg, options)` — the options are the
    // *third* argument. This passed them as `arg`, so the call used Playwright's
    // default 30 s timeout and the measurement below ran while the probe was still
    // legitimately going. It showed up as a wall-clock 30003 ms on every failing
    // run, which is a number no plausible probe would produce; the same class of
    // mistake as §12.8, where the harness was fine and the thing it measured was
    // not. `undefined` is the explicit "no argument" below.
    try {
      await page.waitForFunction(
        () => ![...document.querySelectorAll('.pill-btn')]
          .some((b) => b.textContent.trim() === 'Checking…'),
        undefined,
        { timeout: 150000, polling: 500 },
      );
    } catch {
      // Reported by the probe-settles check below.
    }
    const catalogue = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.pill-btn')].map((b) => b.textContent.trim());
      return {
        provinces: document.body.innerText.includes('Alberta') && document.body.innerText.includes('British Columbia'),
        states: document.body.innerText.includes('California'),
        // The structural count: a download control in every row's action cluster,
        // whatever state the reachability probe is in.
        downloadButtons: document.querySelectorAll('.region-actions .pill-btn').length,
        // And the rows the probe has actually decided, as a distinct fact.
        decided: rows.filter((t) => /^(Download|Unavailable|Downloading)/.test(t)).length,
        pending: rows.filter((t) => t === 'Checking…').length,
        // textContent concatenates an icon's text, so match the whole trimmed
        // string rather than a prefix.
        rows: [...document.querySelectorAll('.pill-btn')]
          .map((b) => ({
            label: b.textContent.trim(),
            // `aria-disabled`, not `disabled`. A `disabled` button is removed from
            // the tab order, so the row's explanation — which is the only thing
            // it has to say — could never be reached by a keyboard user or read
            // aloud. The label below carries that reason, and it is only useful
            // if the control is reachable.
            disabled: b.getAttribute('aria-disabled') === 'true',
            nativeDisabled: b.disabled,
            name: b.getAttribute('aria-label') ?? '',
            focusable: b.tabIndex >= 0,
          }))
          .filter((r) => r.label === 'Download' || r.label === 'Unavailable'
                      || r.label === 'Downloading…'),
      };
    });
    // The label and the affordance have to agree, whatever the network is doing.
    catalogue.consistent = catalogue.rows.every(
      (r) => (r.label === 'Unavailable') === r.disabled);
    catalogue.allFocusable = catalogue.rows.every((r) => r.focusable && !r.nativeDisabled);
    catalogue.allExplain = catalogue.rows
      .filter((r) => r.disabled)
      .every((r) => r.name.length > r.label.length);
    catalogue.detail = catalogue.rows
      .filter((r) => r.label === 'Unavailable' || r.disabled)
      .slice(0, 3).map((r) => `${r.label}/${r.disabled ? 'aria-disabled' : 'enabled'}`)
      .join(', ') || 'all downloadable';
    check('catalogue lists Canadian provinces', catalogue.provinces);
    check('catalogue lists US states', catalogue.states);
    check('every catalogue row has a download control', catalogue.downloadButtons >= 16,
      `${catalogue.downloadButtons} controls`);
    // Separate claim, separate check: the reachability probe has to *settle*. A
    // screen that shows "Checking…" forever tells the driver nothing about whether
    // their download will work, which is what the probe exists to answer.
    check('the availability probe settles', catalogue.pending === 0,
      `${catalogue.decided} decided, ${catalogue.pending} still checking`);
    // A row labelled "Unavailable" must not be activatable, and a downloadable row
    // must be -- the label and the affordance have to agree, whatever the network
    // happens to be doing.
    check('unavailable rows are inert and available rows are not', catalogue.consistent,
      catalogue.detail);
    // And the reason must be reachable: an inert row is useless if the sentence
    // explaining why cannot be read.
    check('unavailable rows stay focusable and carry their reason', catalogue.allFocusable && catalogue.allExplain,
      `${catalogue.rows.filter((r) => r.disabled).length} inert rows, all focusable: ${catalogue.allFocusable}, all explained: ${catalogue.allExplain}`);
    await page.screenshot({ path: join(SHOTS, '8-regions-offline.png') });
  }

  /* ---------------- engine selection + provenance ---------------- */
  // The claim under test is an honesty claim: the app must name the engine that
  // answered, not the one that was selected. With the offline engine pinned and
  // fallback allowed, an online engine may legitimately answer -- but then the
  // trace must say so rather than reporting the selection.
  console.log('\nengines');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  const settingsBtn = await page.$('button[aria-label="Settings"]');
  if (settingsBtn) {
    await settingsBtn.click();
    await page.waitForTimeout(400);
    const enginesLink = await page.$('.hint-card');
    check('settings offers an engine control', !!enginesLink);
    await enginesLink.click();
    await page.waitForTimeout(600);

    const engineScreen = await page.evaluate(() => {
      const text = document.body.innerText;
      const rows = [...document.querySelectorAll('.provider-row')];
      return {
        title: /Engines/.test(text),
        // "Any online engine" plus the four registry entries.
        rows: rows.length,
        labels: rows.map((r) => r.textContent.trim()),
        // Every row must state availability either way -- a bare engine name
        // tells the driver nothing about whether it can be used right now.
        allExplained: rows.every((r) => /Ready —|Unavailable —/.test(r.textContent)),
        fallbackControl: /Use another engine/.test(text) && /Fail instead/.test(text),
        unproven: /No route requested yet/.test(text),
      };
    });
    check('engines screen opens', engineScreen.title);
    check('every engine is listed and selectable', engineScreen.rows === 5,
      `${engineScreen.rows} rows: ${engineScreen.labels.map((l) => l.split('\n')[0]).join(', ')}`);
    check('each engine states whether it is usable', engineScreen.allExplained);
    check('fallback is an explicit choice', engineScreen.fallbackControl);
    check('no provenance is claimed before a route', engineScreen.unproven);
    await page.screenshot({ path: join(SHOTS, '9-engines.png') });

    // Pin the offline engine so a route is guaranteed to be attributable.
    const offlineRow = await page.$('.provider-row:has-text("Offline (.osm)")');
    if (offlineRow) {
      await offlineRow.click();
      await page.waitForTimeout(300);
      await page.goBack().catch(() => {});
      await page.waitForTimeout(400);
    }
  }

  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
} catch (err) {
  check('harness completed', false, err.message);
  await page.screenshot({ path: join(SHOTS, 'error.png') }).catch(() => {});
} finally {
  await browser.close();
}

console.log(`\nscreenshots in ${SHOTS}`);
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
