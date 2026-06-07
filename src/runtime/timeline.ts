// Timeline engine — PUL-F022 / ADR-003 / ADR-032.
//
// Scenes get GSAP as `ctx.gsap` and author + drive their own per-scene
// timeline; they never import GSAP directly (PUL-A001). Under ADR-032 the
// runtime no longer composes a master timeline across the slice — the
// imperative control plane (`spike/control-plane.ts`) plays each scene's
// own timeline standalone, holds for advance, and tears it down. This
// module is therefore reduced to the engine handle the workbench threads
// to scenes; it is the one place a GSAP import lives outside L2.

import { gsap } from 'gsap';

/**
 * The GSAP handle the workbench passes to scenes as `ctx.gsap`
 * (ADR-003). A thin wrapper so the rest of the runtime depends on this
 * module rather than on `gsap` directly — the one place a future engine
 * swap or wrapper expansion would land.
 */
export interface TimelineEngine {
  readonly gsap: typeof gsap;
}

/** Build a {@link TimelineEngine}. The GSAP instance is a process singleton. */
export function createTimelineEngine(): TimelineEngine {
  return { gsap };
}
