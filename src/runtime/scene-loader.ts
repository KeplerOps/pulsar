// Scene loader — PUL-F008.
//
// The scene loader subscribes to PUL-F007's `pulsar:navigate` /
// `pulsar:navigate-error` events (or to `subscribeNavigation`
// directly) and drives every parsed `NavigationTarget` through the
// scene-navigation dispatcher (`./scene-navigation.ts`) and the
// composition-resolver lifecycle (`./composition-resolver.ts`).
//
// The loader owns:
//
//  - Stage attribute coordination so reviewers, agents, and
//    screenshot automation can inspect what the runtime navigated
//    to (or what error the dispatcher produced — ADR-013's "no
//    silent fallback").
//  - Lifecycle abort + cleanup-before-handoff so a popstate-triggered
//    re-navigation always runs the previous scene's `cleanup(ctx)`
//    before the next scene's preload begins.
//  - Serialized navigation queue so concurrent navigations don't
//    race on stage attributes or in-flight loads.
//
// The loader does NOT parse URLs (PUL-F007 does that) and does not
// resolve scenes against the registries (`scene-navigation.ts` does
// that). It is a state machine that translates parsed targets into
// lifecycle execution + workbench observability.
//
// References:
//  - PUL-F008 — when `scene` is present, load the addressed scene.
//  - ADR-014 — scene navigation dispatch decisions.
//  - ADR-007 — runtime parses URL parameters at startup AND popstate.
//  - ADR-013 — URL navigation grammar boundary; F007 owns parsing.

import { type AudioEngine, type AudioService, createAudioService, noopAudioEngine } from './audio';
import type { CompositionRegistry } from './composition-registry';
import type { AssetPreloader, CompositionTimelineAdapter } from './composition-resolver';
import { describeError } from './error';
import { KEBAB_IDENTIFIER_FORM, isKebabIdentifier } from './identifier';
import {
  NAVIGATION_MODES,
  type NavigationMode,
  type NavigationTarget,
  effectiveMode,
} from './navigation';
import { type PresenterCommandSource, createPresenterController } from './presenter';
import {
  type PrompterDispose,
  type PrompterRenderer,
  type PrompterScript,
  buildPrompterScript,
} from './prompter';
import type { SceneRegistry } from './registry';
import {
  type SceneNavigationTarget,
  loadSceneNavigationTarget,
  resolveSceneNavigation,
} from './scene-navigation';
import type { TimelineEngine } from './timeline';

