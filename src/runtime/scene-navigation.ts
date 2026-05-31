// Scene navigation dispatch — PUL-F008 (ADR-014 / ADR-002 §Navigation).
//
// Turns a {@link NavigationTarget} (PUL-F007 parser) into a running scene
// via the composition-resolver lifecycle (PUL-F004). Owns the dispatch
// step the parser does not: scene/composition existence, member/index
// range, snapshotting the manifest slice, and routing through the bridge.

import type { AudioBedDeclaration, CueGateControl } from './audio';
import {
  type CompositionEntry,
  type CompositionManifest,
  entryId,
  findUnregisteredEntries,
} from './composition';
import type { CompositionRegistry, RegisteredComposition } from './composition-registry';
import {
  type AssetPreloader,
  type CompositionTimelineAdapter,
  type ResolveCompositionOptions,
  type SceneActivation,
  resolveComposition,
} from './composition-resolver';
import type { NavigationTarget } from './navigation';
import { deepFreeze } from './object';
import type { PresenterController } from './presenter';
import { type SceneRegistry, createSceneRegistry } from './registry';
import type { SceneModule } from './scene';

/**
 * Composition context on a {@link SceneNavigationTarget} when the locator
 * addressed a composition. `manifestSlice` / `sceneSlice` are deep-frozen
 * snapshots taken at dispatch, so the bridge plays exactly the verified
 * modules with no further registry lookups; `sceneSlice[0]` is the head.
 */
export interface SceneNavigationCompositionContext {
  /** Composition id from the locator. */
  readonly id: string;
  /**
   * Manifest entries from the addressed scene onwards, per-entry `range` /
   * `behavior` overrides intact. Frozen.
   */
  readonly manifestSlice: CompositionManifest;
  /** Scene modules for `manifestSlice`, in order; snapshotted so the bridge never re-resolves. */
  readonly sceneSlice: readonly SceneModule[];
  /**
   * Index of `manifestSlice[0]` in the ORIGINAL manifest (0 for
   * `kind: 'composition'`). PUL-F029 / ADR-028 uses it so a failure
   * diagnostic names the absolute entry, not a slice-relative index;
   * single-scene truncation preserves it.
   */
  readonly startIndex: number;
  /**
   * Composition-level audio bed (PUL-F014 / ADR-004), copied verbatim
   * when declared. The resolver makes no suppression decision — the
   * loader does (standalone suppresses). `undefined` when none declared.
   */
  readonly audioBed?: AudioBedDeclaration;
}

/**
 * The resolved view of "what scene the URL addresses": always a head
 * `scene`, plus the `composition` snapshot when a composition was addressed.
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
 * Inputs to {@link loadSceneNavigationTarget}: lifecycle adapters + ctx.
 * No registry — the bridge synthesizes one from `target`'s snapshot.
 */
