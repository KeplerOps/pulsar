// Workbench mode profiles — the single data source for per-mode behavior.
//
// Under ADR-032 the workbench supports two modes: `present` (run the scene
// slice through the imperative control plane) and `prompter` (render the
// captions script, no scene lifecycle). Each decides a small, fixed set of
// runtime behaviors: the audio output policy, chrome visibility, and whether
// the composition audio bed is suppressed. Mode is data, not control flow:
// the loader and chrome surface read a profile instead of re-deriving each
// behavior. Adding a mode means adding one row here.

import type { AudioOutputPolicy } from './audio';
import type { NavigationMode } from './navigation';

/** The fixed behavior a workbench mode selects. */
export interface ModeProfile {
  /** Audio output policy for the per-navigation audio service (ADR-004). */
  readonly audioPolicy: AudioOutputPolicy;
  /** Chrome surface visibility absent a composition `behavior.chrome` override (ADR-031). */
  readonly chromeVisibility: 'visible' | 'hidden';
  /** Whether the composition audio bed is suppressed — the scene runs as if standalone (PUL-F014). */
  readonly suppressBed: boolean;
}

const profile = (p: ModeProfile): ModeProfile => Object.freeze(p);

const MODE_PROFILES: Readonly<Record<NavigationMode, ModeProfile>> = Object.freeze({
  present: profile({
    audioPolicy: 'audible',
    chromeVisibility: 'visible',
    suppressBed: false,
  }),
  prompter: profile({
    audioPolicy: 'audible',
    chromeVisibility: 'visible',
    suppressBed: false,
  }),
});

/** The frozen profile for a workbench mode. */
export function profileFor(mode: NavigationMode): ModeProfile {
  return MODE_PROFILES[mode];
}
