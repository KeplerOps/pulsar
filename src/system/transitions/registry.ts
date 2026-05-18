// Pulsar L2 transitions — registry.
//
// Maps transition name → implementation. `defaultTransitions()`
// returns a fresh map with all five shipped transitions registered;
// `src/main.ts` passes this to `createGsapCompositionTimeline` so
// composition manifests can declare transitions by name via
// `behavior.transition: { name, durationMs? }`.

import type { Transition, TransitionRegistry } from '../../runtime/timeline';
import { cut } from './cut';
import { dissolve } from './dissolve';
import { hardSlam } from './hard-slam';
import { holdOnBlack } from './hold-on-black';
import { push } from './push';

/** Every transition shipped by default in the L2 system layer. */
export const ALL_TRANSITIONS: readonly Transition[] = [cut, dissolve, hardSlam, holdOnBlack, push];

/**
 * Build the canonical transition registry — a `ReadonlyMap` keyed by
 * `Transition.name`. Returned fresh each call so a deck or test that
 * wants to override or extend can construct from it.
 */
export const defaultTransitions = (): TransitionRegistry => {
  const map = new Map<string, Transition>();
  for (const t of ALL_TRANSITIONS) map.set(t.name, t);
  return map;
};