export interface LoadSceneNavigationTargetOptions {
  /**
   * Per-occurrence scene-context factory (issue #99): called once per
   * entry with its {@link SceneActivation}, so a repeated-id slice gives
   * each occurrence a distinct `ctx`. The resolver never inspects it (ADR-011).
   */
  readonly ctx: (activation: SceneActivation) => unknown;
  /** Preload adapter — see {@link AssetPreloader}. */
  readonly preloadAssets: AssetPreloader;
  /** Timeline composition/playback adapter — see {@link CompositionTimelineAdapter}. */
  readonly timeline: CompositionTimelineAdapter;
  /** Cancellation signal forwarded to {@link resolveComposition} (PUL-F006). */
  readonly signal?: AbortSignal;
  /** Beat label to seek before the head timeline (PUL-F011); head-only via `headBeat`. */
  readonly beat?: string;
  /**
   * Non-fatal missing-beat callback (PUL-F011 / ADR-015); the runner MUST
   * NOT throw on a missing label. REQUIRED whenever {@link beat} is
   * supplied — the bridge throws otherwise so the diagnostic cannot vanish.
   */
  readonly onBeatMissing?: () => void;
  /** Loop repeat hint (PUL-F015 / ADR-018); head-only via `headRepeat`. */
  readonly repeat?: 'until-aborted';
  /** Paused hold hint (PUL-F016 / ADR-019); head-only via `headHold`. */
  readonly hold?: 'first-frame';
  /** Scrub cue-gate hint (PUL-F017 / ADR-020); head-only via `headCueGate`. */
  readonly cueGate?: 'monotonic-forward';
  /** Dynamic cue-eligibility gate paired with {@link cueGate} (PUL-F017 / ADR-020). */
  readonly audioCueGate?: CueGateControl;
  /**
   * Screenshot capture hint (PUL-F018 / ADR-021); head-only via
   * `headScreenshot`. Direct callers supplying `'capture'` MUST also build
   * {@link ctx} with `mode: 'screenshot'` — the deterministic-seed clause
   * flows through `ctx.mode` (PUL-F012), not the runner input. The bridge
   * cannot enforce this (ctx is opaque per ADR-011).
   */
  readonly screenshot?: 'capture';
  /**
   * Present-mode presenter controller (PUL-F020 / ADR-023; PUL-F021 /
   * ADR-024 pause/resume). Forwarded to EVERY scene (not head-only), so
   * the bridge does NOT truncate the slice — present-mode runs the full
   * slice and presenter commands act on whichever scene is active.
   */
  readonly presenter?: PresenterController;
  /** Diagnostic sink for the per-scene presenter wrapper (PUL-F020 / ADR-023). */
  readonly onPresenterError?: (err: unknown) => void;
  /**
   * Per-scene post-cleanup hook (PUL-F024 / ADR-004), receiving the
   * cleaned occurrence's {@link SceneActivation} so a repeated-id slice
   * tears down occurrence-safely (issue #99).
   */
  readonly onSceneCleaned?: (activation: SceneActivation) => void;
  /**
   * Per-scene failure sink (PUL-F029 / ADR-028); the loader appends to
   * `data-pulsar-scene-failures` and surfaces a public diagnostic without
   * serializing the raw cause (ADR-028: no raw causes).
   */
  readonly onSceneFailed?: (event: import('./composition-resolver').SceneFailureEvent) => void;
}

const NAV_FAIL_PREFIX = 'scene navigation failed:';

const fail = (detail: string): never => {
  throw new Error(`${NAV_FAIL_PREFIX} ${detail}`);
};

/**
 * Snapshot a manifest slice's scene modules, pre-resolving every entry so
 * the bridge never re-resolves by id. Aggregates all missing ids into one
 * error; reported indices are ABSOLUTE positions in the original manifest.
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
 * Slice the manifest from `startIndex` and deep-freeze it, so the
 * snapshot is immutable regardless of the registry's own freeze policy.
 */
const sliceManifestFromIndex = (
  manifest: CompositionManifest,
  startIndex: number,
): CompositionManifest => deepFreeze(manifest.slice(startIndex)) as readonly CompositionEntry[];

function resolveRegisteredComposition(
  compositionId: string,
  compositions: CompositionRegistry,
): RegisteredComposition {
  if (!compositions.has(compositionId)) {
    fail(`composition "${compositionId}" is not registered`);
  }
  return compositions.get(compositionId);
}

/**
 * Build the {@link SceneNavigationCompositionContext}, attaching `audioBed`
 * (PUL-F014) only when declared (kept absent under `exactOptionalPropertyTypes`).
 */
function buildCompositionContext(
  compositionId: string,
  manifestSlice: CompositionManifest,
  sceneSlice: readonly SceneModule[],
  startIndex: number,
  audioBed: AudioBedDeclaration | undefined,
): SceneNavigationCompositionContext {
  return {
    id: compositionId,
    manifestSlice,
    sceneSlice,
    startIndex,
    ...(audioBed === undefined ? {} : { audioBed }),
  };
}

/**
 * How to choose a composition slice's start index (ADR-013 / ADR-014):
 *  - `from-start` — index 0; an empty manifest is a navigation error.
 *  - `scene` — the single unambiguous occurrence; 0 = non-member error,
 *    2+ = ambiguous, requiring composition+index.
 *  - `index` — re-validate the parser's invariants (a forged target could
 *    supply a negative / non-integer index).
 */
