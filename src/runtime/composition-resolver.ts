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
//  - PUL-F006 — `cleanup(ctx)` runs on every scene exit. Four exit
//    paths, all routed through `runScene`'s unconditional second
//    try/catch (see ADR-011 risk-table for design rationale):
//      1. normal advance         — happy-path loop iteration.
//      2. presenter skip         — TWO shapes: (a) cooperative
//                                  scene exit (runner returns void;
//                                  resolver cannot distinguish from
//                                  completion per ADR-011), and (b)
//                                  composition-level abort via
//                                  `ResolveCompositionOptions.signal`
//                                  (checked pre-iteration and
//                                  post-preload, and forwarded to
//                                  the runner).
//      3. runtime error in scene — create / timeline / runner throws.
//      4. composition end        — final scene's cleanup is terminal.
//    Cleanup is invoked exactly once per scene activation. Do NOT
//    add a parallel cleanup path for skip or error.

import {
  type BehaviorOverride,
  type CompositionManifest,
  type SubRange,
  assertCompositionManifest,
  entryId,
  findUnregisteredEntries,
} from './composition';
import { describeError } from './error';
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
  /**
   * Cancellation signal forwarded from
   * {@link ResolveCompositionOptions.signal} when the caller supplied
   * one. The runner adapter is responsible for honoring it — typically
   * by polling `signal.aborted`, listening for the `'abort'` event, or
   * calling `signal.throwIfAborted()` at safe points in its timeline
   * traversal. When the runner throws (or rejects) in response to an
   * abort, the resolver still invokes `cleanup(ctx)` for the active
   * scene per PUL-F006 (mandatory cleanup on every scene exit). Absent
   * when the caller did not pass a `signal`.
   */
  readonly signal?: AbortSignal;
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
  /**
   * Optional cancellation signal for composition-level abort (PUL-F006
   * "skip rest of composition" exit path; see ADR-011 risk-table for
   * design rationale). The resolver checks `signal.aborted` at three
   * checkpoints — pre-start, post-preload, and forwarded into the
   * runner via {@link SceneTimelineRunInput.signal} — and throws with
   * a checkpoint-specific message when aborted. `signal.reason` is
   * forwarded as `Error.cause`. A runner that aborts mid-timeline
   * still routes through the cleanup-always path so the active
   * scene's cleanup fires. Absent (`undefined`) disables the
   * abort path entirely; the runner is also free to ignore a
   * forwarded signal.
   */
  readonly signal?: AbortSignal;
}

/**
 * Render a kebab id (scene id, manifest entry id, etc.) for inclusion
 * in a diagnostic message. Centralizing the quoting style means a
 * future change (e.g., to backticks for code-style rendering) lands
 * in one place rather than ten string templates across the file.
 */
const quoteId = (id: string): string => `"${id}"`;

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
 * Throws a wrapped abort error if the optional signal is currently
 * aborted; otherwise returns. The function wrapper exists to defeat
 * TypeScript's control-flow narrowing across the resolver's two
 * abort checkpoints (pre-iteration and post-preload): without it,
 * the second `signal?.aborted === true` read would be narrowed to
 * `false | undefined` by the first checkpoint's then-throw branch
 * and the second check would be flagged as unreachable. The signal's
 * `aborted` getter can flip between checkpoints, so the runtime
 * check must run even when TS thinks it cannot.
 */
function throwIfAborted(signal: AbortSignal | undefined, detail: string): void {
  if (signal?.aborted === true) {
    throw fail(detail, signal.reason);
  }
}

/**
 * Build the {@link SceneTimelineRunInput} for one plan step. Omits
 * `range` / `behavior` from the output object when absent on the
 * source entry rather than emitting `range: undefined` keys, so the
 * runner's `range in input` checks behave intuitively.
 */
