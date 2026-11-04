/**
 * Spoken guidance.
 *
 * The navigation overlay has shown a Mute button since the first release, and it
 * muted nothing: an exhaustive search for `AudioContext`, `new Audio`,
 * `speechSynthesis`, `vibrate` and any bundled audio returned zero functional
 * hits. A driver taps Mute, hears no change, and concludes voice prompts are
 * off — which is the most damaging way for a single control to lie, because the
 * conclusion is safe-looking and wrong.
 *
 * So this wires the Web Speech API, which the Android WebView supports through
 * the platform's own text-to-speech engine. Nothing is bundled: no audio files,
 * no `AudioContext`, nothing to decode on a phone that is already parsing a
 * province in a worker.
 *
 * Design decisions that matter for a car:
 *
 *  - **Say on the maneuver, not the metre.** Distance is on screen and changes
 *    constantly; speaking it would mean talking over the driver. The instruction
 *    and the distance are announced *together*, when the step changes and at the
 *    distance rungs below — not on every tick and not every 50 m.
 *  - **Never speak a step twice.** `voiceKey` derives identity from the
 *    instruction and the distance *rung*, so re-renders — which happen on every
 *    position tick — are silent.
 *  - **Interrupt yourself for the important thing, and only for that.** A new
 *    maneuver cancels the utterance in progress, so a turn instruction is never
 *    queued behind a stale one. A distance refresh of the instruction already
 *    being spoken does *not* interrupt: it waits its turn and speaks the newest
 *    number when the sentence in flight is done. Before this distinction
 *    existed, every 50 m of driving cut the sentence being spoken in half and
 *    restarted it — at 50 km/h a new bucket every 3.6 s against utterances of
 *    about the same length, so the driver never heard a complete prompt.
 *  - **A failed instruction is retried, not swallowed.** The dedup key is
 *    released when the engine refuses to speak, so the same instruction is
 *    offered again on the next tick instead of being suppressed forever as a
 *    "repeat".
 *  - **Degrade honestly.** No `speechSynthesis` means no voice guidance, and an
 *    engine that fails for good — the WebView that exposes the API with no TTS
 *    engine installed, which is the common Android-without-Google-TTS case —
 *    takes the capability away *visibly*: `isVoiceAvailable()` turns false and
 *    `onVoiceAvailabilityChange` tells the UI, so the control becomes the
 *    disabled, explaining one rather than a Mute button for speech that can
 *    never happen.
 */

/**
 * What `speak()` did with a request.
 *
 * `queued` is its own answer because it is not `speaking` (nothing was started)
 * and not `idle` (the request was accepted and will be heard).
 */
export type VoiceState = 'idle' | 'queued' | 'speaking' | 'unavailable';

/** One queued or in-flight utterance. */
export interface Utterance {
  /** Spoken text. */
  text: string;
  /** Identity of the thing being announced, used to suppress repeats. */
  key: string;
  /**
   * `assertive` interrupts — a new maneuver, an imminent turn, an arrival.
   * `polite` waits for the sentence in flight — a distance refresh of the
   * instruction the driver is already hearing.
   */
  priority: 'assertive' | 'polite';
}

/**
 * The language the guidance strings are written in.
 *
 * Set on every utterance rather than left to the engine: on a device whose
 * locale is French, the engine's default voice reads "turn left onto Main
 * Street" with French phonetics. The app's strings are English, so the speech
 * is English.
 */
const SPEECH_LANG = 'en';

/**
 * The distance rungs guidance is announced at.
 *
 * A navigation app talks at distances a driver can act on, not at a fixed
 * interval. Crossing one of these on approach re-announces the instruction once;
 * between them the driver has the banner and the silence. The rungs are metres,
 * spaced so no prompt is more than about twice the previous one until the
 * numbers stop being round in either unit system.
 */
const RUNGS_METRIC = [10, 25, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 30000, 50000];
/** The same rungs in imperial: 1/8, 1/4, 1/2, 1, 2, 5, 10, 20, 50 miles. */
const RUNGS_IMPERIAL = [10, 25, 50, 100, 201, 402, 805, 1609, 3219, 8047, 16093, 32187, 80467];

/** Above the top rung, band to the nearest 10 km / 10 mi so a 250 km leg is
 * not announced as 50 km. 10 km at highway speed is several minutes of
 * silence — dense rungs stop mattering long before this. */
const SPARSE_STEP_METRIC = 10000;
const SPARSE_STEP_IMPERIAL = 16093;

