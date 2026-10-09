/**
 * Finds dead CSS: top-level rules that are later overridden by an identical
 * selector, ignoring anything inside a media query (where a second declaration
 * is usually a deliberate breakpoint).
 *
 * Also flags `var(--x, var(--x, ...))` nesting, which the bulk palette swap
 * briefly introduced — CSS accepts it, so nothing else complains.
 */
import { readFileSync } from 'node:fs';

const css = readFileSync('src/styles.css', 'utf8');

// Walk the file, tracking brace depth and whether we are inside an at-rule.
const rules = [];   // { selector, start, end, inAtRule, decls }
let i = 0, depth = 0, atDepth = null;
const stack = [];

while (i < css.length) {
  const ch = css[i];
  if (ch === '{') {
    const open = stack[stack.length - 1];
    if (open && open.prelude.trim().startsWith('@')) {
      stack.push({ prelude: css.slice(open.preludeEnd, i).trim(), at: true });
    } else {
      const prelude = open ? open.prelude.trim() : '';
      stack.push({
        prelude,
        at: false,
        start: open ? open.preludeStart : i,
        end: -1,
        inAtRule: depth > 0 && !!atDepth,
      });
    }
    depth++;
    i++;
    continue;
  }
  if (ch === '}') {
    const done = stack.pop();
    if (done && !done.at) done.end = i;
    depth--;
    i++;
    continue;
  }
  if (stack.length) {
    const top = stack[stack.length - 1];
    if (!top.preludeEnd) {
      // Accumulating a selector prelude (text before this rule's `{`).
      top.prelude = (top.prelude ?? '') + ch;
      if (ch !== ' ' && ch !== '\n' && ch !== '\t') top.preludeEnd = i;
    }
  }
  i++;
}

const topLevel = rules;
const seen = new Map();
const dead = [];
for (const r of topLevel) {
  if (r.end === -1 || !r.prelude) continue;
  const sel = r.prelude.replace(/\s+/g, ' ').trim();
  const prior = seen.get(sel);
  const line = css.slice(0, r.start).split('\n').length;
  if (prior !== undefined) dead.push({ sel, first: prior, line });
  seen.set(sel, line);
}

console.log('=== duplicate top-level selectors (the earlier block is dead CSS) ===');
if (!dead.length) console.log('  none');
for (const d of dead) console.log(`  "${d.sel}" — first at line ${d.first}, repeated at line ${d.line}`);

const nested = [...css.matchAll(/var\(\s*(--[a-z0-9-]+)\s*,\s*var\(\s*\1\s*,/gi)];
console.log(`\n=== self-referential var() fallbacks: ${nested.length} ===`);
for (const m of nested) {
  console.log(`  line ${css.slice(0, m.index).split('\n').length}: ${m[0].slice(0, 70)}`);
}

const double = [...css.matchAll(/#[0-9a-fA-F]{6}/g)];
console.log(`\nhex literals: ${double.length}`);