/** The minimal subset of an HTMLElement the loader writes to. */
export interface StageElement {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/**
 * The opaque-to-the-resolver scene context the workbench passes to
 * every lifecycle hook. Carries the stage handle so scenes can
 * mutate the DOM through an injected dependency rather than reaching
 * for the global `document`. ADR-008 #2 (manifests over flow control)
 * pushes "explicit dependency" over "ambient global" — passing the
 * stage in `ctx` keeps scenes pure of `document` lookups and
 * Node-test-friendly without `typeof document === 'undefined'` guards.
 *
 * `mode` exposes the effective workbench mode the runtime selected
 * for the current navigation (PUL-F012 / ADR-007). Scenes that need
 * mode-aware behavior — `screenshot` capture-bundle (frame freeze,
 * audio suppression, deterministic seed) per ADR-021, `loop`
 * indefinite repetition — read it here rather than re-implementing
 * mode detection. Per ADR-007 the runtime core is the dispatch
 * point; the field is set per navigation by {@link createSceneLoader}.
 *
 * Per ADR-003 the timeline engine (`gsap`) arrives here; per ADR-004
 * the audio service (`audio`) does too (PUL-F024). The runtime resolver
 * itself never inspects ctx — it is purely a scene-to-environment
 * carrier.
 */
export interface WorkbenchSceneCtx {
  /** The workbench stage element, or `null` when the runtime has no stage. */
  readonly stage: StageElement | null;
  /**
   * The effective workbench mode for the current navigation per
   * PUL-F012 / ADR-007. Set by the loader from
   * {@link effectiveMode}; absent `mode` URL parameter resolves to
   * `'present'`.
   */
  readonly mode: NavigationMode;
  /**
   * The GSAP instance scenes build their timeline with (PUL-F022 /
   * ADR-003). Scenes call `ctx.gsap.timeline()` in `timeline(ctx)`
   * rather than importing GSAP directly, so the timeline engine stays
   * a single swappable dependency of the runtime. The runtime composes
   * the scene timelines into a master timeline (see
   * {@link import('./timeline').composeMasterTimeline}).
   */
  readonly gsap: TimelineEngine['gsap'];
  /**
   * The per-navigation audio service (PUL-F024 / ADR-004). Scenes call
   * `ctx.audio.load(...)` / `play(...)` / `fade(...)` / `stop(...)` /
   * `stopGroup(...)` (and `mute(...)` for master mute) rather than
   * importing Howler or constructing `<audio>`, so the audio engine
   * stays a single swappable runtime dependency and every sound is
   * stopped + unloaded on navigation end. Built by the loader from
   * {@link SceneLoaderOptions.audioEngine}, bound to the navigation's
   * `AbortSignal`, and `silent` under `mode=screenshot` / `mode=paused`
   * (audible playback suppressed — ADR-019 / ADR-021).
   *
   * One service per navigation: under single-scene modes that is the
   * one scene; under `mode=present` it is shared across the whole
   * composition slice (the resolver mounts the slice with one ctx and
   * forbids it repeating a scene id). The sound-id namespace and the
   * source allowlist (the slice's declared `scene.assets`) are therefore
   * slice-scoped — multi-scene compositions pick distinct sound ids, the
   * same stable-identity discipline scene ids obey (ADR-008 #1), and
   * registering an id twice with the same definition is idempotent. A
   * scene scopes a sound to itself with `play(id, { group: <its-scene-id> })`;
   * the loader wires the resolver's per-scene post-`cleanup(ctx)` hook
   * to `stopGroup(sceneId)`, so the runtime (not the author) stops a
   * scene's group when that scene's `cleanup` runs. True per-scene
   * activation contexts (one `ctx.audio` facade per scene entry) are a
   * documented resolver follow-up.
   */
  readonly audio: AudioService;
}

/**
 * Inputs to {@link createSceneLoader}. The loader does not own the
 * registries or the lifecycle adapters; the caller provides them so
 * they stay swappable across browser bootstrap, screenshot tests,
 * and Node-side automation.
 */
export interface SceneLoaderOptions {
  readonly scenes: SceneRegistry;
  readonly compositions: CompositionRegistry;
  /** May be `null` when the workbench has no stage (rare; e.g. Node tests). */
  readonly stage: StageElement | null;
  /**
   * Per-navigation scene context builder. The loader calls this once
   * per navigation that produces a runnable target, passing the
   * effective workbench mode derived from the URL via
   * {@link effectiveMode} (PUL-F012 / ADR-007) and the per-navigation
   * audio service (PUL-F024 / ADR-004) the loader built from
   * {@link audioEngine}. The returned value is forwarded opaquely to
   * every lifecycle hook (`create` / `timeline` / `cleanup`); the
   * resolver never inspects it.
   *
   * Returns {@link WorkbenchSceneCtx} so the production contract
   * "scenes receive `ctx.mode` / `ctx.audio`" is enforced at this
   * boundary rather than relying on a single workbench bootstrap
   * annotation. Mode dispatch lives at this seam per ADR-007 ("Mode is
   * dispatched in the runtime core, not per scene"): the workbench
   * supplies the stage and any other long-lived ctx members through a
   * closure, the loader contributes the per-navigation `mode` and
   * `audio`, and the combined value is what scenes see as `ctx`.
   * Constructing a fresh ctx per navigation also blocks any "previous
   * mode leaks into a `mode`-less URL" regression — every navigation
   * re-derives mode from its own target — and a fresh audio service
   * per navigation makes "audio survives the scene that started it"
   * structurally impossible.
   *
   * Not invoked when the locator is `kind: 'none'` (no scene mounts)
   * or when the navigation event is a parse-error event, because
   * those paths run no lifecycle.
   */
  readonly buildCtx: (mode: NavigationMode, audio: AudioService) => WorkbenchSceneCtx;
  /**
   * The audio engine (PUL-F024 / ADR-004) — a process singleton, like
   * the timeline engine (ADR-003). The loader builds a fresh
   * `createAudioService(audioEngine, ...)` per navigation, scoped to
   * that navigation's `AbortSignal` and threaded into `ctx.audio`, so
   * per-scene audio is stopped + unloaded on supersession / dispose /
   * completion. Optional: a workbench bootstrap that has not wired a
   * real audio backend yet omits it and the loader falls back to
   * {@link import('./audio').noopAudioEngine} (a silent engine —
   * `ctx.audio` still works, it just makes no sound), the same
   * inert-seam pattern {@link renderPrompter} / {@link presenterCommands}
   * follow.
   */
  readonly audioEngine?: AudioEngine;
  /**
   * Build a per-navigation asset preloader bound to that
   * navigation's abort signal. The loader calls this once per
   * navigation, threading the per-load `AbortController.signal`
   * through so back/forward during a long preload aborts the
   * in-flight `fetch` calls instead of waiting for them to finish
   * naturally. Production callers typically wrap PUL-F005's
   * `createAssetPreloader({ init: { signal } })`.
   */
  readonly createPreloader: (signal: AbortSignal) => AssetPreloader;
  /** Timeline composition/playback adapter — see {@link CompositionTimelineAdapter}. */
  readonly timeline: CompositionTimelineAdapter;
  /**
   * Captions/script renderer adapter for `mode=prompter`
   * (PUL-F019 / ADR-022). Receives a {@link import('./prompter').PrompterScript}
   * derived from the addressed navigation target's metadata and the
   * per-navigation `AbortSignal` so a long-running renderer can
   * release resources when superseded by another navigation. The
   * loader awaits the result before considering the prompter
   * dispatch settled (parity with the timeline adapter).
   *
   * **Renderer contract** (see {@link PrompterRenderer}): a renderer
   * that mounts persistent DOM MUST keep its returned promise
   * pending until `signal.aborted` fires AND register its DOM
   * teardown on the abort event. Returning early after mounting DOM
   * would leave stale captions UI on screen with no cleanup path —
   * the loader clears `inFlight` once a load settles, so the next
   * navigation's `enqueue` would not abort anything to drive the
   * cleanup. A trivial / no-DOM renderer (e.g. a test stub) is free
   * to return synchronously because there is nothing to tear down.
   *
   * Optional: a workbench bootstrap that has not yet wired a captions
   * UI omits the field. Under `mode=prompter` the loader still
   * suppresses the resolver lifecycle (no preload, no `create`, no
   * `timeline`, no `cleanup`) because that suppression is the
   * structural defense PUL-F019 / ADR-022 record; the captions data
   * path simply has no consumer until the UI lands. Production
   * bootstrap supplies a concrete renderer when the captions/script
   * UI surface lands.
   */
  readonly renderPrompter?: PrompterRenderer;
  /**
   * Workbench-supplied presenter command source (PUL-F020 / ADR-023;
   * the command set is extended by PUL-F021 / ADR-024 with the
   * `pause` / `resume` kinds — the loader-side dispatch is unchanged).
   * Lives across navigations; the loader does not own or construct
   * it. When supplied AND the per-navigation `effectiveMode(target)`
   * is `'present'`, the loader wraps it in a per-navigation
   * {@link import('./presenter').PresenterController} bound to the
   * navigation's `AbortController.signal` and forwards the controller
   * to the timeline runner via `input.presenter`. Other modes never
   * see the controller — presenter input is scoped to `mode=present`
   * by ADR-007. Per-navigation auto-cleanup means a runner that
   * subscribes via `input.presenter.subscribe(...)` and forgets to
   * unsubscribe cannot leak across navigations.
   *
   * Optional: a workbench bootstrap that has not yet wired a
   * presenter UI omits the field. Under that configuration the
   * loader does not build a controller, runners see
   * `input.presenter === undefined`, and the seam is structurally
   * inert until the workbench wires a real source.
   */
  readonly presenterCommands?: PresenterCommandSource;
  /**
   * Sink for navigation errors (resolution failure, lifecycle phase
   * throw). Defaults to `console.error` in production but is
   * injectable so tests can observe error logging without
   * monkey-patching `console`. Errors are still surfaced to the stage
   * via `data-pulsar-navigation-error` regardless of this hook.
   */
  readonly onError?: (err: unknown) => void;
}

/**
 * Returned by {@link createSceneLoader}. Each call to `handle(target)`
 * cancels any in-flight load, awaits its cleanup, then runs the new
 * target through the lifecycle. `idle()` waits for the queue to
 * drain (e.g. in tests). `dispose()` cancels any in-flight load
 * silently (no error UI) and prevents future handles from running.
 *
 * `handleError(err)` is the symmetric path for parse failures: PUL-F007
 * dispatches `pulsar:navigate-error` for malformed URLs, and the
 * loader records the error on the stage + invokes `onError` without
 * touching the lifecycle.
 */
export interface SceneLoader {
  handle(target: NavigationTarget): Promise<void>;
  handleError(err: unknown): void;
  idle(): Promise<void>;
  dispose(): void;
}

const ATTR_SCENE = 'data-pulsar-scene-target';
const ATTR_COMPOSITION = 'data-pulsar-composition-target';
const ATTR_ERROR = 'data-pulsar-navigation-error';

/**
 * Resolve when `signal` is aborted (or immediately if already
 * aborted). Pure helper hoisted to module scope so the prompter
 * dispatch path can keep its callback nesting under Sonar's
 * S2004 4-level limit (the inline `addEventListener` arrow inside
 * an IIFE inside `buildPrompterLoad` would put the listener at
 * level 5; routing through this helper keeps every callback at
 * level ≤ 2).
 */
function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/**
 * Returns true when `err` is the resolver's own "aborted" wrapper
 * for the active scene's signal — the rejection a new event
 * intentionally caused. Pure function (no closure captures), hoisted
 * to module scope so the loader factory does not recreate it per
 * instance. AggregateErrors carry multi-fault information (abort +
 * cleanup failure, etc.) and are explicitly NOT treated as pure
 * aborts so cleanup failures during an aborted lifecycle still
 * surface to the operator.
 */
function isPureAbort(err: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted &&
    err instanceof Error &&
    !(err instanceof AggregateError) &&
    /aborted/.test(err.message)
  );
}

