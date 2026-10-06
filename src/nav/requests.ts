/**
 * Sequencing for the long-running requests the app makes.
 *
 * `resolveRoute` can be outstanding for twenty seconds — the routing timeout is
 * deliberately generous, because a cold server on a mobile connection should
 * still get a chance. Two callers can have one in flight at once, and neither
 * checked whether its answer still mattered. Both wrote `route`, `provenance` and
 * `fitNonce`, so a late answer installed itself over a newer one: destination A's
 * line under destination B's label, and the first `finally` clearing a spinner
 * while the second request was still running.
 *
 * The reroute case is worse. `App`'s effect resets the reroute state whenever
 * navigation ends, but nothing stopped the *request*: pressing Exit mid-reroute
 * let the abandoned response install a route on the preview screen and write
 * `finishReroute(..., ok: false)` onto freshly-reset state, resurrecting
 * `status: 'failed'` and its banner for a trip that no longer existed.
 *
 * ## What this is not
 *
 * It is not a debounce and not a queue. A driver's second tap on Search is not a
 * refinement of the first, it is a different destination, and the right answer is
 * to forget the first. Queuing would run both and show whichever finished last,
 * which is the same bug with extra latency.
 *
 * ## Why a counter rather than an AbortController
 *
 * An abort would stop the work, and a reader will expect to see one here. It is
 * deliberately not the mechanism, because the fetch is not the part that matters:
 * `resolveRoute` may be walking the region library or an A* search, and neither is
 * interruptible. The sequence number is what makes the *outcome* correct — the
 * request still finishes and its answer is discarded — and that is sufficient for
 * correctness. `abort()` is offered alongside it for the socket, as a
 * best-effort saving rather than the load-bearing part.
 */

/**
 * One in-flight request at a time, identified by a token.
 *
 * `label` names the request in the thrown error, so "superseded" is only
 * meaningful to somebody who can tell *which* request was abandoned.
 */
export class RequestGate {
  private seq = 0;
  private controller: AbortController | null = null;

  constructor(private readonly label: string) {}

  /**
   * Take the gate, superseding anything already in flight.
   *
   * The returned token is what `assertLive` compares, and it must be captured
   * *before* the await it guards.
   */
  begin(): { token: number; signal: AbortSignal } {
    this.controller?.abort(new SupersededError(this.label));
    this.controller = new AbortController();
    this.seq += 1;
    return { token: this.seq, signal: this.controller.signal };
  }

  /** True when `token` is no longer the live request. */
  isStale(token: number): boolean {
    return token !== this.seq;
  }

  /** The token of the request currently in flight, or 0 when there is none. */
  get live(): number {
    return this.seq;
  }

  /**
   * Throw if this answer no longer matters.
   *
   * Preferred over returning a boolean at every call site, because a call site
   * that forgets the check produces the original bug a minute later rather than a
   * compile error. The message says what happened, for the engine trace.
   */
  assertLive(token: number): void {
    if (this.isStale(token)) throw new SupersededError(this.label);
  }

  /**
   * Abandon whatever is in flight, e.g. when the trip ends.
   *
   * Nothing throws. This is called from cleanup, where a rejection would be
   * reported as an application error for something the app did on purpose.
   */
  cancel(): void {
    this.controller?.abort(new SupersededError(this.label));
    this.controller = null;
    this.seq += 1;
  }
}

/**
 * A request whose answer was deliberately discarded.
 *
 * A distinct class because the caller's `catch` writes its value onto the banner.
 * Without this, a superseded request would report "no route found" for a route the
 * app never wanted — the exact confusion this module exists to prevent, arriving
 * through the error path instead of the success path.
 */
export class SupersededError extends Error {
  constructor(readonly which: string) {
    super(`${which} request was superseded; its answer was discarded`);
    this.name = 'SupersededError';
  }
}

/** True for an error that means "this answer was not wanted", not "this failed". */
export function isSuperseded(e: unknown): boolean {
  return e instanceof SupersededError;
}