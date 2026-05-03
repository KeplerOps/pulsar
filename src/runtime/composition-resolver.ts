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
 * One entry of the resolver's internal execution plan. Built once at
 * preflight time and iterated during lifecycle execution so the
 * resolver is immune to caller-owned manifest mutations performed
 * inside lifecycle callbacks (codex review: snapshot the manifest
 * before lifecycle side effects).
 */
interface PlanStep {
  readonly scene: SceneModule;
  readonly range: SubRange | undefined;
  readonly behavior: BehaviorOverride | undefined;
}

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
 * Build the {@link SceneTimelineRunInput} for one plan step. Omits
 * `range` / `behavior` from the output object when absent on the
 * source entry rather than emitting `range: undefined` keys, so the
 * runner's `range in input` checks behave intuitively.
 */
function buildRunInput(step: PlanStep, timeline: unknown): SceneTimelineRunInput {
  const input: { -readonly [K in keyof SceneTimelineRunInput]: SceneTimelineRunInput[K] } = {
    scene: step.scene,
    timeline,
  };
  if (step.range !== undefined) input.range = step.range;
  if (step.behavior !== undefined) input.behavior = step.behavior;
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
  const plan = buildPlan(manifest, registry);

  // Per-scene lifecycle, strictly sequential. Each iteration runs
  // preload → create → timeline → cleanup before the next iteration's
  // preload begins (clause e of PUL-F004). Iterating the resolver-
  // owned `plan` snapshot means lifecycle callbacks cannot mutate the
  // execution path mid-flight by reaching back into the caller's
  // manifest.
  for (const step of plan) {
    await preloadScene(step.scene, preloadAssets);
    await runScene(step, ctx, runTimeline);
  }
}

/**
 * Clause (a) plus snapshot capture: walk every entry exactly once,
 * resolve every scene id against the registry, snapshot per-entry
 * `range` / `behavior` overrides, and aggregate ALL missing ids into
 * one error before any side effect. Aggregating beats fail-on-first
 * because a manifest author fixes every typo in one pass; snapshotting
 * means lifecycle callbacks cannot retroactively alter the plan by
 * mutating the caller's manifest array (codex review).
 */
function buildPlan(manifest: CompositionManifest, registry: SceneRegistry): readonly PlanStep[] {
  const missing: { readonly index: number; readonly id: string }[] = [];
  const plan: PlanStep[] = [];
  for (const [index, entry] of manifest.entries()) {
    const id = entryId(entry);
    if (!registry.has(id)) {
      missing.push({ index, id });
      continue;
    }
    const scene = registry.get(id);
    const range = typeof entry === 'string' ? undefined : entry.range;
    const behavior = typeof entry === 'string' ? undefined : entry.behavior;
    plan.push({ scene, range, behavior });
  }
  if (missing.length > 0) {
    const list = missing.map(({ id, index }) => `"${id}" (entry [${index}])`).join(', ');
    throw fail(`unknown scene id(s): ${list} — not registered`, undefined);
  }
  return Object.freeze(plan);
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
  step: PlanStep,
  ctx: unknown,
  runTimeline: SceneTimelineRunner,
): Promise<void> {
  // Track failure with explicit booleans so `throw undefined` /
  // `Promise.reject(undefined)` are still treated as failures. Using
  // `phaseError !== undefined` as the sentinel would silently swallow
  // those (legal JS) cases.
  const { scene } = step;
  let phase: 'create' | 'timeline' = 'create';
  let phaseFailed = false;
  let phaseError: unknown;
  try {
    await scene.create(ctx);
    phase = 'timeline';
    // Await the timeline factory so async timeline constructors resolve
    // to a concrete timeline before the runner sees them. Awaiting a
    // non-Promise value is identity, so synchronous timeline factories
    // are unaffected.
    const timeline = await scene.timeline(ctx);
    await runTimeline(buildRunInput(step, timeline));
  } catch (err) {
    phaseFailed = true;
    phaseError = err;
  }

  let cleanupFailed = false;
  let cleanupError: unknown;
  try {
    await scene.cleanup(ctx);
  } catch (err) {
    cleanupFailed = true;
    cleanupError = err;
  }

  finalizeSceneFailure(scene, phase, phaseFailed, phaseError, cleanupFailed, cleanupError);
}

/**
 * Convert the failure flags into a thrown wrapping error, or return
 * cleanly when neither phase nor cleanup failed.
 *
 * - Both failed: throws an `AggregateError` whose `errors` array
 *   carries both the phase error and the cleanup error in order. The
 *   message names both. Neither caller-supplied error is mutated. The
 *   `errors` array — NOT `Error.cause` — is the public contract for
 *   double-fault recovery.
 * - Only phase failed: rethrown wrapped, with the original as
 *   `Error.cause`.
 * - Only cleanup failed: rethrown wrapped as a cleanup-only failure.
 */
function finalizeSceneFailure(
  scene: SceneModule,
  phase: 'create' | 'timeline',
  phaseFailed: boolean,
  phaseError: unknown,
  cleanupFailed: boolean,
  cleanupError: unknown,
): void {
  if (phaseFailed && cleanupFailed) {
    throw failAggregate(
      `scene "${scene.id}" ${phase} threw: ${describe(phaseError)} (cleanup also failed: ${describe(cleanupError)})`,
      [phaseError, cleanupError],
    );
  }
  if (phaseFailed) {
    throw fail(`scene "${scene.id}" ${phase} threw: ${describe(phaseError)}`, phaseError);
  }
  if (cleanupFailed) {
    throw fail(`scene "${scene.id}" cleanup threw: ${describe(cleanupError)}`, cleanupError);
  }
}
