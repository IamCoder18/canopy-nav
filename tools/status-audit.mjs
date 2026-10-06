/**
 * STATUS.md, checked mechanically.
 *
 * ## Why this exists
 *
 * This document has been found wrong six times, and every time it was the same
 * shape: a number or a cross-reference written once and never re-derived. The list
 * is in §2 — the e2e count, the screen figure, the unit-test total, two of them
 * disagreeing *within this file at once*, a pixel measurement no probe in the repo
 * could have produced, and a claim about code that turned out not to run.
 *
 * The project's answer to that has been the same each time — re-derive the number,
 * and write down that a number written once is a claim rather than a measurement.
 * That is a discipline, and a discipline is not a gate. This is the gate.
 *
 * ## What it checks, and why only these
 *
 * Only what can be decided mechanically, because a check that needs judgement is a
 * check nobody runs:
 *
 *   - every `wc -l` figure in the §6 layout, against the file on disk;
 *   - every `§N.N` cross-reference, against a heading that defines it;
 *   - the current unit-test and file totals, in every place they are stated;
 *   - every `§7 gap N` reference, against the list's current range — with an escape
 *     for the previous numbering, which §7 says it uses and this file relies on;
 *   - every `npm run X` in §8, against `package.json`;
 *   - every spec file named in the §2 breakdown, against `test/`, in both
 *     directions: a listed file that is gone, and a file on disk that is unlisted.
 *
 * ## What it cannot check, stated so it is not over-trusted
 *
 * Whether a *claim* is true. §13.8's seven-clipped-labels figure was wrong, and this
 * gate would have passed it: the number was in the right format. What caught that
 * was re-measuring. The same is true of the two mechanisms §13.1 and §13.4 corrected
 * — both were prose, and no gate can read prose for truth.
 *
 * Run with `npm run status`. Exits non-zero on a problem.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const doc = readFileSync(join(ROOT, 'STATUS.md'), 'utf8');
const problems = [];

/* -------------------------- §6 line counts -------------------------- */

const layout = doc.slice(doc.indexOf('## 6. Project layout'), doc.indexOf('## 7. Known gaps'));
const srcDirs = ['', 'src/', 'src/osm/', 'src/nav/', 'src/map/', 'src/regions/', 'tools/'];
for (const m of layout.matchAll(/^\s{2,4}([\w./-]+\.(?:ts|tsx|css|mjs))\s+(\d+)\s{2}/gm)) {
  const [, name, claimed] = m;
  const hit = srcDirs.map((d) => d + name).find((p) => existsSync(join(ROOT, p)));
  if (!hit) {
    problems.push(`§6 lists a file that does not exist: ${name}`);
    continue;
  }
  const actual = execFileSync('wc', ['-l', join(ROOT, hit)]).toString().trim().split(/\s+/)[0];
  if (actual !== claimed) problems.push(`§6 line count wrong: ${name} says ${claimed}, is ${actual}`);
}

/* --------------------------- cross-references --------------------------- */

