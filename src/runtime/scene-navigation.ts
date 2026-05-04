// Scene navigation dispatch — PUL-F008.
//
// Turns a {@link NavigationTarget} (from PUL-F007's
// `parseNavigationSearch` boundary parser, see ./navigation.ts) into a
// running scene by way of the existing composition-resolver lifecycle
// (PUL-F004). This module owns the dispatch step the grammar parser
// deliberately does not: scene/composition existence, member /
// index range, snapshotting the manifest slice, and routing through
// the lifecycle bridge.
//
// PUL-F007 (`./navigation.ts`) is the URL parser. PUL-F004
// (`./composition-resolver.ts`) is the lifecycle orchestrator.
// PUL-F008 (this module) sits between them, with no overlap with
// either.
//
// References:
//  - PUL-F008 — when `scene` is present, load the addressed scene as
//    the navigation target.
//  - ADR-014 — scene navigation dispatch decisions: snapshot the
//    slice, fail before lifecycle on missing/empty/out-of-bounds,
//    reuse existing registries.
//  - ADR-013 — URL navigation grammar boundary; this module consumes
//    `NavigationTarget` from that boundary.
//  - ADR-002 §Navigation — composition / scene addressability via id.
//  - ADR-011 — composition resolver as pure orchestrator with
//    injected adapters; reused via `loadSceneNavigationTarget`.

import {
  type CompositionEntry,
  type CompositionManifest,
  entryId,
  findUnregisteredEntries,
} from './composition';
import type { CompositionRegistry } from './composition-registry';
import {
  type AssetPreloader,
  type SceneTimelineRunner,
  resolveComposition,
} from './composition-resolver';
import type { NavigationTarget } from './navigation';
import { deepFreeze } from './object';
import { type SceneRegistry, createSceneRegistry } from './registry';
import type { SceneModule } from './scene';

/**
 * Composition context carried by a {@link SceneNavigationTarget} when
 * the parsed locator addressed a composition (kinds `composition`,
 * `composition-scene`, `composition-index`).
 *
 * `manifestSlice` and `sceneSlice` are deep-frozen snapshots taken at
 * dispatch time: the bridge runs them as-is, with no further registry
 * lookups, so the lifecycle is guaranteed to play exactly the modules
 * the dispatcher verified existed in the registry. `sceneSlice[0]` is
 * always the addressed scene; subsequent entries are the composition
 * entries that follow it.
 */
export interface SceneNavigationCompositionContext {
  /** Composition id from the locator. */
  readonly id: string;
  /**
   * Manifest entries from the addressed scene onwards, preserving
   * per-entry `range` / `behavior` overrides intact. Bare-string
   * entries stay bare strings; object entries stay object entries.
   * The array is frozen.
   */
  readonly manifestSlice: CompositionManifest;
  /**
   * Scene modules referenced by `manifestSlice`, in the same order.
   * Snapshotted at dispatch time so the bridge does not re-resolve by
   * id (re-resolution would let a different registry substitute scenes
   * mid-flight).
   */
  readonly sceneSlice: readonly SceneModule[];
}

/**
 * The runtime's resolved view of "what scene the URL addresses." A
 * single-scene locator (`kind: 'scene'`) carries only `scene`;
 * composition locators (`kind: 'composition'`,
 * `kind: 'composition-scene'`, `kind: 'composition-index'`) carry both
 * `scene` (the head of the playback queue) and the `composition`
 * snapshot the bridge will play.
 */
export interface SceneNavigationTarget {
  /** The addressed scene module — head of the play queue. */
  readonly scene: SceneModule;
  /** Composition context, when the locator addressed a composition. */
  readonly composition?: SceneNavigationCompositionContext;
}

/**
 * Inputs to {@link resolveSceneNavigation}: the registries the
 * dispatcher consults.
 */
export interface ResolveSceneNavigationOptions {
  readonly scenes: SceneRegistry;
  readonly compositions: CompositionRegistry;
}

/**
 * Inputs to {@link loadSceneNavigationTarget}: the lifecycle adapters
 * and ctx the resolver passes through. No scene/composition registry
 * is required — the bridge synthesizes one from the snapshot inside
 * `target` so the lifecycle is guaranteed to run the modules the
 * dispatcher verified.
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
  /**
   * URL beat label (PUL-F011) the runner should seek to before
   * playing the head scene's timeline. Forwarded to
   * {@link resolveComposition} as `headBeat` — the resolver scopes
   * delivery to the head scene's run input only, per ADR-015. Absent
   * when the navigation target had no `beat=` URL parameter.
   */
  readonly beat?: string;
  /**
   * Non-fatal callback invoked by the runner when {@link beat} is
   * supplied but the named timeline label does not exist (PUL-F011 /
   * ADR-015). Forwarded to {@link resolveComposition} as
   * `onBeatMissing`. The runner MUST NOT throw or reject in response
   * to a missing label; the loader uses this hook to surface a
   * navigation-positioning diagnostic without unmounting the active
   * scene.
   */
  readonly onBeatMissing?: () => void;
}

