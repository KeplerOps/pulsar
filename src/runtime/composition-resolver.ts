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
  for (const entry of manifest) {
    const scene = registry.get(entryId(entry));
    const range = typeof entry === 'string' ? undefined : entry.range;
    const behavior = typeof entry === 'string' ? undefined : entry.behavior;
    plan.push({ scene, range, behavior });
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

/** Clause (c): mount one scene via `create(ctx)`. */
async function mountScene(scene: SceneModule, ctx: unknown): Promise<void> {
  try {
    await scene.create(ctx);
  } catch (cause) {
    throw fail(`scene ${quoteId(scene.id)} create threw: ${describeError(cause)}`, cause);
  }
}

/**
 * Collect each mounted scene's `timeline(ctx)` value into a segment list
 * (in mount order), carrying the per-entry `range` / `behavior`
 * overrides through to the adapter unchanged. `timeline(ctx)` is NOT
 * awaited — see {@link SceneTimelineSegment.timeline}. A throwing
 * `timeline(ctx)` factory aborts the composition (every mounted scene
 * is then torn down).
 */
function composeSegments(mounted: readonly PlanStep[], ctx: unknown): SceneTimelineSegment[] {
  return mounted.map((step) => {
    let timeline: unknown;
    try {
      timeline = step.scene.timeline(ctx);
    } catch (cause) {
      throw fail(`scene ${quoteId(step.scene.id)} timeline threw: ${describeError(cause)}`, cause);
    }
    const segment: { -readonly [K in keyof SceneTimelineSegment]: SceneTimelineSegment[K] } = {
      id: step.scene.id,
      timeline,
    };
    if (step.range !== undefined) segment.range = step.range;
    if (step.behavior !== undefined) segment.behavior = step.behavior;
    return segment;
  });
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
async function cleanupAll(
  mounted: readonly PlanStep[],
  ctx: unknown,
  onSceneCleaned?: (sceneId: string) => void,
): Promise<readonly unknown[]> {
  const errors: unknown[] = [];
  for (const step of [...mounted].reverse()) {
    try {
      await step.scene.cleanup(ctx);
    } catch (err) {
      errors.push(
        fail(`scene ${quoteId(step.scene.id)} cleanup threw: ${describeError(err)}`, err),
      );
    }
    try {
      onSceneCleaned?.(step.scene.id);
    } catch (err) {
      errors.push(
        fail(`scene ${quoteId(step.scene.id)} onSceneCleaned threw: ${describeError(err)}`, err),
      );
    }
  }
  return errors;
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
 * Failure semantics:
 *  - A failing preload / `create` / `timeline(ctx)` / timeline-adapter
 *    `run` aborts the composition; every mounted scene is torn down
 *    (reverse order), then the original error is re-raised wrapped with
 *    the `composition resolution failed:` prefix and the original as
 *    `Error.cause`.
 *  - When the phase failure AND one or more cleanup hooks throw, the
 *    wrapping error is an `AggregateError` whose `errors` array carries
 *    the phase error first then the cleanup errors in order. Nothing is
 *    mutated; everything is programmatically recoverable.
 *  - A navigation abort during master playback makes the adapter's `run`
 *    resolve (not throw); the resolver then tears every scene down and
 *    re-raises an `aborted during composition playback` error so the
 *    loader's pure-abort suppression applies.
 *  - The happy path tears every scene down and resolves; a cleanup-only
 *    failure is re-raised as an `AggregateError` of the cleanup errors.
 */
export async function resolveComposition(options: ResolveCompositionOptions): Promise<void> {
  const { registry, manifest, ctx, preloadAssets, timeline, signal } = options;

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

  // Scenes mounted so far (created, or create-attempted) — the cleanup
  // list. Built up during the mount phase; torn down (always) at the
  // end. The old per-scene `runScene` try/catch is replaced by this
  // composition-wide try/catch around the mount + compose + run phases.
  const mounted: PlanStep[] = [];
  try {
    // MOUNT phase. Strictly sequential, manifest order. Abort
    // checkpoints: after each preload (catches a mid-preload abort) and
    // after each create (catches an abort between this scene and the
    // next — the playback abort is handled by the timeline adapter).
    for (const step of plan) {
      await preloadScene(step.scene, preloadAssets);
      throwIfAborted(
        signal,
        `aborted after preloading ${quoteId(step.scene.id)}, before scene activation`,
      );
      // Add to the cleanup list BEFORE `create` so a scene whose
      // `create` partially ran (then threw) is still torn down.
      mounted.push(step);
      await mountScene(step.scene, ctx);
      throwIfAborted(signal, `aborted after mounting ${quoteId(step.scene.id)}`);
    }

    // COMPOSE + RUN phase. Collect every mounted scene's timeline value
    // and hand the slice to the timeline adapter, which composes the
    // master, applies the head hints, plays it, and resolves on the
    // master's natural completion or on abort. The adapter does NOT
    // throw on abort — it resolves; the signal is re-checked below.
    const segments = composeSegments(mounted, ctx);
    try {
      await timeline.run(segments, buildRunOptions(options));
    } catch (cause) {
      throw fail(`composition timeline failed: ${describeError(cause)}`, cause);
    }
  } catch (phaseError) {
    // Mandatory cleanup: tear down every mounted scene (reverse order),
    // then re-raise — aggregating cleanup errors if any.
    const cleanupErrors = await cleanupAll(mounted, ctx, options.onSceneCleaned);
    if (cleanupErrors.length > 0) {
      throw failAggregate(
        `composition aborted with ${cleanupErrors.length} cleanup failure(s) after: ${describeError(phaseError)}`,
        [phaseError, ...cleanupErrors],
      );
    }
    throw phaseError;
  }

  // Happy path, or a navigation abort during master playback (the
  // adapter resolved without throwing). Tear every scene down, then
  // surface an abort error if the signal fired (so the loader's
  // pure-abort suppression applies) or aggregate any cleanup failures.
  const cleanupErrors = await cleanupAll(mounted, ctx, options.onSceneCleaned);
  if (signal?.aborted === true) {
    if (cleanupErrors.length > 0) {
      throw failAggregate(
        `composition aborted during playback with ${cleanupErrors.length} cleanup failure(s)`,
        [fail('aborted during composition playback', signal.reason), ...cleanupErrors],
      );
    }
    throw fail('aborted during composition playback', signal.reason);
  }
  if (cleanupErrors.length > 0) {
    throw failAggregate(
      `composition completed but ${cleanupErrors.length} cleanup hook(s) threw`,
      cleanupErrors,
    );
  }
}
