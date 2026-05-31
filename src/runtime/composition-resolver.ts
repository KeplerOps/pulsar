// Composition resolver — PUL-F004 (ADR-025 / ADR-011 / ADR-008 / PUL-P001).
//
// Plays a composition manifest end-to-end against a scene registry. The
// runtime owns ONE master timeline per composition, so every scene's DOM
// coexists while it plays (ADR-025). A pure orchestrator: asset preloading
// and timeline composition/playback are injected adapters (ADR-011).
//
// Lifecycle:
//   1. validate the manifest; build the plan (resolve ids → modules;
//      snapshot per-entry `range` / `behavior` overrides).
//   2. MOUNT — per scene in order: `preloadAssets`, `await create(ctx)`,
//      no teardown between steps. Abort checkpoints before each scene and
//      after each preload/create; an attempted `create` joins the cleanup
//      list even if it threw.
//   3. COMPOSE + RUN — hand each scene's `timeline(ctx)` to the adapter,
//      which composes the master, applies head hints, plays, and resolves
//      on natural completion or abort.
//   4. CLEANUP — `await cleanup(ctx)` for every mounted scene in reverse
//      order, ALWAYS (including every failure path) — PUL-F006 / PUL-P001.
//
// PUL-F029 / ADR-028 scene-level error isolation: a thrown create /
// timeline / cleanup is a SCENE failure (not a composition failure). The
// resolver eagerly cleans up the failing scene, drops it, and continues
// the surviving scenes, surfacing via `onSceneFailed`; without that
// callback it throws an `AggregateError` of all failures at the end.
// Preload / abort / manifest / registry-miss / adapter-`run` failures are
// NOT scene failures and abort the composition.

import type { CueGateControl } from './audio';
import {
  type BehaviorOverride,
  type CompositionManifest,
  type SubRange,
  assertCompositionManifest,
  entryId,
  findUnregisteredEntries,
} from './composition';
import { describeError } from './error';
import type { PresenterController } from './presenter';
import type { SceneRegistry } from './registry';
import type { SceneModule } from './scene';

/**
 * Adapter that preloads the assets declared by a scene before its
 * `create(ctx)` runs (clause b of PUL-F004). Receives the validated
 * scene module so it can read both `scene.assets` and `scene.id`. May
 * return synchronously or asynchronously; the resolver awaits the
 * result before proceeding to `create`. Throwing or rejecting aborts
 * the composition; subsequent scenes are not mounted.
 */
export type AssetPreloader = (scene: SceneModule) => void | Promise<void>;

/**
 * One scene's contribution to the composition's master timeline. The
 * resolver collects one of these per mounted scene (in manifest order)
 * and hands the list to the injected {@link CompositionTimelineAdapter}.
 */
export interface SceneTimelineSegment {
  /** The scene id (composition entry id). Used for label namespacing. */
  readonly id: string;
  /**
   * The scene's `timeline(ctx)` return, handed to the adapter unchanged
   * and NOT awaited — a GSAP timeline is itself thenable, so awaiting it
   * would block until completion (forever, if paused). Async setup belongs
   * in `create(ctx)`; the adapter rejects a `Promise` arriving here.
   */
  readonly timeline: unknown;
  /**
   * Per-entry sub-range override from an object manifest entry's
   * `CompositionEntryOverride.range` (PUL-F003). The adapter interprets
   * the labels against its own timeline implementation (ADR-003 §Labels);
   * absent for bare-string entries.
   */
  readonly range?: SubRange;
  /**
   * Per-entry behavior-override blob from an object manifest entry's
   * `CompositionEntryOverride.behavior`. Key semantics are the adapter's
   * contract with its callers (ADR-011); absent for bare-string entries.
   */
  readonly behavior?: BehaviorOverride;
}

/**
 * Hints the resolver forwards to the adapter's `run`. The `head*` hints
 * apply to the head scene (`segments[0]`) — the single-scene modes
 * (ADR-017..021). `presenter` is forwarded for the whole composition
 * (present-mode runs the full slice).
 */
