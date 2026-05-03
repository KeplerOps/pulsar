// URL navigation lifecycle bridge — PUL-F008.
//
// Routes a {@link SceneNavigationTarget} through the existing
// composition resolver lifecycle so the URL navigation path inherits
// PUL-F004's preload → create → timeline → cleanup ordering and
// PUL-F006's mandatory-cleanup invariant rather than reinventing them.
//
// Split out of `url-navigation.ts` so the URL parser stays a pure
// "URL → target" function (no `composition-resolver` / `registry`
// imports). This module is the only place that synthesizes a scene
// registry from the resolver snapshot and forwards it to
// `resolveComposition`.

import type { CompositionManifest } from './composition';
import {
  type AssetPreloader,
  type SceneTimelineRunner,
  resolveComposition,
} from './composition-resolver';
import { createSceneRegistry } from './registry';
import type { SceneModule } from './scene';
import type { SceneNavigationTarget } from './url-navigation';

/**
 * Inputs the {@link loadSceneNavigationTarget} bridge needs to drive
 * the existing composition resolver lifecycle.
 *
 * Note that no scene/composition registry is required: the bridge
 * synthesizes a fresh registry from the snapshot inside `target` so
 * the lifecycle is guaranteed to run *exactly* the modules the
 * resolver returned, not whatever modules a passed-in registry
 * happens to map the same ids to (codex review: re-resolving by id
 * could substitute scenes).
 */
export interface LoadSceneNavigationTargetOptions {
  /** Opaque scene context forwarded to every lifecycle hook. */
  readonly ctx: unknown;
  /** Preload adapter — see {@link AssetPreloader}. */
  readonly preloadAssets: AssetPreloader;
  /** Timeline-execution adapter — see {@link SceneTimelineRunner}. */
  readonly runTimeline: SceneTimelineRunner;
  /**
   * Optional cancellation signal forwarded through to
   * {@link resolveComposition}. Honors the same semantics PUL-F006
   * defined for composition-level abort.
   */
  readonly signal?: AbortSignal;
}

/**
 * Drives the addressed scene (or composition slice, when present)
 * through the existing composition resolver lifecycle so the URL
 * navigation path inherits PUL-F004's preload → create → timeline →
 * cleanup ordering and PUL-F006's mandatory-cleanup invariant.
 *
 * Synthesizes a fresh scene registry from the snapshot inside
 * `target` so the lifecycle is guaranteed to run *that exact module
 * sequence*, removing any chance for a passed-in registry to
 * substitute scenes at the same ids (codex review).
 *
 *  - For a single-scene target (`target.composition === undefined`):
 *    the bridge runs a one-entry manifest containing just the
 *    addressed scene.
 *  - For a composition+scene target: the bridge runs
 *    `target.composition.manifestSlice` against a registry built from
 *    `target.composition.sceneSlice`. Per-entry `range` and `behavior`
 *    overrides are preserved and forwarded to the runner adapter
 *    unchanged (ADR-011).
 *
 * Resolves when the lifecycle has run end-to-end; rejects with the
 * resolver's own wrapping error (`composition resolution failed: ...`)
 * when any phase throws. Cleanup runs whenever the scene was touched,
 * matching the resolver's own invariants.
 */
export async function loadSceneNavigationTarget(
  target: SceneNavigationTarget,
  options: LoadSceneNavigationTargetOptions,
): Promise<void> {
  const composition = target.composition;
  const scenes =
    composition === undefined ? [target.scene] : (composition.sceneSlice as SceneModule[]);
  const manifest: CompositionManifest =
    composition === undefined ? [target.scene.id] : composition.manifestSlice;

  // De-duplicate scene modules by id so a manifest slice with
  // repeated scene ids (which `resolveComposition` legitimately
  // supports per PUL-F004) does not crash the synthesized registry's
  // duplicate-id guard. Same id always resolves to the same module
  // because `snapshotSceneSlice` pulled both from the same scene
  // registry, so dedupe is identity-preserving.
  const uniqueScenes = Array.from(new Map(scenes.map((s) => [s.id, s])).values());

  await resolveComposition({
    registry: createSceneRegistry(uniqueScenes),
    manifest,
    ctx: options.ctx,
    preloadAssets: options.preloadAssets,
    runTimeline: options.runTimeline,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}
