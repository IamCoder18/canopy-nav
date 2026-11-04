/**
 * Spoken guidance, tested against an engine that can refuse, die, and lie.
 *
 * ## Why this file exists
 *
 * `src/nav/voice.ts` is the fix for the mute button that muted nothing, and it
 * shipped with no tests at all — so every defect it was written to prevent could
 * come back with a one-line change and the suite would stay green. The worst of
 * them did come back, in a shape no amount of reading caught: the dedup key was
 * latched *before* the platform was called and released only on the synchronous
 * throw, while the Android WebView reports a missing engine **asynchronously**,
 * on `utter.onerror`. Each instruction was swallowed exactly once and never
 * retried — the precise lie the module's own header says it exists to prevent.
 *
 * So the fake here is not a happy path. It throws from `speak()`, it errors on
 * the utterance after the fact, and it hands back no voices — the three ways a
 * WebView with no TTS engine actually fails — and the tests assert what a driver
 * experiences afterwards: that the instruction is *retried*, that a dead engine
 * visibly takes the capability away, and that a prompt already being spoken is
 * never cut in half by the next number.
 *
 * State is per-test (`vi.resetModules()` plus a fresh import) because the module
 * carries process-wide latches — exactly the ones under test.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

type VoiceModule = typeof import('../src/nav/voice');

/** A stand-in for `SpeechSynthesisUtterance`: a bag of fields the module sets. */
class FakeUtterance {
  text: string;
  rate = 1;
  pitch = 1;
  volume = 1;
  lang = '';
  voice: unknown = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((ev: { error: string }) => void) | null = null;

  constructor(text = '') {
    this.text = text;
  }
}

/** The platform engine: records what it was asked to say, and misbehaves on demand. */
class FakeEngine {
  spoken: FakeUtterance[] = [];
  cancels = 0;
  throwOnSpeak = false;
  voices: unknown[] = [];

  speak(utter: FakeUtterance): void {
    if (this.throwOnSpeak) throw new Error('no synthesis engine');
    this.spoken.push(utter);
  }

  cancel(): void {
    this.cancels += 1;
  }

  getVoices(): unknown[] {
    return this.voices;
  }
}

const g = globalThis as unknown as Record<string, unknown>;

/** Fresh module state, fresh engine, both globals installed. */
async function load(): Promise<{ v: VoiceModule; engine: FakeEngine }> {
  vi.resetModules();
  const engine = new FakeEngine();
  g.window = { speechSynthesis: engine };
  g.SpeechSynthesisUtterance = FakeUtterance;
  const v = await import('../src/nav/voice');
  return { v, engine };
}

afterEach(() => {
  delete g.window;
  delete g.SpeechSynthesisUtterance;
});