export interface CompositionTimelineRunOptions {
  /**
   * Composition-level abort signal (navigation supersession / dispose).
   * The adapter resolves — does not throw — when it fires, so the
   * resolver's cleanup phase always runs.
   */
  readonly signal?: AbortSignal;
  /**
   * URL beat label (PUL-F011 / ADR-015) the adapter seeks the head
   * scene to. Requires {@link onBeatMissing}.
   */
  readonly headBeat?: string;
  /**
   * Non-fatal callback the adapter invokes when {@link headBeat} names
   * a label that does not exist. The adapter MUST NOT throw or reject
   * on a missing label.
   */
  readonly onBeatMissing?: () => void;
  /** URL loop hint (PUL-F015 / ADR-018): the adapter sets the master to repeat forever. */
  readonly headRepeat?: 'until-aborted';
  /**
   * URL paused hint (PUL-F016 / ADR-019): the adapter holds the master
   * at frame 0. Wins over {@link headBeat} and {@link headRepeat}.
   */
  readonly headHold?: 'first-frame';
  /**
   * URL scrub hint (PUL-F017 / ADR-020): the adapter runs the head
   * scene under the interactive scrub run mode — the master is left
   * mounted and live (held, not auto-played to completion) so the
   * workbench scrub controls can drive it, and audio-cue firing is
   * gated to monotonic forward playback via {@link audioCueGate}.
   */
  readonly headCueGate?: 'monotonic-forward';
  /**
   * Dynamic audio cue-eligibility gate (PUL-F017 / ADR-020). Paired
   * with {@link headCueGate}: the adapter toggles it `false` whenever
   * the scrub master is paused or playing in reverse and `true` on
   * monotonic forward playback, so the per-navigation audio service
   * suppresses cues that are not produced by forward playback.
   * Forwarded opaquely — the resolver does not interpret it (ADR-011).
   */
  readonly audioCueGate?: CueGateControl;
  /**
   * URL screenshot hint (PUL-F018 / ADR-021): the adapter freezes the
   * master at the addressed beat (or frame 0).
   */
  readonly headScreenshot?: 'capture';
  /**
   * Present-mode presenter command controller (PUL-F020 / ADR-023).
   * Forwarded as-is; command → transport translation is the adapter's
   * future contract.
   */
  readonly presenter?: PresenterController;
  /** Diagnostic sink paired with {@link presenter} (PUL-F020 / ADR-023). */
  readonly onPresenterError?: (err: unknown) => void;
}

/**
 * Adapter that composes the active composition's scene timelines into a
 * master timeline and plays it (clause d of PUL-F004, ADR-025). The
 * GSAP implementation is `createGsapCompositionTimeline` in
 * `./timeline.ts`; the resolver depends only on this interface so it
 * stays GSAP-free (ADR-011).
 *
 * `run` resolves when the master completes (terminal — the resolver
 * tears every scene down) or when `opts.signal` aborts; it rejects
 * (e.g. with `SceneTimelineTypeError`) when a scene's timeline value is
 * invalid — the resolver wraps the rejection and cleanup still runs.
 */
export interface CompositionTimelineAdapter {
  run(
    segments: readonly SceneTimelineSegment[],
    opts: CompositionTimelineRunOptions,
  ): Promise<void>;
}

/**
 * Lifecycle phase whose throw produced a scene failure (PUL-F029 /
 * ADR-028). `cleanup` covers both the eager per-scene cleanup and the
 * final cleanup-phase loop.
 */
export type SceneFailurePhase = 'create' | 'timeline' | 'cleanup';

/**
 * Stable per-occurrence identity of one composition entry (issue #99).
 * ADR-002 lets a composition repeat a scene module; each occurrence is a
 * distinct activation. Derived purely from manifest slice order:
 *
 *  - `sceneId` — which scene module.
 *  - `entryIndex` — position in the slice handed to the resolver (the
 *    loader translates to the absolute index for diagnostics).
 *  - `occurrence` — 0-based ordinal among slice entries sharing `sceneId`,
 *    matching the timeline composer's label namespacing.
 */
export interface SceneActivation {
  readonly sceneId: string;
  readonly entryIndex: number;
  readonly occurrence: number;
}

