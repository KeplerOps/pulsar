// Composition resolver — PUL-F004 (with the resolution lifecycle revised
// by ADR-025).
//
// Plays a composition manifest end-to-end against a scene registry.
// Given a manifest, the runtime SHALL: (a) verify every referenced
// scene id exists in the registry; (b) preload assets declared by each
// scene; (c) mount each scene in order via `create(ctx)`; (d) compose
// the scene timelines into one master timeline and play it; (e) tear
// every scene down via `cleanup(ctx)`.
//
// ADR-025 supersedes ADR-002 §Resolution / ADR-011's per-scene
// `mount → run timeline → cleanup → advance` ordering. The runtime owns
// ONE master timeline per active composition (the transport surface —
// play / pause / seek / speed / labels), so every scene's DOM must
// coexist while the master plays. The new ordering:
//
//   1. validate the manifest; build the plan (resolve scene ids →
//      modules; snapshot per-entry `range` / `behavior` overrides).
//   2. MOUNT phase — for each scene in manifest order: `preloadAssets`,
//      `await create(ctx)`. Scenes are NOT torn down between steps.
//      Abort checkpoints: before any scene, after each preload, after
//      each create. A scene whose `create` was attempted joins the
//      cleanup list even if `create` itself threw.
//   3. COMPOSE + RUN phase — collect each mounted scene's
//      `timeline(ctx)` value and hand them to the injected timeline
//      adapter, which composes the master, applies the head hints
//      (beat / loop / paused / screenshot / cueGate / presenter), plays
//      it, and resolves on the master's natural completion or on abort.
//   4. CLEANUP phase — `await cleanup(ctx)` for every mounted scene in
//      reverse mount order, ALWAYS (including every failure path in 2/3).
//
// PUL-F029 / ADR-028 (scene-level error isolation): a thrown
// `create(ctx)`, `timeline(ctx)`, or `cleanup(ctx)` is a SCENE failure,
// not a composition failure. The resolver isolates the failing scene
// (runs its cleanup eagerly when the failure is in `create` or
// `timeline`, removes it from the segment list, and continues the
// active composition with the remaining scenes), surfacing each
// failure through the optional `onSceneFailed` callback. When the
// callback is NOT wired, the resolver still isolates mid-flight but
// throws an `AggregateError` of every scene failure at the end of the
// lifecycle so direct callers (tests, scripts) don't lose the signal.
// Preload, signal-abort, manifest, registry-miss, and timeline-adapter
// `run` failures are NOT scene failures and keep their abort-the-
// composition semantics per ADR-028's non-goals.
//
// References:
//  - ADR-002 §Resolution — the original 5-step lifecycle; its per-scene
//    ordering is superseded by ADR-025.
//  - ADR-008 — mandatory cleanup invariant (cleanup runs whenever the
//    scene was touched, including failure paths after `create(ctx)`).
//  - ADR-011 — composition resolver as a pure orchestrator; asset
//    preloading and timeline composition/playback are injected adapters
//    so the resolver does not depend on the asset loader (PUL-F005+) or
//    GSAP (ADR-003 / ADR-025).
//  - ADR-025 — timeline adapter + composition master + the revised
//    resolution lifecycle this module implements.
//  - ADR-028 — scene-level error isolation (PUL-F029): per-scene
//    lifecycle failures isolate, surface, and let the composition
//    continue.
//  - PUL-P001 — cleanup is a policy-level invariant.
//  - PUL-F006 — `cleanup(ctx)` runs on every scene exit; the
//    composition-level abort signal (`ResolveCompositionOptions.signal`)
//    is checked at the mount checkpoints and forwarded to the timeline
//    adapter, which resolves (does not throw) on abort so the cleanup
//    phase always runs.

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
   * The value the scene's `timeline(ctx)` returned, handed to the
   * adapter unchanged — NOT awaited: a GSAP timeline (ADR-003 /
   * ADR-025) is itself thenable (`Animation.prototype.then` resolves on
   * completion), so awaiting it would block until the timeline finished
   * — forever, for a paused one — rather than yielding the timeline.
   * Async scene setup goes in `create(ctx)`; the adapter's validator
   * rejects a `Promise` that still arrives here.
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
 * The head-scoped hints the resolver forwards to the timeline adapter's
 * `run`. All apply to the head scene (the first entry of the resolved
 * slice — `segments[0]`): `headBeat` seeks the master to the head
 * scene's named label; `headHold` / `headScreenshot` / `headRepeat` /
 * `headCueGate` correspond to the single-scene workbench modes whose
 * slices are truncated to the head (ADR-017 — ADR-021). `presenter` is
 * forwarded for the whole composition (`mode=present` runs the full
 * slice), though translating its commands to transport is the adapter's
 * future contract (PUL-F020 / PUL-F021 / ADR-023 / ADR-024).
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
   * URL scrub hint (PUL-F017 / ADR-020): forwarded, but the timeline
   * adapter does not yet gate audio cues against it — the PUL-F024 audio
   * service exists, but timeline-callback cue gating is a follow-up;
   * scenes fire their own `ctx.audio` cues from their timeline callbacks
   * today.
   */
  readonly headCueGate?: 'monotonic-forward';
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
 * The lifecycle phase whose throw produced a scene failure (PUL-F029 /
 * ADR-028). One of the three lifecycle hooks the scene contract owns;
 * the loader maps phase + scene id onto the public diagnostic surface.
 * `cleanup` covers both the per-scene cleanup the resolver runs eagerly
 * when `create` or `timeline` failed AND the final cleanup-phase loop.
 */
