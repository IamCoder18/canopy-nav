/**
 * The STATUS.md audit, tested by pointing it at a document that is wrong.
 *
 * ## Why this file exists
 *
 * Two defects got through `tools/status-audit.mjs`, and they are the same defect twice:
 *
 * 1. Every unit-test-total pattern was written `(\d{3})` — three digits — and the total
 *    was 828 when they were written. When the suite passed 1000 tests they all stopped
 *    matching, because `(\d{3})` consumed the first three digits of `1153` and the pattern
 *    then demanded a space where the fourth digit was. No error, no output change: the
 *    patterns returned nothing, and a check over an empty list agrees with itself.
 * 2. The browser-gate patterns were all written against a bold table cell or one prose
 *    phrasing, so §6's layout block and §8's command block — which state the same figures
 *    in monospace — were invisible. Two stale figures sat in those blocks while the audit
 *    reported green.
 *
 * Both are the failure §2 of STATUS.md is written about, occurring *inside the gate
 * written about it*. Neither could be found by reading the audit's source, because "no
 * matches" and "no problems" look identical in the output and in review.
 *
 * So the method here is the one that works for a document audit: take the real document,
 * break exactly one thing, and require the audit to say so. Nothing is asserted against a
 * hand-written fixture, because a fixture is a second document to keep correct and the
 * whole point is that this one is the one the audit actually reads.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REAL = readFileSync(join(ROOT, 'STATUS.md'), 'utf8');

/**
 * Run the audit over a mutated copy of the document.
 *
 * Returns the problems it printed and its exit code. The exit code matters as much as the
 * text: an audit that printed a FAIL and exited 0 would be a gate that reports and does
 * nothing, which is the shape of every "green" failure in this project's history.
 */