describe('speak: once per meaning', () => {
  it('says an instruction once and suppresses the repeat', async () => {
    const { v, engine } = await load();
    const u = { text: 'In 300 m, turn left', key: 'turn@500', priority: 'assertive' as const };
    expect(v.speak(u)).toBe('speaking');
    // The position tick fires several times a second; the guidance does not.
    expect(v.speak(u)).toBe('idle');
    expect(v.speak(u)).toBe('idle');
    expect(engine.spoken).toHaveLength(1);
    expect(v.isSpeaking()).toBe(true);
  });

  it('interrupts the sentence in flight for a new maneuver', async () => {
    const { v, engine } = await load();
    v.speak({ text: 'Continue on Main', key: 'cont@500', priority: 'assertive' });
    const cancelsBefore = engine.cancels;
    v.speak({ text: 'In 300 m, turn left', key: 'turn@500', priority: 'assertive' });
    // Cancel first: the turn must be heard now, not after the stale sentence.
    expect(engine.cancels).toBeGreaterThan(cancelsBefore);
    expect(engine.spoken.map((u) => u.text)).toEqual(['Continue on Main', 'In 300 m, turn left']);
  });

  it('never cuts a sentence in half for its own distance refresh', async () => {
    const { v, engine } = await load();
    expect(v.speak({ text: 'In 500 m, turn left', key: 'turn@500', priority: 'polite' })).toBe('speaking');
    // `start()` clears platform residue before speaking at all; what must not
    // happen is a *second* cancel, which is a sentence cut in half.
    const cancelsBefore = engine.cancels;
    expect(v.speak({ text: 'In 200 m, turn left', key: 'turn@200', priority: 'polite' })).toBe('queued');
    // The refresh waited; nothing was cancelled mid-word.
    expect(engine.cancels).toBe(cancelsBefore);
    expect(engine.spoken).toHaveLength(1);
    engine.spoken[0].onend?.();
    expect(engine.spoken.map((u) => u.text)).toEqual(['In 500 m, turn left', 'In 200 m, turn left']);
  });

  it('speaks only the newest number of a queue built behind one sentence', async () => {
    const { v, engine } = await load();
    v.speak({ text: 'In 1 km, turn left', key: 'turn@1000', priority: 'assertive' });
    expect(v.speak({ text: 'In 500 m, turn left', key: 'turn@500', priority: 'polite' })).toBe('queued');
    expect(v.speak({ text: 'In 200 m, turn left', key: 'turn@200', priority: 'polite' })).toBe('queued');
    engine.spoken[0].onend?.();
    // The 500 m refresh is stale by the time the sentence ends: driven past.
    expect(engine.spoken.map((u) => u.text)).toEqual(['In 1 km, turn left', 'In 200 m, turn left']);
    engine.spoken[1].onend?.();
    expect(engine.spoken).toHaveLength(2);
    expect(v.isSpeaking()).toBe(false);
  });

  it('drops the queue for an assertive instruction and for a teardown', async () => {
    const { v, engine } = await load();
    v.speak({ text: 'In 1 km, turn left', key: 'turn@1000', priority: 'assertive' });
    v.speak({ text: 'In 500 m, turn left', key: 'turn@500', priority: 'polite' });
    // A new maneuver makes the queued refresh stale by definition.
    v.speak({ text: 'Turn left', key: 'turn-now@0', priority: 'assertive' });
    engine.spoken[1].onend?.();
    expect(engine.spoken).toHaveLength(2);

    v.speak({ text: 'In 200 m, turn right', key: 'right@200', priority: 'assertive' });
    v.speak({ text: 'In 100 m, turn right', key: 'right@100', priority: 'polite' });
    v.cancelSpeech();
    expect(v.isSpeaking()).toBe(false);
    // The queued refresh is gone and took its suppression with it: the same
    // request is accepted again rather than silently swallowed as a repeat.
    expect(v.speak({ text: 'In 100 m, turn right', key: 'right@100', priority: 'polite' })).toBe('speaking');
  });
});

describe('a failed instruction is retried, not swallowed', () => {
  it('releases the key when the engine throws synchronously', async () => {
    const { v, engine } = await load();
    engine.throwOnSpeak = true;
    // A WebView that exposes the API but has no engine behind it.
    expect(v.speak({ text: 'In 300 m, turn left', key: 'turn@500', priority: 'assertive' })).toBe('unavailable');
    engine.throwOnSpeak = false;
    // Without the key released this returns 'idle' and the driver never hears
    // the instruction — the exact defect the release exists to prevent.
    expect(v.speak({ text: 'In 300 m, turn left', key: 'turn@500', priority: 'assertive' })).toBe('speaking');
    expect(engine.spoken).toHaveLength(1);
  });

  it('releases the key when the engine fails asynchronously, and retries', async () => {
    const { v, engine } = await load();
    v.speak({ text: 'In 300 m, turn left', key: 'turn@500', priority: 'assertive' });
    // The Android-without-Google-TTS case: the throw never comes; the failure
    // arrives later, on the utterance, by which time `speak()` has returned
    // 'speaking'. It must still be retried on the next tick.
    engine.spoken[0].onerror?.({ error: 'network' });
    expect(v.isSpeaking()).toBe(false);
    expect(v.speak({ text: 'In 300 m, turn left', key: 'turn@500', priority: 'assertive' })).toBe('speaking');
    expect(engine.spoken).toHaveLength(2);
  });

  it('treats a platform cancel as not a failure, but still lets it retry', async () => {
    const { v, engine } = await load();
    v.speak({ text: 'In 300 m, turn left', key: 'turn@500', priority: 'assertive' });
    engine.spoken[0].onerror?.({ error: 'canceled' });
    expect(v.isVoiceAvailable()).toBe(true);
    expect(v.speak({ text: 'In 300 m, turn left', key: 'turn@500', priority: 'assertive' })).toBe('speaking');
  });

  it('never counts this module\'s own cancels against the engine', async () => {
    const { v, engine } = await load();
    v.speak({ text: 'Continue on Main', key: 'cont@500', priority: 'assertive' });
    v.speak({ text: 'In 300 m, turn left', key: 'turn@500', priority: 'assertive' });
    // The interrupted utterance's error event arrives after the fact, late
    // enough to be about an utterance that is no longer current.
    for (let i = 0; i < 4; i += 1) engine.spoken[0].onerror?.({ error: 'interrupted' });
    expect(v.isVoiceAvailable()).toBe(true);
    engine.spoken[1].onend?.();
    expect(v.isSpeaking()).toBe(false);
  });

  it('marks a dead engine unavailable and tells the UI, once', async () => {
    const { v, engine } = await load();
    const seen: number[] = [];
    const off = v.onVoiceAvailabilityChange(() => seen.push(1));
    v.speak({ text: 'In 300 m, turn left', key: 'turn@500', priority: 'assertive' });
    // 'synthesis-unavailable' is the capability itself being absent: no amount
    // of retrying will speak anything, so the claim must go too.
    engine.spoken[0].onerror?.({ error: 'synthesis-unavailable' });
    expect(v.isVoiceAvailable()).toBe(false);
    expect(seen).toEqual([1]);
    expect(v.speak({ text: 'In 300 m, turn right', key: 'right@500', priority: 'assertive' })).toBe('unavailable');
    off();
  });

  it('needs three refusals in a row to call an engine dead, and starts reset the count', async () => {
    const { v, engine } = await load();
    const a = { text: 'In 300 m, turn left', key: 'turn@500', priority: 'assertive' as const };

    v.speak(a);
    engine.spoken[0].onerror?.({ error: 'audio-hardware' }); // 1 — a phone call owns the audio path
    expect(v.isVoiceAvailable()).toBe(true);

    v.speak(a);
    engine.spoken[1].onstart?.();
    engine.spoken[1].onerror?.({ error: 'audio-hardware' }); // the call ended and restarted: 1 again
    expect(v.isVoiceAvailable()).toBe(true);

    v.speak(a);
    engine.spoken[2].onerror?.({ error: 'audio-hardware' }); // 2 consecutive
    expect(v.isVoiceAvailable()).toBe(true);
    v.speak(a);
    engine.spoken[3].onerror?.({ error: 'audio-hardware' }); // 3 — this one is the end of it
    expect(v.isVoiceAvailable()).toBe(false);
  });
});