/**
 * Structured per-scene failure event for
 * {@link ResolveCompositionOptions.onSceneFailed} (PUL-F029 / ADR-028).
 * `cause` is the raw thrown value — programmatic only, NEVER serialized
 * to a public surface (ADR-028); `message` is the {@link describeError}
 * rendering and IS safe to surface.
 */
export interface SceneFailureEvent extends SceneActivation {
  readonly phase: SceneFailurePhase;
  readonly message: string;
  readonly cause: unknown;
}

/**
 * Inputs to {@link resolveComposition}. All fields are required except
 * the head hints / signal / presenter so the caller's wiring is explicit
 * at the call site (workbench bootstrap, export pipeline, test harness).
 */
export interface ResolveCompositionOptions {
  /** Source of truth for which scenes exist (PUL-F002). */
  readonly registry: SceneRegistry;
  /** The ordered manifest to play (PUL-F003). */
  readonly manifest: CompositionManifest;
  /**
   * Per-occurrence scene-context factory (issue #99): called once per
   * entry at plan time with its {@link SceneActivation}, giving each
   * occurrence a distinct opaque `ctx`. The resolver never inspects it
   * (ADR-011); a throw aborts with `composition resolution failed:`.
   */
  readonly ctx: (activation: SceneActivation) => unknown;
  /** Preload adapter — see {@link AssetPreloader}. */
  readonly preloadAssets: AssetPreloader;
  /** Timeline-composition/playback adapter — see {@link CompositionTimelineAdapter}. */
  readonly timeline: CompositionTimelineAdapter;
  /** Optional composition-level abort signal — see {@link CompositionTimelineRunOptions.signal}. */
  readonly signal?: AbortSignal;
  /** URL beat label (PUL-F011 / ADR-015) — see {@link CompositionTimelineRunOptions.headBeat}. */
  readonly headBeat?: string;
  /** Non-fatal missing-beat callback — REQUIRED whenever {@link headBeat} is supplied. */
  readonly onBeatMissing?: () => void;
  /** URL loop hint (PUL-F015 / ADR-018). */
  readonly headRepeat?: 'until-aborted';
  /** URL paused hint (PUL-F016 / ADR-019). */
  readonly headHold?: 'first-frame';
  /** URL scrub hint (PUL-F017 / ADR-020). */
  readonly headCueGate?: 'monotonic-forward';
  /** Dynamic audio cue-eligibility gate paired with {@link headCueGate} (PUL-F017 / ADR-020). */
  readonly audioCueGate?: CueGateControl;
  /** URL screenshot hint (PUL-F018 / ADR-021). */
  readonly headScreenshot?: 'capture';
  /** Present-mode presenter command controller (PUL-F020 / ADR-023). */
  readonly presenter?: PresenterController;
  /** Diagnostic sink paired with {@link presenter}. */
  readonly onPresenterError?: (err: unknown) => void;
  /**
   * Per-scene post-cleanup hook (PUL-F024 / ADR-004): invoked once per
   * occurrence (issue #99) after its `cleanup(ctx)`, with the cleaned
   * {@link SceneActivation}. The loader uses it for runtime-guaranteed
   * audio-group teardown. A throw is treated like a cleanup failure.
   */
  readonly onSceneCleaned?: (activation: SceneActivation) => void;
  /**
   * Per-scene failure sink (PUL-F029 / ADR-028). With it the resolver
   * isolates failures mid-flight and completes for surviving scenes;
   * without it it still isolates but rejects with an `AggregateError` of
   * every failure. A throw from the callback is NOT propagated (a
   * workbench bug, not a scene failure) — it is collected into the final
   * `AggregateError` so a buggy sink cannot interrupt isolation.
   */
  readonly onSceneFailed?: (event: SceneFailureEvent) => void;
}

/** Render a kebab id for a diagnostic message — one place for quoting style. */
const quoteId = (id: string): string => `"${id}"`;

/**
 * One entry of the resolver's execution plan, built once at preflight so
 * the resolver is immune to manifest mutations inside lifecycle callbacks.
 */