function buildRunInput(
  step: PlanStep,
  timeline: unknown,
  signal: AbortSignal | undefined,
): SceneTimelineRunInput {
  const input: { -readonly [K in keyof SceneTimelineRunInput]: SceneTimelineRunInput[K] } = {
    scene: step.scene,
    timeline,
  };
  if (step.range !== undefined) input.range = step.range;
  if (step.behavior !== undefined) input.behavior = step.behavior;
  if (signal !== undefined) input.signal = signal;
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
 * PUL-F006 presenter-skip handling (`options.signal`): if the caller
 * supplies an `AbortSignal`, the resolver checks `signal.aborted`
 * before each scene's preload (so an abort between scenes prevents
 * the next scene from being touched) and forwards the signal to the
 * runner via `SceneTimelineRunInput.signal` (so the runner can honor
 * a mid-scene abort by throwing, which routes through the
 * cleanup-always path above). Pre-start aborts throw without
 * visiting any scene; inter-scene aborts throw with the previously-
 * completed scene id named in the message. The resolver does not
 * inspect `signal.reason`; it is forwarded as `Error.cause`.
 *
 * `range` and `behavior` overrides are forwarded to the runner adapter
 * unchanged (the resolver does not interpret them — that is the
 * runner's job per ADR-011).
 */
export async function resolveComposition(options: ResolveCompositionOptions): Promise<void> {
  const { registry, manifest, ctx, preloadAssets, runTimeline, signal } = options;

  assertCompositionManifest(manifest);
  const plan = buildPlan(manifest, registry);

  // Per-scene lifecycle, strictly sequential. Each iteration runs
  // preload → create → timeline → cleanup before the next iteration's
  // preload begins (clause e of PUL-F004). Iterating the resolver-
  // owned `plan` snapshot means lifecycle callbacks cannot mutate the
  // execution path mid-flight by reaching back into the caller's
  // manifest.
  //
  // PUL-F006 abort checkpoints: at the top of each iteration (catches
  // both abort-before-any-scene and inter-scene aborts) AND after
  // preload (catches mid-preload aborts before the scene is activated).
  // No separate pre-loop check is needed because `assertCompositionManifest`
  // and `buildPlan` are synchronous — there is no yield point between
  // them and the loop's first iteration check.
  let lastCompletedSceneId: string | undefined;
  for (const step of plan) {
    throwIfAborted(
      signal,
      lastCompletedSceneId === undefined
        ? 'aborted before any scene was visited'
        : `aborted between scenes after ${quoteId(lastCompletedSceneId)}`,
    );
    await preloadScene(step.scene, preloadAssets);
    throwIfAborted(
      signal,
      `aborted after preloading ${quoteId(step.scene.id)}, before scene activation`,
    );
    await runScene(step, ctx, runTimeline, signal);
    lastCompletedSceneId = step.scene.id;
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
  const missing = findUnregisteredEntries(manifest, (id) => registry.has(id));
  if (missing.length > 0) {
    const list = missing.map(({ id, index }) => `${quoteId(id)} (entry [${index}])`).join(', ');
    throw fail(`unknown scene id(s): ${list} — not registered`, undefined);
  }
  const plan: PlanStep[] = [];
  for (const entry of manifest) {
    const scene = registry.get(entryId(entry));
    const range = typeof entry === 'string' ? undefined : entry.range;
    const behavior = typeof entry === 'string' ? undefined : entry.behavior;
    plan.push({ scene, range, behavior });
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
    throw fail(`scene ${quoteId(scene.id)} preloadAssets threw: ${describeError(cause)}`, cause);
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
  signal: AbortSignal | undefined,
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
    await runTimeline(buildRunInput(step, timeline, signal));
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
      `scene ${quoteId(scene.id)} ${phase} threw: ${describeError(phaseError)} (cleanup also failed: ${describeError(cleanupError)})`,
      [phaseError, cleanupError],
    );
  }
  if (phaseFailed) {
    throw fail(
      `scene ${quoteId(scene.id)} ${phase} threw: ${describeError(phaseError)}`,
      phaseError,
    );
  }
  if (cleanupFailed) {
    throw fail(
      `scene ${quoteId(scene.id)} cleanup threw: ${describeError(cleanupError)}`,
      cleanupError,
    );
  }
}
