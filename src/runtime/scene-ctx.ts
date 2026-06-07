// Scene context contract — the per-navigation environment the workbench
// passes to every scene lifecycle hook (ADR-032).
//
// Carries the injected stage / gsap / audio / chrome / presenter / rng so
// scenes stay free of ambient `document` / GSAP / Howler globals (ADR-008
// #2). The runtime never inspects it — it is purely a scene-to-environment
// carrier. Lives in its own module so the present-loader, scene fixtures,
// and L2 templates can depend on the ctx shape without importing the
// loader implementation.

import type { NavigationMode } from './navigation';
import type { PresenterController } from './presenter';
import type { SceneActivation } from './scene';
import type { TimelineEngine } from './timeline';

/** The minimal subset of an HTMLElement the runtime writes to. */
export interface StageElement {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/** Optional L2 chrome slot refs (template consumption only; engine stays L2-agnostic). */
export type WorkbenchChromeSlots = Readonly<Record<string, unknown>>;

/**
 * Scene context the workbench passes to every lifecycle hook. The runtime
 * never inspects it — it is purely a scene-to-environment carrier. Stage /
 * gsap / audio are injected dependencies so scenes stay free of ambient
 * `document` / GSAP / Howler globals (ADR-008 #2).
 */
export interface WorkbenchSceneCtx {
  /** The workbench stage element, or `null` when the runtime has no stage. */
  readonly stage: StageElement | null;
  /**
   * Per-navigation presenter controller (`mode=present` only). Auto-detaches
   * on the navigation `AbortSignal` so a forgetful subscriber cannot leak.
   */
  readonly presenter?: PresenterController;
  /** Optional L2 chrome slot refs; `undefined` for stage-only scenes. */
  readonly chrome?: WorkbenchChromeSlots;
  /** Effective workbench mode for this navigation (PUL-F012 / ADR-007). */
  readonly mode: NavigationMode;
  /** GSAP instance for `timeline(ctx)` (PUL-F022 / ADR-003); never imported directly. */
  readonly gsap: TimelineEngine['gsap'];
  /**
   * Per-navigation audio service (PUL-F024 / ADR-004). One service per
   * navigation: shared across the composition slice under `mode=present`, so
   * sound ids and the source allowlist are slice-scoped. A scene's `group` is
   * scene-scoped across repeated occurrences (issue #99); the loader stops the
   * group only after the LAST occurrence's `cleanup(ctx)`, never cutting a live
   * sibling.
   */
  readonly audio: import('./audio').AudioService;
  /**
   * Deterministic seeded RNG (PUL-F018 / ADR-021), replacing the
   * PUL-Q001-banned `Math.random`. Seeded from bounded URL inputs, never the
   * clock/storage/process state. Loader-contributed per occurrence: each
   * occurrence gets its own seed, so a `buildCtx` base omits `rng`.
   */
  readonly rng: () => number;
  /**
   * Stable per-occurrence identity (issue #99): `{ sceneId, entryIndex,
   * occurrence }`. Lets a scene own its occurrence's DOM/state without
   * colliding with a sibling occurrence of the same module (`occurrence` 0
   * = first/only use). Loader-contributed, so a `buildCtx` base omits it.
   */
  readonly activation: SceneActivation;
}
