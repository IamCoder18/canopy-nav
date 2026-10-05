/**
 * A message for a caught value, whatever it turned out to be.
 *
 * ## Why this exists
 *
 * `catch (e) { setError((e as Error).message) }` looks like a type assertion and
 * behaves like one — until the rejection value is not an `Error`.
 *
 * `fetch` rejects with a `TypeError`, but it also rejects with a bare `DOMException`,
 * a string, and in some WebViews `undefined`. `JSON.parse` throws a `SyntaxError`;
 * a Worker terminated mid-flight rejects with an `ErrorEvent`-shaped object;
 * `Promise.reject(null)` rejects with `null`. In every one of those cases
 * `(e as Error).message` is `undefined` — so the user sees a blank banner — and
 * for `null`/`undefined` it is a **`TypeError` thrown inside the `catch` block**.
 *
 * That second case is the damaging one. A throw inside a `catch` skips the
 * `finally` that would have cleared the loading flag, so the operation appears to
 * hang forever, and the real diagnosis is replaced by a message about property
 * access on `undefined`. This module's own note on `App.tsx`'s restore effect
 * describes the same shape: the original cause becomes unrecoverable.
 *
 * `regions/store.ts` already carried a local copy of this coercion. It is here now
 * so there is one, and so a new `catch` block reaches for it rather than
 * re-inventing an assertion that is not safe.
 */

/** A short, honest description of an unknown thrown value. */
export function describeError(value: unknown): string {
  if (value instanceof Error) {
    // An `Error` with no message still happened; say what, rather than blank.
    return value.message.trim() || value.name || 'An unknown error occurred.';
  }
  if (typeof value === 'string') return value.trim() || 'An unknown error occurred.';
  if (value === null) return 'An unknown error occurred (null).';
  if (value === undefined) return 'An unknown error occurred (no reason given).';

  // A DOMException carries its name in `name` and its detail in `message`; an
  // ErrorEvent carries a nested `error`. Neither is an `Error` subclass in every
  // engine, so they are read structurally rather than with `instanceof`.
  const obj = value as { name?: unknown; message?: unknown; error?: unknown; status?: unknown };
  if (typeof obj.name === 'string' && typeof obj.message === 'string' && obj.message.trim()) {
    return obj.message.trim();
  }
  if (typeof obj.message === 'string' && obj.message.trim()) return obj.message.trim();
  if (obj.error !== undefined && obj.error !== null) return describeError(obj.error);
  if (typeof obj.status === 'number') return `HTTP ${obj.status}`;

  try {
    const json = JSON.stringify(value);
    if (json && json !== '{}') return json.slice(0, 200);
  } catch {
    // Circular, or a value with a throwing `toJSON`. Nothing more to say.
  }
  return 'An unknown error occurred.';
}