/**
 * Failures that mean the capability is gone, not that this utterance was
 * refused: no synthesis engine at all, or speech denied to the app. Retrying
 * cannot help, so the honest response is to stop claiming voice guidance at
 * all. Everything else — `audio-hardware` included, because a phone call owns
 * the audio path and hands it back — is transient until three refusals in a row
 * say otherwise (`FAILURE_LIMIT`).
 */
const FATAL_ERRORS = new Set(['synthesis-unavailable', 'not-allowed']);

/**
 * How many consecutive refusals mark the engine dead.
 *
 * One `synthesis-failed` can be a flaky network voice; three in a row is an
 * engine that cannot speak. The counter resets when an utterance actually
 * starts, so an engine that recovers keeps working — but only if it recovered
 * before its third strike.
 */
const FAILURE_LIMIT = 3;

/** Feature-detected plus engine-verified; see `markEngineDead`. */
export function isVoiceAvailable(): boolean {
  return !engineDead && typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/**
 * Called whenever `isVoiceAvailable()` may have changed its answer.
 *
 * The one way it changes is an engine that dies mid-session — the Android
 * WebView without a TTS engine reports `speechSynthesis` truthfully and fails
 * on the first real attempt. A UI that computed availability once per mount
 * would keep showing "Mute voice guidance" for speech that will never happen,
 * which is the exact lie this module exists to prevent. Returns the
 * unsubscribe.
 */
export function onVoiceAvailabilityChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

let current: SpeechSynthesisUtterance | null = null;
let currentKey: string | null = null;
/** The one polite utterance waiting behind `current`. Newest wins. */
let queued: Utterance | null = null;
let lastKey: string | null = null;
let engineDead = false;
let consecutiveFailures = 0;
const listeners = new Set<() => void>();

/**
 * Cancel anything in flight, including the queue.
 *
 * Called on unmount and whenever guidance is replaced. Without it, leaving the
 * navigating screen mid-utterance leaves the WebView speaking into the home
 * screen, which is the kind of bug that gets the app uninstalled.
 */
export function cancelSpeech(): void {
  lastKey = null;
  queued = null;
  current = null;
  currentKey = null;
  stopPlatform();
}

/**
 * Speak `u` unless this exact `key` was the last thing said.
 *
 * Returns what it did, so a caller can surface it. A repeat is the common case
 * — the position updates several times a second and the guidance does not — so
 * it is the path that matters most.
 */
export function speak(u: Utterance): VoiceState {
  if (!isVoiceAvailable()) return 'unavailable';
  // Both latches matter: `lastKey` covers what was said or queued, `currentKey`
  // covers the utterance actually in flight — which may be older than `lastKey`
  // and would otherwise be re-queued behind itself when it ends.
  if (u.key === lastKey || u.key === currentKey) return 'idle';

  lastKey = u.key;

  if (u.priority === 'polite' && current) {
    // Newest wins: a queue of distance refreshes would speak numbers the driver
    // had already driven past.
    queued = u;
    return 'queued';
  }

  // Anything queued behind this point was waiting on a sentence that a more
  // urgent thing has now replaced; it is stale by definition.
  queued = null;
  return start(u) ? 'speaking' : 'unavailable';
}

/** True while an utterance is in flight. Used by tests and diagnostics. */
export function isSpeaking(): boolean {
  return current !== null;
}

/**
 * A key that changes when the *meaning* of a step changes, not when the metres do.
 *
 * The distance is banded to the rungs `announceBand` defines, so creeping along
 * a road does not re-announce while each rung crossed on approach does — once,
 * with the distance the driver is actually at. Round numbers here are what keep
 * the engine from talking over itself every second.
 */
export function voiceKey(instruction: string, metres: number, units: 'metric' | 'imperial'): string {
  return `${instruction}@${announceBand(metres, units)}`;
}

/**
 * The rung a distance announces at — the smallest rung at or above `metres`.
 *
 * Ceiling rather than rounding on purpose: the rung is also the number spoken
 * and shown to assistive technology, and ceilinging means the value is exact at
 * the moment the announcement changes (the crossing *is* the rung) and only
 * stale — never invented — between changes.
 *
 * Returns 0 below the smallest rung: the step is about to change hands, and the
 * next instruction is the thing to say.
 */
export function announceBand(metres: number, units: 'metric' | 'imperial'): number {
  if (metres <= 0) return 0;
  const rungs = units === 'metric' ? RUNGS_METRIC : RUNGS_IMPERIAL;
  const hit = rungs.find((r) => metres <= r);
  if (hit !== undefined) return hit;
  const step = units === 'metric' ? SPARSE_STEP_METRIC : SPARSE_STEP_IMPERIAL;
  return Math.ceil(metres / step) * step;
}

/* ------------------------------------------------------------------ internals */

function stopPlatform(): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    // A cancelled synthesis is not an error worth surfacing.
  }
}

