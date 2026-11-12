/**
 * Fuzzy matching primitives: how far off a query may be and still mean a name.
 *
 * Split from `text.ts` because only the *matcher* needs them — the result rows
 * highlight matches with `text.ts`'s normalization and nothing else — and the
 * matcher loads on demand (see `App.tsx`'s search effect). Normalization is
 * boot-adjacent (it renders); edit distance is search.
 *
 * Run with: npx vitest run test/search-match.spec.ts
 */

/**
 * How many edits a token of this length may absorb and still count as the
 * same word.
 *
 * Short tokens get none: with a three-letter needle almost every token in the
 * gazetteer is within one edit ("gas" -> "bar", "ave" -> "are"), so tolerance
 * there buys recall and pays in nonsense. Long tokens can carry two.
 */
export function fuzzyTolerance(len: number): number {
  return len <= 3 ? 0 : len <= 5 ? 1 : 2;
}

/**
 * Damerau-Levenshtein (optimal string alignment) distance, bounded.
 *
 * Returns `max + 1` once the distance is known to exceed `max`, so the fuzzy
 * scan over a whole vocabulary rejects most tokens on the length filter alone.
 * There is deliberately no per-row early exit: an OSA row can dip one below
 * the previous row's minimum (transpositions), so "row minimum exceeded max"
 * is not proof the final distance does, and an off-by-one here silently kills
 * exactly the near-miss matches the fuzzy tier exists for.
 */
export function editDistance(a: string, b: string, max = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const m = a.length;
  const n = b.length;
  // Two rolling rows; dp[i][j] is the distance between a[..i] and b[..j].
  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      // Transposition: OSA allows adjacent swaps ("calgry" -> "calgary").
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur[j] = v;
    }
    prev2 = prev;
    prev = cur;
  }
  return Math.min(prev[n], max + 1);
}
