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
/**
 * `STATUS_DOC` exists so `test/status-audit.spec.ts` can run this against a mutated copy
 * of the document and assert the audit objects.
 *
 * That is the only reason it is here, and the reason it is worth the parameter: the two
 * defects this pass fixed — a digit-width that stopped matching at 1000 tests, and a set
 * of patterns written only for bold table cells — were both *silent*. Nothing failed, no
 * output changed, and the only way to learn a check had stopped looking is to change the
 * thing it looks at and see whether it notices. An audit that cannot be pointed at
 * evidence cannot be seen to fail, and §3.19's rule is that a suite never seen to fail has
 * not been tested.
 */
const doc = readFileSync(process.env.STATUS_DOC ?? join(ROOT, 'STATUS.md'), 'utf8');
const problems = [];

/* -------------------------- §6 line counts -------------------------- */

const layout = doc.slice(doc.indexOf('## 6. Project layout'), doc.indexOf('## 7. Known gaps'));
const srcDirs = ['', 'src/', 'src/osm/', 'src/nav/', 'src/map/', 'src/regions/', 'tools/'];

/**
 * §6's layout block states two different kinds of number in one column: a `wc -l` for
 * every source and `tools/` file, and a *check count* for the two `test/*.mjs` browser
 * suites (`test/e2e.mjs 55 browser checks`, `test/screens.mjs 53 checks x 3 viewports`).
 * Only the first is a line count, so `test/*.mjs` is excluded by name rather than by
 * guessing — a check that guessed would report a 55-line file as being 847 lines.
 *
 * Leading indentation is optional (`\s{0,4}`, not `\s{2,4}`) because the `tools/` rows are
 * not indented and `\s{2,4}` silently excluded **every one of them**: twelve line counts
 * that looked checked and were not. Same shape as the `\d{3}` width above, and found the
 * same way — by asking what the pattern actually matched rather than what it looked like.
 */
