/**
 * Bundle size budget.
 *
 * This app ships inside an Android WebView on a phone, where the entry chunk is
 * parsed on the main thread before anything is interactive. A 1.4 MB entry chunk
 * existed until it was measured; nothing in the build would have complained about
 * it getting worse again, and "it was slow once" is not a rule.
 *
 * So the sizes are asserted here, on the built output, in the same way the test
 * count is asserted: a number that fails the build when it regresses instead of a
 * note in a document nobody re-reads.
 *
 * Sizes are gzip, because that is what crosses the wire. The budget is
 * deliberately on the *initial* payload rather than the total: MapLibre is
 * large and unavoidable, but it is deferred, so counting it would either force a
 * limit too loose to catch a regression in the entry chunk or one too tight to
 * admit the map at all.
 *
 * Run with: node tools/bundle-budget.mjs
 * Exits non-zero when a budget is exceeded, so it works as a CI step.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const assets = join(root, 'dist', 'assets');

/**
 * Budgets in kilobytes, gzip. Raising one is a deliberate edit to this file and
 * should be justified in the commit message — that is the whole mechanism.
 */
const BUDGET = {
  /** JS parsed before the first interaction. React + the whole OSM pipeline. */
  entryJs: 130,
  /** Render-blocking CSS on first paint. MapLibre's own CSS is deferred. */
  entryCss: 16,
  /** Everything a cold visit downloads before the map appears. */
  initialTotal: 150,
  /** The largest single chunk, currently MapLibre. */
  largestChunk: 300,
  /** Every JS byte the build emits, deferred included. */
  totalJs: 460,
};

let failed = false;

/**
 * @param {number} actualBytes measured gzip size, in bytes
 * @param {number} limitKb    budget, in kilobytes (as written in BUDGET)
 * @param {string} label
 */
function check(actualBytes, limitKb, label) {
  const limitBytes = limitKb * 1024;
  const ok = actualBytes <= limitBytes;
  if (!ok) failed = true;
  const deltaBytes = limitBytes - actualBytes;
  const note = ok
    ? `${(deltaBytes / 1024).toFixed(1)} kB under`
    : `${(-deltaBytes / 1024).toFixed(1)} kB OVER`;
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(18)} ${(actualBytes / 1024).toFixed(1).padStart(7)} kB` +
    `  (limit ${limitKb} kB, ${note})`,
  );
}

function listAssets() {
  let entries;
  try {
    entries = readdirSync(assets);
  } catch {
    console.error('dist/assets not found. Run `npm run build` first.');
    process.exit(2);
  }
  return entries
    .map((name) => {
      const path = join(assets, name);
      const raw = statSync(path).size;
      return { name, raw, gz: gzipSync(readFileSync(path)).length };
    })
    .sort((a, b) => b.gz - a.gz);
}

const files = listAssets();

/**
 * The entry chunk is the JS `index.html` loads eagerly.
 *
 * Identified by content rather than by filename: Rollup names entry chunks
 * `index-<hash>.js`, but so does every other dynamically-imported screen, and a
 * filename convention would silently start measuring the wrong file the first
 * time a hash or naming scheme changed.
 */
/**
 * The assets `index.html` loads eagerly.
 *
 * Read from the HTML rather than inferred from filenames. Rollup gives the entry
 * chunk and its stylesheet independent content hashes, so deriving one name from
 * the other silently measures nothing; and only the entry assets appear in the
 * HTML at all, which is exactly the set that blocks first paint.
 */
function findEntryAssets() {
  const html = readFileSync(join(root, 'dist', 'index.html'), 'utf8');
  const urls = [
    ...[...html.matchAll(/<script[^>]+src="\/([^"]+)"/g)].map((m) => m[1]),
    ...[...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="\/([^"]+)"/g)].map((m) => m[1]),
  ];
  if (urls.length === 0) {
    console.error('no module script found in dist/index.html — is the build sane?');
    process.exit(2);
  }
  return urls
    .map((u) => files.find((f) => f.name === u.split('/').pop()))
    .filter(Boolean);
}

console.log('\nbundle budget (gzip)\n');

const entryAssets = findEntryAssets();
const entry = entryAssets.filter((f) => f.name.endsWith('.js'));
const entryCss = entryAssets.filter((f) => f.name.endsWith('.css'));

for (const f of entry) {
  check(f.gz, BUDGET.entryJs, `entry js ${f.name.slice(0, 12)}…`);
}
for (const f of entryCss) {
  check(f.gz, BUDGET.entryCss, `entry css ${f.name.slice(0, 12)}…`);
}
if (entry.length === 0) {
  console.error('  FAIL  no entry js found in index.html');
  process.exit(2);
}
if (entryCss.length === 0) {
  // Not a failure, but worth saying: an app with no render-blocking CSS is
  // either very small or has lost its stylesheet.
  console.log('  WARN  no entry css — confirm styles are inlined or lazy-loaded on purpose');
}

const entryGz = entryAssets.reduce((n, f) => n + f.gz, 0);
check(entryGz, BUDGET.initialTotal, 'initial total');

const js = files.filter((f) => f.name.endsWith('.js'));
check(Math.max(...js.map((f) => f.gz)), BUDGET.largestChunk, 'largest chunk');
check(js.reduce((n, f) => n + f.gz, 0), BUDGET.totalJs, 'total js');

console.log(`\n${files.length} assets, ${(js.reduce((n, f) => n + f.raw, 0) / 1024 / 1024).toFixed(2)} MB raw js\n`);

if (failed) {
  console.error('bundle budget exceeded.');
  process.exit(1);
}
console.log('within budget.');