const NAV_FAIL_PREFIX = 'scene navigation failed:';

const fail = (detail: string): never => {
  throw new Error(`${NAV_FAIL_PREFIX} ${detail}`);
};

/**
 * Snapshot a manifest slice's scene modules from the input scene
 * registry. Pre-resolves every entry so the bridge does not re-resolve
 * by id later. Aggregates every missing scene id into a single error
 * so a manifest author / composition registrar fixes every gap in one
 * pass rather than chasing a sequence of "first miss" errors.
 *
 * Reported entry indices are ABSOLUTE positions in the original
 * composition manifest (`originalStartIndex + slice-relative-index`),
 * so the operator sees the same indices the composition author wrote.
 * Slice-relative indices would lie about which composition entry was
 * gone for `composition-scene` / `composition-index` targets where
 * the slice starts mid-manifest.
 */
function snapshotSceneSlice(
  manifestSlice: CompositionManifest,
  originalStartIndex: number,
  scenes: SceneRegistry,
  compositionId: string,
): readonly SceneModule[] {
  const missing = findUnregisteredEntries(manifestSlice, (id) => scenes.has(id));
  if (missing.length > 0) {
    const list = missing
      .map(({ id, index }) => `"${id}" (entry [${originalStartIndex + index}])`)
      .join(', ');
    fail(`composition "${compositionId}" references scene(s) not in the scene registry: ${list}`);
  }
  return Object.freeze(manifestSlice.map((entry) => scenes.get(entryId(entry))));
}

/**
 * Slice the manifest from `startIndex` and deep-freeze the resulting
 * array — including object-form entries — so the dispatcher's snapshot
 * is immutable regardless of whether the source `CompositionRegistry`
 * implementation deep-froze its stored manifests. The
 * `CompositionRegistry` interface allows alternative implementations,
 * so the dispatcher does its own freezing rather than relying on a
 * specific registry's deep-freeze policy.
 */
const sliceManifestFromIndex = (
  manifest: CompositionManifest,
  startIndex: number,
): CompositionManifest => deepFreeze(manifest.slice(startIndex)) as readonly CompositionEntry[];

function resolveCompositionManifest(
  compositionId: string,
  compositions: CompositionRegistry,
): CompositionManifest {
  if (!compositions.has(compositionId)) {
    fail(`composition "${compositionId}" is not registered`);
  }
  return compositions.get(compositionId);
}

function resolveCompositionFromStart(
  compositionId: string,
  scenes: SceneRegistry,
  compositions: CompositionRegistry,
): SceneNavigationCompositionContext {
  const manifest = resolveCompositionManifest(compositionId, compositions);
  if (manifest.length === 0) {
    fail(`composition "${compositionId}" is empty — no scene to navigate to`);
  }
  const manifestSlice = sliceManifestFromIndex(manifest, 0);
  const sceneSlice = snapshotSceneSlice(manifestSlice, 0, scenes, compositionId);
  return { id: compositionId, manifestSlice, sceneSlice };
}

function resolveCompositionAndScene(
  compositionId: string,
  sceneId: string,
  scenes: SceneRegistry,
  compositions: CompositionRegistry,
): SceneNavigationCompositionContext {
  const manifest = resolveCompositionManifest(compositionId, compositions);
  // Walk the whole manifest once: a single occurrence is the
  // unambiguous slice start; zero occurrences is a non-member error;
  // two or more occurrences make `composition+scene` ambiguous and
  // require `composition+index` per ADR-013. Without the count check,
  // `findIndex` silently picks the first match and a later occurrence
  // (especially with different `range` / `behavior` overrides) loads
  // a slice that does not match what the URL named.
  let startIndex = -1;
  let count = 0;
  for (const [index, entry] of manifest.entries()) {
    if (entryId(entry) === sceneId) {
      if (startIndex < 0) startIndex = index;
      count += 1;
    }
  }
  if (count === 0) {
    fail(`scene "${sceneId}" is not a member of composition "${compositionId}"`);
  }
  if (count > 1) {
    fail(
      `scene "${sceneId}" appears ${count} times in composition "${compositionId}" — use composition+index for ambiguous locators`,
    );
  }
  const manifestSlice = sliceManifestFromIndex(manifest, startIndex);
  const sceneSlice = snapshotSceneSlice(manifestSlice, startIndex, scenes, compositionId);
  return { id: compositionId, manifestSlice, sceneSlice };
}