const LINE_COUNT_ROW = /^\s{0,4}([\w./-]+\.(?:ts|tsx|css|mjs))\s+(\d+)(?=\s|$)/gm;
let lineCountRows = 0;
for (const m of layout.matchAll(LINE_COUNT_ROW)) {
  const [, name, claimed] = m;
  if (name.startsWith('test/')) continue;   // a check count, not a line count
  lineCountRows++;
  const hit = srcDirs.map((d) => d + name).find((p) => existsSync(join(ROOT, p)));
  if (!hit) {
    problems.push(`§6 lists a file that does not exist: ${name}`);
    continue;
  }
  const actual = execFileSync('wc', ['-l', join(ROOT, hit)]).toString().trim().split(/\s+/)[0];
  if (actual !== claimed) problems.push(`§6 line count wrong: ${name} says ${claimed}, is ${actual}`);
}
// A pattern that matches nothing is the failure this file has now produced twice, so it
// is asserted rather than trusted: this layout block *has* `tools/` rows, and if the
// indentation ever changes again this stops quietly verifying half of §6.
if (lineCountRows < 45) {
  problems.push(
    `§6 line-count check matched only ${lineCountRows} rows; expected the src/ and tools/ tables, so this check is looking at nothing`,
  );
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

/** One value the file states more than once must be the same everywhere it is stated. */
const one = (values, what) => {
  if (new Set(values).size > 1) problems.push(`${what} disagree in this file: ${[...new Set(values)].join(', ')}`);
  return values;
};

/**
 * Every place this file states the *current* unit-test total, as anchors rather than
 * one blended regex.
 *
 * ## Why anchors, and why this note is longer than the code
 *
 * The first version used `(\d{3})` -- exactly three digits -- and the total was 828 when
 * it was written, so every pattern worked. The suite then passed 1000 tests and **all of
 * them stopped matching**: `(\d{3})` matched the first three digits of `1153`, the
 * pattern then demanded a space where the fourth digit was, and the match failed. No
 * error, no warning -- the patterns simply returned nothing, forever.
 *
 * So the gate that exists because this document has carried wrong numbers spent a long
 * stretch reporting agreement on an *empty list*, which is vacuously consistent. That is
 * the failure §2 is written about, reproduced inside the gate written about it: §8's
 * `npm test` line sat 127 tests behind the suite and nothing said so.
 *
 * Hence `\d+` and never a fixed width, and hence an explicit complaint when an anchor
 * finds nothing. `test/status-audit.spec.ts` runs every anchor against a fixture holding
 * a four-digit total, because "it agrees" and "it matched nothing" are indistinguishable
 * from the outside.
 */
const TOTAL_ANCHORS = [
  { what: '§1 requirement row', re: /\*\*Done\.\*\* (\d+) unit tests across (\d+) files/, files: 2 },
  { what: '§2 verification table', re: /\*\*(\d+) passing\*\*, (\d+) files/, files: 2 },
  { what: '§2 breakdown preamble', re: /\*\*(\d+) files, (\d+) tests\*\*/, testsAt: 2, filesAt: 1 },
  { what: '§6 layout block', re: /^test\/ +(\d+) unit tests, (\d+) files$/m, files: 2 },
  { what: '§8 command block', re: /^npm test +# (\d+) unit tests$/m },
];

const unitTotals = [];
const fileTotals = [];
for (const a of TOTAL_ANCHORS) {
  const m = a.re.exec(doc);
  if (!m) {
    problems.push(
      `cannot find the ${a.what} unit-test total -- the anchor no longer matches, so this check is looking at nothing`,
    );
    continue;
  }
  unitTotals.push(m[a.testsAt ?? 1]);
  const at = a.filesAt ?? a.files;
  if (at) fileTotals.push(m[at]);
}
one(unitTotals, 'current unit-test totals');
one(fileTotals, 'current spec-file totals');

/* ------------------------------ §7 gap refs ------------------------------ */

const gapsSection = doc.slice(doc.indexOf('## 7. Known gaps'), doc.indexOf('### Closed in the §3.17'));
// Items wrap over several lines, so a title is matched loosely: a numbered list item
// that starts bold is a gap. `~~**` is allowed too, because a gap that has been closed
// is struck through in place rather than deleted, and without this the list read as
// ending two entries early -- which is what happened when §7 gaps 11 and 12 were
// closed, and the gate reported the document's own cross-references as dangling.
const maxGap = Math.max(
  ...[...gapsSection.matchAll(/^(\d+)\.\s+(?:~~)?\*\*/gm)].map((m) => Number(m[1])),
);
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
  // `unitTotals` is reused rather than re-anchored here. The first version kept a second
  // copy of the patterns in this block, which is how two readers of the same number
  // came to disagree about how many digits it has -- and the copy that was wrong here is
  // the one that decided whether a wrong total was caught.
  for (const t of [...new Set(unitTotals)]) {
    if (Number(t) !== sum) problems.push(`STATUS.md states ${t} unit tests in total, the run has ${sum}`);
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
 *
 * ## The limitation that mattered, and cost a stale pair
 *
 * "Everywhere" has to mean the *code blocks* too, and the first version did not: every
 * pattern it used was written against a bold table cell or one prose phrasing. §6's layout
 * block and §8's command block both state the same figures in monospace, and both were
 * invisible to it -- so §6 and §8 sat at 46 e2e checks while §2 said 55, and the gate
 * saw one number and agreed with itself.
 *
 * That is the same shape as the `\d{3}` failure above, and worth stating plainly: both
 * were a check that could only see the *form* it was written against, treating "nothing
 * found" and "nothing wrong" as the same result.
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
/**
 * Each browser gate's figure, and only that gate's.
 *
 * ## Why a *line predicate* and not a token
 *
 * The first version matched figures by scanning every line for a gate's *name* —
 * `\btextscale\b`, say. The §2 breakdown table has rows named `textscale.spec.ts` and
 * `textscale-layout.spec.ts`, whose counts are 16 and 13, so a loose token compares a
 * browser check count against two spec counts: not a disagreement, but a comparison of two
 * things that do not measure the same thing — which is the "screens gate given the e2e
 * number" mistake one level down.
 *
 * So every gate is bound to the lines that actually name *its command or its tool*: the §2
 * verification row (`npm run reflow`), the §2 per-tool row (`| `tools/reflow.mjs` |`), the
 * §6 layout row, and the §8 command block. A spec row cannot match any of those.
 */
const GATE_FIGURES = [
  {
    name: 'e2e',
    // Every gate's figure must be findable. An empty list is not agreement.
    mustFind: true,
    lines: /\be2e\b/,
    excludes: /spec\.ts/,
    res: [
      /\*\*(\d+) checks/g,
      /\| `test\/e2e\.mjs` \| (\d+)/g,
      /# (\d+) browser checks/g,                  // §8's command block
      /test\/e2e\.mjs\s+(\d+) browser checks/g,  // §6's layout block
    ],
  },
  {
    name: 'screens',
    mustFind: true,
    lines: /\bscreens\b/,
    excludes: /spec\.ts/,
    // Two quantities, not one: a per-viewport base and a total. Compared like with like,
    // because 53 and 159 are not two answers to the same question.
    baseRes: [
      /(\d+) checks × \d+ viewports/g,
      /screens (\d+) ×/g,
      /screens\.mjs\s+(\d+) checks x \d+ viewports/g,
    ],
    totalRes: [
      /\| `test\/screens\.mjs` \| (\d+)/g,
      // The **total** is the number after the `=`, not the first one. The earlier version
      // captured group 1 -- the per-viewport base -- and so counted the §2 row's `53` as a
      // total, which put 53 and 159 in the same column and reported a disagreement between
      // a base and a total. The first number is matched and discarded.
      /\*\*\d+ checks × \d+ viewports = (\d+)\*\*/g,
    ],
  },
  {
    name: 'focus',
    mustFind: true,
    lines: /\bfocus\b/,
    excludes: /spec\.ts/,
    res: [
      /\*\*(\d+) checks\*\* in a real browser/g,
      /\| `tools\/focus\.mjs` \| (\d+)/g,
      /# (\d+) keyboard and focus checks/g,              // §8 says "keyboard and focus"
      /# (\d+) keyboard\/focus checks/g,                // §6 says "keyboard/focus"
      /tools\/focus\.mjs\s+\d+\s+(\d+) keyboard/g,      // §6's layout row
    ],
  },
  {
    name: 'reflow',
    mustFind: true,
    lines: /npm run reflow|tools\/reflow\.mjs/,
    excludes: /spec\.ts/,
    res: [
      /\*\*(\d+) checks/g,                            // §2's verification row
      /\| `tools\/reflow\.mjs` \| (\d+)/g,           // §2's per-tool row
    ],
  },
  {
    name: 'textscale',
    mustFind: true,
    lines: /npm run textscale|tools\/textscale-check\.mjs/,
    excludes: /spec\.ts/,
    res: [
      /\*\*(\d+) checks/g,                            // §2's verification row
      /\| `tools\/textscale-check\.mjs` \| (\d+)/g,
    ],
  },
  {
    name: 'swshell',
    mustFind: true,
    lines: /npm run swshell|tools\/sw-shellcheck\.mjs/,
    excludes: /spec\.ts/,
    res: [
      /\| `tools\/sw-shellcheck\.mjs` \| (\d+)/g,
    ],
  },
];

const lines = doc.split('\n');

/**
 * The figures one gate is counted at, read only from lines that name that gate.
 *
 * The historical-figure exclusion is line-scoped and looks one line up as well, because a
 * heading can wrap away from the figure it introduces. It is deliberately narrow: a
 * paragraph-level exclusion swallowed all of §2's table once already, hiding a wrong e2e
 * figure under a prose note three rows above it.
 */
const gateCounts = (gate, patterns) => {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!gate.lines.test(line)) continue;
    if (gate.excludes?.test(line)) continue;
    if (/re-derived rather than remembered|as of that revision/i.test(line + '\n' + (lines[i - 1] ?? ''))) {
      continue;
    }
    for (const re of patterns) {
      for (const m of line.matchAll(re)) out.push(Number(m[1]));
    }
  }
  return [...new Set(out)].filter((n) => Number.isInteger(n) && n > 0 && n < 500);
};

const disagree = (label, counts, gate) => {
  if (counts.length > 1) {
    problems.push(
      `the ${label} gate is counted ${counts.join(' and ')} on lines that name it; `
      + 'the smaller figures are stale',
    );
    return;
  }
  /**
   * No figures found is not agreement.
   *
   * This is the defect the previous commit fixed for the unit-test total and the §6 line
   * counts, and it was still live one function away: every pattern is written against a
   * *form*, so a document that stops using that form leaves `counts` empty — and an empty
   * list is vacuously consistent, which is exactly what was being reported.
   *
   * Demonstrated before the fix: rewording all four e2e figure forms to non-numeric text
   * produced `all checks passed`, exit 0. `disagreement` and `absence` are different
   * failures and only one of them was detected.
   */
  if (counts.length === 0 && gate.mustFind) {
    problems.push(
      `the ${label} gate has no figure anywhere in this file, so nothing was compared; `
      + 'the patterns no longer match how this document states it',
    );
  }
};

for (const gate of GATE_FIGURES) {
  if (gate.baseRes) {
    // Compared like with like: the per-viewport base against itself, and the total against
    // itself. Mixing them is a false positive — 53 and 159 answer different questions.
    disagree(`${gate.name} (per viewport)`, gateCounts(gate, gate.baseRes), gate);
    disagree(`${gate.name} (total)`, gateCounts(gate, gate.totalRes), gate);
    continue;
  }
  disagree(gate.name, gateCounts(gate, gate.res ?? []), gate);
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
  // Both flags, not one. `--outputFile` only applies once a reporter is selected, so it
  // alone writes the default reporter's output and no JSON — verified by running it.
  console.log('  to include them: npx vitest run --reporter=json --outputFile=/tmp/r.json && VITEST_JSON=/tmp/r.json npm run status');
}
if (problems.length === 0) {
  console.log('all checks passed');
  process.exit(0);
}
for (const p of [...new Set(problems)]) console.log(`  FAIL  ${p}`);
console.log(`\n${new Set(problems).size} problem(s)`);
process.exit(1);