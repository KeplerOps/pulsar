// Composition resolver — PUL-F004.
//
// Plays a composition manifest end-to-end against a scene registry.
// Given a manifest, the runtime SHALL: (a) verify every referenced
// scene id exists in the registry; (b) preload assets declared by each
// scene; (c) mount each scene in order via `create(ctx)`; (d) run its
// timeline; (e) tear it down via `cleanup(ctx)` before mounting the
// next scene.
//
// References:
//  - ADR-002 §Resolution — the canonical 5-step lifecycle this module
//    implements.
//  - ADR-008 — mandatory cleanup invariant (cleanup runs whenever the
//    scene was touched, including failure paths after `create(ctx)` or
//    timeline execution).
//  - ADR-011 — composition resolver as a pure orchestrator; asset
//    preloading and timeline execution are injected adapters so the
//    resolver does not depend on the asset loader (PUL-F005+) or the
//    GSAP timeline engine (ADR-003). Per-entry `range` and `behavior`
//    overrides flow through the runner adapter input so the future
//    GSAP runner can honor sub-range cuts and behavior overrides
//    without another resolver-signature change.
//  - PUL-P001 — cleanup is a policy-level invariant.

import {
  type BehaviorOverride,
  type CompositionEntry,
  type CompositionManifest,
  type SubRange,
  assertCompositionManifest,
} from './composition';
import type { SceneRegistry } from './registry';
import type { SceneModule } from './scene';

/**
 * Adapter that preloads the assets declared by a scene before its
 * `create(ctx)` runs (clause b of PUL-F004). Receives the validated
 * scene module so it can read both `scene.assets` and `scene.id` (the
 * latter is useful for diagnostic logging inside the adapter).
 *
 * May return synchronously (`void`) or asynchronously
 * (`Promise<void>`); the resolver awaits the result before proceeding
 * to `create`. Throwing or rejecting aborts the composition; subsequent
 * scenes are not visited.
 */
export type AssetPreloader = (scene: SceneModule) => void | Promise<void>;

/**
 * Inputs the resolver passes to the {@link SceneTimelineRunner} for
 * one scene. The shape carries everything the runner needs to honor
 * per-entry overrides without forcing the resolver to interpret them
 * itself:
 *
 *  - `scene` — the validated scene module (ADR-008's "stable, addressable
 *    identity").
 *  - `timeline` — the value `scene.timeline(ctx)` returned, awaited so
 *    async timeline factories resolve to a concrete timeline before the
 *    runner sees them.
 *  - `range` — optional sub-range from an object entry's
 *    `CompositionEntryOverride.range` (PUL-F003); the runner interprets
 *    the labels against its own timeline implementation (ADR-003 §Labels).
 *  - `behavior` — optional behavior-override blob from an object entry's
 *    `CompositionEntryOverride.behavior`; key semantics are the runner's
 *    contract with its callers (ADR-011).
 *
 * `range` and `behavior` are absent when the entry is a bare string.
 */
export interface SceneTimelineRunInput {
  readonly scene: SceneModule;
  readonly timeline: unknown;
  readonly range?: SubRange;
  readonly behavior?: BehaviorOverride;
}

/**
 * Adapter that runs a single scene's timeline (clause d of PUL-F004).
 * Receives a {@link SceneTimelineRunInput} bundle. Resolves when the
 * scene's timeline has ended; the resolver then runs `cleanup(ctx)`
 * (clause e). Throwing or rejecting aborts the composition; cleanup
 * still runs for the failing scene.
 */
export type SceneTimelineRunner = (input: SceneTimelineRunInput) => void | Promise<void>;

/**
 * Inputs to {@link resolveComposition}. All fields are required: the
 * resolver does not provide defaults so the caller's wiring is
 * explicit at the call site (workbench bootstrap, export pipeline, or
 * test harness).
 */
export interface ResolveCompositionOptions {
  /** Source of truth for which scenes exist (PUL-F002). */
  readonly registry: SceneRegistry;
  /** The ordered manifest to play (PUL-F003). */
  readonly manifest: CompositionManifest;
  /**
   * Opaque scene context passed straight through to every lifecycle
   * hook. Per ADR-003 / ADR-004 this will carry `ctx.gsap`, `ctx.audio`
   * and similar engine handles when those subsystems land; the resolver
   * itself does not inspect or extend it.
   */
  readonly ctx: unknown;
  /** Preload adapter — see {@link AssetPreloader}. */
  readonly preloadAssets: AssetPreloader;
  /** Timeline-execution adapter — see {@link SceneTimelineRunner}. */
  readonly runTimeline: SceneTimelineRunner;
}