export interface PlanStep {
  readonly scene: SceneModule;
  readonly range: SubRange | undefined;
  readonly behavior: BehaviorOverride | undefined;
  /** This entry's per-occurrence {@link SceneActivation}, built once at plan time. */
  readonly activation: SceneActivation;
  /** Per-occurrence scene context (issue #99), built once at plan time. Opaque to the resolver. */
  readonly ctx: unknown;
}

/** Wrapping `Error` carrying the `composition resolution failed:` prefix. */
const fail = (detail: string, cause: unknown): Error =>
  new Error(`composition resolution failed: ${detail}`, { cause });

/** Wrapping `AggregateError` preserving every member error in order. */
const failAggregate = (detail: string, errors: readonly unknown[]): AggregateError =>
  new AggregateError(errors, `composition resolution failed: ${detail}`);

/**
 * Throw a wrapped abort error if `signal` is aborted. A function (not an
 * inline check) so TS does not narrow the `aborted` getter away between
 * the resolver's mount checkpoints, where it can flip.
 */
function throwIfAborted(signal: AbortSignal | undefined, detail: string): void {
  if (signal?.aborted === true) {
    throw fail(detail, signal.reason);
  }
}

/**
 * Clause (a) + snapshot: resolve every scene id, snapshot per-entry
 * `range` / `behavior`, assign each entry its activation + `ctx`
 * (issue #99). Aggregates ALL missing ids into one error before any
 * side effect.
 */
export function buildPlan(
  manifest: CompositionManifest,
  registry: SceneRegistry,
  ctxFor: (activation: SceneActivation) => unknown,
): readonly PlanStep[] {
  const missing = findUnregisteredEntries(manifest, (id) => registry.has(id));
  if (missing.length > 0) {
    const list = missing.map(({ id, index }) => `${quoteId(id)} (entry [${index}])`).join(', ');
    throw fail(`unknown scene id(s): ${list} — not registered`, undefined);
  }
  // ADR-002 / issue #99: a repeated scene id is one distinct activation
  // (and `PlanStep`) per entry. The 0-based per-id `occurrence` ordinal
  // is the stable identity threaded to every per-occurrence surface.
  const occurrenceCounter = new Map<string, number>();
  const plan: PlanStep[] = [];
  for (const [entryIndex, entry] of manifest.entries()) {
    const id = entryId(entry);
    const scene = registry.get(id);
    const occurrence = occurrenceCounter.get(id) ?? 0;
    occurrenceCounter.set(id, occurrence + 1);
    const range = typeof entry === 'string' ? undefined : entry.range;
    const behavior = typeof entry === 'string' ? undefined : entry.behavior;
    const activation: SceneActivation = { sceneId: id, entryIndex, occurrence };
    let ctx: unknown;
    try {
      ctx = ctxFor(activation);
    } catch (cause) {
      throw fail(
        `scene ${quoteId(id)} (entry [${entryIndex}]) ctx factory threw: ${describeError(cause)}`,
        cause,
      );
    }
    plan.push({ scene, range, behavior, activation, ctx });
  }
  return Object.freeze(plan);
}

/** Clause (b): await the injected asset preloader for one scene. */
async function preloadScene(scene: SceneModule, preloadAssets: AssetPreloader): Promise<void> {
  try {
    await preloadAssets(scene);
  } catch (cause) {
    throw fail(`scene ${quoteId(scene.id)} preloadAssets threw: ${describeError(cause)}`, cause);
  }
}

/**
 * Build a {@link SceneFailureEvent} + `Error` wrapper for one isolated
 * scene-lifecycle failure (PUL-F029 / ADR-028); the wrapper keeps the
 * `composition resolution failed:` envelope for the no-callback fallback.
 */
function buildSceneFailure(
  phase: SceneFailurePhase,
  step: PlanStep,
  cause: unknown,
  detail: string,
): { event: SceneFailureEvent; wrapper: Error } {
  const event: SceneFailureEvent = {
    ...step.activation,
    phase,
    message: describeError(cause),
    cause,
  };
  return { event, wrapper: fail(detail, cause) };
}