export type SceneFailurePhase = 'create' | 'timeline' | 'cleanup';

/**
 * The structured per-scene failure event the resolver hands to
 * {@link ResolveCompositionOptions.onSceneFailed} (PUL-F029 / ADR-028).
 * The `cause` field is the original thrown value — programmatic only;
 * the loader MUST NOT serialize it to a public diagnostic surface (per
 * ADR-028: no raw causes, stacks, scene objects, DOM, captions,
 * headers, cookies, environment, or auth values). The `message` field
 * is the {@link describeError} rendering of the cause and IS safe to
 * surface to operators.
 *
 * `entryIndex` carries the position of the failing scene in the
 * manifest the resolver was handed (ADR-028: composition entry index
 * is part of the failure diagnostic contract). When the resolver is
 * driven from a composition slice that started mid-manifest the index
 * is relative to the slice the resolver saw, not the absolute
 * composition index — the loader (which knows the composition's
 * entry-index translation) augments the public diagnostic with the
 * composition id and effective mode (the other two fields ADR-028
 * requires) on top of this resolver-level event.
 */
export interface SceneFailureEvent {
  readonly phase: SceneFailurePhase;
  readonly sceneId: string;
  readonly entryIndex: number;
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
   * Opaque scene context passed straight through to every lifecycle
   * hook. Carries `ctx.gsap` (ADR-003) and similar engine handles; the
   * resolver itself does not inspect or extend it.
   */
  readonly ctx: unknown;
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
  /** URL screenshot hint (PUL-F018 / ADR-021). */
  readonly headScreenshot?: 'capture';
  /** Present-mode presenter command controller (PUL-F020 / ADR-023). */
  readonly presenter?: PresenterController;
  /** Diagnostic sink paired with {@link presenter}. */
  readonly onPresenterError?: (err: unknown) => void;
  /**
   * Per-scene post-cleanup hook (PUL-F024 / ADR-004). Invoked after each
   * scene's `cleanup(ctx)` completes during the cleanup phase, in the
   * same reverse-mount order. The scene loader wires this so the runtime
   * stops the audio group a scene scoped to itself (`group: <sceneId>`)
   * when that scene's `cleanup` runs — runtime-guaranteed per-scene
   * audio teardown rather than author discipline. The resolver itself
   * does not interpret the id; it just forwards it. A throw from the
   * hook is treated like a cleanup failure (collected, not swallowed).
   */
  readonly onSceneCleaned?: (sceneId: string) => void;
  /**
   * Per-scene failure sink (PUL-F029 / ADR-028). Invoked once per
   * isolated lifecycle failure with structured `{ phase, sceneId,
   * entryIndex, message, cause }`. When supplied the resolver isolates
   * failures mid-flight and completes the composition for the
   * surviving scenes; when omitted it still isolates but rejects at
   * the end with an `AggregateError` carrying every scene failure
   * (plus any `onSceneCleaned` hook errors) so direct callers don't
   * lose the signal.
   *
   * A throw from the callback itself is NOT propagated — it would
   * otherwise let a buggy diagnostic sink interrupt cleanup-then-
   * continue isolation for surviving scenes. The throw is treated
   * like an `onSceneCleaned` hook error (a workbench bug, not a
   * scene failure): collected and aggregated into the resolver's
   * final `AggregateError` (under the `cleanup hook(s) threw`
   * envelope) so it surfaces to operators, but lifecycle work keeps
   * going. The callback's `cause` field is programmatic only; never
   * serialize it to a public diagnostic surface (per ADR-028: no raw
   * causes, stacks, scene objects, DOM, captions, headers, cookies,
   * env, auth values).
   */
  readonly onSceneFailed?: (event: SceneFailureEvent) => void;
}

