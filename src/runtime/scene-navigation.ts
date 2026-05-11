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
  type CompositionTimelineAdapter,
  resolveComposition,
} from './composition-resolver';
import type { NavigationTarget } from './navigation';
import { deepFreeze } from './object';
import type { PresenterController } from './presenter';
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
  /** Timeline composition/playback adapter — see {@link CompositionTimelineAdapter}. */
  readonly timeline: CompositionTimelineAdapter;
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
   *
   * REQUIRED whenever {@link beat} is supplied: a beat without a
   * diagnostic surface would silently lose the missing-label error
   * the runner reports — the bridge throws when this invariant is
   * violated rather than letting the diagnostic vanish.
   */
  readonly onBeatMissing?: () => void;
  /**
   * URL loop-mode repeat hint (PUL-F015 / ADR-018) the runner uses to
   * decide whether to restart the addressed scene's timeline on
   * completion. Forwarded to {@link resolveComposition} as `headRepeat`
   * — the resolver scopes delivery to the head scene's run input only,
   * so following composition entries never receive `repeat`. Absent
   * when the navigation target had no `mode=loop` parameter.
   */
  readonly repeat?: 'until-aborted';
  /**
   * URL paused-mode hold hint (PUL-F016 / ADR-019) the runner uses to
   * decide whether to hold the addressed scene's timeline at its
   * first frame. Forwarded to {@link resolveComposition} as
   * `headHold` — the resolver scopes delivery to the head scene's
   * run input only, so following composition entries never receive
   * `hold`. Absent when the navigation target had no `mode=paused`
   * parameter.
   */
  readonly hold?: 'first-frame';
  /**
   * URL scrub-mode cue-gate hint (PUL-F017 / ADR-020) the runner uses
   * to decide whether to gate audio-cue firing to monotonic forward
   * playback only. Forwarded to {@link resolveComposition} as
   * `headCueGate` — the resolver scopes delivery to the head scene's
   * run input only, so following composition entries never receive
   * `cueGate`. Absent when the navigation target had no `mode=scrub`
   * parameter.
   */
  readonly cueGate?: 'monotonic-forward';
  /**
   * URL screenshot-mode capture-bundle hint (PUL-F018 / ADR-021) the
   * runner uses to decide whether to render the addressed scene at
   * the addressed beat (or first frame), hold the timeline still,
   * and suppress all audio. Forwarded to {@link resolveComposition}
   * as `headScreenshot` — the resolver scopes delivery to the head
   * scene's run input only, so following composition entries never
   * receive `screenshot`. Absent when the navigation target had no
   * `mode=screenshot` parameter.
   *
   * Direct bridge callers (test harnesses, future export pipelines)
   * supplying `screenshot: 'capture'` MUST also build {@link ctx}
   * with `mode: 'screenshot'` — PUL-F018's "any randomness sourced
   * from a deterministic seed" clause flows through the scene-side
   * `ctx.mode === 'screenshot'` seam (PUL-F012 / ADR-007), not
   * through the runner input, because scene `create(ctx)` and
   * `timeline(ctx)` run before this option reaches the runner. The
   * loader path always pairs the two seams from the same parsed
   * `target.mode`, so production navigation is coherent by
   * construction; the contract here is for direct bridge callers.
   * The bridge does not (and cannot) inspect ctx to enforce
   * coherence — ctx is opaque per ADR-011.
   */
  readonly screenshot?: 'capture';
  /**
   * URL present-mode presenter controller (PUL-F020 / ADR-023; the
   * command set is extended by PUL-F021 / ADR-024 with the `pause` /
   * `resume` kinds — the bridge forwarding is unchanged). The
   * loader builds a per-navigation
   * {@link import('./presenter').PresenterController} bound to its
   * `AbortController.signal` when `effectiveMode(target) === 'present'`
   * AND the workbench supplied a `presenterCommands` source, then
   * forwards it here. The bridge passes it to {@link resolveComposition}
   * as `presenter`; the resolver hands it to EVERY scene's run input
   * (NOT head-only) because mode=present runs the FULL composition
   * slice and presenter commands act on whichever scene is active.
   *
   * The bridge does NOT truncate the slice when `presenter` is
   * supplied — `presenter` is independent of the four head-only
   * runner-input hints (`repeat` / `hold` / `cueGate` /
   * `screenshot`), every one of which corresponds to a single-
   * scene-execution mode where truncation enforces "no following
   * entries run." Mode=present has no such promise; truncating
   * would silently drop tail-scene presenter handling.
   *
   * Absent for every mode other than `present` because the loader
   * scopes delivery (the bridge does not enforce mode coherence;
   * mode dispatch is a loader concern per ADR-007). Direct bridge
   * callers — outside the loader path — supplying `presenter` for
   * a non-present-mode navigation will see the controller forwarded
   * to every scene's run input, but production navigation through
   * the loader cannot reach that state.
   */
  readonly presenter?: PresenterController;
  /**
   * Optional diagnostic sink for the per-scene presenter wrapper
   * (PUL-F020 / ADR-023). Forwarded to {@link resolveComposition}
   * as `onPresenterError`. The loader threads its own `onError`
   * here so a runner-handler exception (or an unknown command kind
   * that reaches a per-scene wrapper) surfaces through the same
   * diagnostic channel as every other navigation-level error.
   * Absent: the per-scene wrapper drops diagnostics silently.
   */
  readonly onPresenterError?: (err: unknown) => void;
  /**
   * Per-scene post-cleanup hook (PUL-F024 / ADR-004). Forwarded to
   * {@link resolveComposition} as `onSceneCleaned`; the loader wires it
   * to stop the audio group a scene scoped to itself when that scene's
   * `cleanup(ctx)` runs. Absent for callers that do not need it.
   */
  readonly onSceneCleaned?: (sceneId: string) => void;
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
 * Bridge-level structural defense for modes whose head-scene
 * timeline does not naturally advance to completion:
 *
 * - PUL-F015 / ADR-018 (`mode=loop`, `repeat: 'until-aborted'`): the
 *   head's timeline restarts on completion — by definition it never
 *   naturally completes, so following composition entries cannot
 *   run.
 * - PUL-F016 / ADR-019 (`mode=paused`, `hold: 'first-frame'`): the
 *   head's timeline holds at frame 0 and never advances, so
 *   following composition entries cannot run.
 * - PUL-F017 / ADR-020 (`mode=scrub`, `cueGate: 'monotonic-forward'`):
 *   the head's timeline is driven interactively by the future
 *   scrub-controls UI; following composition entries cannot run
 *   because there is no monotonic-forward completion to hand off
 *   on.
 * - PUL-F018 / ADR-021 (`mode=screenshot`, `screenshot: 'capture'`):
 *   the runtime renders one deterministic frame; the head's
 *   timeline is held at the addressed beat (or first frame) and
 *   does not advance, so following composition entries cannot run.
 *
 * Truncating the slice at the bridge guarantees that structural
 * promise without depending on the runner's adapter conformance to
 * `input.repeat` / `input.hold` / `input.cueGate` /
 * `input.screenshot`. A direct bridge caller (test harness, future
 * export pipeline, etc.) gets the same guarantee the loader's
 * `applySingleSceneSlice` provides on the loader→bridge path; the
 * two truncations are idempotent (truncating a single-entry slice
 * is a no-op).
 *
 * Pure function — no closure captures. Returns the input unchanged
 * when `headOnly` is `false`, when there is no composition slice, or
 * when the slice is already empty (the bridge would surface that as
 * a navigation error elsewhere).
 */
