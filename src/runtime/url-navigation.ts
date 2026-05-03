// URL navigation — PUL-F008.
//
// Owns the `scene` and `composition` URL parameter contracts:
//
//  1. Parse `scene` (and optionally `composition`) once from
//     `URLSearchParams` at the runtime boundary.
//  2. Validate identifier shapes via the shared `isKebabIdentifier`
//     rule from `./identifier.ts` (ADR-013 forbids URL-only regexes).
//  3. Resolve scene existence through {@link SceneRegistry.has} /
//     `.get`, and composition existence through
//     {@link CompositionRegistry.has} / `.get` (ADR-002 §Navigation:
//     registries are the only addressability path; ADR-013 forbids
//     array scans, dynamic imports, or conditional dispatch).
//  4. When both `scene` and `composition` are present (ADR-002 +
//     ADR-013): `scene` names a target *within* that composition.
//     The resolver verifies the addressed scene is a member of the
//     composition, snapshots the manifest slice from that scene
//     onwards, and pre-resolves the matching scene modules so the
//     bridge can run the slice without re-resolving by id (which
//     would let a different registry substitute scenes mid-flight).
//  5. Treat malformed or unknown ids, unregistered compositions, and
//     non-member scenes as navigation errors before any scene
//     lifecycle hook runs.
//  6. Preserve the existing lifecycle contract — the optional
//     {@link loadSceneNavigationTarget} convenience routes the
//     resolved target through {@link resolveComposition} so the URL
//     path inherits PUL-F004's preload → create → timeline → cleanup
//     ordering and PUL-F006's mandatory-cleanup invariant rather than
//     reinventing them.
//  7. URL state is authoritative — this module never reads from
//     localStorage, cookies, or any cached state.
//  8. `scene` is orthogonal to `mode`, `index`, and `beat`; the
//     resolver does not interpret those parameters (they are owned by
//     future requirements).
//  9. Repeated/conflicting `scene` or `composition` parameters fail
//     loudly because `URLSearchParams.get()` silently picks one value.
//
// References:
//  - PUL-F008 — when `scene` is present, load the addressed scene as
//    the navigation target.
//  - ADR-013 — `scene` URL parameter is a navigation target selector.
//  - ADR-002 §Navigation — URL grammar.
//  - ADR-007 — workbench URL parameters and modes.
//  - ADR-008 #1 — kebab-case identity rule shared with scenes,
//    compositions, beats, and assets.
//  - ADR-011 — composition resolver as a pure orchestrator with
//    injected adapters; reused by {@link loadSceneNavigationTarget}.

import { type CompositionManifest, entryId } from './composition';
import type { CompositionRegistry } from './composition-registry';
import {
  type AssetPreloader,
  type SceneTimelineRunner,
  resolveComposition,
} from './composition-resolver';
import { KEBAB_IDENTIFIER_FORM, isKebabIdentifier } from './identifier';
import { type SceneRegistry, createSceneRegistry } from './registry';
import type { SceneModule } from './scene';

/**
 * Composition context carried by a {@link SceneNavigationTarget} when
 * the URL also supplied a `composition` parameter.
 *
 * `manifestSlice` and `sceneSlice` are snapshots taken at resolve time:
 * the bridge runs them as-is, with no further registry lookups, so
 * the lifecycle is guaranteed to play exactly the modules the resolver
 * verified existed in the registry. `sceneSlice[0]` is always the
 * addressed scene; subsequent entries are the composition entries that
 * follow it.
 */
export interface SceneNavigationCompositionContext {
  /** Composition id from the URL. */
  readonly id: string;
  /**
   * Manifest entries from the addressed scene onwards, preserving
   * per-entry `range` / `behavior` overrides intact. Bare-string
   * entries stay bare strings; object entries stay object entries.
   */
  readonly manifestSlice: CompositionManifest;
  /**
   * Scene modules referenced by `manifestSlice`, in the same order.
   * Snapshotted at resolve time so the bridge does not re-resolve by
   * id (codex review: re-resolving could substitute scenes if a
   * different registry maps the same id elsewhere).
   */
  readonly sceneSlice: readonly SceneModule[];
}

/**
 * The runtime's resolved view of "which scene the URL addresses".
 *
 *  - `scene`: the addressed scene module (already validated and
 *    pulled from the scene registry).
 *  - `composition`: optional; present only when the URL supplied
 *    `?composition=X` alongside `?scene=Y`. Carries the snapshot the
 *    bridge needs to play the composition slice end-to-end.
 */
