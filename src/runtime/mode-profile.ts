// Workbench mode profiles — the single data source for per-mode behavior.
//
// Each of the eight workbench modes (ADR-007 / ADR-016..022) decides a
// small, fixed set of runtime behaviors: the audio output policy, whether
// the composition slice truncates to its addressed head, chrome
// visibility, whether the composition audio bed is suppressed, whether the
// loader builds the shared scrub cue gate, and the head-scene runner-input
// hints the resolver receives.
//
// Before this table those decisions were scattered as `mode === X`
// branches across `scene-loader.ts` (audio policy, runner hints, slice
// truncation, bed suppression, cue gate) and `workbench-chrome.ts` (chrome
// visibility). Mode is data, not control flow: the loader and chrome
// surface read a profile instead of re-deriving each behavior. Adding a
// mode means adding one row here — the consumers do not change.

import type { AudioOutputPolicy } from './audio';
import type { NavigationMode } from './navigation';

/**
 * Head-scene runner-input hints. The resolver scopes each hint to the
 * addressed head scene only; following composition entries never see them
 * because the slice is truncated upstream (single-scene modes) or the
 * head's timeline never naturally completes (loop/paused). At most one
 * field is set, because the modes that set them are mutually exclusive at
 * the URL boundary.
 */
export interface RunnerHints {
  /** PUL-F015 / ADR-018: restart the head scene's timeline on completion. */
  readonly repeat?: 'until-aborted';
  /** PUL-F016 / ADR-019: hold the head scene's timeline at the first frame. */
  readonly hold?: 'first-frame';
  /** PUL-F017 / ADR-020: gate audio cues to monotonic forward playback. */
  readonly cueGate?: 'monotonic-forward';
  /** PUL-F018 / ADR-021: render the addressed beat, hold still, suppress audio, seed RNG. */
  readonly screenshot?: 'capture';
}

/** The fixed behavior a workbench mode selects. */
export interface ModeProfile {
  /** Audio output policy for the per-navigation audio service (ADR-004). */
  readonly audioPolicy: AudioOutputPolicy;
  /** Whether the validated composition slice truncates to its addressed head. */
  readonly singleScene: boolean;
  /** Chrome surface visibility absent a composition `behavior.chrome` override (ADR-031). */
  readonly chromeVisibility: 'visible' | 'hidden';
  /** Whether the composition audio bed is suppressed — the scene runs as if standalone (PUL-F014). */
  readonly suppressBed: boolean;
  /** Whether the loader builds the shared scrub cue gate for this mode (PUL-F017). */
  readonly buildScrubCueGate: boolean;
  /** Head-scene runner-input hints threaded to the resolver (empty for most modes). */
  readonly runnerHints: RunnerHints;
}

const profile = (p: ModeProfile): ModeProfile => Object.freeze(p);

const MODE_PROFILES: Readonly<Record<NavigationMode, ModeProfile>> = Object.freeze({
  present: profile({
    audioPolicy: 'audible',
    singleScene: false,
    chromeVisibility: 'visible',
    suppressBed: false,
    buildScrubCueGate: false,
    runnerHints: Object.freeze({}),
  }),
  standalone: profile({
    audioPolicy: 'audible',
    singleScene: true,
    chromeVisibility: 'hidden',
    suppressBed: true,
    buildScrubCueGate: false,
    runnerHints: Object.freeze({}),
  }),
  loop: profile({
    audioPolicy: 'audible',
    singleScene: true,
    chromeVisibility: 'visible',
    suppressBed: false,
    buildScrubCueGate: false,
    runnerHints: Object.freeze({ repeat: 'until-aborted' }),
  }),
  paused: profile({
    audioPolicy: 'silent',
    singleScene: true,
    chromeVisibility: 'visible',
    suppressBed: false,
    buildScrubCueGate: false,
    runnerHints: Object.freeze({ hold: 'first-frame' }),
  }),
  scrub: profile({
    audioPolicy: 'audible',
    singleScene: true,
    chromeVisibility: 'visible',
    suppressBed: false,
    buildScrubCueGate: true,
    runnerHints: Object.freeze({ cueGate: 'monotonic-forward' }),
  }),
  screenshot: profile({
    audioPolicy: 'silent',
    singleScene: true,
    chromeVisibility: 'hidden',
    suppressBed: false,
    buildScrubCueGate: false,
    runnerHints: Object.freeze({ screenshot: 'capture' }),
  }),
  prompter: profile({
    audioPolicy: 'audible',
    singleScene: false,
    chromeVisibility: 'visible',
    suppressBed: false,
    buildScrubCueGate: false,
    runnerHints: Object.freeze({}),
  }),
  rehearsal: profile({
    audioPolicy: 'log-cues',
    singleScene: false,
    chromeVisibility: 'visible',
    suppressBed: false,
    buildScrubCueGate: false,
    runnerHints: Object.freeze({}),
  }),
});

/** The frozen profile for a workbench mode. */
export function profileFor(mode: NavigationMode): ModeProfile {
  return MODE_PROFILES[mode];
}
