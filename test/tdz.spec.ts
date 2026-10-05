/**
 * Temporal dead zone check for `src/App.tsx`.
 *
 * ## Why this file exists
 *
 * This project tests pure logic under node, with no DOM. That is a good trade —
 * it is why 747 tests run in four seconds — and it was the right call. It has
 * one blind spot with a demonstrated cost.
 *
 * A `useMemo` / `useEffect` / `useCallback` callback runs *during render*. So
 * anything it closes over has to be initialised by that point in the component
 * body. A `const` or `let` declared further down is in its temporal dead zone,
 * and reading it throws `ReferenceError: Cannot access 'x' before
 * initialization`.
 *
 * It shipped once. The ETA fix added a `routePos` ref below the two guidance
 * memos that read it. Every one of those 747 tests stayed green. The app
 * rendered nothing except the error boundary's recovery card — and because the
 * boundary exists and works, it failed *quietly*, which is the worst way for
 * this to fail. Only `test/e2e.mjs` caught it, because only the browser suite
 * renders the component.
 *
 * A render smoke test does not close the gap either, and it is worth saying why
 * rather than leaving a test that looks like it does. `renderToStaticMarkup`
 * performs one render, and on that render both guidance memos return early —
 * there is no route and no dataset yet — so they never read the ref. The bug
 * needs a route to exist. Closing this properly means either driving the real UI
 * in a DOM, which is what the browser suite already is, or checking the ordering
 * statically. This is the static half, and it is cheap enough to run on every
 * test pass.
 *
 * ## What it checks
 *
 * For every component-scope declaration in `App.tsx`, whether the name is
 * *read* anywhere textually earlier in the file than it is declared. Reading a
 * component-scope binding before its declaration executes is a TDZ error; this
 * over-approximates by ignoring whether the earlier read is really inside a hook
 * callback that runs during render, so it can report a false positive where an
 * earlier read sits in a handler that only runs on click. That direction of
 * error is deliberate: a noisy warning is cheap, a crash in a car is not.
 *
 * Excluded: imports (hoisted, and initialised before the module body runs),
 * function declarations (hoisted), object and array destructuring, and
 * anything at a nesting depth other than the component body.
 *
 * Run with `npx vitest run test/tdz.spec.ts`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'src/App.tsx'), 'utf8');

/**
 * Strip comments and string bodies, so a name appearing in prose or in markup is
 * not mistaken for a read of a binding. Block comments are removed first: a
 * `/** ... *\/` doc comment routinely contains the very identifiers being
 * searched for, and leaving them in produced a page of nonsense.
 */
function stripNonCode(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/.*$/gm, (m) => m.replace(/[^\n]/g, ' '));
}

const stripped = stripNonCode(source);
const lines = stripped.split('\n');

/** Strip string bodies from a single already-stripped line. */
function code(line: string): string {
  return line.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""').trim();
}

/** Indent depth of a line, in spaces. Tabs are not used in this file. */
function depth(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * The line range of `App()`'s body.
 *
 * This has to be the *real* body rather than "any two-space-indented code":
 * `App.tsx` declares a dozen other top-level functions and components, and
 * treating their locals as `App`'s produced a false positive for almost every
 * common word in the file. Brace counting from the signature is crude but
 * sufficient here, because the body contains no template literal or string with
 * an unbalanced brace once strings are blanked.
 */
function appBody(): { first: number; last: number } {
  const start = lines.findIndex((l) => /export default function App\(/.test(l));
  if (start === -1) throw new Error('could not find App() in src/App.tsx');
  let level = 0;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') level++;
      else if (ch === '}') level--;
    }
    if (level === 0 && i > start) return { first: start + 1, last: i + 1 };
  }
  throw new Error('could not find the end of App()');
}

const BODY = appBody();

/**
 * Every component-scope `useMemo`, with the line range of its callback body.
 *
 * Found by brace-matching from the `{` that opens the arrow function, so the body
 * is the real one rather than a guess at how many lines it spans.
 */
function useMemoBodies(): { line: number; last: number }[] {
  const out: { line: number; last: number }[] = [];
  for (let i = BODY.first; i < BODY.last; i++) {
    if (!/^const\s+\w+\s*=\s*useMemo\(/.test(code(lines[i]))) continue;
    const startLine = i + 1;
    let level = 0;
    let started = false;
    for (let j = i; j < BODY.last; j++) {
      for (const ch of lines[j]) {
        if (ch === '{') { level++; started = true; }
        else if (ch === '}') level--;
      }
      if (started && level === 0) { out.push({ line: startLine, last: j + 1 }); break; }
    }
  }
  return out;
}

/**
 * Component-scope bindings: declarations at exactly two spaces of indentation
 * *inside App()'s body*. Anything deeper is inside a nested callback, and
 * anything outside the body belongs to a different function entirely.
 *
 * Both plain `const x =` and array-destructuring `const [x, setX] = useState()`
 * are collected. The second form is most of this component's declarations, and
 * omitting it left the parser reporting 25 of the real total.
 */
function componentDeclarations(): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = BODY.first; i < BODY.last; i++) {
    if (depth(lines[i]) !== 2) continue;
    const line = code(lines[i]);

    const plain = /^const\s+([A-Za-z_$][\w$]*)\s*[:=]/.exec(line);
    if (plain) {
      out.set(plain[1], i + 1);
      continue;
    }
    // `const [a, b] = useState(...)` — each element is a binding of its own.
    const arr = /^const\s+\[([^\]]+)\]\s*[:=]/.exec(line);
    if (arr) {
      for (const part of arr[1].split(',')) {
        const name = part.split(':')[0].split('=')[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) out.set(name, i + 1);
      }
    }
  }
  return out;
}