/**
 * The audio source URLs the resolved (possibly head-truncated) slice
 * declared — every scene's `assets` in the slice (just the head scene's
 * for a bare `kind: 'scene'` target, the full composition slice's for
 * `mode=present`). The per-navigation audio service uses this so
 * `ctx.audio.load()` can only register a URL the preloader (PUL-F005)
 * already warmed — ADR-008 #5: the only audio inventory is
 * `scene.assets`. Pure function (no closure captures), hoisted to
 * module scope so the loader factory does not recreate it per instance.
 */
function collectAudioSources(target: SceneNavigationTarget): readonly string[] {
  return target.composition === undefined
    ? target.scene.assets
    : target.composition.sceneSlice.flatMap((scene) => scene.assets);
}

/**
 * One in-flight load: the abort signal that cancels it, the promise
 * that settles when the lifecycle ends (or rejects on abort), the
 * abort-detection flag used to suppress the "rejection is an error"
 * branch when the rejection was an intentional abort, and the
 * navigation's audio service (PUL-F024) so the loader can `stopAll()`
 * it once the lifecycle settles — the signal binding already covers
 * supersession / dispose; this covers happy-path completion. `null`
 * for a `mode=prompter` load (no resolver lifecycle, no `ctx.audio`).
 */
interface InFlightLoad {
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  /** Set when `dispose()` aborted the load — suppresses error UI on dispose. */
  silent: boolean;
  /** The navigation's audio service, or `null` for a prompter load. */
  readonly audio: AudioService | null;
  /**
   * Lifecycle controller for the per-navigation
   * {@link import('./presenter').PresenterController} (PUL-F025 /
   * ADR-023). A separate `AbortController` from `controller` so the
   * navigation signal stays un-aborted on the happy path (PUL-F013
   * boundary contract): the navigation `controller` is only aborted
   * on supersession / dispose / popstate, while `presenterAbort` is
   * aborted on EITHER supersession (wired in `buildLoad` to the
   * navigation signal) OR normal completion (in `runTarget`'s
   * `finally`). That gives presenter subscriptions a deterministic
   * teardown on every path — the workbench-supplied long-lived
   * `PresenterCommandSource` does not accumulate stale wrappers
   * across successful present-mode completions. `null` when no
   * presenter controller was built (non-present mode, no
   * `presenterCommands` supplied, or `mode=prompter` load).
   */
  readonly presenterAbort: AbortController | null;
}

/**
 * One queued navigation event. The discriminator routes the event to
 * either a target-resolve+lifecycle path (`kind: 'target'`) or an
 * error-surfacing path (`kind: 'error'`). Both flow through the same
 * queue so cleanup-before-handoff and latest-event supersession apply
 * uniformly to PUL-F007's `pulsar:navigate` and `pulsar:navigate-error`
 * events.
 */
type NavigationEvent =
  | { readonly kind: 'target'; readonly target: NavigationTarget }
  | { readonly kind: 'error'; readonly err: unknown };