// Headings look like `## 7. Known gaps` and `### 13.4 Two claims`.
const heads = new Set(
  [...doc.matchAll(/^#{2,5}\s+([\d]+(?:\.[\d]+)*)\.?\s/gm)].map((m) => m[1]),
);
for (const m of doc.matchAll(/§(\d+(?:\.[\d]+)*)/g)) {
  if (!heads.has(m[1])) problems.push(`§${m[1]} is referenced but no heading defines it`);
}

/* ------------------------------ the totals ------------------------------ */

/** Only figures claiming to be *current*; historical ones in prose are legitimate. */
const stated = (re) => [...doc.matchAll(re)].map((m) => m[1]);
const one = (values, what) => {
  if (new Set(values).size > 1) problems.push(`${what} disagree in this file: ${[...new Set(values)].join(', ')}`);
};

const unitTotals = [
  ...stated(/\*\*(\d{3}) passing\*\*/g),
  ...stated(/\*\*Done\.\*\* (\d{3}) unit tests/g),
  ...stated(/\*\*(\d{3}) unit tests, \d+ files\*\*/g),
  ...stated(/# (\d{3}) unit tests/g),
];
one(unitTotals, 'current unit-test totals');

const fileTotals = [
  ...stated(/\*\*\d{3} passing\*\*, (\d+) files/g),
  ...stated(/\*\*Done\.\*\* \d{3} unit tests across (\d+) files/g),
  ...stated(/\*\*\d{3} unit tests, (\d+) files/g),
];
one(fileTotals, 'current spec-file totals');

/* ------------------------------ §7 gap refs ------------------------------ */

const gapsSection = doc.slice(doc.indexOf('## 7. Known gaps'), doc.indexOf('### Closed in the §3.17'));
// Items 4, 11 and 12 wrap over several lines, so the title is matched loosely: a
// numbered list item that starts bold is a gap.
const maxGap = Math.max(...[...gapsSection.matchAll(/^(\d+)\.\s+\*\*/gm)].map((m) => Number(m[1])));
for (const m of doc.matchAll(/§7 gaps? (\d+)(?:[–-](\d+))?/g)) {
  // §7 renumbered from 18 entries to 12, and the file deliberately refers back to
  // the old numbers where it records history. Only a *bare* high number is a bug.
  // The escape may sit either side of the reference — §7's own note is above it,
  // and §13's inline corrections are in the sentence that follows.
  const around = doc.slice(Math.max(0, m.index - 400), m.index + 260);
  const legacy = /previous numbering|previous revision|old numbering|previous §7|there is no gap/i.test(around);
  for (const n of [m[1], m[2]]) {
    if (n && Number(n) > maxGap && !legacy) {
      problems.push(`§7 gap ${n} referenced but the list now ends at ${maxGap}, with no "previous numbering" note`);
    }
  }
}

/* -------------------------- §8 commands exist -------------------------- */

const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts;
const commands = doc.slice(doc.indexOf('## 8. Commands'), doc.indexOf('## 9. The plan'));
for (const m of commands.matchAll(/npm run ([\w-]+)/g)) {
  if (!scripts[m[1]]) problems.push(`§8 documents \`npm run ${m[1]}\` but package.json has no such script`);
}

/* ---------------------- §2 breakdown matches disk ---------------------- */

const listed = [...doc.matchAll(/^\| `([\w.-]+\.spec\.ts)` \| (\d+) \|/gm)].map((m) => m[1]);
const onDisk = readdirSync(join(ROOT, 'test')).filter((f) => f.endsWith('.spec.ts')).sort();
for (const f of onDisk) {
  if (!listed.includes(f)) problems.push(`§2 breakdown omits test/${f}, which exists`);
}
for (const f of listed) {
  if (!onDisk.includes(f)) problems.push(`§2 breakdown lists test/${f}, which does not exist`);
}
if (listed.length !== onDisk.length) {
  problems.push(`§2 breakdown lists ${listed.length} spec files, disk has ${onDisk.length}`);
}

/* ---------------------- §2 breakdown counts vs disk ---------------------- */

/**
 * Each spec file's row in the §2 breakdown, against the run.
 *
 * The table says its counts come from `vitest --reporter=json` rather than being
 * retyped. That is only true if something checks it, and until now nothing did —
 * the file-name column was compared against `test/` but the number beside it was
 * taken on trust, which is the part that goes stale.
 *
 * `npm test` would mean running the whole suite inside a check whose job is to be
 * cheap, so the report is used when one is present and skipped when it is not, with
 * that stated in the output rather than passing silently.
 */
const reportPath = process.env.VITEST_JSON ?? '/tmp/canopy-vitest.json';
let ranSuite = false;
if (existsSync(reportPath)) {
  ranSuite = true;
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const actual = {};
  for (const file of report.testResults) {
    const name = file.name.replace(/.*\//, '');
    actual[name] = (actual[name] ?? 0) + (file.assertionResults ?? []).length;
  }
  for (const m of doc.matchAll(/^\| `([\w.-]+\.spec\.ts)` \| (\d+) \|/gm)) {
    const [, f, claimed] = m;
    if (actual[f] === undefined) continue;   // already reported as missing from disk
    if (actual[f] !== Number(claimed)) {
      problems.push(`§2 breakdown counts ${f} at ${claimed}, the run has ${actual[f]}`);
    }
  }
  const sum = Object.values(actual).reduce((a, b) => a + b, 0);
  // Every phrasing this file uses for the current total, so a re-derivation in one
  // place cannot leave another claiming a different number.
  const statedTotals = [
    ...stated(/\*\*(\d{3}) unit tests across \d+ files\*\*/g),
    ...stated(/\*\*\d+ files, (\d{3}) tests\*\*/g),
    ...stated(/\*\*(\d{3}) passing\*\*/g),
  ];
  for (const t of statedTotals) {
    if (Number(t) !== sum) problems.push(`§2 states ${t} unit tests in total, the run has ${sum}`);
  }
}

/* --------------------------- browser counts --------------------------- */

/**
 * The figures for each browser gate must agree with each other.
 *
 * Not verifiable here — running the suites is slow and this gate's job is to be
 * cheap — but *internal disagreement* is exactly the failure the seventh wrong
 * count was: §2 and §8 said 15 focus checks while §6 said 17, in the same file.
 * Two of the three were right, and nobody compared them.
 *
 * So this checks that the numbers the document claims for one gate are the same
 * number everywhere it claims them. When a count is re-derived, the others
 * become visible as stale here rather than at some later reading.
 */
// Each gate's figure, read only from lines that actually name that gate. Cross-
// matching is how the first version of this check reported "e2e gate is counted 46
// and 15" — the same mistake the audit is meant to catch, one level up.
/**
 * Each gate's figure, and only that gate's.
 *
 * Token and number have to be bound together, because the first version of this
 * check attributed one gate's number to another — a line reading "e2e 44; screens
 * 53 x 3 = 159" gave the `screens` gate the number 44, since both tokens appear on
 * it. The same shape as the `waitForFunction` bug: reading a value without reading
 * what it belongs to.
 */
const GATE_FIGURES = [
  { name: 'e2e', token: /\be2e\b/, res: [/\*\*(\d+) checks/g, /\be2e (\d+)\b/g, /\| `test\/e2e\.mjs` \| (\d+) \|/g] },
  {
    name: 'screens',
    token: /\bscreens\b/,
    // "53 checks x 3 viewports = 159" and the per-tool breakdown row.
    // Two quantities here, not one: `53 checks × 3 viewports = 159` states a
    // per-viewport base, and `test/screens.mjs | 159` states the total. Compared
    // against each other they are a false positive, so the base is compared with
    // the base and the total with the total.
    baseRes: [/(\d+) checks × \d+ viewports/g, /screens (\d+) ×/g],
    totalRes: [/\| `test\/screens\.mjs` \| (\d+)/g, /\*\*(\d+) checks × \d+ viewports = (\d+)\*\*/g],
  },
  {
    name: 'focus',
    token: /\bfocus\b/,
    res: [/\*\*(\d+) checks\*\* in a real browser/g, /(\d+) keyboard\/focus checks/g, /\| `tools\/focus\.mjs` \| (\d+) \|/g],
  },
];

const lines = doc.split('\n');
const gateCounts = (gate) => {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!gate.token.test(line)) continue;

    // A heading can wrap away from the figure it introduces, so the historical
    // marker is looked for on this line and the one above. Narrow on purpose: a
    // paragraph-level exclusion swallowed all of §2's table once already, hiding a
    // wrong e2e figure under a prose note three rows up.
    if (/re-derived rather than remembered|as of that revision/i.test(line + '\n' + (lines[i - 1] ?? ''))) {
      continue;
    }
    for (const re of gate.res ?? []) {
      for (const m of line.matchAll(re)) out.push(Number(m[1]));
    }
  }
  return [...new Set(out)].filter((n) => Number.isInteger(n) && n > 0 && n < 500);
};

const disagree = (label, counts) => {
  if (counts.length > 1) {
    problems.push(
      `the ${label} gate is counted ${counts.join(' and ')} on lines that name it; `
      + 'the smaller figures are stale',
    );
  }
};

for (const gate of GATE_FIGURES) {
  if (gate.baseRes) {
    // Compared like with like: the per-viewport base against itself, and the
    // total against itself. Mixing them is a false positive — 53 and 159 are not
    // two answers to the same question.
    const base = [];
    const total = [];
    for (let i = 0; i < lines.length; i++) {
      if (!gate.token.test(lines[i])) continue;
      if (/re-derived rather than remembered|as of that revision/i.test(lines[i] + (lines[i - 1] ?? ''))) continue;
      for (const m of lines[i].matchAll(/(\d+) checks × \d+ viewports = (\d+)/g)) { base.push(Number(m[1])); total.push(Number(m[2])); }
      for (const m of lines[i].matchAll(/screens (\d+) [x×]/g)) base.push(Number(m[1]));
      for (const m of lines[i].matchAll(/(\d+) checks x (\d+) viewports \((\d+) total\)/g)) { base.push(Number(m[1])); total.push(Number(m[3])); }
      for (const m of lines[i].matchAll(/\| `test\/screens\.mjs` \| (\d+)/g)) total.push(Number(m[1]));
    }
    const uniq = (a) => [...new Set(a)].filter((n) => n > 0 && n < 500);
    disagree(`${gate.name} (per viewport)`, uniq(base));
    disagree(`${gate.name} (total)`, uniq(total));
    // And the arithmetic itself.
    for (const m of doc.matchAll(/(\d+) checks [x×] (\d+) viewports = (\d+)/g)) {
      const [, a, b, c] = m.map(Number);
      if (a * b !== c) problems.push(`§2 says ${a} × ${b} = ${c}, which is not ${a * b}`);
    }
    continue;
  }
  disagree(gate.name, gateCounts(gate));
}

/** Every `checks × N = M` in this file must multiply out. */
for (const m of doc.matchAll(/(\d+) checks × (\d+) viewports = (\d+)/g)) {
  const [, a, b, c] = m.map(Number);
  if (a * b !== c) problems.push(`§2 says ${a} × ${b} = ${c}, which is not ${a * b}`);
}

/* ------------------------------- report ------------------------------- */

console.log(`STATUS.md audit: ${listed.length} spec files listed, §7 gap list ends at ${maxGap}`);
if (!ranSuite) {
  console.log('per-file test counts NOT checked — no vitest JSON report found.');
  console.log('  to include them: VITEST_JSON=/tmp/r.json npx vitest run --reporter=json');
}
if (problems.length === 0) {
  console.log('all checks passed');
  process.exit(0);
}
for (const p of [...new Set(problems)]) console.log(`  FAIL  ${p}`);
console.log(`\n${new Set(problems).size} problem(s)`);
process.exit(1);