describe('App.tsx has no temporal dead zone reads', () => {
  const decls = componentDeclarations();

  it('finds the component-scope declarations it expects', () => {
    // A parser that silently matched nothing would make every other assertion in
    // this file vacuously true, which is the failure mode this whole project has
    // been bitten by before. So the parser is pinned to a known set.
    console.log(`  tdz: parsed ${decls.size} component-scope declarations`);
    expect(decls.size).toBeGreaterThan(60);
    for (const known of ['route', 'progressAlong', 'guidance', 'localGuidance', 'routePos']) {
      expect(decls.has(known), `expected to find declaration of ${known}`).toBe(true);
    }
  });

  it('never reads a component-scope binding before declaring it inside a useMemo', () => {
    // Only `useMemo` is checked, and the narrowness is the point.
    //
    // A `useMemo` callback executes *during render*, so a binding it closes over
    // must already exist. `useEffect` and `useCallback` do not: an effect runs
    // after the commit, and a callback is merely *created* at render time, so a
    // handler that reads a helper declared further down the body is fine — it
    // runs on a click, long after render has finished. Reporting those would mean
    // reporting most of this file.
    //
    // That distinction is also why the bug that motivated this file went
    // unnoticed for a moment even when found: `beginRouteProgress` genuinely was
    // read above its declaration, and genuinely was harmless, because it is only
    // called from a click handler. So the ordering rule it follows is uniform
    // anyway — helpers a memo needs are declared with the memos.
    const offenders: string[] = [];

    for (const { line: memoAt, last } of useMemoBodies()) {
      for (const [name, declaredAt] of decls) {
        if (declaredAt <= memoAt) continue;
        const re = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`);
        for (let i = memoAt; i < last - 1; i++) {
          const line = code(lines[i]);
          if (!re.test(line)) continue;
          if (new RegExp(`\\b(const|let|var|function|class)\\s+${name}\\b`).test(line)) continue;
          if (new RegExp(`[.\\?]${name}\\b`).test(line)) continue;
          if (new RegExp(`[{,]\\s*${name}\\s*[:,}]`).test(line)) continue;
          offenders.push(
            `useMemo on line ${memoAt} reads ${name}, declared later on line ${declaredAt}: ` +
            `  ${lines[i].trim()}`,
          );
        }
      }
    }

    expect(offenders, `TDZ risks in src/App.tsx:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('reports no earlier read of any component-scope binding, for information', () => {
    // The wider scan, kept as a documented inventory rather than a failure. It
    // over-approximates — it cannot tell a render-time read from one inside a
    // click handler — so it is printed, not asserted on. If this list grows, the
    // next one above is the one that will tell you it matters.
    const reads: string[] = [];
    for (const [name, declaredAt] of decls) {
      const re = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`);
      for (let i = BODY.first; i < declaredAt - 1; i++) {
        const line = code(lines[i]);
        if (!re.test(line)) continue;
        if (new RegExp(`\\b(const|let|var|function|class)\\s+${name}\\b`).test(line)) continue;
        if (new RegExp(`[.\\?]${name}\\b`).test(line)) continue;
        if (new RegExp(`[{,]\\s*${name}\\s*[:,}]`).test(line)) continue;
        reads.push(`${name} (declared ${declaredAt}, read ${i + 1})`);
      }
    }
    console.log(`  tdz: earlier-read inventory: ${reads.length ? reads.join(', ') : 'none'}`);
    expect(Array.isArray(reads)).toBe(true);
  });

  it('declares routePos above the guidance memos that read it', () => {
    // The specific regression, pinned by name so that a future refactor that
    // reintroduces it fails here with a message that says what happened, rather
    // than only failing the generic scan above.
    const routePosAt = decls.get('routePos');
    expect(routePosAt, 'routePos should be a component-scope const').toBeDefined();

    const guidanceAt = lines.findIndex((l) => /^const guidance = useMemo/.test(code(l))) + 1;
    const localAt = lines.findIndex((l) => /^const localGuidance = useMemo/.test(code(l))) + 1;
    expect(guidanceAt).toBeGreaterThan(0);
    expect(localAt).toBeGreaterThan(0);

    expect(routePosAt!).toBeLessThan(guidanceAt);
    expect(routePosAt!).toBeLessThan(localAt);
  });

  it('has a hook callback that actually reads routePos, so the check above has teeth', () => {
    // If a future change stopped the guidance memos reading the ref, the ordering
    // assertions would pass for the wrong reason. Confirm the read is still there.
    const reads = lines.filter((l) => /(?<![\w$.])routePos(?![\w$])/.test(code(l)));
    // Declaration, the position effect, and the memos.
    expect(reads.length).toBeGreaterThanOrEqual(4);
  });
});
