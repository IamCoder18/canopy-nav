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
 *    and the distance are announced *together*, once, when the step changes.
 *  - **Never speak a step twice.** `useGuidanceVoice` compares a key derived from
 *    the instruction and its rounded distance bucket, so re-renders — which happen
 *    on every position tick — are silent.
 *  - **Interrupt yourself for the important thing.** A new maneuver cancels the
 *    utterance in progress, so a turn instruction is never queued behind a stale
 *    one.
 *  - **Degrade honestly.** No `speechSynthesis` means no voice guidance, and
 *    `isVoiceAvailable()` lets the UI say so rather than showing a mute button
 *    for a capability that does not exist.
 */

export type VoiceState = 'idle' | 'speaking' | 'unavailable';

/** Feature-detected once; the WebView does not gain the API mid-session. */
export function isVoiceAvailable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/** One queued or in-flight utterance. */
export interface Utterance {
  /** Spoken text. */
  text: string;
  /** Identity of the thing being announced, used to suppress repeats. */
  key: string;
  /** `assertive` for a maneuver, `polite` for an arrival. */
  priority: 'assertive' | 'polite';
}

let current: SpeechSynthesisUtterance | null = null;
let lastKey: string | null = null;

/**
 * Cancel anything in flight.
 *
 * Called on unmount and whenever guidance is replaced. Without it, leaving the
 * navigating screen mid-utterance leaves the WebView speaking into the home
 * screen, which is the kind of bug that gets the app uninstalled.
 */
export function cancelSpeech(): void {
  lastKey = null;
  if (!isVoiceAvailable()) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    // A cancelled synthesis is not an error worth surfacing.
  }
  current = null;
}

/**
 * Speak `text` unless this exact `key` was the last thing said.
 *
 * Returns what it did, so a caller can surface it. A repeat is the common case
 * — the position updates several times a second and the guidance does not — so it
 * is the path that matters most.
 */
export function speak(u: Utterance): VoiceState {
  if (!isVoiceAvailable()) return 'unavailable';
  if (u.key === lastKey) return 'idle';

  try {
    // Cancel first: a maneuver instruction arriving mid-utterance must be heard
    // now, not after whatever is still talking.
    window.speechSynthesis.cancel();

    const utter = new SpeechSynthesisUtterance(u.text);
    // A little above default so it is audible over road noise without being
    // startling; ~1.15x is roughly what navigation apps use.
    utter.rate = 1.05;
    utter.pitch = 1;
    utter.volume = 1;
    if (u.priority === 'assertive') utter.volume = 1;

    utter.onend = () => { current = null; };
    utter.onerror = () => { current = null; };

    lastKey = u.key;
    current = utter;
    window.speechSynthesis.speak(utter);
    return 'speaking';
  } catch {
    // Some WebViews expose the API but throw when the engine is missing. That is
    // "no voice", not a crash, and the caller reports it as such.
    current = null;
    return 'unavailable';
  }
}

/** True while an utterance is in flight. Used by tests and diagnostics. */
export function isSpeaking(): boolean {
  return current !== null;
}

/**
 * A key that changes when the *meaning* of a step changes, not when the metres do.
 *
 * Distance is bucketed to 50 m (or 0.2 mi), so creeping along a road does not
 * re-announce, while a new maneuver block does. Round numbers here are what keep
 * the engine from talking over itself every second.
 */
export function voiceKey(instruction: string, metres: number, units: 'metric' | 'imperial'): string {
  const bucket = units === 'metric'
    ? Math.round(metres / 50) * 50
    : Math.round((metres / 1609.34) / 0.2) * 0.2 * 1609.34;
  return `${instruction}@${Math.round(bucket)}`;
}