/**
 * Render a kebab id (scene id, manifest entry id, etc.) for inclusion
 * in a diagnostic message — one place to change the quoting style.
 */
const quoteId = (id: string): string => `"${id}"`;

/**
 * One entry of the resolver's internal execution plan. Built once at
 * preflight time so the resolver is immune to caller-owned manifest
 * mutations performed inside lifecycle callbacks.
 */
interface PlanStep {
  readonly scene: SceneModule;
  readonly range: SubRange | undefined;
  readonly behavior: BehaviorOverride | undefined;
  /**
   * Position of the entry in the manifest the resolver was handed
   * (PUL-F029 / ADR-028 diagnostic contract — see
   * {@link SceneFailureEvent.entryIndex}).
   */
  readonly entryIndex: number;
}

/**
 * Build the resolver's wrapping `Error`. Every public failure carries
 * the `composition resolution failed:` prefix so callers can pattern-
 * match on origin without parsing scene-specific detail.
 */
const fail = (detail: string, cause: unknown): Error =>
  new Error(`composition resolution failed: ${detail}`, { cause });

/**
 * Build the resolver's wrapping `AggregateError` for a combined
 * lifecycle + cleanup failure (or multiple cleanup failures). The
 * `errors` array preserves the phase error (first) and the cleanup
 * errors (in order) programmatically without mutating any of them.
 */
const failAggregate = (detail: string, errors: readonly unknown[]): AggregateError =>
  new AggregateError(errors, `composition resolution failed: ${detail}`);

/**
 * Throws a wrapped abort error if the optional signal is currently
 * aborted; otherwise returns. The function wrapper defeats TypeScript's
 * control-flow narrowing across the resolver's mount checkpoints — the
 * `aborted` getter can flip between checkpoints, so the runtime check
 * must run even when TS thinks a later one is unreachable.
 */
function throwIfAborted(signal: AbortSignal | undefined, detail: string): void {
  if (signal?.aborted === true) {
    throw fail(detail, signal.reason);
  }
}

/**
 * Clause (a) plus snapshot capture: walk every entry exactly once,
 * resolve every scene id against the registry, snapshot per-entry
 * `range` / `behavior` overrides, and aggregate ALL missing ids into
 * one error before any side effect (friendlier than fail-on-first — a
 * manifest author fixes every typo in one pass).
 */
