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
  /**
   * URL beat label (PUL-F011) the runner SHOULD seek to before
   * playing the timeline. Only present on the run input for the FIRST
   * scene of the resolved composition slice — subsequent scenes never
   * receive `beat` because ADR-015 scopes URL beat to the active head
   * scene only. Absent when the navigation target had no `beat=`
   * parameter. Label-existence checking is the runner's responsibility
   * (the resolver does not parse the timeline value).
   */
  readonly beat?: string;
  /**
   * Non-fatal callback the runner SHOULD invoke when {@link beat} is
   * supplied but the named label does not exist in the timeline
   * (PUL-F011 / ADR-015).
   *
   * On invocation, the runner MUST NOT throw, reject, or otherwise
   * signal a lifecycle failure (the resolver would treat that as a
   * fatal scene error and unmount via cleanup). The runner MUST also
   * NOT seek to the requested label — there is no such label. The
   * scene's playback position MUST be the timeline's start (PUL-F011's
   * "scene's first beat"). Whether the runner then plays the timeline
   * forward from that start, holds parked, or hands control to a
   * presenter is the runner's contract with its callers — the
   * requirement only mandates the position, not the post-position
   * behavior.
   *
   * Paired with {@link beat}: only present on the head scene's run
   * input, and only when the caller supplied `onBeatMissing` on
   * {@link ResolveCompositionOptions}.
   */
  readonly onBeatMissing?: () => void;
  /**
   * Repeat hint for the head scene's timeline (PUL-F015 / ADR-018).
   * When `'until-aborted'`, the runner SHOULD restart the timeline on
   * completion and continue restarting until the navigation aborts or
   * disposes (e.g. a future GSAP runner uses `timeline.repeat(-1)`).
   *
   * Only present on the run input for the FIRST scene of the resolved
   * composition slice — subsequent scenes never receive `repeat`
   * because a head whose timeline never naturally completes cannot
   * advance to following entries. Absent when the navigation target
   * had no `mode=loop` parameter.
   *
   * Discriminated by literal type so future repeat semantics (e.g. a
   * fixed-iteration variant) can extend the union without breaking
   * existing runners — a runner that ignores the field, or that only
   * recognizes `'until-aborted'`, gracefully degrades to no-repeat
   * behavior. The resolver does not interpret the value.
   */
  readonly repeat?: 'until-aborted';
  /**
   * Hold hint for the head scene's timeline (PUL-F016 / ADR-019). When
   * `'first-frame'`, the runner SHOULD render the addressed scene's
   * timeline at time `0` and hold it there without advancing (e.g. a
   * future GSAP runner calls `timeline.pause()` after seeking to time
   * 0). The mount/preload/`create(ctx)`/`timeline(ctx)` flow runs
   * normally; only timeline progression is suppressed.
   *
   * Only present on the run input for the FIRST scene of the resolved
   * composition slice — subsequent scenes never receive `hold`
   * because a head whose timeline never advances cannot reach the
   * following entries. Absent when the navigation target had no
   * `mode=paused` parameter.
   *
   * Discriminated by literal type so future hold semantics (e.g. a
   * specific-frame variant for screenshot determinism) can extend
   * the union without breaking existing runners — a runner that
   * ignores the field, or that only recognizes `'first-frame'`,
   * gracefully degrades to no-hold behavior. The resolver does not
   * interpret the value.
   *
   * `hold` and `repeat` are independent fields on the runner input;
   * the URL grammar makes their parent modes (`paused` and `loop`)
   * mutually exclusive (mode is a single field), but a programmatic
   * caller could supply both, and the runner's policy decides which
   * wins. ADR-019 records the runner-side preference: `hold` wins
   * over `repeat` when both are set, because a paused timeline never
   * completes for the repeat to fire on.
   */
  readonly hold?: 'first-frame';
  /**
   * Cue-gate hint for the head scene's timeline (PUL-F017 / ADR-020).
   * When `'monotonic-forward'`:
   *
   * - A runner that schedules audio cues MUST fire each cue only on
   *   monotonic forward crossings of its trigger time. Backwards
   *   scrub, jump-to-beat, hydration, and direct seek MUST NOT
   *   produce cue-fire events. This is the runner-side enforcement
   *   of PUL-F017's "audio cues SHALL fire only on monotonic
   *   forward playback" SHALL — the runtime-level SHALL is
   *   delivered by combining loader mode dispatch (`cueGate` set on
   *   the head's run input under `mode=scrub`) + runner conformance
   *   (this field's MUST).
   * - A runner that does NOT have an audio-cue subsystem (e.g., the
   *   placeholder timeline runner today; a future Node-side test
   *   harness that never schedules audio) has no cues to gate and
   *   trivially satisfies the gate. The placeholder runner's
   *   "ignore the field" behavior is correct because there are no
   *   cues to suppress.
   *
   * The hint also signals scrub-mode is active; the future
   * scrub-controls UI surface drives the timeline's playhead through
   * the runner's transport API while the runner consults
   * `input.cueGate` to decide whether each cue's time crossing
   * counts as monotonic-forward.
   *
   * Only present on the run input for the FIRST scene of the resolved
   * composition slice — subsequent scenes never receive `cueGate`
   * because under scrub the slice is truncated upstream and the
   * head's interactive timeline never hands off to following
   * entries. Absent when the navigation target had no `mode=scrub`
   * parameter.
   *
   * Discriminated by literal type so future cue-gating semantics
   * (e.g. an `'all-suppressed'` variant for deterministic frame
   * capture under `mode=screenshot`) can extend the union without
   * breaking audio-capable runners that only recognize the existing
   * variant. A runner that recognizes a future variant it does not
   * understand SHOULD log a warning and fall back to its strictest
   * known gating policy (rather than silently dropping the gate).
   * The resolver does not interpret the value.
   *
   * `cueGate`, `repeat`, and `hold` are independent fields on the
   * runner input; the URL grammar makes their parent modes
   * (`scrub`, `loop`, `paused`) mutually exclusive (mode is a single
   * field), but a programmatic caller could supply more than one
   * and the runner's policy decides which wins.
   */
  readonly cueGate?: 'monotonic-forward';
  /**
   * Screenshot capture-bundle hint for the head scene's timeline
   * (PUL-F018 / ADR-021). When `'capture'`, the runner MUST render
   * the addressed scene at the addressed frame — `input.beat` if
   * present, else frame 0 — and HOLD there (no animation in
   * progress); the runner MUST also suppress all audio output it
   * controls. These are the runner-side axes of PUL-F018's bundle:
   * frame freeze at beat-or-zero, no animation, audio suppression
   * via the runner's audio adapter (e.g. ADR-004's future Howler
   * integration). Both are runner-input concerns because they
   * happen on or after the runner sees this bundle.
   *
   * Scene-side concerns — specifically PUL-F018's "any randomness
   * sourced from a deterministic seed" clause — are NOT delivered
   * through this field. Scene `create(ctx)` and `timeline(ctx)`
   * run BEFORE the runner ever sees `input.screenshot`, so a flag
   * on the runner input cannot gate randomness consumed during
   * those phases. Scene-side determinism flows through the
   * existing PUL-F012 / ADR-007 `ctx.mode === 'screenshot'` seam
   * (available from `create(ctx)` forward) plus a future
   * deterministic-seed surface on `ctx` (e.g. `ctx.seed`) the
   * scene reads. The runner-input `behavior` field is NOT this
   * surface — `behavior` is a per-entry manifest override
   * (ADR-002 / ADR-011) consumed by the runner at timeline
   * execution time, not by `create(ctx)`. ADR-021 records the
   * split.
   *
   * Only present on the run input for the FIRST scene of the
   * resolved composition slice — subsequent scenes never receive
   * `screenshot` because under screenshot the slice is truncated
   * upstream and the captured frame belongs to one scene. Absent
   * when the navigation target had no `mode=screenshot` parameter.
   *
   * Discriminated by literal type so future capture semantics (e.g.
   * `'capture-still'` vs a future multi-frame variant) can extend
   * the union without breaking existing runners — a runner that
   * ignores the field, or that only recognizes `'capture'`,
   * gracefully degrades to no-capture behavior. The placeholder
   * timeline runner (which has no real timeline and no audio
   * engine) ignores the field today and vacuously satisfies the
   * runner-side axes because none of the affected subsystems are
   * wired. ADR-003's GSAP runner + ADR-004's Howler integration
   * deliver the active runner-side behavior; scene-side
   * determinism is delivered through `ctx.mode` + a future seed
   * surface. The resolver does not interpret the value.
   *
   * `screenshot`, `beat`, `repeat`, `hold`, and `cueGate` are
   * independent fields on the runner input. The URL grammar makes
   * the parent modes (`screenshot`, `loop`, `paused`, `scrub`)
   * mutually exclusive (mode is a single field), but a programmatic
   * caller could supply more than one and the runner's policy
   * decides which wins. `beat` under `mode=screenshot` IS honored as
   * the addressed-frame anchor (PUL-F018 explicitly calls for "at
   * the addressed beat"), unlike `mode=paused` where ADR-019 records
   * "first frame wins."
   */
  readonly screenshot?: 'capture';
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
  /**
   * URL beat label (PUL-F011) to forward to the FIRST scene's run
   * input as {@link SceneTimelineRunInput.beat}. Subsequent scenes
   * never receive a beat — ADR-015 scopes URL beat to the active head
   * scene only, so a composition slice does not search later scenes
   * for the label. Absent when the navigation target had no `beat=`
   * parameter.
   */
  readonly headBeat?: string;
  /**
   * Non-fatal callback paired with {@link headBeat}. Forwarded to the
   * head scene's run input as {@link SceneTimelineRunInput.onBeatMissing}
   * so the runner can report a missing label without rejecting (which
   * would trigger PUL-F006 cleanup and unmount the scene, violating
   * PUL-F011's "remain at the scene's first beat").
   *
   * REQUIRED whenever {@link headBeat} is supplied: a beat without a
   * diagnostic surface would silently lose the missing-label error
   * the runner reports — the resolver throws when this invariant is
   * violated rather than letting the diagnostic vanish. Absent when
   * {@link headBeat} is also absent.
   */
  readonly onBeatMissing?: () => void;
  /**
   * URL loop-mode repeat hint (PUL-F015 / ADR-018) to forward to the
   * FIRST scene's run input as {@link SceneTimelineRunInput.repeat}.
   * Subsequent scenes never receive a repeat hint — under
   * `mode=loop` the head's timeline never naturally completes, so
   * following composition entries cannot run. Absent when the
   * navigation target had no `mode=loop` parameter.
   *
   * The resolver does not interpret the value — honoring "restart on
   * completion" is the runner's contract per ADR-018. A runner that
   * ignores the field gracefully degrades to no-repeat (a regression
   * the seam tests in `scene-loader.test.ts` pin against the loader
   * boundary, where mode dispatch lives).
   */
  readonly headRepeat?: 'until-aborted';
  /**
   * URL paused-mode hold hint (PUL-F016 / ADR-019) to forward to the
   * FIRST scene's run input as {@link SceneTimelineRunInput.hold}.
   * Subsequent scenes never receive a hold hint — under `mode=paused`
   * the head's timeline never advances, so following composition
   * entries cannot run. Absent when the navigation target had no
   * `mode=paused` parameter.
   *
   * The resolver does not interpret the value — honoring
   * "hold at first frame" is the runner's contract per ADR-019. A
   * runner that ignores the field gracefully degrades to no-hold (a
   * regression the seam tests in `scene-loader.test.ts` pin against
   * the loader boundary, where mode dispatch lives).
   */
  readonly headHold?: 'first-frame';
  /**
   * URL scrub-mode cue-gate hint (PUL-F017 / ADR-020) to forward to
   * the FIRST scene's run input as
   * {@link SceneTimelineRunInput.cueGate}. Subsequent scenes never
   * receive a cue-gate hint — under `mode=scrub` the slice is
   * truncated upstream so the head's interactive timeline does not
   * hand off to following composition entries. Absent when the
   * navigation target had no `mode=scrub` parameter.
   *
   * The resolver does not interpret the value — honoring "audio
   * cues fire only on monotonic forward playback" is the runner's
   * contract per ADR-020. A runner that ignores the field
   * gracefully degrades to no-gating (a regression the seam tests
   * in `scene-loader.test.ts` pin against the loader boundary,
   * where mode dispatch lives).
   */
  readonly headCueGate?: 'monotonic-forward';
  /**
   * URL screenshot-mode capture hint (PUL-F018 / ADR-021) to forward
   * to the FIRST scene's run input as
   * {@link SceneTimelineRunInput.screenshot}. Subsequent scenes
   * never receive a screenshot hint — under `mode=screenshot` the
   * slice is truncated upstream so the captured frame belongs to
   * one scene; following composition entries cannot run because the
   * runtime is rendering a single deterministic frame. Absent when
   * the navigation target had no `mode=screenshot` parameter.
   *
   * The resolver does not interpret the value — honoring the
   * runner-side axes of the capture bundle (frame freeze at
   * beat-or-zero, no animation, all audio suppressed) is the
   * runner's contract per ADR-021. The fourth axis of PUL-F018's
   * statement — "any randomness sourced from a deterministic
   * seed" — is NOT the runner's contract via this field; it
   * flows through the scene-side `ctx.mode === 'screenshot'` seam
   * (PUL-F012 / ADR-007) plus a future scene-side seed surface
   * on `ctx`, because scene `create(ctx)` and `timeline(ctx)`
   * run BEFORE this field reaches the runner. A runner that
   * ignores the field gracefully degrades (the placeholder runner
   * today vacuously satisfies the runner-side axes because none
   * of the affected subsystems exist; ADR-003's GSAP runner +
   * ADR-004's audio engine deliver active runner-side behavior
   * when they land; scene-side determinism is delivered through
   * `ctx`). A regression that gated `headScreenshot` on an
   * unrelated condition is pinned by the seam tests in
   * `scene-loader.test.ts` against the loader boundary, where
   * mode dispatch lives.
   */
  readonly headScreenshot?: 'capture';
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
 * `range` / `behavior` / `beat` / `onBeatMissing` from the output
 * object when absent on the source entry rather than emitting
 * `field: undefined` keys, so the runner's `field in input` checks
 * behave intuitively.
 *
 * `beat` and `onBeatMissing` are caller-supplied per-call (resolver
 * passes them only for the head plan step); the rest are per-entry
 * (resolver derives from the manifest snapshot).
 */