const entryId = (entry: CompositionEntry): string => (typeof entry === 'string' ? entry : entry.id);

const describe = (value: unknown): string =>
  value instanceof Error ? value.message : String(value);

/**
 * Build the resolver's wrapping `Error`. Every public failure carries
 * the `composition resolution failed:` prefix so callers can pattern-
 * match on origin without parsing scene-specific detail.
 */
const fail = (detail: string, cause: unknown): Error =>
  // ES2024 has Error.cause natively per tsconfig target; verbatimModule
  // syntax is happy without runtime feature detection.
  new Error(`composition resolution failed: ${detail}`, { cause });

/**
 * Build the resolver's wrapping `AggregateError` for a combined
 * lifecycle + cleanup failure. The `errors` array preserves both
 * failures programmatically without mutating either error's
 * `cause` chain.
 */
const failAggregate = (detail: string, errors: readonly unknown[]): AggregateError =>
  new AggregateError(errors, `composition resolution failed: ${detail}`);

/**
 * Build the {@link SceneTimelineRunInput} for one entry. Bare-string
 * entries omit `range` / `behavior` entirely; object entries forward
 * whatever the validator accepted (which already rejects unknown
 * override keys per PUL-F003).
 */
function buildRunInput(
  scene: SceneModule,
  entry: CompositionEntry,
  timeline: unknown,
): SceneTimelineRunInput {
  if (typeof entry === 'string') return { scene, timeline };
  const input: { -readonly [K in keyof SceneTimelineRunInput]: SceneTimelineRunInput[K] } = {
    scene,
    timeline,
  };
  if (entry.range !== undefined) input.range = entry.range;
  if (entry.behavior !== undefined) input.behavior = entry.behavior;
  return input;
}

/**
 * Resolves and plays `manifest` against `registry`.
 *
 * Algorithm (PUL-F004):
 *  1. Defensively call {@link assertCompositionManifest} (boundary
 *     validation; the same pattern `createSceneRegistry` uses for
 *     `assertSceneModule`).
 *  2. Walk every entry and aggregate ALL missing scene ids into a
 *     single error before any side effect — clause (a). This is
 *     friendlier than fail-on-first because a manifest author fixes
 *     every typo in one pass.
 *  3. For each entry in order:
 *       a. `await preloadAssets(scene)` — clause (b). Failure aborts
 *          the composition; create / timeline / cleanup do not run for
 *          the failing scene and subsequent scenes are not visited.
 *       b. `await scene.create(ctx)` — clause (c).
 *       c. `await runTimeline({ scene, timeline, range?, behavior? })`
 *          — clause (d). The timeline value is awaited before being
 *          handed to the runner so async timeline factories resolve to
 *          a concrete timeline.
 *       d. `await scene.cleanup(ctx)` — clause (e). Cleanup runs
 *          whenever step (b) was attempted — including when create
 *          itself threw (resources may have been partially acquired)
 *          and when timeline execution threw. This is the
 *          mandatory-cleanup invariant from ADR-008 / PUL-P001.
 *
 * Failure semantics:
 *  - A failing preload, create, or timeline aborts the composition;
 *    the original error is attached as `Error.cause` of the wrapping
 *    error so it is never silently dropped.
 *  - When both the lifecycle phase AND cleanup throw, the wrapping
 *    error is an `AggregateError` whose `errors` array carries both
 *    the phase error and the cleanup error in order. Neither is
 *    mutated; both are programmatically recoverable.
 *  - A cleanup-only failure (timeline succeeded) is re-raised with
 *    `Error.cause` set to the original cleanup error.
 *
 * Out of scope here: cancellation / presenter interrupts. `range` and
 * `behavior` overrides are forwarded to the runner adapter unchanged
 * (the resolver does not interpret them — that is the runner's job
 * per ADR-011).
 */