describe('the utterance is configured for the road and the offline case', () => {
  it('speaks the language its strings are written in, audibly but not urgently', async () => {
    const { v, engine } = await load();
    v.speak({ text: 'In 300 m, turn left', key: 'turn@500', priority: 'assertive' });
    const u = engine.spoken[0];
    // A French device must not read English strings with French phonetics.
    expect(u.lang).toBe('en');
    // The rate `voice.ts` documents. Checked because a comment that states a
    // number and a test that does not is a stale comment on a schedule.
    expect(u.rate).toBe(1.05);
    expect(u.volume).toBe(1);
  });

  it('prefers a local voice, so guidance survives losing signal', async () => {
    const { v, engine } = await load();
    const net = { localService: false, lang: 'en-US' };
    const local = { localService: true, lang: 'en-GB' };
    engine.voices = [net, local];
    v.speak({ text: 'In 300 m, turn left', key: 'turn@500', priority: 'assertive' });
    expect(engine.spoken[0].voice).toBe(local);
  });

  it('uses the engine default when the voice list is still empty', async () => {
    const { v, engine } = await load();
    // `getVoices()` legitimately returns [] until the async list loads; that
    // must degrade to the engine's own default, not to silence.
    engine.voices = [];
    v.speak({ text: 'In 300 m, turn left', key: 'turn@500', priority: 'assertive' });
    expect(engine.spoken[0].voice).toBe(null);
  });
});

describe('the rungs', () => {
  it('are exact at the crossing and hold the value in between', async () => {
    const { v } = await load();
    // A crossing *is* a rung, so the number spoken and shown changes to one
    // that is true at that instant.
    expect(v.announceBand(500, 'metric')).toBe(500);
    expect(v.announceBand(2000, 'metric')).toBe(2000);
    expect(v.announceBand(1609, 'imperial')).toBe(1609);
    // Below the smallest rung the step is about to change hands.
    expect(v.announceBand(0, 'metric')).toBe(0);
  });

  it('change with the meaning, not with every metre', async () => {
    const { v } = await load();
    const at500 = v.voiceKey('turn left', 500, 'metric');
    expect(v.voiceKey('turn left', 420, 'metric')).toBe(at500);
    expect(v.voiceKey('turn left', 199, 'metric')).not.toBe(at500);
    expect(v.voiceKey('turn right', 500, 'metric')).not.toBe(at500);
  });

  it('thin out above the last rung instead of announcing as the top rung', async () => {
    const { v } = await load();
    // A 250 km leg is not "In 50 km" and is not re-announced every 50 km.
    expect(v.announceBand(250000, 'metric')).toBe(250000);
    expect(v.announceBand(255000, 'metric')).toBe(260000);
    expect(v.announceBand(60000, 'metric')).toBe(60000);
    // 100 km banded up to 7 × 10 mi (16093 m), the step the imperial ladder uses.
    expect(v.announceBand(100000, 'imperial')).toBe(7 * 16093);
  });
});
