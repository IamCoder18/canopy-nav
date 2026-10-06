/**
 * Why the turn list is empty.
 *
 * Three situations produce an empty list, and one piece of copy used to render for
 * all three. It named the wrong cause for two of them, which is worse than saying
 * nothing: it sent the driver to Settings to change a setting that would not have
 * changed the answer.
 *
 * The distinction that matters is **whose** failure it is. An engine that answered
 * and supplied no maneuvers is a missing capability, and naming the engine is
 * right. An offline route with no turns is neither — the offline engine emits no
 * maneuvers *ever*, so an empty list there says something about the route, and the
 * two possible things it can say need different advice from the driver.
 */

import { describe, it, expect } from 'vitest';
import { stepsEmptyReason } from '../src/nav/steps';

const ADVICE = /Valhalla engine in Settings/;

describe('stepsEmptyReason', () => {
  it('blames the engine only when the engine is what is missing', () => {
    const copy = stepsEmptyReason({ inferred: false, engineLabel: 'Valhalla — FOSSGIS' });
    expect(copy).toMatch(/Valhalla — FOSSGIS answered this route/);
    expect(copy).toMatch(/does not supply turn-by-turn guidance/);
    expect(copy).toMatch(ADVICE);
  });

  it('still works with no engine label at all', () => {
    // Provenance is null before any route exists, and a missing label must not
    // produce "null answered this route".
    const copy = stepsEmptyReason({ inferred: false, engineLabel: null });
    expect(copy).toMatch(/The engine that answered this route/);
    expect(copy).not.toMatch(/null|undefined/);
  });

  it('does not blame the engine when the steps were inferred and there were none', () => {
    // §3.19's deferred item. The inference ran, found nothing, and the driver was
    // told their engine could not help — which is not what happened.
    const copy = stepsEmptyReason({ inferred: true, engineLabel: 'Offline (.osm)' });
    expect(copy).toMatch(/no significant turns/i);
    expect(copy).not.toMatch(/does not supply turn-by-turn guidance/);
    // And nothing about a setting, because no setting would help this route.
    expect(copy).not.toMatch(ADVICE);
  });

  it('names the real reason when the route was too coarse to read turns from', () => {
    const copy = stepsEmptyReason({ inferred: true, tooSparseToInfer: true });
    expect(copy).toMatch(/too coarse to read turns from/i);
    expect(copy).not.toMatch(/does not supply turn-by-turn guidance/);
  });

  it('offers both routes out of the sparse case, because both are real', () => {
    // A longer route may give the inference more to work with; a Valhalla engine
    // gives real instructions regardless. Omitting either sends someone down the
    // wrong road.
    const copy = stepsEmptyReason({ inferred: true, tooSparseToInfer: true });
    expect(copy).toMatch(/longer route/i);
    expect(copy).toMatch(ADVICE);
  });

  it('prefers the sparse explanation over the engine one', () => {
    // Both flags can be true — the route is offline *and* coarse — and the coarse
    // one is the specific truth. Ordering matters, so it is asserted.
    const copy = stepsEmptyReason({
      inferred: true, tooSparseToInfer: true, engineLabel: 'Offline (.osm)',
    });
    expect(copy).toMatch(/too coarse/i);
    expect(copy).not.toMatch(/does not supply turn-by-turn/);
  });

  it('treats a sparse online route as sparse rather than as an engine gap', () => {
    // `tooSparseToInfer` is only ever set for the offline engine today, but the
    // reason it is reported separately rather than folded into `inferred` is
    // exactly that the two are independent facts.
    const copy = stepsEmptyReason({
      inferred: false, tooSparseToInfer: true, engineLabel: 'Valhalla — FOSSGIS',
    });
    expect(copy).toMatch(/too coarse/i);
    expect(copy).not.toMatch(/does not supply turn-by-turn/);
  });

  it('always says what is still available, when there is something to say', () => {
    // The driver is not stuck: distance and ETA do not depend on maneuvers.
    for (const copy of [
      stepsEmptyReason({ inferred: false, engineLabel: 'x' }),
      stepsEmptyReason({ inferred: true }),
      stepsEmptyReason({ inferred: true, tooSparseToInfer: true }),
    ]) {
      expect(copy.length).toBeGreaterThan(60);
      expect(copy).toMatch(/\.$/);
    }
  });
});