function truncateToHead(target: SceneNavigationTarget, headOnly: boolean): SceneNavigationTarget {
  if (!headOnly || target.composition === undefined) {
    return target;
  }
  const headEntry = target.composition.manifestSlice[0];
  const headScene = target.composition.sceneSlice[0];
  if (headEntry === undefined || headScene === undefined) {
    return target;
  }
  return {
    scene: target.scene,
    composition: {
      id: target.composition.id,
      manifestSlice: Object.freeze([headEntry]),
      sceneSlice: Object.freeze([headScene]),
    },
  };
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
  // PUL-F015 / ADR-018 + PUL-F016 / ADR-019 + PUL-F017 / ADR-020 +
  // PUL-F018 / ADR-021: under `repeat: 'until-aborted'` the head's
  // timeline restarts on completion (loop), under
  // `hold: 'first-frame'` the head's timeline never advances
  // (paused), under `cueGate: 'monotonic-forward'` the head's
  // timeline is driven interactively by the future scrub-controls UI
  // (scrub), and under `screenshot: 'capture'` the head's timeline
  // is held at the addressed beat (or first frame) for a
  // deterministic frame capture (screenshot). All four modes share
  // the same structural promise: following composition entries
  // cannot run. Truncating the slice at the bridge layer makes "no
  // following entries run" a structural guarantee that does not
  // depend on the runner honoring `input.repeat` / `input.hold` /
  // `input.cueGate` / `input.screenshot` (codex pre-push review):
  // a runner bug or no-op runner under any of the four modes MUST
  // NOT silently degrade into normal composition playback. The
  // truncation is layered with the loader's `applySingleSceneSlice`
  // (which already truncates for `mode=standalone`, `mode=loop`,
  // `mode=paused`, `mode=scrub`, and `mode=screenshot`) so direct
  // bridge callers — outside the loader path — still benefit from
  // the structural guarantee. Truncating an already-single-entry
  // slice is a no-op, so the layering is idempotent.
  const effectiveTarget = truncateToHead(
    target,
    options.repeat !== undefined ||
      options.hold !== undefined ||
      options.cueGate !== undefined ||
      options.screenshot !== undefined,
  );
  const composition = effectiveTarget.composition;
  // Collapse the single-scene vs composition-slice paths into one
  // assignment so the two values cannot drift (e.g. picking
  // composition manifest with single-scene registry, or vice versa).
  let scenes: readonly SceneModule[];
  let manifest: CompositionManifest;
  if (composition === undefined) {
    scenes = [effectiveTarget.scene];
    manifest = [effectiveTarget.scene.id];
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

  // PUL-F011 / ADR-015: a `beat` without an `onBeatMissing` would
  // silently lose the missing-label diagnostic the runner is
  // contracted to surface. Mirror the resolver's check at this
  // boundary so the bridge's direct callers fail at construction
  // time, not after the lifecycle started. Routed through the
  // module's `fail(...)` helper so the error carries the documented
  // `scene navigation failed:` envelope — same prefix as every
  // other navigation-level failure (unknown scene, out-of-range
  // index, etc.).
  if (options.beat !== undefined && options.onBeatMissing === undefined) {
    fail(
      '"onBeatMissing" is required when "beat" is supplied — a beat without a diagnostic surface would silently lose missing-label errors',
    );
  }

  await resolveComposition({
    registry: createSceneRegistry(uniqueScenes),
    manifest,
    ctx: options.ctx,
    preloadAssets: options.preloadAssets,
    timeline: options.timeline,
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
    // `repeat` is independent of `beat` per ADR-018: a URL like
    // `?scene=x&mode=loop` (no beat) and `?scene=x&beat=hook&mode=loop`
    // (beat + loop) are both valid. Spread `headRepeat` only when the
    // caller supplied it so a runner that branches on `'repeat' in
    // input` sees an absent key rather than `undefined`.
    ...(options.repeat === undefined ? {} : { headRepeat: options.repeat }),
    // `hold` is independent of `beat` and `repeat` per ADR-019: a URL
    // like `?scene=x&mode=paused` (no beat, no loop) is valid, and so
    // is `?scene=x&beat=hook&mode=paused` (the runner's policy
    // decides which wins — ADR-019 records that `hold` wins over
    // `beat` for paused mode). Spread `headHold` only when the
    // caller supplied it so a runner that branches on `'hold' in
    // input` sees an absent key rather than `undefined`.
    ...(options.hold === undefined ? {} : { headHold: options.hold }),
    // `cueGate` is independent of `beat`, `repeat`, and `hold` per
    // ADR-020: a URL like `?scene=x&mode=scrub` (no beat) is valid,
    // and so is `?scene=x&beat=hook&mode=scrub` (the natural
    // scrub-to-named-beat path PUL-F017's "to named beats" clause
    // anticipates). Spread `headCueGate` only when the caller
    // supplied it so a runner that branches on `'cueGate' in input`
    // sees an absent key rather than `undefined`.
    ...(options.cueGate === undefined ? {} : { headCueGate: options.cueGate }),
    // `screenshot` is independent of `beat`, `repeat`, `hold`, and
    // `cueGate` per ADR-021: a URL like `?scene=x&mode=screenshot`
    // (no beat) is valid (renders at first frame), and so is
    // `?scene=x&beat=midpoint&mode=screenshot` (the natural
    // deterministic-frame-capture-at-named-beat path PUL-F018
    // names directly). Spread `headScreenshot` only when the
    // caller supplied it so a runner that branches on
    // `'screenshot' in input` sees an absent key rather than
    // `undefined`.
    ...(options.screenshot === undefined ? {} : { headScreenshot: options.screenshot }),
    // `presenter` is independent of `beat`, `repeat`, `hold`,
    // `cueGate`, and `screenshot` per ADR-023: presenter input is
    // only valid under `mode=present` (the loader scopes delivery),
    // and that mode has no head-only structural promise to defend.
    // Spread `presenter` only when the caller supplied it so a
    // runner that branches on `'presenter' in input` sees an absent
    // key rather than `undefined`. The resolver forwards it to
    // EVERY scene's run input (NOT head-only) — mode=present runs
    // the full slice and presenter commands act on whichever scene
    // is active.
    ...(options.presenter === undefined ? {} : { presenter: options.presenter }),
    // `onPresenterError` is paired with `presenter` per ADR-023 —
    // a sink without a controller has nothing to surface
    // diagnostics from. Drop the sink when no presenter is
    // supplied; otherwise spread it so the per-scene wrapper inside
    // the resolver routes its boundary diagnostics through the
    // loader's `onError` channel.
    ...(options.presenter === undefined || options.onPresenterError === undefined
      ? {}
      : { onPresenterError: options.onPresenterError }),
    // `onSceneCleaned` (PUL-F024 / ADR-004 — the audio group teardown
    // hook) is forwarded as-is; the loader supplies it on every
    // navigation that runs the resolver lifecycle.
    ...(options.onSceneCleaned === undefined ? {} : { onSceneCleaned: options.onSceneCleaned }),
  });
}