function resolveCompositionAndIndex(
  compositionId: string,
  index: number,
  scenes: SceneRegistry,
  compositions: CompositionRegistry,
): SceneNavigationCompositionContext {
  const manifest = resolveCompositionManifest(compositionId, compositions);
  // Re-validate the index invariants PUL-F007's parser already
  // enforces. `NavigationTarget` is an exported type and a non-parser
  // caller (event-detail unmarshaling, future test harness, etc.)
  // could supply a negative or non-integer index. Without this
  // re-check, `manifest.slice(-1)` would silently load the last scene
  // when the URL claimed `index=-1`.
  if (!Number.isInteger(index) || index < 0 || index >= manifest.length) {
    fail(
      `index ${index} is out of range for composition "${compositionId}" (size ${manifest.length})`,
    );
  }
  const manifestSlice = sliceManifestFromIndex(manifest, index);
  const sceneSlice = snapshotSceneSlice(manifestSlice, index, scenes, compositionId);
  return { id: compositionId, manifestSlice, sceneSlice };
}

/**
 * Resolves a {@link NavigationTarget} (from PUL-F007's parser) against
 * the runtime registries and returns a {@link SceneNavigationTarget}
 * the bridge can run, or `null` when the locator is `kind: 'none'`
 * (no explicit target — the caller falls back to whatever default the
 * workbench owns).
 *
 * Throws an `Error` whose message starts with `scene navigation
 * failed:` for any of:
 *  - unregistered scene (`kind: 'scene'`)
 *  - unregistered composition (any composition kind)
 *  - scene not a member of the named composition
 *    (`kind: 'composition-scene'`)
 *  - index out of range (`kind: 'composition-index'`)
 *  - empty composition (any composition kind targeting it from start)
 *  - composition references a scene id not in the scene registry
 *
 * No lifecycle hook is invoked on any error path; identifier-shape
 * validation is already done by PUL-F007's parser, so this layer
 * only does existence/membership checks.
 */
export function resolveSceneNavigation(
  target: NavigationTarget,
  options: ResolveSceneNavigationOptions,
): SceneNavigationTarget | null {
  const { scenes, compositions } = options;
  const locator = target.locator;
  switch (locator.kind) {
    case 'none':
      return null;
    case 'scene': {
      if (!scenes.has(locator.scene)) {
        fail(`scene "${locator.scene}" is not registered`);
      }
      return { scene: scenes.get(locator.scene) };
    }
    case 'composition': {
      const composition = resolveCompositionFromStart(locator.composition, scenes, compositions);
      return { scene: composition.sceneSlice[0] as SceneModule, composition };
    }
    case 'composition-scene': {
      const composition = resolveCompositionAndScene(
        locator.composition,
        locator.scene,
        scenes,
        compositions,
      );
      return { scene: composition.sceneSlice[0] as SceneModule, composition };
    }
    case 'composition-index': {
      const composition = resolveCompositionAndIndex(
        locator.composition,
        locator.index,
        scenes,
        compositions,
      );
      return { scene: composition.sceneSlice[0] as SceneModule, composition };
    }
  }
}

/**
 * Drives the addressed scene (or composition slice, when present)
 * through the existing composition resolver lifecycle so the URL
 * navigation path inherits PUL-F004's preload → create → timeline →
 * cleanup ordering and PUL-F006's mandatory-cleanup invariant.
 *
 * Synthesizes a fresh scene registry from the snapshot inside
 * `target` so the lifecycle is guaranteed to run that exact module
 * sequence, removing any chance for an outside registry to substitute
 * scenes at the same ids.
 *
 *  - For a single-scene target (`target.composition === undefined`):
 *    runs a one-entry manifest containing just the addressed scene.
 *  - For a composition target: runs `target.composition.manifestSlice`
 *    against a registry built from `target.composition.sceneSlice`.
 *    Per-entry `range` and `behavior` overrides are preserved and
 *    forwarded to the runner adapter unchanged (ADR-011).
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
  // Collapse the single-scene vs composition-slice paths into one
  // assignment so the two values cannot drift (e.g. picking
  // composition manifest with single-scene registry, or vice versa).
  let scenes: readonly SceneModule[];
  let manifest: CompositionManifest;
  if (composition === undefined) {
    scenes = [target.scene];
    manifest = [target.scene.id];
  } else {
    scenes = composition.sceneSlice;
    manifest = composition.manifestSlice;
  }

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
    // `onBeatMissing` is paired with `beat` per ADR-015 — a callback
    // without a label has no trigger condition, so dropping it when
    // `beat` is absent prevents misuse-by-spread (e.g. a caller
    // accidentally passing `onBeatMissing` with no `beat`).
    ...(options.beat === undefined
      ? {}
      : {
          headBeat: options.beat,
          ...(options.onBeatMissing === undefined ? {} : { onBeatMissing: options.onBeatMissing }),
        }),
  });
}