type CompositionLocation =
  | { readonly kind: 'from-start' }
  | { readonly kind: 'scene'; readonly scene: string }
  | { readonly kind: 'index'; readonly index: number };

function findStartIndex(
  manifest: CompositionManifest,
  compositionId: string,
  location: CompositionLocation,
): number {
  if (location.kind === 'from-start') {
    if (manifest.length === 0) {
      fail(`composition "${compositionId}" is empty — no scene to navigate to`);
    }
    return 0;
  }
  if (location.kind === 'index') {
    const { index } = location;
    if (!Number.isInteger(index) || index < 0 || index >= manifest.length) {
      fail(
        `index ${index} is out of range for composition "${compositionId}" (size ${manifest.length})`,
      );
    }
    return index;
  }
  let startIndex = -1;
  let count = 0;
  for (const [index, entry] of manifest.entries()) {
    if (entryId(entry) === location.scene) {
      if (startIndex < 0) startIndex = index;
      count += 1;
    }
  }
  if (count === 0) {
    fail(`scene "${location.scene}" is not a member of composition "${compositionId}"`);
  }
  if (count > 1) {
    fail(
      `scene "${location.scene}" appears ${count} times in composition "${compositionId}" — use composition+index for ambiguous locators`,
    );
  }
  return startIndex;
}

/**
 * Resolve a composition locator into its
 * {@link SceneNavigationCompositionContext}: look it up, pick the start
 * index per `location`, snapshot the slice + scene modules.
 */
function resolveCompositionContext(
  compositionId: string,
  location: CompositionLocation,
  scenes: SceneRegistry,
  compositions: CompositionRegistry,
): SceneNavigationCompositionContext {
  const { manifest, audioBed } = resolveRegisteredComposition(compositionId, compositions);
  const startIndex = findStartIndex(manifest, compositionId, location);
  const manifestSlice = sliceManifestFromIndex(manifest, startIndex);
  const sceneSlice = snapshotSceneSlice(manifestSlice, startIndex, scenes, compositionId);
  return buildCompositionContext(compositionId, manifestSlice, sceneSlice, startIndex, audioBed);
}

/**
 * Bridge-level slice truncation for single-scene modes (loop / paused /
 * scrub / screenshot — PUL-F015..F018), whose head timeline never
 * naturally completes. Guarantees "no following entries run" independent
 * of runner conformance, mirroring (and idempotent with) the loader's
 * `applySingleSceneSlice`. Returns the input unchanged when `headOnly` is
 * false or there is no composition slice.
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
      ...(target.composition.audioBed === undefined
        ? {}
        : { audioBed: target.composition.audioBed }),
      // PUL-F029 / ADR-028: preserve the absolute start index so a failure
      // diagnostic still names the right manifest entry after truncation.
      startIndex: target.composition.startIndex,
    },
  };
}

/**
 * Resolve a {@link NavigationTarget} against the registries into a
 * runnable {@link SceneNavigationTarget}, or `null` for `kind: 'none'`.
 * Throws (`scene navigation failed: ...`) on existence / membership
 * failures: unregistered scene/composition, non-member scene, index out
 * of range, empty composition, or a slice scene id absent from the
 * registry. No lifecycle hook runs on any error path; shape validation
 * is already the parser's.
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
      const composition = resolveCompositionContext(
        locator.composition,
        { kind: 'from-start' },
        scenes,
        compositions,
      );
      return { scene: composition.sceneSlice[0] as SceneModule, composition };
    }
    case 'composition-scene': {
      const composition = resolveCompositionContext(
        locator.composition,
        { kind: 'scene', scene: locator.scene },
        scenes,
        compositions,
      );
      return { scene: composition.sceneSlice[0] as SceneModule, composition };
    }
    case 'composition-index': {
      const composition = resolveCompositionContext(
        locator.composition,
        { kind: 'index', index: locator.index },
        scenes,
        compositions,
      );
      return { scene: composition.sceneSlice[0] as SceneModule, composition };
    }
  }
}

/**
 * Drive the addressed scene (or composition slice) through the
 * composition resolver lifecycle, so URL navigation inherits PUL-F004's
 * preload → create → timeline → cleanup ordering and PUL-F006's
 * mandatory cleanup. Synthesizes a fresh registry from `target`'s
 * snapshot so no outside registry can substitute scenes at the same ids.
 *
 * Per PUL-F029 / ADR-028, per-scene phase throws are SCENE failures:
 * with `onSceneFailed` wired they isolate (the composition plays on);
 * without it they aggregate into an `AggregateError`. Composition-wide
 * failures still reject (`composition resolution failed: ...`).
 */