/**
 * Failure / hook-error buckets the lifecycle helpers append into.
 *  - `sceneFailureErrors` — scene lifecycle failures (PUL-F029 / ADR-028);
 *    surfaced via `onSceneFailed` when wired, else aggregated.
 *  - `hookErrors` — workbench `onSceneCleaned` / `onSceneFailed` throws.
 *    NOT scene failures: they bypass `onSceneFailed` and ALWAYS aggregate,
 *    so a workbench hook bug is never silently swallowed.
 */
export interface FailureBucket {
  readonly sceneFailureErrors: Error[];
  readonly hookErrors: Error[];
}

/**
 * Shared lifecycle plumbing threaded through every phase helper.
 * `reportFailure` collects the wrapped error AND fans the event out via
 * `onSceneFailed` (wrapped ONCE in {@link buildLifecycleContext}); a sink
 * throw lands in `bucket.hookErrors`, never breaking cleanup-then-continue.
 */
export interface LifecycleContext {
  readonly signal: AbortSignal | undefined;
  readonly onSceneCleaned: ((activation: SceneActivation) => void) | undefined;
  readonly bucket: FailureBucket;
  readonly reportFailure: (phase: SceneFailurePhase, step: PlanStep, cause: unknown) => void;
}

const FAILURE_DETAIL: Record<SceneFailurePhase, string> = {
  create: 'create',
  timeline: 'timeline',
  cleanup: 'cleanup',
};

export function buildLifecycleContext(
  signal: AbortSignal | undefined,
  onSceneCleaned: ((activation: SceneActivation) => void) | undefined,
  onSceneFailed: ((event: SceneFailureEvent) => void) | undefined,
  bucket: FailureBucket,
): LifecycleContext {
  const reportFailure = (phase: SceneFailurePhase, step: PlanStep, cause: unknown): void => {
    const { event, wrapper } = buildSceneFailure(
      phase,
      step,
      cause,
      `scene ${quoteId(step.scene.id)} ${FAILURE_DETAIL[phase]} threw: ${describeError(cause)}`,
    );
    bucket.sceneFailureErrors.push(wrapper);
    if (onSceneFailed === undefined) return;
    try {
      onSceneFailed(event);
    } catch (err) {
      bucket.hookErrors.push(
        fail(`scene ${quoteId(event.sceneId)} onSceneFailed threw: ${describeError(err)}`, err),
      );
    }
  };
  return { signal, onSceneCleaned, bucket, reportFailure };
}

/**
 * Run one scene's `cleanup(ctx)` AND its `onSceneCleaned` hook (PUL-F024 /
 * ADR-004 audio teardown). Shared by the eager-cleanup branches and the
 * final loop so the hook fires exactly once per scene cleanup. Cleanup
 * failures route to `sceneFailureErrors` + `onSceneFailed`; a hook throw
 * routes to `hookErrors` only (workbench bug, not a scene failure).
 */
async function cleanOneScene(step: PlanStep, lc: LifecycleContext): Promise<void> {
  try {
    await step.scene.cleanup(step.ctx);
  } catch (error_) {
    lc.reportFailure('cleanup', step, error_);
  }
  try {
    lc.onSceneCleaned?.(step.activation);
  } catch (err) {
    lc.bucket.hookErrors.push(
      fail(`scene ${quoteId(step.scene.id)} onSceneCleaned threw: ${describeError(err)}`, err),
    );
  }
}

/**
 * Mount the planned scenes (clauses b + c, PUL-F029 / ADR-028 isolation).
 * A throwing `create(ctx)` is recorded, the scene's cleanup runs eagerly,
 * the scene is dropped, and the loop continues. Preload errors and signal
 * aborts still throw out (composition-wide semantics).
 */
