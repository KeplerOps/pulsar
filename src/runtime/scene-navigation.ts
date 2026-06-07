// Scene navigation dispatch — PUL-F008 (ADR-014 / ADR-002 §Navigation).
//
// Turns a {@link NavigationTarget} (PUL-F007 parser) into the resolved view
// of "what scene the URL addresses" (ADR-032). Owns the dispatch step the
// parser does not: scene/composition existence, member/index range, and
// snapshotting the manifest slice. The present-loader (`present-loader.ts`)
// then sequences the resolved slice through the imperative control plane.

import type { AudioBedDeclaration } from './audio';
import {
  type CompositionEntry,
  type CompositionManifest,
  entryId,
  findUnregisteredEntries,
} from './composition';
import type { CompositionRegistry, RegisteredComposition } from './composition-registry';
import type { NavigationTarget } from './navigation';
import { deepFreeze } from './object';
import type { SceneRegistry } from './registry';
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
    ...(audioBed ? { audioBed } : {}),
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
