// Pulsar L2 — audio cue authoring helpers.
//
// Thin wrappers over `ctx.audio` (PUL-F024 / ADR-004) that decks call
// from scene callbacks. The runtime owns the AudioService lifecycle;
// these helpers just trim the load-then-play boilerplate that every
// audio-bearing scene otherwise repeats.
//
// Every audio source URL the deck plays MUST also appear in the
// scene's `audio` declaration (which the loader passes as
// `allowedSources` to the service). Otherwise `load` throws
// `AudioSourceError`.

import type { AudioService, AudioSpriteMap, PlayOptions } from '../../runtime/audio';

/**
 * Ensure a sound is registered, then play it. Idempotent: re-calling
 * with the same id + identical definition is a no-op load (service
 * verifies the definition matches). The most common cue shape for
 * cinematic decks — call it from a `tl.call(...)` at a label, or
 * directly from `scene.create()` for an ambient bed.
 *
 * Example (cold-open music bed):
 *
 *     ctx.audio?.load('cold-open', { src: ['/assets/sounds/cold-open.mp3'] });
 *     tl.call(() => playCue(ctx.audio, 'cold-open', { loop: true, volume: 0.68 }));
 */
export const playCue = (
  audio: AudioService | undefined,
  soundId: string,
  options: PlayOptions = {},
): void => {
  if (audio === undefined || audio.isDisposed()) return;
  audio.play(soundId, options);
};

/**
 * Fade a sound from its current volume to silence over `durationMs`
 * and stop it. Mirrors the demo_thoughts decks' `fadeOutAudio` rAF
 * loop but rides on the AudioService's `fade` (Howler-backed) so the
 * tween survives master pause/seek/speed changes consistently.
 */
export const fadeAndStop = (
  audio: AudioService | undefined,
  soundId: string,
  fromVolume: number,
  durationMs: number,
): void => {
  if (audio === undefined || audio.isDisposed()) return;
  try {
    audio.fade(soundId, fromVolume, 0, durationMs);
  } catch {
    // Sound may not be loaded yet (the load on first play races our
    // fade) — fall through to stop, which is the only outcome that
    // matters semantically.
  }
  const stopAfterFade = (): void => {
    if (audio.isDisposed()) return;
    try {
      audio.stop(soundId);
    } catch {
      // Stop on an unknown id is fine.
    }
  };
  setTimeout(stopAfterFade, durationMs + 50); // PUL-Q001-allow: post-fade stop sequenced off the fade duration; screenshot mode short-circuits via the muted policy and never reaches here.
};

/**
 * One-shot helper: register the sound (idempotent), then play it.
 * Useful when scene.create wants to declare-and-play in one line.
 */
export const loadAndPlayCue = (
  audio: AudioService | undefined,
  soundId: string,
  def: { readonly src: readonly string[]; readonly sprite?: AudioSpriteMap },
  options: PlayOptions = {},
): void => {
  if (audio === undefined || audio.isDisposed()) return;
  audio.load(soundId, def);
  audio.play(soundId, options);
};
