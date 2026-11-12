import { join } from 'node:path';
/** Shared by the full browser gate. A fresh page avoids legacy imports masking
 * an accidental fallback to GeoJSON or A*. Exercises the production file picker. */
export async function bundleE2e(browser, base, testDir, check) {
  const context = await browser.newContext({viewport:{width:1280,height:720},permissions:['geolocation'],geolocation:{longitude:-1.399,latitude:51.503,accuracy:8}});
  const page = await context.newPage();
  const errors = [];page.on('pageerror',(e) => errors.push(e.message));
  // Block external APIs, not the app shell: the entire workflow must be local.
  await page.route('**/*',(route) => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : route.abort());
  try {
    await page.goto(base,{waitUntil:'domcontentloaded'});
    await page.getByText('Import .osm or routing pack',{exact:true}).first().click();
    await page.locator('input[type=file]').setInputFiles(join(testDir,'packserver/fixture.tar.gz'));
    await page.waitForFunction(() => document.body.innerText.includes('Fixture City') || document.body.innerText.includes('routable ways'),null,{timeout:60000});
    // The basemap must use the stored vector source, not an empty GeoJSON
    // substitute. Force offline mode through the same connectivity event.
    await page.evaluate(() => { Object.defineProperty(navigator,'onLine',{configurable:true,get:() => false});window.dispatchEvent(new Event('offline')); });
    await page.waitForFunction(() => {
      const map = window.__canopyMap;
      return map?.getStyle()?.sources?.['canopy-basemap']?.type === 'vector' && map.isSourceLoaded('canopy-basemap');
    },null,{timeout:30000});
    await page.waitForFunction(() => window.__canopyMap?.queryRenderedFeatures({layers:['canopy-osm-roads']}).length > 0,null,{timeout:10000}).catch(() => {});
    const map = await page.evaluate(() => {
      const m = window.__canopyMap;
      const features = m.queryRenderedFeatures({layers:['canopy-osm-roads']});
      return { count:features.length, attribution:document.querySelector('.maplibregl-ctrl-attrib')?.textContent ?? '', source:m.getStyle().sources['canopy-basemap'],zoom:m.getZoom(),center:m.getCenter(),loaded:m.isSourceLoaded('canopy-basemap') };
    });
    check('bundle map actually draws stored MVT roads',map.count>0,JSON.stringify(map));
    check('bundle map displays OSM attribution',map.attribution.includes('OpenStreetMap'));
    await page.locator('.search-field').click();await page.locator('.inline-search input').fill('123 main');
    await page.waitForSelector('button.result-row:has-text("123 Main Street")');
    check('bundle exact real address has admin context',(await page.locator('button.result-row').first().innerText()).includes('Fixture City'));
    await page.locator('.inline-search input').fill('blue yondr');await page.waitForSelector('button.result-row:has-text("Blue Yonder Cafe")');
    check('bundle search tolerates typos',true);
    await page.getByRole('button',{name:'Near map',exact:true}).click();check('bundle search exposes map location bias',await page.getByRole('button',{name:'Near map',exact:true}).getAttribute('aria-pressed') === 'true');
    await page.locator('button.result-row').first().click();
    await page.waitForSelector('button.primary-btn:has-text("Start")', {timeout:60000});
    await page.waitForFunction(() => /Valhalla \(offline\)|Offline Valhalla/.test(document.body.innerText),null,{timeout:10000});
    const preview = await page.locator('body').innerText();
    check('bundle route uses offline Valhalla, not deprecated A*',/Valhalla \(offline\)|Offline Valhalla/.test(preview));
    await page.reload({waitUntil:'domcontentloaded'});
    await page.waitForFunction(() => document.body.innerText.includes('routable ways'),null,{timeout:60000});
    check('bundle restores without raw OSM parsing',!(await page.locator('body').innerText()).includes('No map loaded'));
    check('bundle workflow has no page errors',errors.length===0,errors.join('; '));
  } finally {await context.close();}
}