function audit(mutate?: (doc: string) => string): { out: string; code: number } {
  const dir = mkdtempSync(join(tmpdir(), 'canopy-audit-'));
  const path = join(dir, 'STATUS.md');
  writeFileSync(path, mutate ? mutate(REAL) : REAL);
  try {
    const out = execFileSync('node', [join(ROOT, 'tools/status-audit.mjs')], {
      env: { ...process.env, STATUS_DOC: path },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { out, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; status?: number };
    return { out: `${err.stdout ?? ''}`, code: err.status ?? 1 };
  }
}

/**
 * The current unit-test total, read from the document rather than written down here.
 *
 * This file's own anchors carry the total — `npm test # 1171 unit tests` and friends — and
 * so they change every time the suite does. They were left stale when the total moved
 * 1169 -> 1171 and six of these tests failed with `anchor appears 0 times`, which is the
 * document audit failing in the way it is built to catch and me having hardcoded a figure
 * in the very file that exists because hardcoded figures rot. §2.1's whole subject, one
 * level down.
 */
const TOTAL = /^test\/ +(\d+) unit tests, \d+ files$/m.exec(REAL)?.[1];
if (!TOTAL) throw new Error('could not read the current unit-test total out of STATUS.md');

/**
 * The current e2e check count, read for the same reason `TOTAL` is.
 *
 * It moved 55 -> 66 in one commit, and hardcoding it broke three of these tests the same
 * way `TOTAL` did. A figure this file re-derives on every other axis has no business
 * being written into it by hand.
 */
const E2E = /test\/e2e\.mjs +(\d+) browser checks/.exec(REAL)?.[1];
if (!E2E) throw new Error('could not read the current e2e count out of STATUS.md');

/**
 * The spec-file count, for the same reason.
 *
 * It has now moved three times (57 -> 58 -> 59) and every one of these anchors broke
 * with it. The two figures move together whenever a spec file is added, so reading both
 * from the document is the whole fix; hardcoding one and deriving the other would just
 * move the breakage.
 */
const FILES = /unit tests, (\d+) files$/m.exec(REAL)?.[1];
if (!FILES) throw new Error('could not read the current spec-file count out of STATUS.md');

/**
 * Replace exactly one occurrence, and fail loudly if the anchor has moved.
 *
 * The error is deliberately specific about the count, because "anchor appears 0 times" on
 * a figure that moved is a different problem from "this line was reworded" and the two
 * need different fixes.
 */
function substitute(from: string, to: string): (doc: string) => string {
  return (doc) => {
    const hits = doc.split(from).length - 1;
    if (hits !== 1) {
      throw new Error(
        `anchor appears ${hits} times, expected exactly 1: ${JSON.stringify(from)}`
        + ` — if a figure in STATUS.md moved, read it from \`TOTAL\` rather than writing it here`,
      );
    }
    return doc.replace(from, to);
  };
}

describe('the audit reads the real document', () => {
  it('passes on STATUS.md as it stands', () => {
    const { out, code } = audit();
    expect(out).toContain('all checks passed');
    expect(code).toBe(0);
  });
});

describe('the unit-test total is checked', () => {
  // The defect this exists for. §8's command block carried a figure behind the suite for
  // as long as it took the count to cross 1000, and nothing said so.
  const staleTotal = substitute(`npm test             # ${TOTAL} unit tests`, 'npm test             # 1026 unit tests');

  it('rejects a stale figure in §8 — the defect that shipped', () => {
    const { out, code } = audit(staleTotal);
    expect(out).toMatch(/current unit-test totals disagree/);
    expect(code).toBe(1);
  });

  it('rejects a stale figure in the §2 verification table', () => {
    const { code } = audit(substitute(`**${TOTAL} passing**, ${FILES} files`, `**9999 passing**, ${FILES} files`));
    expect(code).toBe(1);
  });

  it('rejects a stale figure in the §6 layout block', () => {
    const { code } = audit(substitute(`test/            ${TOTAL} unit tests, ${FILES} files`, `test/            1000 unit tests, ${FILES} files`));
    expect(code).toBe(1);
  });

  it('rejects a spec-file count that disagrees with the test total', () => {
    const { out, code } = audit(substitute(`**${TOTAL} passing**, ${FILES} files`, `**${TOTAL} passing**, 55 files`));
    expect(out).toMatch(/current spec-file totals disagree/);
    expect(code).toBe(1);
  });

  /**
   * The check that would have caught the original bug. A fixed digit width is not a
   * *wrong answer* — it is an absent one, and absent checks are invisible in the output.
   * So this asserts the anchors still find the document at all, by breaking the anchor's
   * own wording: if §8's line is ever reworded, the audit must complain rather than
   * silently stop reading that section.
   */
  it('complains when an anchor stops matching, instead of finding nothing', () => {
    // Re-worded so the anchor genuinely stops matching. An earlier version only re-spaced
    // the comment, which the anchor's ` +` still accepted — the test passed for the wrong
    // reason once more, which is why the substitution now removes the shape the anchor
    // depends on rather than merely reflowing it.
    const { out, code } = audit(substitute(`npm test             # ${TOTAL} unit tests`, `npm test  ->  ${TOTAL} passing`));
    expect(out).toMatch(/cannot find the §8 command block unit-test total/);
    expect(code).toBe(1);
  });
});

describe('the browser-gate figures are checked everywhere they are stated', () => {
  // §6 and §8 state these in code blocks. The first version of the check read only bold
  // table cells, so both blocks went unread.
  it('rejects a stale e2e count in §8', () => {
    const { out, code } = audit(substitute(`# ${E2E} browser checks against the built bundle`, '# 46 browser checks against the built bundle'));
    expect(out).toMatch(new RegExp(`the e2e gate is counted ${E2E} and 46`));
    expect(code).toBe(1);
  });

  it('rejects a stale e2e count in §6', () => {
    const { out, code } = audit(substitute(`test/e2e.mjs           ${E2E} browser checks, built bundle`, 'test/e2e.mjs           46 browser checks, built bundle'));
    expect(out).toMatch(new RegExp(`the e2e gate is counted ${E2E} and 46`));
    expect(code).toBe(1);
  });

  /**
   * Absence is not agreement.
   *
   * The defect an adversarial review of the previous two commits found here, and it was the
   * same one those commits had just fixed twice elsewhere: `disagree()` returned success
   * for an *empty* list, so rewording every e2e figure form to non-numeric text produced
   * `all checks passed`, exit 0. A check that has stopped matching reports the same thing
   * as a check that found nothing wrong.
   */
  it('rejects a gate whose figures have vanished', () => {
    // Chained `substitute` calls rather than a `reduce` over pairs. `substitute` throws if
    // an anchor appears zero or many times, so an anchor that drifts out of date is a loud
    // failure rather than a mutation that silently does nothing -- which is what the first
    // version of this test was: a `reduce` with no initial value, whose accumulator was
    // the first *string* of the pair list.
    // Each `substitute` returns a function over the document, so the *innermost* call is
    // the one given the document -- the shape is `s1(s2(s3(s4(doc))))`. Getting that
    // backwards passes a function where a string is expected, and the audit fails with
    // `doc.split is not a function`, which names neither the mutation nor the cause.
    const { out, code } = audit((doc) =>
      substitute(`npm run e2e          # ${E2E} browser checks against the built bundle`,
        'npm run e2e          # several browser checks against the built bundle')(
        substitute(`test/e2e.mjs           ${E2E} browser checks, built bundle`,
          'test/e2e.mjs           some browser checks, built bundle')(
          substitute(`| \`test/e2e.mjs\` | ${E2E} |`, '| `test/e2e.mjs` | many |')(
            substitute(`**${E2E} checks** against the built bundle`,
              '**lots of checks** against the built bundle')(doc),
          ),
        ),
      ),
    );
    expect(out).toMatch(/the e2e gate has no figure anywhere in this file/);
    expect(code).toBe(1);
  });

  /**
   * The three gates that were not compared at all.
   *
   * `GATE_FIGURES` listed e2e, screens and focus. §2's table also states reflow, textscale
   * and swshell, so a stale copy of any of those three was invisible — the same failure as
   * the seventh wrong figure, one level up: two places disagreeing with a gate built to
   * compare them not looking.
   */
  it('rejects a stale reflow count', () => {
    const { out, code } = audit(substitute('**12 checks, all passing**', '**11 checks, all passing**'));
    expect(out).toMatch(new RegExp('the reflow gate is counted 11 and 12'));
    expect(code).toBe(1);
  });

  it('rejects a stale textscale count', () => {
    // One of its two copies, not both -- changing both leaves them agreeing, which is the
    // mistake a first attempt at this test made.
    const { out, code } = audit(
      substitute('| `tools/textscale-check.mjs` | 13 — a gate', '| `tools/textscale-check.mjs` | 14 — a gate'),
    );
    expect(out).toMatch(/the textscale gate is counted 13 and 14/);
    expect(code).toBe(1);
  });

  /**
   * A loose token would read the wrong column.
   *
   * §2's breakdown table has `textscale.spec.ts` and `textscale-layout.spec.ts` rows, with
   * counts of 16 and 13. Matching textscale figures by the word "textscale" therefore
   * compares a browser gate against two unit-test files, which is not a disagreement but a
   * comparison of two things that measure different quantities -- the "screens gate given
   * the e2e number" mistake, one level down. This asserts a spec row is not read as one.
   */
  it('does not read a spec-file row as a gate figure', () => {
    const { code } = audit(
      substitute('| `textscale.spec.ts` | 16 |', '| `textscale.spec.ts` | 99 |'),
    );
    expect(code).toBe(0);
  });

  it('rejects a screens total that is really the per-viewport base', () => {
    // The §2 row reads "53 checks x 3 viewports = 159". An earlier pattern captured the
    // first number, so 53 was counted as a *total* and put 53 and 159 in one column.
    const { code } = audit(substitute('**53 checks × 3 viewports = 159**', '**54 checks × 3 viewports = 159**'));
    expect(code).toBe(1);
  });

  it('rejects a stale focus count in §6', () => {
    const { code } = audit(substitute('tools/focus.mjs         297 15 keyboard/focus checks', 'tools/focus.mjs         297 17 keyboard/focus checks'));
    expect(code).toBe(1);
  });

  /**
   * The live stale figure this fix surfaced. §11.7 said 17 while §2, §6 and §8 all said
   * 15, and 15 is right — counted off an actual run. Two of the three agreed with each
   * other and were wrong, which is the one configuration a value check cannot see, and
   * this instance had been sitting in the file because the §11.7 line says "keyboard and
   * focus checks" where the other three say "keyboard/focus" — a phrasing that no pattern
   * matched, so the check that exists to compare them never compared it.
   *
   * This is the eighth wrong figure in this document, and the first one the machinery was
   * already supposed to catch.
   */
  it('rejects a stale focus count in §11.7, where the wording differs', () => {
    const { out, code } = audit(substitute('npm run focus   # 15 keyboard and focus checks', 'npm run focus   # 17 keyboard and focus checks'));
    expect(out).toMatch(/the focus gate is counted 15 and 17/);
    expect(code).toBe(1);
  });

  it('rejects a screens figure that does not multiply out', () => {
    const { out, code } = audit(substitute('**53 checks × 3 viewports = 159**', '**53 checks × 3 viewports = 158**'));
    expect(out).toMatch(/53 × 3 = 158, which is not 159/);
    expect(code).toBe(1);
  });
});

describe('the rest of the audit still objects', () => {
  it('catches a §6 line count that no longer matches disk', () => {
    const { out, code } = audit(substitute('  shellcheck.ts            77', '  shellcheck.ts            78'));
    expect(out).toMatch(/§6 line count wrong: shellcheck\.ts says 78/);
    expect(code).toBe(1);
  });

  /**
   * The third silent hole, and the one that was hiding the other two's shape. §6's layout
   * regex was `^\s{2,4}` — two to four leading spaces — and the `tools/` rows are not
   * indented. So all twelve of them were unchecked, in the table whose caption says
   * "Every line count below is `wc -l`".
   *
   * This one was catchable without the document being wrong: mutate a `tools/` row and
   * require a complaint, where the pre-fix audit had none to give. Verified by restoring
   * `\s{2,4}` and watching this go green.
   */
  it('catches a stale line count in the unindented tools/ rows', () => {
    const { out, code } = audit(substitute('tools/sw-shellcheck.mjs  99 offline boot', 'tools/sw-shellcheck.mjs  98 offline boot'));
    expect(out).toMatch(/§6 line count wrong: tools\/sw-shellcheck\.mjs says 98/);
    expect(code).toBe(1);
  });

  /**
   * A pattern matching nothing is a green result, which is why this hole is closed by
   * count as well as by behaviour.
   *
   * The audit slices §6 out of the document by heading text. Rename that heading — which
   * a reorganisation would do, and which is exactly what a stale cross-reference looks
   * like from the other end — and the slice comes back empty. The audit must then say
   * "this check is looking at nothing" rather than reporting zero stale line counts, which
   * is the same confusion as the `\d{3}` width and the bold-cells-only patterns.
   */
  it('complains when the §6 line-count pattern stops matching the layout table', () => {
    const { out, code } = audit(substitute('## 6. Project layout', '## 6. Layout of the project'));
    expect(out).toMatch(/line-count check matched only 0 rows; expected the src\/ and tools\/ tables/);
    expect(code).toBe(1);
  });

  it('catches a dangling cross-reference', () => {
    const { out, code } = audit(substitute("§14.17's heap guard then makes it explicit", "§14.17's heap guard (§3.5.9) then makes it explicit"));
    expect(out).toMatch(/§3\.5\.9 is referenced but no heading defines it/);
    expect(code).toBe(1);
  });

  it('catches an npm script §8 documents but package.json does not have', () => {
    const { out, code } = audit(substitute('npm run textscale ', 'npm run nosuchscript '));
    expect(out).toMatch(/documents `npm run nosuchscript` but package.json has no such script/);
    expect(code).toBe(1);
  });
});

describe('what this file is not', () => {
  /**
   * The honest limit, asserted so the next person reads the suite correctly.
   *
   * A pass/fail result does not tell you the check is looking at the right thing, and a
   * green suite here means "these mutations are caught", not "STATUS.md is correct". That
   * distinction is §13.16's, and it is the reason this file exists at all.
   */
  it('cannot tell whether a *claim* in the document is true', () => {
    const { code } = audit(
      substitute(
        'PBF still collects to a contiguous buffer.',
        'PBF never collects to a contiguous buffer, and never has.',
      ),
    );
    expect(code).toBe(0);
  });

  it('finds several real things in one run, not just the first', () => {
    const { out, code } = audit(
      (doc) =>
        substitute(`# ${E2E} browser checks against the built bundle`, '# 46 browser checks against the built bundle')(
          substitute(`npm test             # ${TOTAL} unit tests`, 'npm test             # 1026 unit tests')(doc),
        ),
    );
    expect(code).toBe(1);
    expect(out).toMatch(/current unit-test totals disagree/);
    expect(out).toMatch(/the e2e gate is counted/);
  });
});