async function mountPlan(
  plan: readonly PlanStep[],
  preloadAssets: AssetPreloader,
  lc: LifecycleContext,
  mounted: PlanStep[],
): Promise<void> {
  for (const step of plan) {
    await preloadScene(step.scene, preloadAssets);
    throwIfAborted(
      lc.signal,
      `aborted after preloading ${quoteId(step.scene.id)}, before scene activation`,
    );
    // Track in `mounted` BEFORE create so a partial-create scene still
    // gets cleanup — and so the eager-cleanup branch below pops the
    // scene only after its cleanup ran (one cleanup per scene).
    mounted.push(step);
    try {
      await step.scene.create(step.ctx);
    } catch (cause) {
      lc.reportFailure('create', step, cause);
      // PUL-F029: eager cleanup through the same helper (so the
      // `onSceneCleaned` audio teardown fires), then drop the scene so
      // the final cleanup phase doesn't double-clean.
      await cleanOneScene(step, lc);
      mounted.pop();
      // Re-check abort after the awaited cleanup so an abort mid-cleanup
      // doesn't kick off the next scene (cleanup-before-handoff).
      throwIfAborted(lc.signal, `aborted after isolating ${quoteId(step.scene.id)} create failure`);
      continue;
    }
    throwIfAborted(lc.signal, `aborted after mounting ${quoteId(step.scene.id)}`);
  }
}

/**
 * Collect each mounted scene's `timeline(ctx)` into a segment list (in
 * mount order), carrying `range` / `behavior` through unchanged.
 * `timeline(ctx)` is NOT awaited. A throwing factory isolates that scene
 * (PUL-F029 / ADR-028): eager cleanup, drop from `mounted`, no segment.
 */
async function composeSegments(
  mounted: PlanStep[],
  lc: LifecycleContext,
): Promise<SceneTimelineSegment[]> {
  const segments: SceneTimelineSegment[] = [];
  // Snapshot up-front: the loop removes failed scenes from `mounted`, so
  // iterating the live array would skip an entry after each splice.
  const snapshot = Array.from(mounted);
  for (const step of snapshot) {
    let timeline: unknown;
    try {
      timeline = step.scene.timeline(step.ctx);
    } catch (cause) {
      lc.reportFailure('timeline', step, cause);
      // PUL-F029: eager cleanup (audio teardown), then drop from `mounted`.
      await cleanOneScene(step, lc);
      const at = mounted.indexOf(step);
      if (at !== -1) mounted.splice(at, 1);
      // Re-check abort after cleanup so superseded navigations don't run
      // `timeline(ctx)` on surviving scenes.
      throwIfAborted(
        lc.signal,
        `aborted after isolating ${quoteId(step.scene.id)} timeline failure`,
      );
      continue;
    }
    segments.push({
      id: step.scene.id,
      timeline,
      ...(step.range !== undefined ? { range: step.range } : {}),
      ...(step.behavior !== undefined ? { behavior: step.behavior } : {}),
    });
  }
  return segments;
}

/**
 * Tear down every mounted scene via `cleanup(ctx)` in reverse mount
 * order; each runs even if a previous one threw (failures collected, not
 * raised). `onSceneCleaned` runs after each and a throw is collected like
 * a cleanup failure. Never throws.
 */
async function cleanupAll(mounted: readonly PlanStep[], lc: LifecycleContext): Promise<void> {
  for (let i = mounted.length - 1; i >= 0; i -= 1) {
    const step = mounted[i];
    if (step === undefined) continue;
    await cleanOneScene(step, lc);
  }
}

/**
 * Terminal condition the lifecycle engine reached after cleanup; mapped
 * by `finalize` onto the public return-or-throw contract.
 *  - `completed` — the happy path.
 *  - `aborted` — `run` resolved because `signal` aborted mid-playback.
 *  - `phase-error` — a composition-wide failure (preload / abort /
 *    manifest / registry-miss / adapter `run`); `error` is pre-wrapped.
 */
export type LifecycleOutcome =
  | { readonly kind: 'completed' }
  | { readonly kind: 'aborted'; readonly reason: unknown }
  | { readonly kind: 'phase-error'; readonly error: unknown };

/** Happy-path aggregate wording (tests pattern-match on it; kept verbatim). */
function happyPathAggregateDetail(sceneCount: number, hookCount: number): string {
  if (sceneCount === 0) return `composition completed but ${hookCount} cleanup hook(s) threw`;
  if (hookCount === 0) return `composition completed with ${sceneCount} scene failure(s)`;
  return `composition completed with ${sceneCount} scene failure(s) and ${hookCount} cleanup hook(s) threw`;
}