function buildPlan(manifest: CompositionManifest, registry: SceneRegistry): readonly PlanStep[] {
  const missing = findUnregisteredEntries(manifest, (id) => registry.has(id));
  if (missing.length > 0) {
    const list = missing.map(({ id, index }) => `${quoteId(id)} (entry [${index}])`).join(', ');
    throw fail(`unknown scene id(s): ${list} — not registered`, undefined);
  }
  // ADR-025: the mount-all lifecycle activates every entry concurrently
  // (every scene's DOM coexists while the master plays), so two entries
  // with the same scene id would share one activation context — the
  // second `create(ctx)` would clobber the first's DOM / listeners and
  // `cleanup(ctx)` could not tell which occurrence it owns. Per-entry
  // activation contexts (a container / occurrence handle threaded
  // through create / timeline / cleanup) are a follow-up; until then a
  // composition slice may not repeat a scene id. Single-scene workbench
  // modes truncate the slice to the head before the resolver sees it,
  // so a `[x, x]` composition is still navigable under those modes.
  const occurrences = new Map<string, number[]>();
  for (const [index, entry] of manifest.entries()) {
    const id = entryId(entry);
    const at = occurrences.get(id);
    if (at === undefined) occurrences.set(id, [index]);
    else at.push(index);
  }
  for (const [id, indices] of occurrences) {
    if (indices.length > 1) {
      const entryList = indices.map((i) => `[${i}]`).join(', ');
      throw fail(
        `composition references scene id ${quoteId(id)} more than once (entries ${entryList}) — repeated scene ids in a composition slice are not yet supported: each occurrence would share one activation context (DOM, listeners, timeline targets, cleanup ownership)`,
        undefined,
      );
    }
  }
  const plan: PlanStep[] = [];
  for (const [entryIndex, entry] of manifest.entries()) {
    const scene = registry.get(entryId(entry));
    const range = typeof entry === 'string' ? undefined : entry.range;
    const behavior = typeof entry === 'string' ? undefined : entry.behavior;
    plan.push({ scene, range, behavior, entryIndex });
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
 * Build a {@link SceneFailureEvent} and an `Error` wrapper for one
 * isolated scene-lifecycle failure (PUL-F029 / ADR-028). The wrapper
 * preserves the existing `composition resolution failed:` envelope so
 * the legacy-throwing fallback path (no `onSceneFailed` supplied)
 * yields the same Error.message + Error.cause shape callers expect.
 */
function buildSceneFailure(
  phase: SceneFailurePhase,
  step: PlanStep,
  cause: unknown,
  detail: string,
): { event: SceneFailureEvent; wrapper: Error } {
  const event: SceneFailureEvent = {
    phase,
    sceneId: step.scene.id,
    entryIndex: step.entryIndex,
    message: describeError(cause),
    cause,
  };
  return { event, wrapper: fail(detail, cause) };
}

/**
 * Failure / hook-error buckets the lifecycle helpers append into. One
 * record passed by reference instead of five separate arrays keeps the
 * helper signatures readable.
 *
 *  - `sceneFailures` / `sceneFailureErrors` — scene lifecycle failures
 *    (PUL-F029 / ADR-028). Surfaced through `onSceneFailed` when wired;
 *    aggregated into the resolver's `AggregateError` fallback when not.
 *  - `hookErrors` — workbench-supplied `onSceneCleaned` throws. Per the
 *    option contract these are NOT scene failures (the scene's cleanup
 *    succeeded; the workbench's audio-teardown hook is what threw), so
 *    they bypass `onSceneFailed` and ALWAYS aggregate into the
 *    resolver's throw — independent of whether `onSceneFailed` was
 *    supplied. Without that distinction a workbench hook bug becomes
 *    silently swallowed under PUL-F029.
 */
interface FailureBucket {
  readonly sceneFailures: SceneFailureEvent[];
  readonly sceneFailureErrors: Error[];
  readonly hookErrors: Error[];
}

/**
 * Shared lifecycle plumbing the mount / compose / cleanup helpers all
 * thread through. One struct avoids each helper carrying 6–8 separate
 * positional parameters (Sonar S107) and keeps the bucket + observer
 * wiring identical across phases.
 */
interface LifecycleContext {
  readonly ctx: unknown;
  readonly signal: AbortSignal | undefined;
  readonly onSceneCleaned: ((sceneId: string) => void) | undefined;
  readonly onSceneFailed: ((event: SceneFailureEvent) => void) | undefined;
  readonly bucket: FailureBucket;
}

/**
 * Invoke `onSceneFailed` defensively. A throw from the caller-supplied
 * diagnostic sink MUST NOT interrupt the resolver's cleanup-then-
 * continue invariant (codex review, cycle 2): if it did, a buggy
 * logger could break mandatory cleanup for surviving scenes, mask the
 * original phase error in the catch path, or strand resources. The
 * sink throw is collected in `bucket.hookErrors` so it surfaces
 * through the resolver's final aggregate just like an `onSceneCleaned`
 * hook throw — same "workbench bug, not a scene failure" contract.
 */
function notifyFailure(
  onSceneFailed: ((event: SceneFailureEvent) => void) | undefined,
  event: SceneFailureEvent,
  bucket: FailureBucket,
): void {
  if (onSceneFailed === undefined) return;
  try {
    onSceneFailed(event);
  } catch (err) {
    bucket.hookErrors.push(
      fail(`scene ${quoteId(event.sceneId)} onSceneFailed threw: ${describeError(err)}`, err),
    );
  }
}

/**
 * Run one scene's `cleanup(ctx)` AND its post-cleanup hook
 * (`onSceneCleaned`). Used by BOTH the eager-cleanup branches in
 * `mountPlan` / `composeSegments` (PUL-F029 isolation) AND the final
 * cleanup loop. Centralising the call sequence means the workbench-
 * supplied `onSceneCleaned` hook (PUL-F024 / ADR-004 — the audio
 * group teardown hook) runs exactly once per scene cleanup, regardless
 * of whether that cleanup happened eagerly after a `create` / `timeline`
 * throw or at the end of the lifecycle. Without that, a failed scene's
 * audio group would keep playing while the surviving composition
 * continues — a real production observability gap (codex review,
 * cycle 1).
 *
 * Scene cleanup failures route to `bucket.sceneFailures` /
 * `sceneFailureErrors` + `onSceneFailed`. Hook (`onSceneCleaned`)
 * failures route to `bucket.hookErrors` only; per the option's
 * contract, a hook throw is a workbench bug, not a scene failure.
 */
async function cleanOneScene(step: PlanStep, lc: LifecycleContext): Promise<void> {
  try {
    await step.scene.cleanup(lc.ctx);
  } catch (error_) {
    const { event, wrapper } = buildSceneFailure(
      'cleanup',
      step,
      error_,
      `scene ${quoteId(step.scene.id)} cleanup threw: ${describeError(error_)}`,
    );
    lc.bucket.sceneFailures.push(event);
    lc.bucket.sceneFailureErrors.push(wrapper);
    notifyFailure(lc.onSceneFailed, event, lc.bucket);
  }
  try {
    lc.onSceneCleaned?.(step.scene.id);
  } catch (err) {
    lc.bucket.hookErrors.push(
      fail(`scene ${quoteId(step.scene.id)} onSceneCleaned threw: ${describeError(err)}`, err),
    );
  }
}

/**
 * Mount the planned scenes one by one (clauses b + c with the PUL-F029
 * / ADR-028 isolation rule). A throwing `create(ctx)` is recorded as a
 * scene failure, the failing scene's `cleanup(ctx)` runs immediately
 * (so DOM / listeners / partial state don't leak), the scene is
 * dropped from the `mounted` list for the rest of the lifecycle, and
 * the mount loop continues with the next scene. Preload errors,
 * signal aborts, and the pre-start abort still throw out — those keep
 * their composition-wide semantics per ADR-028's non-goals.
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
      await step.scene.create(lc.ctx);
    } catch (cause) {
      const { event, wrapper } = buildSceneFailure(
        'create',
        step,
        cause,
        `scene ${quoteId(step.scene.id)} create threw: ${describeError(cause)}`,
      );
      lc.bucket.sceneFailures.push(event);
      lc.bucket.sceneFailureErrors.push(wrapper);
      notifyFailure(lc.onSceneFailed, event, lc.bucket);
      // PUL-F029: run the failing scene's cleanup eagerly through the
      // SAME helper as the final cleanup loop, so the per-scene
      // `onSceneCleaned` hook (PUL-F024 / ADR-004 audio-group
      // teardown) fires for the failed scene too — otherwise a scene
      // that played grouped audio in `create` before throwing would
      // leak that group while the surviving composition continues.
      // Then drop the scene from `mounted` so the final cleanup phase
      // doesn't double-clean.
      await cleanOneScene(step, lc);
      mounted.pop();
      // Codex review cycle 2: re-check the abort signal after the
      // awaited eager cleanup. Without this, a navigation aborted
      // during the failed scene's cleanup would still kick off the
      // next scene's preload + create — exactly the
      // cleanup-before-handoff regression the loader guards against.
      throwIfAborted(lc.signal, `aborted after isolating ${quoteId(step.scene.id)} create failure`);
      // Continue to the next scene — the active composition keeps
      // going (PUL-F029 SHALL NOT halt the active composition).
      continue;
    }
    throwIfAborted(lc.signal, `aborted after mounting ${quoteId(step.scene.id)}`);
  }
}

/**
 * Collect each mounted scene's `timeline(ctx)` value into a segment list
 * (in mount order), carrying the per-entry `range` / `behavior`
 * overrides through to the adapter unchanged. `timeline(ctx)` is NOT
 * awaited — see {@link SceneTimelineSegment.timeline}. A throwing
 * `timeline(ctx)` factory isolates that scene (PUL-F029 / ADR-028):
 * the scene's cleanup runs eagerly, the scene is dropped from
 * `mounted`, and no segment is contributed; surviving scenes still
 * produce segments and the adapter plays the master with whatever the
 * composition produced. Mutates `mounted` in place to remove cleaned
 * scenes so the final cleanup loop doesn't double-clean.
 */
async function composeSegments(
  mounted: PlanStep[],
  lc: LifecycleContext,
): Promise<SceneTimelineSegment[]> {
  const segments: SceneTimelineSegment[] = [];
  // Snapshot up-front: the loop body removes failed scenes from
  // `mounted` and a live iteration would skip the entry after the
  // splice. Sonar's "unnecessary `[...mounted]`" hint (S7747) is
  // wrong here — the mutation is the whole point.
  const snapshot = Array.from(mounted);
  for (const step of snapshot) {
    let timeline: unknown;
    try {
      timeline = step.scene.timeline(lc.ctx);
    } catch (cause) {
      const { event, wrapper } = buildSceneFailure(
        'timeline',
        step,
        cause,
        `scene ${quoteId(step.scene.id)} timeline threw: ${describeError(cause)}`,
      );
      lc.bucket.sceneFailures.push(event);
      lc.bucket.sceneFailureErrors.push(wrapper);
      notifyFailure(lc.onSceneFailed, event, lc.bucket);
      // PUL-F029: run cleanup eagerly through the same helper so the
      // `onSceneCleaned` hook fires for the failed scene too (audio
      // teardown), then drop from `mounted` so the final cleanup
      // phase doesn't see this scene again.
      await cleanOneScene(step, lc);
      const at = mounted.indexOf(step);
      if (at !== -1) mounted.splice(at, 1);
      // Codex review cycle 2: re-check the abort signal after the
      // awaited eager cleanup so we don't call `timeline(ctx)` on
      // surviving scenes for a navigation that's already been
      // superseded.
      throwIfAborted(
        lc.signal,
        `aborted after isolating ${quoteId(step.scene.id)} timeline failure`,
      );
      continue;
    }
    const segment: { -readonly [K in keyof SceneTimelineSegment]: SceneTimelineSegment[K] } = {
      id: step.scene.id,
      timeline,
    };
    if (step.range !== undefined) segment.range = step.range;
    if (step.behavior !== undefined) segment.behavior = step.behavior;
    segments.push(segment);
  }
  return segments;
}

/**
 * Tear down every mounted scene via `cleanup(ctx)`, in reverse mount
 * order (last in, first out — symmetric with the mount phase). Each
 * scene's cleanup runs even if a previous one threw; the wrapped thrown
 * values are collected and returned (the caller decides whether to
 * re-raise them). `onSceneCleaned` (PUL-F024 / ADR-004 — the audio
 * group teardown hook) runs after each scene's `cleanup(ctx)`; a throw
 * from it is collected like a cleanup failure. Never throws.
 */
async function cleanupAll(mounted: readonly PlanStep[], lc: LifecycleContext): Promise<void> {
  // Reverse-iterate via index rather than `[...mounted].reverse()` —
  // avoids the spread + mutating copy when the caller only needs the
  // visit order.
  for (let i = mounted.length - 1; i >= 0; i -= 1) {
    const step = mounted[i];
    if (step === undefined) continue;
    await cleanOneScene(step, lc);
  }
}

/**
 * Compute the tail of errors that should aggregate into the resolver's
 * final throw, given the `onSceneFailed` wiring. Scene lifecycle
 * failures are dropped when the callback fanned them out; hook errors
 * (`onSceneCleaned` workbench throws) always aggregate (Sonar S3776
 * pulled this out of `resolveComposition` to keep it under cognitive-
 * complexity 15).
 */
function residualTail(
  bucket: FailureBucket,
  onSceneFailed: ((event: SceneFailureEvent) => void) | undefined,
): readonly Error[] {
  const scene = onSceneFailed === undefined ? bucket.sceneFailureErrors : [];
  return [...scene, ...bucket.hookErrors];
}

/**
 * Build the human-readable summary that prefixes the resolver's final
 * `AggregateError` on the happy path. The hand-rolled cases pick the
 * historical "cleanup hook(s) threw" / "scene failure(s)" wording the
 * pre-PUL-F029 tests pattern-match on. Sonar S3358 pulled this out of
 * `resolveComposition` to flatten the nested ternary.
 */
function happyPathAggregateDetail(sceneCount: number, hookCount: number): string {
  if (sceneCount === 0) return `composition completed but ${hookCount} cleanup hook(s) threw`;
  if (hookCount === 0) return `composition completed with ${sceneCount} scene failure(s)`;
  return `composition completed with ${sceneCount} scene failure(s) and ${hookCount} cleanup hook(s) threw`;
}

/**
 * Build the {@link CompositionTimelineRunOptions} the resolver forwards
 * to the adapter, omitting absent keys (so an adapter that branches on
 * `'<key>' in opts` sees absent rather than `undefined`).
 */
function buildRunOptions(options: ResolveCompositionOptions): CompositionTimelineRunOptions {
  const opts: {
    -readonly [K in keyof CompositionTimelineRunOptions]: CompositionTimelineRunOptions[K];
  } = {};
  if (options.signal !== undefined) opts.signal = options.signal;
  if (options.headBeat !== undefined) {
    opts.headBeat = options.headBeat;
    if (options.onBeatMissing !== undefined) opts.onBeatMissing = options.onBeatMissing;
  }
  if (options.headRepeat !== undefined) opts.headRepeat = options.headRepeat;
  if (options.headHold !== undefined) opts.headHold = options.headHold;
  if (options.headCueGate !== undefined) opts.headCueGate = options.headCueGate;
  if (options.headScreenshot !== undefined) opts.headScreenshot = options.headScreenshot;
  if (options.presenter !== undefined) {
    opts.presenter = options.presenter;
    if (options.onPresenterError !== undefined) opts.onPresenterError = options.onPresenterError;
  }
  return opts;
}

/**
 * Resolves and plays `manifest` against `registry` using the lifecycle
 * in the module header (mount-all → compose-master → play → cleanup-all,
 * ADR-025).
 *
 * Failure semantics (PUL-F029 / ADR-028):
 *  - A failing `create(ctx)` / `timeline(ctx)` / `cleanup(ctx)` is a
 *    per-scene lifecycle failure. The resolver isolates the failing
 *    scene (runs its `cleanup(ctx)` eagerly when the failure is in
 *    `create` or `timeline`, drops it from the segment list, and
 *    continues the active composition with the remaining scenes).
 *    Each failure surfaces through {@link ResolveCompositionOptions.onSceneFailed}
 *    when supplied; when omitted the failures still isolate but
 *    aggregate into the resolver's `AggregateError` at the end of the
 *    lifecycle so direct callers don't lose the signal.
 *  - A failing preload / signal-aborted checkpoint / manifest /
 *    registry-miss / timeline-adapter `run` rejection is a
 *    composition-wide failure (NOT per-scene). The resolver tears
 *    every still-mounted scene down (reverse order), then re-raises
 *    the original error wrapped with the `composition resolution
 *    failed:` prefix and the original as `Error.cause`.
 *  - When the phase failure AND one or more cleanup hooks throw, the
 *    wrapping error is an `AggregateError` whose `errors` array carries
 *    the phase error first then the cleanup errors in order. Nothing is
 *    mutated; everything is programmatically recoverable.
 *  - A navigation abort during master playback makes the adapter's `run`
 *    resolve (not throw); the resolver then tears every scene down and
 *    re-raises an `aborted during composition playback` error so the
 *    loader's pure-abort suppression applies.
 *  - The happy path tears every scene down and resolves. When
 *    `onSceneFailed` is wired the resolver returns normally even if
 *    some scenes failed (they were already fanned out through the
 *    callback). When the callback is NOT wired, any scene cleanup
 *    failure aggregates with the scene's already-isolated lifecycle
 *    failures into an `AggregateError`. `onSceneCleaned` hook throws
 *    (workbench bugs — not scene failures) ALWAYS aggregate
 *    regardless of `onSceneFailed`.
 */
export async function resolveComposition(options: ResolveCompositionOptions): Promise<void> {
  const { registry, manifest, preloadAssets, timeline, signal } = options;

  // PUL-F011 / ADR-015: a `headBeat` without an `onBeatMissing` would
  // silently lose the missing-label diagnostic the adapter is
  // contracted to surface — fail fast at the boundary, with the
  // documented `composition resolution failed:` envelope.
  if (options.headBeat !== undefined && options.onBeatMissing === undefined) {
    throw fail(
      '"onBeatMissing" is required when "headBeat" is supplied — a beat without a diagnostic surface would silently lose missing-label errors',
      undefined,
    );
  }

  assertCompositionManifest(manifest);
  const plan = buildPlan(manifest, registry);

  // Pre-start abort: nothing was touched, so this needs no cleanup.
  throwIfAborted(signal, 'aborted before the composition started');

  // PUL-F029 / ADR-028: per-scene failures and `onSceneCleaned` hook
  // throws collect into one bucket. Scene lifecycle failures fan out
  // through `onSceneFailed` when wired (and aggregate into the
  // resolver's throw when not). Hook errors ALWAYS aggregate — per the
  // option's contract a hook throw is "treated like a cleanup failure
  // (collected, not swallowed)."
  const lc: LifecycleContext = {
    ctx: options.ctx,
    signal,
    onSceneCleaned: options.onSceneCleaned,
    onSceneFailed: options.onSceneFailed,
    bucket: { sceneFailures: [], sceneFailureErrors: [], hookErrors: [] },
  };

  // Scenes mounted so far — the cleanup list for the final cleanup
  // phase. `mountPlan` / `composeSegments` remove eagerly-cleaned
  // scenes from this list so cleanup never runs twice. Passed as an
  // out-parameter so a preload-or-abort throw still leaves the partial
  // mount list visible to the catch handler below.
  const mounted: PlanStep[] = [];
  try {
    await mountPlan(plan, preloadAssets, lc, mounted);
    const segments = await composeSegments(mounted, lc);
    try {
      await timeline.run(segments, buildRunOptions(options));
    } catch (cause) {
      throw fail(`composition timeline failed: ${describeError(cause)}`, cause);
    }
  } catch (phaseError) {
    await cleanupAll(mounted, lc);
    return finalizeCompositionWideFailure(phaseError, lc);
  }

  await cleanupAll(mounted, lc);
  if (signal?.aborted === true) {
    return finalizeAbortedPlayback(signal, lc);
  }
  return finalizeHappyPath(lc);
}

/**
 * Re-raise a composition-wide failure (preload / abort / manifest /
 * registry / adapter `run` rejection) after the mandatory cleanup
 * phase ran. PUL-F029: when `onSceneFailed` is wired, scene lifecycle
 * failures already fanned out through the callback, so they do NOT
 * re-aggregate here (that would route the loader into its fatal
 * navigation-error surface for events PUL-F029 says must isolate).
 * Hook errors still aggregate. Hoisted out of `resolveComposition` to
 * keep the latter under Sonar's cognitive-complexity budget (S3776).
 */
function finalizeCompositionWideFailure(phaseError: unknown, lc: LifecycleContext): never {
  const tail = residualTail(lc.bucket, lc.onSceneFailed);
  if (tail.length > 0) {
    throw failAggregate(
      `composition aborted with ${tail.length} additional failure(s) after: ${describeError(phaseError)}`,
      [phaseError, ...tail],
    );
  }
  throw phaseError;
}

/**
 * Re-raise the post-playback abort wrapper after the cleanup phase
 * ran. Same scene-failure / hook-error policy as
 * {@link finalizeCompositionWideFailure}, with the historical
 * "cleanup failure(s)" wording preserved when the aggregate is
 * scene-cleanup-only (pre-PUL-F029 tests pattern-match on it).
 */
function finalizeAbortedPlayback(signal: AbortSignal, lc: LifecycleContext): never {
  const tail = residualTail(lc.bucket, lc.onSceneFailed);
  if (tail.length > 0) {
    const sceneCount = lc.onSceneFailed === undefined ? lc.bucket.sceneFailureErrors.length : 0;
    const hookCount = lc.bucket.hookErrors.length;
    const detail =
      hookCount === 0
        ? `composition aborted during playback with ${sceneCount} cleanup failure(s)`
        : `composition aborted during playback with ${tail.length} additional failure(s)`;
    throw failAggregate(detail, [
      fail('aborted during composition playback', signal.reason),
      ...tail,
    ]);
  }
  throw fail('aborted during composition playback', signal.reason);
}

/**
 * Happy-path finalizer: when no `onSceneFailed` was wired, surface every
 * isolated scene failure (mount / compose / cleanup) PLUS any hook
 * errors as one `AggregateError` so the caller doesn't lose
 * information. When the callback IS wired, the resolver has already
 * fanned out every per-scene failure inline; only hook errors
 * aggregate (workbench-contract violations PUL-F029 does not subsume).
 */
function finalizeHappyPath(lc: LifecycleContext): void {
  const sceneFailuresForAggregate =
    lc.onSceneFailed === undefined ? lc.bucket.sceneFailureErrors : [];
  const aggregate = [...sceneFailuresForAggregate, ...lc.bucket.hookErrors];
  if (aggregate.length === 0) return;
  throw failAggregate(
    happyPathAggregateDetail(sceneFailuresForAggregate.length, lc.bucket.hookErrors.length),
    aggregate,
  );
}
