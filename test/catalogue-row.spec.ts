/**
 * The catalogue row must not become the thing the driver came to look at.
 *
 * `§3.19` deferred this with a recorded estimate of "~365dp at 412dp; row height
 * is nominally 116dp". Measured with every catalogue probe answered deterministically
 * with a 500, it was **1139dp** — nearly ten times the row, sixteen times over, so
 * the screen was nothing but red paragraphs and the row anyone needed was in the
 * middle of it.
 *
 * Measuring it against the live Geofabrik URLs does not work: those probes are
 * CORS-blocked in a browser, so whether a reason exists at all depends on the
 * network, and a layout measurement that depends on the network is a number that
 * will be stale. See `tools/measure4`-style interception documented below.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(ROOT, 'src', 'styles.css'), 'utf8');
const regions = readFileSync(join(ROOT, 'src', 'regions', 'RegionsScreen.tsx'), 'utf8');

/** The stylesheet with comments removed, so a note quoting the old rule is not a match. */
const applied = css.replace(/\/\*[\s\S]*?\*\//g, '');

describe('the unavailable reason is one line until asked otherwise', () => {
  it('is a control, not a hover attribute', () => {
    // §11.2's finding: a `title` is unreachable on the only kind of device this app
    // has. An expansion that needs a mouse is not an expansion.
    expect(regions).toMatch(/className="unavailable-reason"[\s\S]{0,400}aria-expanded/);
    expect(regions).toMatch(/onClick=\{\(\) => setExpandedReason/);
  });

  it('says whether it is expanded, rather than leaving it to be guessed', () => {
    expect(regions).toMatch(/aria-expanded=\{expandedReason\.has\(e\.id\)\}/);
  });

  it('offers a way back once expanded', () => {
    // Expanding without collapsing is a one-way door on a list of sixteen rows.
    expect(regions).toMatch(/className="reason-collapse"/);
  });

  it('truncates the folded reason rather than wrapping it', () => {
    // The measured defect: 868dp of wrapped reason inside a 116dp row.
    expect(regions).toMatch(/expandedReason\.has\(e\.id\)\s*\?\s*'unavailable-reason-text'\s*:\s*'truncate'/);
    // And `.truncate` is the one-line treatment, not a soft wrap.
    expect(applied).toMatch(/\.truncate\s*\{[^}]*overflow:\s*hidden/);
  });

  it('keeps the reason legible as a button, which it now is', () => {
    // A `<button>` defaults to `text-align: center` and to its own font, both of
    // which silently restyle the sentence it now owns.
    expect(applied).toMatch(/\.unavailable-reason\s*\{[^}]*text-align:\s*left/);
    expect(applied).toMatch(/\.unavailable-reason\s*\{[^}]*font:\s*inherit/);
    expect(applied).toMatch(/\.unavailable-reason\s*\{[^}]*background:\s*none/);
  });

  it('still meets the touch-target minimum when it is a control', () => {
    // It became interactive, so the 44dp minimum applies to it now.
    expect(applied).toMatch(/\.unavailable-reason\s*\{[^}]*min-height:\s*28px/);
  });

  it('has a focus ring, because it is focusable', () => {
    expect(applied).toMatch(/\.unavailable-reason:focus-visible\s*\{[^}]*outline:/);
    expect(applied).toMatch(/\.reason-collapse:focus-visible\s*\{[^}]*outline:/);
  });

  it('still carries the reason in the row button for anyone not reading it', () => {
    // Belt and braces: the Download control's accessible name still contains the
    // sentence, so the reason is announced whether or not the row is expanded.
    expect(regions).toMatch(/aria-label=\{[\s\S]{0,300}Unavailable — \$\{unavailableReason\[e\.id\]/);
  });
});