export interface SceneNavigationTarget {
  /** The registered scene module the URL addresses. */
  readonly scene: SceneModule;
  /** Composition context, if `?composition=X` was supplied. */
  readonly composition?: SceneNavigationCompositionContext;
}

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
 * Inputs accepted by {@link resolveSceneNavigationTarget}. Anything
 * `URLSearchParams` can read is supported so callers can pass a
 * `Location`, a `URL`, a parsed `URLSearchParams`, or a raw search
 * string — the runtime boundary normalizes once and never re-parses.
 *
 * `Location`-like values are typed as `{ search: string }` so the
 * function works in browser bootstrap (`window.location`) and in
 * Node-side tooling without dragging a DOM lib dependency through
 * the type signature.
 */
export type SceneUrlInput = URL | URLSearchParams | string | { readonly search: string };

const NAV_FAIL_PREFIX = 'scene navigation failed:';

const fail = (detail: string): never => {
  throw new Error(`${NAV_FAIL_PREFIX} ${detail}`);
};

/**
 * Normalize the parser input to a {@link URLSearchParams}. The
 * runtime parses URL state exactly once at this boundary so downstream
 * code (lifecycle, future composition/mode/beat resolvers) operates on
 * a structured surface rather than re-parsing strings.
 */
function toSearchParams(input: SceneUrlInput): URLSearchParams {
  if (input instanceof URLSearchParams) return input;
  if (input instanceof URL) return input.searchParams;
  if (typeof input === 'string') {
    // A bare `?` or empty string both yield an empty search.
    if (input === '' || input === '?') return new URLSearchParams();
    // Detect a fully-qualified URL string vs. a bare query string.
    // `URL` accepts both `https://...` and `protocol:...` shapes; the
    // cheaper guard is "starts with `?`" or "has no `:` before `?`".
    if (input.startsWith('?')) return new URLSearchParams(input);
    // A full URL parses; otherwise treat as a bare search string.
    try {
      return new URL(input).searchParams;
    } catch {
      return new URLSearchParams(input);
    }
  }
  return new URLSearchParams(input.search);
}

/**
 * Read a singleton string parameter — return `null` when absent, the
 * value when present exactly once, and throw the navigation-failed
 * error when the parameter appears more than once. Centralizes the
 * "URLSearchParams.get silently picks one" defense (ADR-013) for
 * `scene` and `composition`.
 */
function readSingletonParam(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  if (values.length === 0) return null;
  if (values.length > 1) {
    const rendered = values.map((v) => `"${v}"`).join(', ');
    fail(
      `\`${name}\` URL parameter appears ${values.length} times (${rendered}); expected exactly one`,
    );
  }
  return values[0] as string;
}

/**
 * Resolve the named composition manifest, validating shape and
 * existence, and centralizing the "composition registry must exist
 * when `composition` is supplied" guard. Used by both the
 * composition+scene path and the composition-only path.
 */
function resolveCompositionManifest(
  compositionId: string,
  compositions: CompositionRegistry | undefined,
): CompositionManifest {
  if (compositions === undefined) {
    fail(
      'composition registry was not provided to the navigation resolver — pass a `CompositionRegistry` when `composition` is supplied',
    );
  }
  // `compositions` narrowed to defined by the throw above.
  const compRegistry = compositions as CompositionRegistry;
  if (!isKebabIdentifier(compositionId)) {
    fail(
      `composition id "${compositionId}" is not a valid kebab-case identifier (${KEBAB_IDENTIFIER_FORM})`,
    );
  }
  if (!compRegistry.has(compositionId)) {
    fail(`composition "${compositionId}" is not registered`);
  }
  return compRegistry.get(compositionId);
}

/**
 * Snapshot a manifest slice's scene modules from the input scene
 * registry. Pre-resolves every entry so the bridge does not re-
 * resolve by id later (codex review: re-resolving could substitute
 * scenes if a different registry maps the same id elsewhere).
 */
function snapshotSceneSlice(
  manifestSlice: CompositionManifest,
  scenes: SceneRegistry,
  compositionId: string,
): readonly SceneModule[] {
  const sceneSlice: SceneModule[] = [];
  for (const entry of manifestSlice) {
    const id = entryId(entry);
    if (!scenes.has(id)) {
      fail(
        `composition "${compositionId}" references scene "${id}" which is not in the scene registry`,
      );
    }
    sceneSlice.push(scenes.get(id));
  }
  return Object.freeze(sceneSlice);
}

/**
 * Build the composition context for a `?composition=X&scene=Y` URL:
 * verify the composition exists, verify the scene is a member, and
 * snapshot the manifest slice + matching scene modules from the
 * addressed scene onwards.
 */