/** Release `key`'s suppression so the caller's next tick may retry it. */
function releaseKey(key: string): void {
  if (lastKey === key) lastKey = null;
}

function markEngineDead(): void {
  if (engineDead) return;
  engineDead = true;
  queued = null;
  current = null;
  currentKey = null;
  lastKey = null;
  stopPlatform();
  // Copy: a listener may unsubscribe itself while being notified.
  for (const cb of [...listeners]) {
    try {
      cb();
    } catch {
      // One listener that throws must not keep the others uninformed.
    }
  }
}

/**
 * Record why an utterance did not happen, and let the caller try again.
 *
 * The key is released unconditionally here, and that is only reachable for a
 * *real* refusal: this module's own cancels — the cancel before a more urgent
 * utterance, or `cancelSpeech` — set `current` to something else before the
 * platform event arrives, so the guard in the handlers above has already
 * returned. A platform-side `canceled` or `interrupted` on the utterance still
 * current is the platform's doing, not this module's, and the instruction is
 * allowed to retry; it is only the strike count that spares it, because this
 * module did nothing wrong and the engine did nothing broken.
 */
function failed(key: string, code: string): void {
  releaseKey(key);
  // Whatever was queued was queued behind speech that never finished; the
  // caller re-requests what still matters.
  queued = null;
  if (code === 'canceled' || code === 'interrupted') return;
  if (FATAL_ERRORS.has(code)) {
    markEngineDead();
    return;
  }
  consecutiveFailures += 1;
  if (consecutiveFailures >= FAILURE_LIMIT) markEngineDead();
}

/** Begin `u`, cancelling whatever was still talking first. False if the engine refused. */
function start(u: Utterance): boolean {
  current = null;
  currentKey = null;
  stopPlatform();

  let utter: SpeechSynthesisUtterance;
  try {
    utter = new SpeechSynthesisUtterance(u.text);
  } catch {
    failed(u.key, 'synthesis-unavailable');
    return false;
  }

  // A little above default so it is audible over road noise without being
  // startling; ~1.15x is roughly what navigation apps use. (Measured intent:
  // the number is 1.05, chosen as the audible-uplift without the clipped
  // urgency of 1.2.)
  utter.rate = 1.05;
  utter.pitch = 1;
  utter.volume = 1;
  utter.lang = SPEECH_LANG;
  const local = pickLocalVoice();
  if (local) utter.voice = local;

  // Success resets the refusals: an engine that recovered keeps working. Both
  // events count — `onstart` says the engine began, `onend` says it finished.
  utter.onstart = () => {
    consecutiveFailures = 0;
  };
  utter.onend = () => {
    if (current !== utter) return;
    consecutiveFailures = 0;
    current = null;
    currentKey = null;
    pump();
  };
  utter.onerror = (ev) => {
    if (current !== utter) return;
    // The Android WebView reports a missing engine here and not as a throw —
    // asynchronously, on the next task. This is the path that swallowed every
    // instruction exactly once while `isVoiceAvailable()` still said `true`.
    current = null;
    currentKey = null;
    failed(u.key, ev.error);
  };

  current = utter;
  currentKey = u.key;
  try {
    window.speechSynthesis.speak(utter);
    return true;
  } catch {
    // Some WebViews expose the API but throw when the engine is missing. That is
    // "no voice", not a crash, and the caller reports it as such.
    current = null;
    currentKey = null;
    failed(u.key, 'synthesis-failed');
    return false;
  }
}

/** Speak the polite utterance waiting behind one that just finished. */
function pump(): void {
  if (current || !queued) return;
  const u = queued;
  queued = null;
  start(u);
}

/**
 * A local TTS voice, so prompts survive losing signal.
 *
 * This app routes, searches and navigates offline; guidance that needs the
 * network to *speak* is guidance that dies at the county line. `getVoices()`
 * can legitimately return `[]` before the async voice list loads, in which case
 * the engine's own default is used — which on Android is a local voice anyway.
 */
function pickLocalVoice(): SpeechSynthesisVoice | null {
  try {
    const voices = window.speechSynthesis.getVoices?.() ?? [];
    const local = voices.filter((v) => v.localService);
    const english = local.filter((v) => v.lang.toLowerCase().startsWith('en'));
    return english[0] ?? local[0] ?? null;
  } catch {
    return null;
  }
}