/** Aborted-during-playback aggregate wording (tests pattern-match on it). */
function abortedPlaybackDetail(sceneCount: number, hookCount: number): string {
  return hookCount === 0
    ? `composition aborted during playback with ${sceneCount} cleanup failure(s)`
    : `composition aborted during playback with ${sceneCount + hookCount} additional failure(s)`;
}

/**
 * Build the head error + aggregate-detail prefix for a non-happy
 * {@link LifecycleOutcome}. `null` means the happy path — `finalize`
 * picks the happy-path wording instead.
 */
function outcomeHead(
  outcome: LifecycleOutcome,
  sceneCount: number,
  hookCount: number,
): { head: unknown; detail: string } | null {
  if (outcome.kind === 'completed') return null;
  if (outcome.kind === 'phase-error') {
    return {
      head: outcome.error,
      detail: `composition aborted with ${sceneCount + hookCount} additional failure(s) after: ${describeError(outcome.error)}`,
    };
  }
  return {
    head: fail('aborted during composition playback', outcome.reason),
    detail: abortedPlaybackDetail(sceneCount, hookCount),
  };
}

/**
 * Map {@link LifecycleOutcome} + {@link FailureBucket} onto the public
 * return-or-throw contract — the single aggregate-vs-reraise decision.
 * `aggregateScene` (set when `onSceneFailed` was absent) re-aggregates
 * scene failures so a direct caller doesn't lose them; with the callback
 * wired they do NOT re-aggregate (they already isolated). Hook errors
 * ALWAYS aggregate. A composition-wide head error is always re-raised,
 * with residual failures behind it.
 */
function finalize(outcome: LifecycleOutcome, bucket: FailureBucket, aggregateScene: boolean): void {
  const sceneErrors = aggregateScene ? bucket.sceneFailureErrors : [];
  const residual = [...sceneErrors, ...bucket.hookErrors];
  const headSpec = outcomeHead(outcome, sceneErrors.length, bucket.hookErrors.length);
  if (headSpec === null) {
    if (residual.length === 0) return;
    throw failAggregate(
      happyPathAggregateDetail(sceneErrors.length, bucket.hookErrors.length),
      residual,
    );
  }
  if (residual.length === 0) throw headSpec.head;
  throw failAggregate(headSpec.detail, [headSpec.head, ...residual]);
}

/**
 * Bare lifecycle engine: mount-all → compose-master → play → cleanup-all
 * (reverse), per the module header. GSAP-free, fans NOTHING out, makes no
 * aggregate-vs-reraise decision — per-scene failures flow through
 * `lc.reportFailure`, composition-wide failures via the returned
 * {@link LifecycleOutcome}. Cleanup ALWAYS runs before returning. Exported
 * for bare testing; `withFailureIsolation` is the only production caller.
 */
export async function runLifecycle(
  plan: readonly PlanStep[],
  preloadAssets: AssetPreloader,
  timeline: CompositionTimelineAdapter,
  runOptions: CompositionTimelineRunOptions,
  lc: LifecycleContext,
): Promise<LifecycleOutcome> {
  // Scenes mounted so far = the cleanup list (eagerly-cleaned scenes are
  // removed so cleanup never runs twice); declared outside the try so a
  // preload/abort throw still leaves the partial mount visible.
  const mounted: PlanStep[] = [];
  let phaseError: { error: unknown } | null = null;
  try {
    await mountPlan(plan, preloadAssets, lc, mounted);
    const segments = await composeSegments(mounted, lc);
    try {
      await timeline.run(segments, runOptions);
    } catch (cause) {
      throw fail(`composition timeline failed: ${describeError(cause)}`, cause);
    }
  } catch (error) {
    phaseError = { error };
  }
  await cleanupAll(mounted, lc);
  if (phaseError !== null) return { kind: 'phase-error', error: phaseError.error };
  // Abort observed only after the mandatory cleanup phase (a cleanup
  // hook could fire it), matching the historical post-cleanup check.
  if (lc.signal?.aborted === true) return { kind: 'aborted', reason: lc.signal.reason };
  return { kind: 'completed' };
}

/**
 * Pick the {@link CompositionTimelineRunOptions} keys from the resolver
 * options, dropping absent ones for `exactOptionalPropertyTypes`
 * cleanliness and a minimal forwarded object.
 */
