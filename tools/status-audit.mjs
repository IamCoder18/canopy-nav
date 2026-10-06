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

/* ------------------------------- report ------------------------------- */

console.log(`STATUS.md audit: ${listed.length} spec files listed, §7 gap list ends at ${maxGap}`);
if (problems.length === 0) {
  console.log('all checks passed');
  process.exit(0);
}
for (const p of [...new Set(problems)]) console.log(`  FAIL  ${p}`);
console.log(`\n${new Set(problems).size} problem(s)`);
process.exit(1);