export async function resolveComposition(options: ResolveCompositionOptions): Promise<void> {
  const { registry, manifest, ctx, preloadAssets, runTimeline } = options;

  assertCompositionManifest(manifest);
  preflightSceneIds(manifest, registry);

  // Per-scene lifecycle, strictly sequential. Each iteration runs
  // preload → create → timeline → cleanup before the next iteration's
  // preload begins (clause e of PUL-F004).
  for (const entry of manifest) {
    const scene = registry.get(entryId(entry));
    await preloadScene(scene, preloadAssets);
    await runScene(scene, entry, ctx, runTimeline);
  }
}

/**
 * Clause (a): walk every entry, aggregate ALL missing scene ids into
 * a single error before any side effect, and throw if any are missing.
 * Aggregating beats fail-on-first because a manifest author fixes
 * every typo in one pass.
 */
function preflightSceneIds(manifest: CompositionManifest, registry: SceneRegistry): void {
  const missing: { readonly index: number; readonly id: string }[] = [];
  for (const [index, entry] of manifest.entries()) {
    const id = entryId(entry);
    if (!registry.has(id)) {
      missing.push({ index, id });
    }
  }
  if (missing.length === 0) return;
  const list = missing.map(({ id, index }) => `"${id}" (entry [${index}])`).join(', ');
  throw fail(`unknown scene id(s): ${list} — not registered`, undefined);
}

/**
 * Clause (b): await the injected asset preloader for one scene. A
 * preload failure aborts before any lifecycle hook touches the scene
 * — neither `create` nor `cleanup` runs.
 */
async function preloadScene(scene: SceneModule, preloadAssets: AssetPreloader): Promise<void> {
  try {
    await preloadAssets(scene);
  } catch (cause) {
    throw fail(`scene "${scene.id}" preloadAssets threw: ${describe(cause)}`, cause);
  }
}

/**
 * Clauses (c), (d), (e): mount, run timeline, cleanup. Both `create`
 * and `timeline` run inside a single try so cleanup fires whenever
 * the scene was touched (codex preflight: cleanup must run after
 * `create` OR timeline execution if resources may have been acquired).
 * Cleanup failures are surfaced through {@link finalizeSceneFailure}.
 */
async function runScene(
  scene: SceneModule,
  entry: CompositionEntry,
  ctx: unknown,
  runTimeline: SceneTimelineRunner,
): Promise<void> {
  let phase: 'create' | 'timeline' = 'create';
  let phaseError: unknown;
  try {
    await scene.create(ctx);
    phase = 'timeline';
    // Await the timeline factory so async timeline constructors resolve
    // to a concrete timeline before the runner sees them. Awaiting a
    // non-Promise value is identity, so synchronous timeline factories
    // are unaffected.
    const timeline = await scene.timeline(ctx);
    await runTimeline(buildRunInput(scene, entry, timeline));
  } catch (err) {
    phaseError = err;
  }

  let cleanupError: unknown;
  try {
    await scene.cleanup(ctx);
  } catch (err) {
    cleanupError = err;
  }

  finalizeSceneFailure(scene, phase, phaseError, cleanupError);
}

/**
 * Convert the pair `(phaseError, cleanupError)` into a thrown wrapping
 * error, or return cleanly when both are absent.
 *
 * - Both present: throws an `AggregateError` whose `errors` array
 *   carries both the phase error and the cleanup error in order. The
 *   message names both. Neither caller-supplied error is mutated.
 * - Only `phaseError`: rethrown wrapped, with the original as
 *   `Error.cause`.
 * - Only `cleanupError`: rethrown wrapped as a cleanup-only failure.
 */
function finalizeSceneFailure(
  scene: SceneModule,
  phase: 'create' | 'timeline',
  phaseError: unknown,
  cleanupError: unknown,
): void {
  if (phaseError !== undefined && cleanupError !== undefined) {
    throw failAggregate(
      `scene "${scene.id}" ${phase} threw: ${describe(phaseError)} (cleanup also failed: ${describe(cleanupError)})`,
      [phaseError, cleanupError],
    );
  }
  if (phaseError !== undefined) {
    throw fail(`scene "${scene.id}" ${phase} threw: ${describe(phaseError)}`, phaseError);
  }
  if (cleanupError !== undefined) {
    throw fail(`scene "${scene.id}" cleanup threw: ${describe(cleanupError)}`, cleanupError);
  }
}