export function createSceneLoader(options: SceneLoaderOptions): SceneLoader {
  const { stage } = options;
  const onError = options.onError ?? ((err) => console.error(err));
  // PUL-F024 / ADR-004: the audio engine. A workbench that has not
  // wired a real backend gets the silent no-op engine so `ctx.audio`
  // still works (just makes no sound) — the inert-seam pattern the
  // prompter / presenter options also use.
  const audioEngine = options.audioEngine ?? noopAudioEngine;
  let inFlight: InFlightLoad | null = null;
  let disposed = false;
  // Latest-event generation. Every enqueue bumps this counter; queued
  // events that find their generation no longer current at the top of
  // `runOnce` skip themselves. Without this, a sequence
  // handle(B) → handle(C) while A is in flight would run A → B → C
  // even though B was superseded before it ever started.
  let generation = 0;
  // `pending` chains every navigation event so handlers run in
  // submission order without overlapping stage mutations.
  let pending: Promise<void> = Promise.resolve();

  const setStageAttr = (name: string, value: string): void => {
    stage?.setAttribute(name, value);
  };
  const clearStageAttr = (name: string): void => {
    stage?.removeAttribute(name);
  };
  const resetStageAttrs = (): void => {
    clearStageAttr(ATTR_SCENE);
    clearStageAttr(ATTR_COMPOSITION);
    clearStageAttr(ATTR_ERROR);
  };

  const abortAndAwait = async (): Promise<void> => {
    if (inFlight === null) return;
    const current = inFlight;
    current.controller.abort();
    try {
      await current.settled;
    } catch {
      // Expected: the abort caused the resolver to reject. The
      // resolver still ran cleanup for the active scene, so the stage
      // is in a known state.
    }
  };

  const surfaceError = (err: unknown): void => {
    onError(err);
    setStageAttr(ATTR_ERROR, describeError(err));
  };

  /**
   * Defense-in-depth for ADR-013's `beat` grammar rules.
   * `parseNavigationSearch` enforces both on URL input, but
   * `NavigationTarget` is an exported type that non-parser callers
   * (event-detail unmarshaling, future test harnesses, programmatic
   * navigation) can construct directly. Re-checking at the loader
   * boundary stops a hand-built target with an invalid `beat`
   * (wrong shape, or paired with a non-scene-like locator) from
   * reaching the runner with a value the parser would have
   * rejected. Returns an `Error` with the parser's exact grammar
   * message when the target is invalid, or `null` when no further
   * check is needed.
   */
  const validateBeatGrammar = (target: NavigationTarget): Error | null => {
    if (target.beat === undefined) return null;
    if (!isKebabIdentifier(target.beat)) {
      return new Error(
        `navigation grammar is invalid: "beat" must be a non-empty lowercase kebab-case string (${KEBAB_IDENTIFIER_FORM})`,
      );
    }
    const k = target.locator.kind;
    if (k !== 'scene' && k !== 'composition-scene' && k !== 'composition-index') {
      return new Error(
        'navigation grammar is invalid: "beat" requires a scene-like target ("scene", "composition" + "scene", or "composition" + "index")',
      );
    }
    return null;
  };

  /**
   * Defense-in-depth for ADR-007's mode allowlist (PUL-F012).
   * `parseNavigationSearch` validates `mode` against
   * `NAVIGATION_MODES` on URL input, but `NavigationTarget` is an
   * exported type that non-parser callers (event-detail unmarshaling,
   * future test harnesses, programmatic navigation) can construct
   * directly. Re-checking at the loader boundary stops a hand-built
   * target with a mode the parser would have rejected from reaching
   * `effectiveMode` and `buildCtx`, where it would propagate to
   * scenes as `ctx.mode`. Returns an `Error` with the parser's exact
   * grammar message when the target is invalid, or `null` when no
   * further check is needed.
   */
  const validateModeGrammar = (target: NavigationTarget): Error | null => {
    if (target.mode === undefined) return null;
    if (!(NAVIGATION_MODES as readonly string[]).includes(target.mode)) {
      return new Error(
        `navigation grammar is invalid: "mode" unknown mode "${target.mode}" — allowed: ${NAVIGATION_MODES.join(', ')}`,
      );
    }
    return null;
  };

  /**
   * PUL-F011 / ADR-015: build the non-fatal callback the loader
   * supplies to the timeline runner when the URL carries
   * `beat=<label>`. The callback writes
   * `data-pulsar-navigation-error` and calls `onError` without
   * throwing, so a missing label does NOT cause the resolver to
   * reject (which would unmount the scene via PUL-F006 cleanup —
   * violating "remain at the scene's first beat"). Returns
   * `undefined` when no beat was supplied.
   *
   * Three guards parallel the existing fatal-error suppression in
   * the queue (`isPureAbort`, `inFlight.silent`, post-dispose
   * no-op):
   *  - `signal.aborted` — a stale runner that reports
   *    `onBeatMissing` after the load was aborted (a new
   *    navigation enqueued, popstate, etc.) MUST NOT write the
   *    diagnostic for the superseded navigation. Mirrors
   *    `isPureAbort`'s "the new event owns the visible state".
   *  - `disposed` — post-`dispose()` runners must not surface
   *    diagnostics; the workbench is shutting down.
   *  - `fired` — a runner that calls the callback multiple
   *    times (a buggy GSAP integration retrying on each label
   *    miss, etc.) MUST NOT spam `onError` and the stage
   *    attribute. Once-only matches the "single diagnostic per
   *    navigation" semantics of every other surfaceError call.
   */
  const buildOnBeatMissing = (
    beat: string | undefined,
    headSceneId: string,
    signal: AbortSignal,
  ): (() => void) | undefined => {
    if (beat === undefined) return undefined;
    let fired = false;
    return (): void => {
      if (fired || signal.aborted || disposed) return;
      fired = true;
      // PUL-F011 / ADR-015: this path is non-fatal by contract — the
      // timeline adapter is forbidden from throwing or rejecting on
      // missing labels (the resolver would treat that as a lifecycle
      // failure and tear every scene down). The injected `onError` sink
      // is user-supplied, so an exception from it would propagate back
      // through the adapter's `onBeatMissing()` invocation, into the
      // resolver's `await timeline.run(...)`, and trigger the
      // cleanup-then-throw path. Swallow here so the diagnostic
      // surface stays non-fatal even when the operator's logger
      // throws.
      try {
        surfaceError(
          new Error(
            `beat positioning failed: beat "${beat}" does not exist in scene "${headSceneId}"`,
          ),
        );
      } catch {
        // Intentionally empty: see comment above.
      }
    };
  };

  /**
   * Build the in-flight load record: an `AbortController`, the
   * preloader factory's per-load preloader (a synchronous failure
   * is rolled back through `resetStageAttrs()` + `surfaceError`),
   * and the bridge call that drives the lifecycle. Returns the
   * record, or `null` when the preloader factory threw — in which
   * case the caller has already been told via `surfaceError` and
   * should bail. Hoisted out of `runTarget` so the latter stays
   * within Sonar's cognitive-complexity budget.
   */
  const buildLoad = (
    resolved: SceneNavigationTarget,
    target: NavigationTarget,
  ): InFlightLoad | null => {
    const controller = new AbortController();
    // PUL-F012 / ADR-007: mode dispatch lives at the runtime-core seam.
    // The loader derives the effective mode from the parsed target via
    // `effectiveMode` (URL-only — no localStorage, sessionStorage,
    // cookies, history.state, or cached state); every navigation
    // re-derives from its own target, so a previous non-`present` mode
    // cannot leak into a subsequent `mode`-less URL. The mode also
    // selects whether the audio service is `silent` (screenshot /
    // paused suppress audible playback — ADR-019 / ADR-021).
    const mode = effectiveMode(target);
    let preloadAssets: AssetPreloader;
    try {
      preloadAssets = options.createPreloader(controller.signal);
    } catch (err) {
      // Roll back the success-state attrs we just wrote and surface
      // the error so the stage doesn't lie about a half-loaded scene.
      // `resetStageAttrs()` clears all three navigation attrs in
      // lock-step with the success-path reset, so this rollback
      // cannot drift if a fourth navigation attr is added later.
      resetStageAttrs();
      surfaceError(err);
      return null;
    }
    // PUL-F024 / ADR-004: the per-navigation audio service. Built over
    // `audioEngine`, scoped to `controller.signal` (abort ⇒ every sound
    // stopped + unloaded), restricted to the URLs the slice declared in
    // `scene.assets` (ADR-008 #5 — the preloader warmed them), and
    // `silent` under screenshot / paused. Threaded into `ctx.audio` via
    // `buildCtx`, alongside `mode` (PUL-F012). Built AFTER the preloader
    // so a preloader-factory failure does not waste allocations, and
    // wrapped in the same rollback-then-surfaceError pattern so a
    // throwing builder does not leave stale stage attrs or skip the
    // queue's error sink.
    let ctx: unknown;
    let audio: AudioService;
    try {
      audio = createAudioService(audioEngine, {
        signal: controller.signal,
        silent: mode === 'screenshot' || mode === 'paused',
        allowedSources: collectAudioSources(resolved),
        onError,
      });
      ctx = options.buildCtx(mode, audio);
    } catch (err) {
      // Abort the freshly-created controller before bailing so any
      // signal-tied resource (the preloader factory's fetch listener,
      // the audio service's stop-on-abort hook) observes cancellation
      // and releases. Without this, the signal is GC'd in the
      // never-aborted state and any abort-keyed listener runs at GC
      // time (or never).
      controller.abort();
      resetStageAttrs();
      surfaceError(err);
      return null;
    }
    const beat = target.beat;
    const onBeatMissing = buildOnBeatMissing(beat, resolved.scene.id, controller.signal);
    // PUL-F015 / ADR-018: under `mode=loop` the runner restarts the
    // addressed scene's timeline on completion. The loader is the
    // dispatch point for mode → runner-input plumbing (parallel to
    // PUL-F012's `ctx.mode` derivation): when `effectiveMode === 'loop'`,
    // pass `repeat: 'until-aborted'` through the bridge. The bridge
    // and resolver scope delivery to the head scene only — following
    // composition entries do not see `repeat`, because a looping
    // head's timeline never naturally completes. Use a literal
    // `undefined` sentinel so the spread below cleanly omits the key
    // for non-loop modes (parity with the `beat` plumbing).
    const repeat: 'until-aborted' | undefined = mode === 'loop' ? 'until-aborted' : undefined;
    // PUL-F016 / ADR-019: under `mode=paused` the runner mounts the
    // addressed scene and holds its timeline at the first frame.
    // Same dispatch-point pattern as `repeat`: when
    // `effectiveMode === 'paused'`, pass `hold: 'first-frame'`
    // through the bridge. The bridge and resolver scope delivery to
    // the head scene only — following composition entries do not see
    // `hold`, because a paused head's timeline never advances.
    // `mode=paused` and `mode=loop` are mutually exclusive at the URL
    // boundary (mode is a single field), so at most one of `repeat` /
    // `hold` is non-undefined here.
    const hold: 'first-frame' | undefined = mode === 'paused' ? 'first-frame' : undefined;
    // PUL-F017 / ADR-020: under `mode=scrub` the runner gates audio
    // cues to monotonic forward playback only. Same dispatch-point
    // pattern as `repeat` and `hold`: when `effectiveMode === 'scrub'`,
    // pass `cueGate: 'monotonic-forward'` through the bridge. The
    // bridge and resolver scope delivery to the head scene only —
    // following composition entries do not see `cueGate`, because the
    // slice is truncated upstream and the head's interactive timeline
    // never hands off to following entries. `mode=scrub`, `mode=loop`,
    // and `mode=paused` are mutually exclusive at the URL boundary,
    // so at most one of `repeat` / `hold` / `cueGate` is non-undefined
    // here.
    const cueGate: 'monotonic-forward' | undefined =
      mode === 'scrub' ? 'monotonic-forward' : undefined;
    // PUL-F018 / ADR-021: under `mode=screenshot` the runner renders
    // the addressed scene at the addressed beat (or first frame),
    // holds the timeline still, suppresses all audio, and sources
    // any randomness from a deterministic seed. Same dispatch-point
    // pattern as `repeat` / `hold` / `cueGate`: when
    // `effectiveMode === 'screenshot'`, pass `screenshot: 'capture'`
    // through the bridge. The bridge and resolver scope delivery to
    // the head scene only — following composition entries do not
    // see `screenshot`, because the slice is truncated upstream and
    // the captured frame belongs to one scene. `mode=screenshot`,
    // `mode=scrub`, `mode=loop`, and `mode=paused` are mutually
    // exclusive at the URL boundary, so at most one of `repeat` /
    // `hold` / `cueGate` / `screenshot` is non-undefined here.
    const screenshot: 'capture' | undefined = mode === 'screenshot' ? 'capture' : undefined;
    // PUL-F020 / ADR-023: under `mode=present` the loader builds a
    // per-navigation `PresenterController` bound to this load's
    // `controller.signal` and forwards it to every scene's run input
    // via the bridge → resolver. Two scoping conditions: the mode
    // must resolve to `'present'` (URL `mode=present` OR absent
    // `mode=`, both of which `effectiveMode` collapses), AND the
    // workbench must have supplied a `presenterCommands` source.
    // When either condition is unmet, `presenter` is `undefined` and
    // the spread below omits it from the bridge call so a runner
    // that branches on `'presenter' in input` sees an absent key
    // (parity with the `repeat` / `hold` / `cueGate` / `screenshot`
    // / `beat` plumbing).
    //
    // Auto-cleanup: the controller registers `controller.signal`'s
    // abort listener internally. When the navigation aborts (next
    // handle, dispose, popstate, presenter-driven scene exit), every
    // outstanding runner subscription is detached from the source.
    // A runner that subscribes via `input.presenter.subscribe(...)`
    // and forgets to unsubscribe cannot leak across navigations.
    //
    // Per ADR-007, mode dispatch lives in the runtime core, not at
    // adapters; this is the central enforcement point for "presenter
    // input only under mode=present" — no other code path builds the
    // controller.
    // PUL-F025 / ADR-023 (codex review, post-PUL-F025): the
    // presenter controller's lifetime is "the navigation" — which
    // ends on supersession / dispose / popstate (the navigation
    // signal aborts) OR on normal completion (the resolver finishes
    // and `runTarget`'s `finally` runs). Binding to the navigation
    // signal alone covers only the first set; we use a separate
    // `AbortController` so the loader can also tear down on the
    // success path. The presenter signal is fired on EITHER cause:
    // the navigation-abort listener below propagates supersession /
    // dispose / popstate, and `runTarget`'s `finally` aborts it on
    // completion. Both aborts are idempotent. The navigation signal
    // itself stays un-aborted on the success path so the PUL-F013
    // boundary contract — "the navigation signal reaches the runner
    // un-aborted at receive time AND stays un-aborted across a
    // successful completion" — is preserved.
    const presenterAbort: AbortController | null =
      mode === 'present' && options.presenterCommands !== undefined ? new AbortController() : null;
    if (presenterAbort !== null) {
      // Propagate navigation abort → presenter abort. Without this
      // wiring, a supersession-time `controller.abort()` would not
      // tear down the presenter controller (because it's bound to
      // `presenterAbort.signal`, not `controller.signal`).
      const propagateAbort = (): void => {
        presenterAbort.abort();
      };
      if (controller.signal.aborted) {
        presenterAbort.abort();
      } else {
        controller.signal.addEventListener('abort', propagateAbort, { once: true });
      }
    }
    const presenter =
      presenterAbort !== null && options.presenterCommands !== undefined
        ? createPresenterController(options.presenterCommands, presenterAbort.signal, onError)
        : undefined;
    // PUL-F025 / ADR-004: presenter master mute. The audio handler
    // lives here because this is the only seam where both the
    // per-navigation `PresenterController` and the per-navigation
    // `AudioService` are in scope — the runner cannot reach `audio`
    // and the audio service does not see presenter commands.
    //
    // The command is a *fact* ("presenter pressed mute"), not a
    // target state — the handler reads the engine's current master
    // mute at receipt time and flips it via the audio boundary.
    // `audio.mute()` validates the boolean (PUL-F024) and is inert
    // post-dispose; the engine owns mute as runtime state so the
    // flip survives scene cleanup and is observable by sibling
    // services backed by the same engine (ADR-004, pinned in
    // `audio.test.ts`).
    //
    // The subscription auto-detaches on `controller.signal` abort
    // via the presenter controller's existing `tearDownAll` — no
    // separate teardown wiring is needed. The handler is additive,
    // not a filter: the runner still receives every command kind
    // on its own `input.presenter.subscribe(...)`. Other kinds
    // fall through to no-ops here.
    //
    // The handler can only throw if `audio.mute()` itself does. The
    // controller's per-handler `try/catch` (`createPresenterController`)
    // catches and routes through the same `onError` sink the loader
    // already supplies, so a regression that made `mute()` throw
    // mid-toggle cannot poison sibling subscribers or abort the
    // navigation.
    if (presenter !== undefined) {
      presenter.subscribe((cmd) => {
        if (cmd.kind !== 'toggle-master-mute') return;
        audio.mute(!audio.isMuted());
      });
    }
    return {
      controller,
      settled: loadSceneNavigationTarget(resolved, {
        ctx,
        preloadAssets,
        timeline: options.timeline,
        signal: controller.signal,
        ...(beat === undefined ? {} : { beat }),
        ...(onBeatMissing === undefined ? {} : { onBeatMissing }),
        ...(repeat === undefined ? {} : { repeat }),
        ...(hold === undefined ? {} : { hold }),
        ...(cueGate === undefined ? {} : { cueGate }),
        ...(screenshot === undefined ? {} : { screenshot }),
        // Forward `presenter` AND the `onError` sink so the
        // resolver's per-scene wrapper around `presenter` can
        // route runner-handler exceptions / unknown-kind drops
        // through the same diagnostic channel as every other
        // navigation-level error (codex review, cycle 2).
        ...(presenter === undefined ? {} : { presenter, onPresenterError: onError }),
        // PUL-F024 / ADR-004: the runtime stops the audio group a scene
        // scoped to itself (`group: <its-scene-id>`) when that scene's
        // `cleanup(ctx)` runs — runtime-guaranteed per-scene teardown,
        // not author discipline. (`stopGroup` is a no-op when the group
        // is empty or the service is already disposed.)
        onSceneCleaned: (sceneId) => audio.stopGroup(sceneId),
      }),
      silent: false,
      audio,
      presenterAbort,
    };
  };

  /**
   * Truncate the validated composition slice to its addressed head
   * entry under modes that mean "run only the addressed scene."
   *
   * PUL-F014 / ADR-017 (`standalone`): the runtime renders a single
   * scene "as if no surrounding composition existed."
   *
   * PUL-F015 / ADR-018 (`loop`): the runtime runs the addressed
   * scene's timeline and restarts on completion. Truncating the
   * slice makes "no following entries run" a structural guarantee
   * even if the runner ignores the `repeat: 'until-aborted'` hint
   * (codex review): a runner bug or no-op runner under `mode=loop`
   * MUST NOT silently degrade into normal composition playback.
   *
   * PUL-F016 / ADR-019 (`paused`): the runtime mounts the addressed
   * scene and holds it at its first frame without advancing the
   * timeline. Truncating the slice makes "no following entries run"
   * a structural guarantee even if the runner ignores the
   * `hold: 'first-frame'` hint — a runner bug or no-op runner under
   * `mode=paused` MUST NOT silently degrade into normal composition
   * playback (parallel to the ADR-018 codex-review argument).
   *
   * PUL-F017 / ADR-020 (`scrub`): the runtime displays timeline
   * controls allowing the user to scrub forward, backward, and to
   * named beats while audio cues fire only on monotonic forward
   * playback. Truncating the slice makes "no following entries run"
   * a structural guarantee even if the runner ignores the
   * `cueGate: 'monotonic-forward'` hint — a runner bug or no-op
   * runner under `mode=scrub` MUST NOT silently degrade into normal
   * composition playback. Scrub is single-timeline by construction:
   * one timeline of controls, one head scene; following composition
   * entries cannot be part of the interactive scrub UX.
   *
   * PUL-F018 / ADR-021 (`screenshot`): the runtime renders the
   * addressed scene at the addressed beat (or first frame) with
   * the timeline held still, all audio suppressed, and any
   * randomness sourced from a deterministic seed. Truncating the
   * slice makes "no following entries run" a structural guarantee
   * even if the runner ignores the `screenshot: 'capture'` hint —
   * a runner bug or no-op runner under `mode=screenshot` MUST NOT
   * silently degrade into normal composition playback. Screenshot
   * is single-frame-capture by construction: one deterministic
   * frame, one head scene; following composition entries cannot
   * be part of a single-frame snapshot.
   *
   * All five modes share the same slice-shape transform — they
   * differ only in the head's runner-side semantic: standalone
   * plays normally, loop sets `input.repeat = 'until-aborted'`,
   * paused sets `input.hold = 'first-frame'`, scrub sets
   * `input.cueGate = 'monotonic-forward'`, screenshot sets
   * `input.screenshot = 'capture'`. The shape transform is shared
   * because the structural promise ("no following entries run") is
   * identical.
   *
   * The composition slice — already validated by
   * `resolveSceneNavigation` so unregistered compositions /
   * unknown member scenes / out-of-range indexes still surface as
   * navigation errors — is truncated to a one-entry slice so the
   * lifecycle runs only the addressed head scene. The slice is
   * TRUNCATED rather than dropped so the head entry's per-entry
   * `range` / `behavior` overrides (object-form entries per ADR-002
   * / ADR-011) reach the runner unchanged: a flat `{ scene }` would
   * lose them and turn the mode into direct-scene flattening,
   * contradicting ADR-017 / ADR-018 / ADR-019 / ADR-020 / ADR-021's
   * "preserve head-entry overrides" contract.
   *
   * Stage attrs (set by the caller before this transform) reflect
   * what the URL ADDRESSED, not what runs:
   * `data-pulsar-composition-target` stays set so external
   * observers (agents, screenshot tooling) see the URL-addressed
   * composition even when only the head scene executes. Pure
   * function — no closure captures — hoisted out of `runTarget` so
   * the latter stays within Sonar's cognitive-complexity budget.
   */
  const applySingleSceneSlice = (
    resolved: SceneNavigationTarget,
    target: NavigationTarget,
  ): SceneNavigationTarget => {
    const mode = effectiveMode(target);
    if (
      (mode !== 'standalone' &&
        mode !== 'loop' &&
        mode !== 'paused' &&
        mode !== 'scrub' &&
        mode !== 'screenshot') ||
      resolved.composition === undefined
    ) {
      return resolved;
    }
    const headEntry = resolved.composition.manifestSlice[0];
    const headScene = resolved.composition.sceneSlice[0];
    if (headEntry === undefined || headScene === undefined) {
      return resolved;
    }
    return {
      scene: resolved.scene,
      composition: {
        id: resolved.composition.id,
        manifestSlice: Object.freeze([headEntry]),
        sceneSlice: Object.freeze([headScene]),
      },
    };
  };

  /**
   * Run a `mode=prompter` dispatch end-to-end: invoke the renderer
   * and, when the renderer returned a {@link PrompterDispose}
   * callback, park until abort and then run the callback.
   *
   * Hoisted out of `buildPrompterLoad` so the IIFE chain stays under
   * Sonar's nested-function limit (S2004): the inline addEventListener
   * arrow inside an IIFE inside an arrow function inside an arrow
   * function would put the listener at level 5; pulling the work
   * into a top-level helper keeps every callback at level ≤ 2.
   */
  const dispatchPrompter = async (
    renderer: PrompterRenderer,
    script: PrompterScript,
    signal: AbortSignal,
  ): Promise<void> => {
    const result = await renderer(script, signal);
    if (typeof result !== 'function') {
      // `void` / `undefined` return: renderer indicated nothing
      // persistent was mounted. Dispatch is fully complete; do not
      // park.
      return;
    }
    // PrompterDispose callback: renderer mounted persistent state
    // and delegated cleanup ordering to the loader. Park until
    // abort (next navigation, dispose(), etc.), then run the
    // callback.
    const dispose: PrompterDispose = result;
    await waitForAbort(signal);
    await dispose();
  };

  /**
   * PUL-F019 / ADR-022: build the in-flight record for a `mode=prompter`
   * dispatch. Mirrors {@link buildLoad}'s contract — returns an
   * {@link InFlightLoad} carrying a fresh `AbortController` and a
   * settled-promise — but routes through the captions data path
   * INSTEAD of the resolver lifecycle. No preload, no `create`, no
   * `timeline`, no `cleanup`; the structural defense is "do not
   * invoke the lifecycle that would render scenes visually."
   *
   * The renderer's return value drives the cleanup lifecycle (see
   * {@link PrompterRenderer} and {@link dispatchPrompter}). When
   * `renderPrompter` is undefined the loader still pays the
   * structural-suppression cost (lifecycle is bypassed) but resolves
   * immediately — there is no captions consumer.
   */
  const buildPrompterLoad = (resolved: SceneNavigationTarget): InFlightLoad => {
    const controller = new AbortController();
    const renderer = options.renderPrompter;
    // `mode=prompter` bypasses the resolver lifecycle entirely — no
    // scene mounts, so there is no `ctx.audio` consumer and no audio
    // service to build (`audio: null`).
    if (renderer === undefined) {
      return {
        controller,
        settled: Promise.resolve(),
        silent: false,
        audio: null,
        presenterAbort: null,
      };
    }
    const script = buildPrompterScript(resolved);
    return {
      controller,
      settled: dispatchPrompter(renderer, script, controller.signal),
      silent: false,
      audio: null,
      presenterAbort: null,
    };
  };

  const runTarget = async (target: NavigationTarget): Promise<void> => {
    const beatErr = validateBeatGrammar(target);
    if (beatErr !== null) {
      surfaceError(beatErr);
      return;
    }
    const modeErr = validateModeGrammar(target);
    if (modeErr !== null) {
      surfaceError(modeErr);
      return;
    }

    let resolved: SceneNavigationTarget | null;
    try {
      resolved = resolveSceneNavigation(target, {
        scenes: options.scenes,
        compositions: options.compositions,
      });
    } catch (err) {
      surfaceError(err);
      return;
    }

    if (resolved === null) return;

    setStageAttr(ATTR_SCENE, resolved.scene.id);
    if (resolved.composition !== undefined) {
      setStageAttr(ATTR_COMPOSITION, resolved.composition.id);
    }

    // PUL-F019 / ADR-022: under `mode=prompter` bypass the resolver
    // lifecycle entirely. Visual rendering is suppressed structurally
    // by NOT running the path that would mount scenes. The captions
    // data path takes its place. No `applySingleSceneSlice` (the
    // captions view consumes the FULL slice — see ADR-022 for why
    // the truncation defense from F015–F018 does not apply here),
    // no `buildLoad` (no preloader, no buildCtx, no runner), just a
    // captions-renderer dispatch wrapped in the same abort/queue
    // pattern so cleanup-before-handoff and supersession still work.
    let load: InFlightLoad | null;
    if (effectiveMode(target) === 'prompter') {
      load = buildPrompterLoad(resolved);
    } else {
      const runnable = applySingleSceneSlice(resolved, target);
      load = buildLoad(runnable, target);
    }
    if (load === null) return;
    inFlight = load;

    try {
      await load.settled;
    } catch (err) {
      // Suppress only the resolver's own "aborted" wrapper error —
      // the new event that triggered the abort owns the visible
      // state. AggregateErrors (multi-fault: phase + cleanup) and
      // any non-abort errors still surface so cleanup failures
      // during an aborted lifecycle are not silently dropped.
      if (!load.silent && !isPureAbort(err, load.controller.signal)) {
        surfaceError(err);
      }
    } finally {
      // PUL-F024 / ADR-004: the navigation is over — stop + unload
      // every sound it created. On supersession / dispose the signal
      // binding already disposed the service, so this is the
      // happy-path-completion path (the resolver ran every scene's
      // `cleanup(ctx)`, then `load.settled` resolved); `stopAll()` is
      // idempotent so the double-call on the abort paths is harmless.
      load.audio?.stopAll();
      // PUL-F025 / ADR-023 (codex review, post-PUL-F025): tear down
      // the presenter controller's subscriptions on the happy path
      // too. The presenter controller is built against a *separate*
      // `presenterAbort` signal in `buildLoad` (NOT the navigation
      // signal) so the navigation signal's "un-aborted on success"
      // invariant — pinned by the PUL-F013 boundary tests — is
      // preserved. The separate signal still fires on navigation
      // abort (wired in `buildLoad`), and we abort it here so the
      // long-lived `PresenterCommandSource` does not accumulate
      // stale wrappers across successful present-mode completions
      // (the loader's PUL-F025 mute handler, plus any runner-owned
      // subscription that forgot to unsubscribe at scene-exit).
      // Idempotent: a subsequent supersession-time abort of the
      // same `presenterAbort` is a no-op.
      load.presenterAbort?.abort();
      if (inFlight === load) inFlight = null;
    }
  };

  const runOnce = async (event: NavigationEvent, myGen: number): Promise<void> => {
    // Drop superseded events before doing any visible work — both at
    // entry (handle → handle race) and after the abort-and-await yield
    // (slow cleanup observed by another enqueue).
    if (myGen !== generation || disposed) return;
    await abortAndAwait();
    if (myGen !== generation || disposed) return;
    resetStageAttrs();

    if (event.kind === 'error') {
      surfaceError(event.err);
      return;
    }
    await runTarget(event.target);
  };

  const enqueue = (event: NavigationEvent): Promise<void> => {
    if (disposed) return pending;
    // Eagerly abort any in-flight load so the queued event can
    // proceed past `await load.settled` immediately. Without this, a
    // popstate-fired re-navigation would wait for the current load to
    // drain naturally — exactly the wrong behavior when the user
    // clicked back/forward.
    if (inFlight !== null) inFlight.controller.abort();
    const myGen = ++generation;
    pending = pending.then(
      () => runOnce(event, myGen),
      () => runOnce(event, myGen),
    );
    return pending;
  };

  return {
    handle: (target) => enqueue({ kind: 'target', target }),
    handleError: (err) => {
      void enqueue({ kind: 'error', err });
    },
    idle: () => pending,
    dispose: () => {
      disposed = true;
      if (inFlight !== null) {
        inFlight.silent = true;
        inFlight.controller.abort();
      }
    },
  };
}