function resolveCompositionAndScene(
  compositionId: string,
  sceneId: string,
  scenes: SceneRegistry,
  compositions: CompositionRegistry | undefined,
): SceneNavigationCompositionContext {
  const manifest = resolveCompositionManifest(compositionId, compositions);
  const startIndex = manifest.findIndex((entry) => entryId(entry) === sceneId);
  if (startIndex < 0) {
    fail(`scene "${sceneId}" is not a member of composition "${compositionId}"`);
  }
  const manifestSlice: CompositionManifest = manifest.slice(startIndex);
  const sceneSlice = snapshotSceneSlice(manifestSlice, scenes, compositionId);
  return { id: compositionId, manifestSlice, sceneSlice };
}

/**
 * Build the composition context for a `?composition=X` URL with no
 * `scene` parameter (ADR-002 §Navigation: load composition from
 * start). Verifies the composition exists and is non-empty, then
 * snapshots the full manifest plus matching scene modules.
 */
function resolveCompositionFromStart(
  compositionId: string,
  scenes: SceneRegistry,
  compositions: CompositionRegistry | undefined,
): SceneNavigationCompositionContext {
  const manifest = resolveCompositionManifest(compositionId, compositions);
  if (manifest.length === 0) {
    fail(`composition "${compositionId}" is empty — no scene to navigate to`);
  }
  const manifestSlice: CompositionManifest = manifest.slice();
  const sceneSlice = snapshotSceneSlice(manifestSlice, scenes, compositionId);
  return { id: compositionId, manifestSlice, sceneSlice };
}

/**
 * Resolves URL navigation parameters into a
 * {@link SceneNavigationTarget}. Returns `null` when neither `scene`
 * nor `composition` is supplied — the caller decides whether to fall
 * through to other URL routing logic.
 *
 * Three URL navigation shapes are supported (ADR-002 §Navigation +
 * ADR-013):
 *  - `?scene=Y` — single-scene navigation against the scene registry.
 *  - `?composition=X` — composition from start; the navigation target
 *    is the composition's first scene.
 *  - `?composition=X&scene=Y` — composition-scoped navigation; the
 *    target is `Y` *within* `X`, with the manifest slice from `Y`
 *    onwards snapshot for the bridge.
 *
 * For any URL that supplies `composition`, `compositions` MUST be
 * supplied; the resolver uses it to verify the composition exists.
 *
 * Throws an `Error` whose message starts with `scene navigation
 * failed:` for any of:
 *  - `scene` repeated, malformed, or unregistered
 *  - `composition` repeated, malformed, empty, unregistered, or
 *    supplied without a composition registry
 *  - addressed scene not a member of the named composition
 *  - `composition` (alone) names an empty composition
 *
 * No lifecycle hook is invoked on any error path.
 */
export function resolveSceneNavigationTarget(
  input: SceneUrlInput,
  scenes: SceneRegistry,
  compositions?: CompositionRegistry,
): SceneNavigationTarget | null {
  const params = toSearchParams(input);

  const sceneId = readSingletonParam(params, 'scene');
  const compositionId = readSingletonParam(params, 'composition');

  if (sceneId === null && compositionId === null) return null;

  if (sceneId !== null && !isKebabIdentifier(sceneId)) {
    fail(`scene id "${sceneId}" is not a valid kebab-case identifier (${KEBAB_IDENTIFIER_FORM})`);
  }

  if (compositionId !== null && sceneId !== null) {
    // Composition-scoped scene navigation. Composition is resolved
    // first so composition-level errors (registry missing, malformed
    // id, unknown composition, scene not a member) surface before any
    // scene-only validation that could mask them.
    const composition = resolveCompositionAndScene(compositionId, sceneId, scenes, compositions);
    return {
      scene: composition.sceneSlice[0] as SceneModule,
      composition,
    };
  }

  if (compositionId !== null) {
    // Composition-only navigation: load from start (ADR-002).
    const composition = resolveCompositionFromStart(compositionId, scenes, compositions);
    return {
      scene: composition.sceneSlice[0] as SceneModule,
      composition,
    };
  }

  // Plain `?scene=Y` navigation.
  // sceneId is guaranteed non-null here: at the top we returned null
  // when both ids were null, the composition+scene branch covers
  // sceneId !== null && compositionId !== null, and the
  // composition-only branch covers compositionId !== null && sceneId
  // === null. The remaining case is sceneId !== null && compositionId
  // === null.
  const id = sceneId as string;
  if (!scenes.has(id)) {
    fail(`scene "${id}" is not registered`);
  }
  return { scene: scenes.get(id) };
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