export async function loadSceneNavigationTarget(
  target: SceneNavigationTarget,
  options: LoadSceneNavigationTargetOptions,
): Promise<void> {
  // Truncate to head for single-scene modes (PUL-F015..F018) so "no
  // following entries run" holds independent of runner conformance;
  // idempotent with the loader's `applySingleSceneSlice`.
  const effectiveTarget = truncateToHead(
    target,
    options.repeat !== undefined ||
      options.hold !== undefined ||
      options.cueGate !== undefined ||
      options.screenshot !== undefined,
  );
  const composition = effectiveTarget.composition;
  // One assignment for both paths so manifest and registry cannot drift.
  let scenes: readonly SceneModule[];
  let manifest: CompositionManifest;
  if (composition === undefined) {
    scenes = [effectiveTarget.scene];
    manifest = [effectiveTarget.scene.id];
  } else {
    scenes = composition.sceneSlice;
    manifest = composition.manifestSlice;
  }

  // Dedupe by id (identity-preserving — same id is the same module) so a
  // repeated-id slice does not trip the synthesized registry's dup guard.
  const uniqueScenes = Array.from(new Map(scenes.map((s) => [s.id, s])).values());

  // PUL-F011 / ADR-015: fail at construction if `beat` lacks
  // `onBeatMissing`, mirroring the resolver, so direct callers cannot
  // silently lose the missing-label diagnostic.
  if (options.beat !== undefined && options.onBeatMissing === undefined) {
    fail(
      '"onBeatMissing" is required when "beat" is supplied — a beat without a diagnostic surface would silently lose missing-label errors',
    );
  }

  await resolveComposition(
    buildResolverOptions(createSceneRegistry(uniqueScenes), manifest, options),
  );
}

/**
 * Build the {@link ResolveCompositionOptions} the bridge hands the
 * resolver: map the bridge's input names onto the resolver's head-scoped
 * names (`beat`→`headBeat`, etc.) and drop absent keys so the resolver's
 * `'<key>' in opts` checks see absent rather than `undefined`. Paired
 * surfaces (`onBeatMissing` / `onPresenterError`) are dropped when their
 * partner (`beat` / `presenter`) is absent.
 */
function buildResolverOptions(
  registry: ReturnType<typeof createSceneRegistry>,
  manifest: CompositionManifest,
  options: LoadSceneNavigationTargetOptions,
): ResolveCompositionOptions {
  const optional: Record<string, unknown> = {
    signal: options.signal,
    headBeat: options.beat,
    onBeatMissing: options.beat === undefined ? undefined : options.onBeatMissing,
    headRepeat: options.repeat,
    headHold: options.hold,
    headCueGate: options.cueGate,
    audioCueGate: options.audioCueGate,
    headScreenshot: options.screenshot,
    presenter: options.presenter,
    onPresenterError: options.presenter === undefined ? undefined : options.onPresenterError,
    onSceneCleaned: options.onSceneCleaned,
    onSceneFailed: options.onSceneFailed,
  };
  for (const key of Object.keys(optional)) {
    if (optional[key] === undefined) delete optional[key];
  }
  return {
    registry,
    manifest,
    ctx: options.ctx,
    preloadAssets: options.preloadAssets,
    timeline: options.timeline,
    ...optional,
  };
}