function runOptionsFrom(options: ResolveCompositionOptions): CompositionTimelineRunOptions {
  const all: Record<keyof CompositionTimelineRunOptions, unknown> = {
    signal: options.signal,
    headBeat: options.headBeat,
    onBeatMissing: options.onBeatMissing,
    headRepeat: options.headRepeat,
    headHold: options.headHold,
    headCueGate: options.headCueGate,
    audioCueGate: options.audioCueGate,
    headScreenshot: options.headScreenshot,
    presenter: options.presenter,
    onPresenterError: options.onPresenterError,
  };
  const opts: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(all)) {
    if (value !== undefined) opts[key] = value;
  }
  return opts as CompositionTimelineRunOptions;
}

/**
 * Bare orchestrator: validate the boundary contracts, build the plan, and
 * drive {@link runLifecycle}. Returns the raw {@link LifecycleOutcome},
 * making NO aggregate-vs-reraise decision (that is
 * {@link withFailureIsolation}'s job).
 */
async function orchestrate(
  options: ResolveCompositionOptions,
  lc: LifecycleContext,
): Promise<LifecycleOutcome> {
  const { registry, manifest, preloadAssets, timeline, signal } = options;

  // PUL-F011 / ADR-015: fail fast if `headBeat` lacks `onBeatMissing` so
  // the missing-label diagnostic cannot be silently lost.
  if (options.headBeat !== undefined && options.onBeatMissing === undefined) {
    throw fail(
      '"onBeatMissing" is required when "headBeat" is supplied — a beat without a diagnostic surface would silently lose missing-label errors',
      undefined,
    );
  }

  assertCompositionManifest(manifest);
  const plan = buildPlan(manifest, registry, options.ctx);

  // Pre-start abort: nothing was touched, so this needs no cleanup.
  throwIfAborted(signal, 'aborted before the composition started');

  return runLifecycle(plan, preloadAssets, timeline, runOptionsFrom(options), lc);
}

/**
 * Scene-failure-isolation decorator (PUL-F029 / ADR-028) over the bare
 * {@link orchestrate} engine. Owns the {@link FailureBucket}, wraps
 * `onSceneFailed` ONCE (in {@link buildLifecycleContext}), and routes the
 * {@link LifecycleOutcome} through {@link finalize}. Exported as
 * {@link resolveComposition}.
 */
function withFailureIsolation(
  engine: (options: ResolveCompositionOptions, lc: LifecycleContext) => Promise<LifecycleOutcome>,
): (options: ResolveCompositionOptions) => Promise<void> {
  return async (options) => {
    // PUL-F029 / ADR-028: one bucket for scene failures + hook throws;
    // `finalize` keys aggregate-vs-reraise off whether `onSceneFailed` was wired.
    const bucket: FailureBucket = { sceneFailureErrors: [], hookErrors: [] };
    const lc = buildLifecycleContext(
      options.signal,
      options.onSceneCleaned,
      options.onSceneFailed,
      bucket,
    );
    const outcome = await engine(options, lc);
    finalize(outcome, bucket, options.onSceneFailed === undefined);
  };
}

/**
 * Resolve and play `manifest` against `registry` (lifecycle per the
 * module header). Failure semantics (PUL-F029 / ADR-028):
 *  - Per-scene `create`/`timeline`/`cleanup` throws isolate (eager
 *    cleanup, drop, continue); surfaced via `onSceneFailed` when wired,
 *    else aggregated so direct callers keep the signal.
 *  - Preload / abort-checkpoint / manifest / registry-miss / adapter-`run`
 *    failures are composition-wide: tear every scene down, then re-raise
 *    wrapped (`composition resolution failed:` + original as `cause`;
 *    `AggregateError` when hook errors also occurred).
 *  - A playback abort makes `run` resolve (not throw); scenes tear down
 *    and an `aborted during composition playback` error re-raises.
 *  - Hook (`onSceneCleaned` / `onSceneFailed`) throws ALWAYS aggregate.
 */
export const resolveComposition: (options: ResolveCompositionOptions) => Promise<void> =
  withFailureIsolation(orchestrate);
