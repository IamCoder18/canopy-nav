/**
 * What the turn list says when it has nothing to list.
 *
 * ## Why this is a function and not three branches of JSX
 *
 * Three different situations produce an empty turn list, and the single piece of
 * copy that used to render for all three named the wrong cause for two of them.
 *
 * The offline engine emits no maneuvers at all. This app *infers* them from where
 * the route bends — `App.tsx`'s `localGuidance` — so an empty list there is a fact
 * about **this route** and about nothing else:
 *
 *  - the route is too coarse for the inference to read any bend from (fewer than
 *    17 vertices, and the sampler needs 8 either side of each candidate), or
 *  - the inference ran and found no turn worth stopping for.
 *
 * Both used to render "`<engine> answered this route but does not supply turn-by-turn
 * guidance`", which sends the driver to Settings to change something that would not
 * have changed the answer — and, in the sparse case, blames a capability for a
 * route that simply has nothing in it. §3.19's deferred item.
 *
 * Extracted so all three branches are testable. `App.tsx` renders this, and nothing
 * else in the app decides what an empty turn list means.
 */

/** What the turn list is empty because of. */
export interface StepsEmptyContext {
  /** The steps came from inference rather than from an engine's maneuvers. */
  inferred: boolean;
  /**
   * The route was too coarse for the inference to look at any window of it.
   *
   * Distinct from "the inference ran and found nothing", and the copy distinguishes
   * them because the advice differs: a longer route helps in one case and no route
   * length helps in the other.
   */
  tooSparseToInfer?: boolean;
  /** The engine that produced the route, for the case that names it. */
  engineLabel?: string | null;
}

/** The setting that produces real turn-by-turn guidance, named in every branch. */
const ENGINE_ADVICE =
  'Choose a Valhalla engine in Settings → Routing → Engines for detailed instructions.';

export function stepsEmptyReason(ctx: StepsEmptyContext): string {
  if (ctx.tooSparseToInfer) {
    // Actionable in two directions: the route itself, and the setting. Neither
    // "your engine cannot help" nor a bare apology would tell anyone what to do.
    return 'Your offline map worked out this route from a shape too coarse to read turns '
      + `from, so there is nothing to list. A longer route usually gives it more to go on. ${ENGINE_ADVICE}`;
  }

  if (ctx.inferred) {
    // The inference worked. There is genuinely nothing here, and saying so is more
    // useful than implying a missing capability.
    return 'This route has no significant turns in it — the offline map found nothing worth '
      + 'stopping for. Distance and arrival time are still shown on the navigation screen.';
  }

  // An engine that answered and supplied no maneuvers. The one case where naming
  // the engine is right, because the capability is genuinely the engine's.
  const who = ctx.engineLabel
    ? `${ctx.engineLabel} answered this route but does not supply turn-by-turn guidance.`
    : 'The engine that answered this route does not supply turn-by-turn guidance.';
  return `${who} ${ENGINE_ADVICE} The distance and ETA remain available on the navigation screen.`;
}