function buildRunInput(
  step: PlanStep,
  timeline: unknown,
  signal: AbortSignal | undefined,
  beat: string | undefined,
  onBeatMissing: (() => void) | undefined,
  repeat: 'until-aborted' | undefined,
  hold: 'first-frame' | undefined,
  cueGate: 'monotonic-forward' | undefined,
  screenshot: 'capture' | undefined,
): SceneTimelineRunInput {
  const input: { -readonly [K in keyof SceneTimelineRunInput]: SceneTimelineRunInput[K] } = {
    scene: step.scene,
    timeline,
  };
  if (step.range !== undefined) input.range = step.range;
  if (step.behavior !== undefined) input.behavior = step.behavior;
  if (signal !== undefined) input.signal = signal;
  if (beat !== undefined) input.beat = beat;
  if (onBeatMissing !== undefined) input.onBeatMissing = onBeatMissing;
  if (repeat !== undefined) input.repeat = repeat;
  if (hold !== undefined) input.hold = hold;
  if (cueGate !== undefined) input.cueGate = cueGate;
  if (screenshot !== undefined) input.screenshot = screenshot;
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
  const {
    registry,
    manifest,
    ctx,
    preloadAssets,
    runTimeline,
    signal,
    headBeat,
    onBeatMissing,
    headRepeat,
    headHold,
    headCueGate,
    headScreenshot,
  } = options;

  // PUL-F011 / ADR-015: a `headBeat` without an `onBeatMissing` would
  // silently lose the missing-label diagnostic the runner is contracted
  // to surface (the runner MUST NOT throw on missing labels; the
  // callback is its only error channel). Failing fast at the boundary
  // is better than running a doomed lifecycle that reports nothing.
  // Routed through the resolver's `fail(...)` helper so the error
  // carries the documented `composition resolution failed:` envelope
  // — callers pattern-matching on origin get the same prefix as
  // every other resolver-level failure.
  if (headBeat !== undefined && onBeatMissing === undefined) {
    throw fail(
      '"onBeatMissing" is required when "headBeat" is supplied — a beat without a diagnostic surface would silently lose missing-label errors',
      undefined,
    );
  }

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
  //
  // PUL-F011: `headBeat` / `onBeatMissing` (when supplied) are forwarded
  // to the FIRST scene's run input only. Subsequent scenes do not
  // receive them — ADR-015 scopes URL beat to the active head scene.
  let lastCompletedSceneId: string | undefined;
  for (const [index, step] of plan.entries()) {
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
    const isHead = index === 0;
    // `onBeatMissing` is paired with `headBeat` per ADR-015. Drop the
    // callback when no beat is supplied — otherwise the runner would
    // see `input.onBeatMissing` with no `input.beat` to trigger it
    // against, an impossible state per the documented contract.
    const stepBeat = isHead ? headBeat : undefined;
    const stepOnBeatMissing = stepBeat === undefined ? undefined : onBeatMissing;
    // `headRepeat` is head-only per ADR-018: under `mode=loop` the
    // head's timeline never naturally completes, so subsequent scenes
    // cannot run. Forwarding repeat to non-head scenes would imply a
    // following entry could itself loop, which contradicts the
    // requirement's "the addressed scene's timeline" scoping.
    const stepRepeat = isHead ? headRepeat : undefined;
    // `headHold` is head-only per ADR-019: under `mode=paused` the
    // head's timeline never advances, so subsequent scenes cannot
    // run. Forwarding hold to non-head scenes would imply a
    // following entry could itself be held at frame 0, which
    // contradicts the requirement's "the addressed scene" scoping.
    const stepHold = isHead ? headHold : undefined;
    // `headCueGate` is head-only per ADR-020: under `mode=scrub` the
    // slice is truncated upstream so the head's interactive timeline
    // does not hand off to following composition entries. Forwarding
    // the cue gate to non-head scenes would imply a following entry
    // could itself run under scrub semantics, which contradicts the
    // requirement's single-timeline-controls scoping.
    const stepCueGate = isHead ? headCueGate : undefined;
    // `headScreenshot` is head-only per ADR-021: under
    // `mode=screenshot` the slice is truncated upstream because the
    // captured frame belongs to one scene. Forwarding the capture
    // hint to non-head scenes would imply a following entry could
    // itself produce a deterministic frame, which contradicts the
    // requirement's single-frame scoping.
    const stepScreenshot = isHead ? headScreenshot : undefined;
    await runScene(
      step,
      ctx,
      runTimeline,
      signal,
      stepBeat,
      stepOnBeatMissing,
      stepRepeat,
      stepHold,
      stepCueGate,
      stepScreenshot,
    );
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
  beat: string | undefined,
  onBeatMissing: (() => void) | undefined,
  repeat: 'until-aborted' | undefined,
  hold: 'first-frame' | undefined,
  cueGate: 'monotonic-forward' | undefined,
  screenshot: 'capture' | undefined,
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
    await runTimeline(
      buildRunInput(step, timeline, signal, beat, onBeatMissing, repeat, hold, cueGate, screenshot),
    );
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
