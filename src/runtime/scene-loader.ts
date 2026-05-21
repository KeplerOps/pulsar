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

import {
  type AudioCueLogEntry,
  type AudioEngine,
  type AudioOutputPolicy,
  type AudioService,
  type CueGateControl,
  createAudioService,
  createCueGate,
  noopAudioEngine,
} from './audio';
import type { CompositionRegistry } from './composition-registry';
import type {
  AssetPreloader,
  CompositionTimelineAdapter,
  SceneActivation,
  SceneFailureEvent,
} from './composition-resolver';
import { describeErrorDetailed, formatSceneContext } from './error';
import { KEBAB_IDENTIFIER_FORM, isKebabIdentifier } from './identifier';
import {
  NAVIGATION_MODES,
  type NavigationMode,
  type NavigationTarget,
  effectiveMode,
} from './navigation';
import {
  type PresenterCommandSource,
  type PresenterController,
  createPresenterController,
} from './presenter';
import {
  type PrompterDispose,
  type PrompterRenderer,
  type PrompterScript,
  buildPrompterScript,
} from './prompter';
import type { SceneRegistry } from './registry';
import { sceneDeclaresAudio } from './scene';
import {
  type SceneNavigationTarget,
  loadSceneNavigationTarget,
  resolveSceneNavigation,
} from './scene-navigation';
import { type TimelineEngine, sceneSegmentLabel } from './timeline';

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
/**
 * Optional refs for the L2 chrome slot DOM that `src/main.ts`
 * mounts into the workbench chrome surface. Scenes built from the
 * L2 template library read `ctx.chrome` to address title/brand/
 * centerpiece/lower-third/tag/act-frame/flash slots without reaching
 * for ambient `document` lookups. Runtime contract does not require
 * a specific shape — the field is declared as a generic record so
 * the runtime engine stays L2-agnostic; the L2 system layer's
 * `ChromeSlots` type narrows it at the consumer boundary.
 */
export type WorkbenchChromeSlots = Readonly<Record<string, unknown>>;

export interface WorkbenchSceneCtx {
  /** The workbench stage element, or `null` when the runtime has no stage. */
  readonly stage: StageElement | null;
  /**
   * Optional per-navigation `PresenterController` (`mode=present` only,
   * undefined under every other mode). Scenes that need to subscribe
   * to presenter `advance` commands directly — for ambient loops that
   * break on advance (`while (!state.advanceSignal)` style decks) —
   * pass this into `aSleep(ms, { signal, controller })` or
   * `holdUntilAdvance(controller, signal)`. The controller auto-detaches
   * on the navigation's `AbortSignal`, so a scene that subscribes and
   * forgets to unsubscribe cannot leak across navigations.
   */
  readonly presenter?: PresenterController;
  /**
   * Optional L2 chrome slot refs. Templates that compose against the
   * cinematic chrome pack read this field; engine-level fixtures and
   * the trivial placeholder scene leave it `undefined` and operate
   * stage-only.
   */
  readonly chrome?: WorkbenchChromeSlots;
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
   * composition slice. The sound-id namespace and the source allowlist
   * (the slice's declared `scene.assets`) are therefore slice-scoped —
   * multi-scene compositions pick distinct sound ids, the same
   * stable-identity discipline scene ids obey (ADR-008 #1), and
   * registering an id twice with the same definition is idempotent. A
   * scene scopes a sound to itself with `play(id, { group: <its-scene-id> })`;
   * that group is scene-scoped — shared by every occurrence of a scene
   * id a composition slice repeats (issue #99). The loader wires the
   * resolver's per-scene post-`cleanup(ctx)` hook so the runtime (not
   * the author) stops a scene's group when the LAST occurrence of that
   * scene id has been cleaned up — occurrence-safe teardown that never
   * cuts a still-active sibling occurrence's audio.
   */
  readonly audio: AudioService;
  /**
   * This activation's stable per-occurrence identity (issue #99 — see
   * {@link import('./composition-resolver').SceneActivation}):
   * `{ sceneId, entryIndex, occurrence }`. A composition slice may
   * reference the same scene module more than once; every occurrence
   * runs against its OWN `ctx` carrying its own `activation`, so a
   * scene can own its occurrence's DOM / listeners / state (e.g. derive
   * an occurrence-scoped mount sub-root, or key any scene-local map by
   * the activation) without colliding with a sibling occurrence of the
   * same module. `occurrence` is `0` for the first / only use.
   *
   * Loader-contributed: {@link SceneLoaderOptions.buildCtx} builds the
   * navigation-scoped fields above; the loader then adds `activation`
   * per occurrence, which is why `buildCtx`'s return type omits it.
   */
  readonly activation: SceneActivation;
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
   * {@link audioEngine}. The returned navigation-scoped value is the
   * base the loader threads, per occurrence, into every lifecycle hook
   * (`create` / `timeline` / `cleanup`); the resolver never inspects it.
   *
   * Returns the navigation-scoped fields of {@link WorkbenchSceneCtx} so
   * the production contract "scenes receive `ctx.mode` / `ctx.audio`"
   * is enforced at this boundary rather than relying on a single
   * workbench bootstrap annotation. Mode dispatch lives at this seam
   * per ADR-007 ("Mode is dispatched in the runtime core, not per
   * scene"): the workbench supplies the stage and any other long-lived
   * ctx members through a closure, the loader contributes the
   * per-navigation `mode` and `audio`. Constructing a fresh ctx per
   * navigation also blocks any "previous mode leaks into a `mode`-less
   * URL" regression — every navigation re-derives mode from its own
   * target — and a fresh audio service per navigation makes "audio
   * survives the scene that started it" structurally impossible.
   *
   * The return type omits `activation` (issue #99): `buildCtx` is
   * called once per navigation and cannot know a per-occurrence
   * identity. The loader adds each occurrence's `SceneActivation` on
   * top of this base, so a composition slice that repeats a scene id
   * gives every occurrence a distinct `ctx`.
   *
   * Not invoked when the locator is `kind: 'none'` (no scene mounts)
   * or when the navigation event is a parse-error event, because
   * those paths run no lifecycle.
   */
  readonly buildCtx: (
    mode: NavigationMode,
    audio: AudioService,
    presenter?: PresenterController,
  ) => Omit<WorkbenchSceneCtx, 'activation'>;
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
   * Workbench-supplied cue-log sink (PUL-F026 / ADR-004). When set,
   * the loader threads it through to every per-navigation
   * {@link AudioService} as `onCue`. The per-navigation
   * {@link AudioOutputPolicy} decides whether cues are emitted — the
   * loader supplies `'log-cues'` under `mode=rehearsal` and `'silent'`
   * under `mode=screenshot` / `mode=paused`, so a workbench that
   * always wires a cue-log surface only sees entries during
   * rehearsal navigations. Optional: a workbench that has not wired
   * a cue UI yet omits the field and rehearsal navigations are
   * effectively silent — the audio is still muted at the engine
   * level (PUL-F026: "audio is silenced OR logged as cues").
   */
  readonly onAudioCue?: (entry: AudioCueLogEntry) => void;
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
  /**
   * PUL-F030 / ADR-029: workbench-supplied unlock adapter that collects
   * one explicit user gesture and resolves once browser autoplay policy
   * is satisfied for a present-mode composition that declares audio.
   * The loader invokes the adapter BEFORE asset preload, scene
   * `create(ctx)`, scene `timeline(ctx)`, and master timeline playback
   * — so a present-mode composition cannot begin with a suspended
   * `AudioContext` mid-cue. Gate semantics:
   *
   *  - Triggered when `effectiveMode(target) === 'present'` AND the
   *    resolved target carries a composition slice (composition
   *    navigation, not a direct `?scene=...&mode=present`) AND at
   *    least one scene in `sceneSlice` declares audio statically via
   *    {@link import('./scene').sceneDeclaresAudio} (`scene.audio`
   *    list non-empty).
   *  - Bypassed for every non-`present` mode (rehearsal / screenshot /
   *    paused / scrub / loop / standalone / prompter) and for present-
   *    mode loads that don't carry audio.
   *  - Bound to the navigation's `AbortSignal`: supersession /
   *    `dispose()` / popstate aborts the gate, the adapter observes
   *    `signal.aborted`, and the lifecycle never starts.
   *  - Adapter receives bounded semantic context only (composition id,
   *    scene ids, signal) plus a one-shot `unlock()` callback bound to
   *    the audio engine — never raw scene objects, source URLs,
   *    headers, cookies, or Howler handles.
   *  - An adapter rejection is surfaced through the existing
   *    `onError` + `data-pulsar-navigation-error` channel without
   *    starting lifecycle work.
   *  - When the gate triggers but no adapter is supplied, the loader
   *    fails loud through the same diagnostic channel — the gate IS
   *    the structural defense PUL-F030 records, so an unwired gate is
   *    a workbench-bootstrap defect, not an inert seam.
   */
  readonly audioUnlockAdapter?: AudioUnlockAdapter;
  /**
   * PUL-F031 / ADR-031: workbench-supplied chrome controller. The
   * loader calls `chrome.applyMode(effectiveMode(target))` once per
   * navigation, immediately after mode-grammar validation passes and
   * BEFORE scene resolution / lifecycle work, so chrome visibility
   * tracks the addressed workbench mode (`present` → visible;
   * `standalone` / `screenshot` → hidden; other modes → visible per
   * preflight policy) and a present-mode composition does not flash
   * an un-chromed frame.
   *
   * Chrome is workbench-owned and built at bootstrap by
   * `src/runtime/workbench-chrome.ts`. The loader's seam is
   * intentionally narrow: one call per navigation with the URL-derived
   * mode. The chrome controller itself decides what "visible" /
   * "hidden" mean structurally (DOM `hidden` attribute, visibility
   * data attribute) — the loader does not know.
   *
   * Optional: a workbench bootstrap that has not wired chrome yet
   * (Node tests, pre-PUL-F031 bootstraps) omits the field and the
   * seam is structurally inert, the same inert-seam pattern
   * {@link renderPrompter} / {@link presenterCommands} /
   * {@link audioUnlockAdapter} follow.
   *
   * The chrome surface persists across scene navigations within a
   * composition because the loader's single call site is upstream of
   * the resolver's per-scene loop — a multi-scene composition under
   * `mode=present` produces exactly one `applyMode('present')` call.
   * Per ADR-007 / ADR-016 / PUL-A008, chrome state is workbench-owned
   * and scenes never see a chrome handle.
   */
  readonly chrome?: WorkbenchChromeAdapter;
}

/**
 * PUL-F031 / ADR-031: workbench-supplied chrome controller surface.
 * The loader only needs the one operation — apply a validated mode
 * to chrome — so the interface stays narrow. The full chrome
 * controller lives in {@link import('./workbench-chrome').WorkbenchChromeController}
 * with a `dispose()` method the workbench (not the loader) calls on
 * HMR teardown.
 */
export interface WorkbenchChromeAdapter {
  applyMode(mode: NavigationMode): void;
  /**
   * Optional composition-level override: force chrome visibility hidden
   * regardless of the mode-derived default. Used when a composition's
   * head entry declares `behavior.chrome: 'hidden'` (e.g. a deck that
   * owns its own atmospherics). Pass `null` to clear the override.
   * Optional on the adapter so existing chrome implementations stay
   * compatible — the loader only calls it when defined.
   */
  setForcedVisibility?(visibility: 'hidden' | null): void;
}

/**
 * PUL-F030 / ADR-029: semantic context handed to the workbench-supplied
 * unlock adapter. The adapter MUST NOT receive raw scene objects, source
 * URLs, scheme parsers, Howler handles, request headers, cookies, or
 * any payload outside this shape — the gate is the structural defense,
 * and the workbench gesture surface only needs bounded identifiers and
 * a callback into the audio boundary.
 */
export interface AudioUnlockContext {
  /** Composition id (from the resolved navigation target). */
  readonly compositionId: string;
  /**
   * Scene ids in the resolved composition slice, in playback order.
   * Lets the workbench prompt copy (when it lands) reflect what is
   * about to play without exposing scene objects or URLs.
   */
  readonly sceneIds: readonly string[];
  /**
   * Navigation `AbortSignal`. Adapters that show a gesture surface
   * MUST listen for abort and reject (or resolve cleanly without
   * starting playback) so a superseded navigation does not start the
   * old composition after the user finally clicks.
   */
  readonly signal: AbortSignal;
  /**
   * Audio-boundary unlock callback bound to the runtime audio engine.
   * The adapter calls this AFTER collecting the user gesture; the
   * engine resumes its `AudioContext` so subsequent playback satisfies
   * browser autoplay policy. Idempotent.
   */
  readonly unlock: () => Promise<void>;
}

/**
 * PUL-F030 / ADR-029: signature of the workbench-supplied unlock
 * adapter. Resolves when the gate is satisfied (engine unlocked, the
 * navigation may proceed); rejects when the user dismissed the gesture
 * or another error prevents unlock. The loader awaits the returned
 * promise BEFORE running asset preload / scene lifecycle for the
 * present-mode composition.
 */
export type AudioUnlockAdapter = (gate: AudioUnlockContext) => Promise<void>;

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
// PUL-F029 / ADR-028: per-scene lifecycle failures land on a dedicated
// attribute so the fatal `data-pulsar-navigation-error` surface keeps
// its "composition aborted" semantics. The value is a comma-separated
// list of `<sceneId>:<phase>` entries in encounter order; a failure of
// a repeated scene id (issue #99) namespaces the entry by occurrence
// (`<sceneId>#<n>:<phase>` for occurrence > 0, bare for occurrence 0).
const ATTR_SCENE_FAILURES = 'data-pulsar-scene-failures';

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
 * declared as audio — every scene's static {@link import('./scene').SceneModule.audio}
 * list in the slice (just the head scene's for a bare `kind: 'scene'`
 * target, the full composition slice's for composition targets). The
 * per-navigation audio service uses this as the SCENE-FACING source
 * allowlist so `ctx.audio.load()` can only register URLs the scene
 * EXPLICITLY declared as audio — not any URL that happens to be in
 * `scene.assets`. This makes the PUL-F030 / ADR-029 unlock-gate
 * predicate ({@link import('./scene').sceneDeclaresAudio}) AND the
 * audio-service allowlist consistent: a scene that registers audio
 * MUST declare it in `scene.audio`, so the present-mode unlock gate
 * cannot be bypassed by a scene that hides its audio in `assets`
 * (codex review, cycle 1 — class finding "audio gate can be bypassed
 * by undeclared ctx.audio loads"). `scene.audio` is validated at the
 * schema boundary to be a subset of `scene.assets`, so the preloader
 * still warms every declared audio URL.
 *
 * The PUL-F014 composition audio bed is deliberately NOT added here.
 * The bed is composition-owned runtime infrastructure, not a
 * `scene.audio` entry, and exposing its source through the scene
 * allowlist would let a scene `ctx.audio.load()` the bed URL as its
 * own sound — playing the bed even under `mode=standalone` where it
 * is suppressed. The audio service gates the bed against the bed's
 * OWN declared `src` inside `startBed`, so the scene allowlist stays
 * limited to `scene.audio` (codex review, cycle 1 — "composition bed
 * source leaks into scene audio allowlist").
 *
 * Pure function (no closure captures), hoisted to module scope so the
 * loader factory does not recreate it per instance.
 */
function collectAudioSources(target: SceneNavigationTarget): readonly string[] {
  return target.composition === undefined
    ? target.scene.audio
    : target.composition.sceneSlice.flatMap((scene) => scene.audio);
}

/**
 * Count, per scene id, how many times it occurs in the resolved
 * navigation slice (issue #99). The loader's occurrence-safe audio
 * teardown consults this so the scene-scoped audio group
 * (`group: <sceneId>`, shared by every occurrence of that scene because
 * `ctx.audio` is one slice-scoped service) is stopped exactly once —
 * when the LAST occurrence of that id has been cleaned up — rather than
 * once per occurrence. Stopping it on the first occurrence's cleanup
 * would tear down a still-active sibling occurrence's audio. For a
 * single-occurrence scene the count is `1`, so teardown fires on its
 * only cleanup, unchanged. Pure function (no closure captures), hoisted
 * to module scope so the loader factory does not recreate it per
 * instance.
 */
function countSceneOccurrences(target: SceneNavigationTarget): Map<string, number> {
  const scenes = target.composition === undefined ? [target.scene] : target.composition.sceneSlice;
  const counts = new Map<string, number>();
  for (const scene of scenes) {
    counts.set(scene.id, (counts.get(scene.id) ?? 0) + 1);
  }
  return counts;
}

/**
 * Map the effective workbench mode to the per-navigation
 * {@link AudioOutputPolicy} (PUL-F024 / PUL-F026 / ADR-004):
 *
 *  - `'rehearsal'`                       → `'log-cues'`
 *  - `'screenshot'` / `'paused'`         → `'silent'`
 *  - every other lifecycle-running mode  → `'audible'`
 *
 * Pure function (no closure captures), hoisted to module scope so the
 * loader's `buildLoad` stays within Sonar's cognitive-complexity
 * budget and the mode→policy table lives in one place.
 */
function audioOutputPolicyFor(mode: NavigationMode): AudioOutputPolicy {
  if (mode === 'rehearsal') return 'log-cues';
  if (mode === 'screenshot' || mode === 'paused') return 'silent';
  return 'audible';
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

/**
 * PUL-F030 / ADR-029: the internal gate-prelude callback `buildLoad`
 * invokes BEFORE the resolver lifecycle. Distinct from the public
 * {@link AudioUnlockAdapter}: the public adapter receives a semantic
 * composition context (composition id, scene ids, signal, unlock);
 * this internal helper is what `buildLoad` actually awaits, with the
 * composition context already partially-applied by `buildUnlockGate`.
 * The adapter is workbench-supplied; the helper is the loader's
 * internal closure over it.
 */
type UnlockGate = (env: {
  readonly signal: AbortSignal;
  readonly unlock: () => Promise<void>;
}) => Promise<void>;

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
    clearStageAttr(ATTR_SCENE_FAILURES);
  };

  /**
   * Build the per-navigation `onSceneFailed` handler (PUL-F029 /
   * ADR-028). Each event arrives as a `{ phase, sceneId, entryIndex,
   * message, cause }` tuple from the resolver. The loader augments
   * the public diagnostic with `compositionId` and effective `mode`
   * (the two extra context fields ADR-028's diagnostic contract
   * requires beyond what the resolver knows) when rendering the
   * `onError` message. `event.cause` itself stays programmatic and
   * is never serialized to the stage or to `onError`'s argument (per
   * ADR-028: no raw causes, stacks, scene objects, DOM, captions,
   * headers, cookies, env, auth values).
   *
   * The handler accumulates occurrence-namespaced entries into a Set so
   * a scene whose `create` AND `cleanup` both throw shows up once per
   * (id, occurrence, phase) tuple in encounter order, not twice for the
   * same tuple — and so two occurrences of one repeated scene id stay
   * distinguishable (issue #99).
   *
   * Two-tier suppression:
   *  - **Stage attribute writes** are suppressed when the
   *    navigation's `signal.aborted` (a superseded navigation must
   *    not stomp on the new navigation's stage state) or when the
   *    loader is `disposed`. This parallels `buildOnBeatMissing`.
   *  - **`onError` calls** still fire on abort so a cleanup-phase
   *    scene failure during an aborted lifecycle stays visible to
   *    the workbench logger — the multi-fault visibility the pre-
   *    PUL-F029 `AggregateError` surface provided. Suppressed only
   *    when the loader is fully `disposed` (the workbench is
   *    shutting down; there is no sink to surface to).
   */
  const buildOnSceneFailed = (
    signal: AbortSignal,
    mode: NavigationMode,
    composition: { readonly id: string; readonly startIndex: number } | undefined,
  ): ((event: SceneFailureEvent) => void) => {
    const entries: string[] = [];
    const seen = new Set<string>();
    const renderMessage = (event: SceneFailureEvent): string => {
      // PUL-Q006 / ADR-028: scene id, lifecycle phase, and the
      // per-occurrence ordinal (issue #99) come from the canonical
      // `formatSceneContext` helper in `./error.ts` so any future
      // PUL-Q006 context gets added there once instead of re-templated
      // at every public-surface seam (codex preflight: "do not satisfy
      // the requirement by parsing Error.message"). Occurrence 0
      // renders bare, so a single-occurrence diagnostic is unchanged.
      const prefix = formatSceneContext({
        sceneId: event.sceneId,
        phase: event.phase,
        occurrence: event.occurrence,
      });
      // Codex review cycle 2: render the ABSOLUTE composition entry
      // index (slice start + resolver-level slice-relative index).
      // The resolver's `event.entryIndex` is relative to the manifest
      // slice it was handed; for `composition-scene` and
      // `composition-index` navigations that slice starts mid-
      // manifest, so a slice-relative index would point operators at
      // the wrong entry.
      const compositionSuffix =
        composition === undefined
          ? ''
          : ` (composition "${composition.id}" entry [${composition.startIndex + event.entryIndex}])`;
      return `${prefix}${compositionSuffix} under mode "${mode}": ${event.message}`;
    };
    return (event: SceneFailureEvent): void => {
      if (disposed) return;
      if (!signal.aborted) {
        // issue #99: namespace the entry by the failing occurrence so
        // two failures of the same scene id in the same phase are
        // distinguishable. `sceneSegmentLabel` is the canonical
        // scene+occurrence namer the timeline composer also uses —
        // occurrence 0 renders bare (`<sceneId>:<phase>`), so a
        // single-occurrence failures attribute is unchanged.
        const key = `${sceneSegmentLabel(event.sceneId, event.occurrence)}:${event.phase}`;
        if (!seen.has(key)) {
          seen.add(key);
          entries.push(key);
          setStageAttr(ATTR_SCENE_FAILURES, entries.join(','));
        }
      }
      // Public diagnostic: scene id + phase + composition context +
      // mode + the resolver-rendered `event.message`. Wrapped in an `Error` so
      // existing `onError` consumers that call `err.message` keep
      // working. `event.cause` deliberately stays inside the resolver
      // — the loader never publishes it (ADR-028's "no raw causes"
      // rule).
      try {
        onError(new Error(renderMessage(event)));
      } catch {
        // `onError` is caller-supplied; an exception from it must not
        // propagate back through the resolver's `onSceneFailed`
        // invocation (the resolver would then re-route via the
        // composition-wide failure path and abort surviving scenes —
        // exactly the wrong behavior for a diagnostic sink throw).
      }
    };
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
    // PUL-Q009: render the public-surface diagnostic through the
    // bounded multi-cause walker so a preload failure (resolver wrap
    // around an asset-preloader AggregateError) surfaces the scene id
    // AND every failing declared asset path on `data-pulsar-navigation-error`
    // and in `onError`'s argument. When the walker has nothing extra
    // to add (a plain Error whose `.message` is already the full
    // story), pass the original through so consumers comparing error
    // identity / .message wording see no change.
    const rendered = describeErrorDetailed(err);
    const surfaced =
      err instanceof Error && err.message === rendered ? err : new Error(rendered, { cause: err });
    onError(surfaced);
    setStageAttr(ATTR_ERROR, rendered);
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
        // PUL-Q006: route the missing-beat diagnostic through the
        // canonical `formatSceneContext` helper so the scene-id +
        // beat-label fields come from the same structural seam
        // `buildOnSceneFailed.renderMessage` uses. Future context
        // (composition entry, occurrence index, mode) gets added at
        // the helper and reaches this surface for free.
        surfaceError(
          new Error(
            `beat positioning failed: ${formatSceneContext({ sceneId: headSceneId, beat })} — beat does not exist`,
          ),
        );
      } catch {
        // Intentionally empty: see comment above.
      }
    };
  };

  /**
   * Construct the per-navigation presenter pipeline:
   *  - `presenterAbort` — a separate `AbortController` whose signal
   *    drives the `PresenterController`'s teardown. Distinct from
   *    the navigation `controller` so the navigation signal can
   *    stay un-aborted across a successful completion (PUL-F013
   *    boundary). Wired to fire on navigation abort AND aborted by
   *    `runTarget`'s `finally` on normal completion.
   *  - `presenter` — the `PresenterController` itself (PUL-F020 /
   *    ADR-023), with the PUL-F025 audio handler attached.
   *
   * Both are `null` / `undefined` when the loader does NOT build a
   * controller for this navigation: non-present mode OR the workbench
   * did not supply a `presenterCommands` source. Hoisted out of
   * `buildLoad` to keep that function within Sonar's
   * cognitive-complexity budget.
   *
   * The PUL-F025 audio handler (presenter master mute / ADR-004)
   * lives here — the only seam where both the controller and the
   * per-navigation `AudioService` are in scope. On
   * `'toggle-master-mute'` it reads the engine's current master
   * mute and flips it via the audio boundary; `audio.mute()`
   * validates the boolean (PUL-F024) and is inert post-dispose.
   * Master mute is engine-level runtime state so the flip survives
   * scene cleanup and is observable by sibling services backed by
   * the same engine (pinned in `audio.test.ts`). The handler is
   * additive — the runner still receives every kind on its own
   * `input.presenter.subscribe(...)`. The controller's per-handler
   * `try/catch` already routes any throw through the same `onError`.
   */
  const buildPresenterPipe = (
    mode: NavigationMode,
    controller: AbortController,
    audio: AudioService,
  ): {
    readonly presenter: ReturnType<typeof createPresenterController> | undefined;
    readonly presenterAbort: AbortController | null;
  } => {
    if (mode !== 'present' || options.presenterCommands === undefined) {
      return { presenter: undefined, presenterAbort: null };
    }
    const presenterAbort = new AbortController();
    // Propagate navigation abort → presenter abort. Without this
    // wiring, supersession-time `controller.abort()` would not tear
    // down the presenter controller (bound to `presenterAbort.signal`,
    // not `controller.signal`).
    if (controller.signal.aborted) {
      presenterAbort.abort();
    } else {
      controller.signal.addEventListener('abort', () => presenterAbort.abort(), { once: true });
    }
    const presenter = createPresenterController(
      options.presenterCommands,
      presenterAbort.signal,
      onError,
    );
    // PUL-F025 / ADR-004 audio handler — see method header.
    presenter.subscribe((cmd) => {
      if (cmd.kind !== 'toggle-master-mute') return;
      audio.mute(!audio.isMuted());
    });
    return { presenter, presenterAbort };
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
  /**
   * PUL-F030 / ADR-029: build the per-navigation closure that calls
   * the workbench-supplied unlock adapter with the composition context
   * captured here and the navigation-bound signal + engine-bound
   * unlock callback supplied at gate-invocation time by `buildLoad`.
   * Partial application keeps the composition context out of the
   * `buildLoad` body so the latter stays within Sonar's cognitive-
   * complexity budget.
   *
   * Pure factory — captures only `adapter` and `composition`. The
   * adapter receives bounded semantic context: composition id, scene
   * ids in playback order, the navigation `AbortSignal`, and the
   * engine-bound `unlock()` callback. It does NOT receive scene
   * objects, source URLs, asset payloads, or Howler handles (per
   * ADR-029's "workbench gesture surface" guardrail).
   */
  const buildUnlockGate = (
    adapter: AudioUnlockAdapter,
    composition: SceneNavigationTarget['composition'] & object,
  ): UnlockGate => {
    const compositionId = composition.id;
    const sceneIds = Object.freeze(composition.sceneSlice.map((scene) => scene.id));
    return ({ signal, unlock }) =>
      adapter({
        compositionId,
        sceneIds,
        signal,
        unlock,
      });
  };

  /**
   * PUL-F030 / ADR-029: decide whether the present-mode audio unlock
   * gate applies to this navigation, and if so build the gate. Returns
   * one of:
   *
   *  - `null` — the gate does not apply (mode is not present, no
   *    composition slice, or no scene in the slice declares audio).
   *    The lifecycle runs without a prelude.
   *  - `'fail-loud'` — the gate applies but no `audioUnlockAdapter`
   *    is supplied. The caller surfaces a navigation-level error and
   *    skips the lifecycle.
   *  - `UnlockGate` — a closure that invokes the workbench adapter
   *    with the composition context. The lifecycle awaits it before
   *    preload / `create(ctx)` / `timeline(ctx)` / master playback.
   *
   * Hoisted out of `runTarget` so the latter stays within Sonar's
   * cognitive-complexity budget (S3776).
   */
  const resolveUnlockGate = (
    target: NavigationTarget,
    resolved: SceneNavigationTarget,
  ): UnlockGate | 'fail-loud' | null => {
    if (effectiveMode(target) !== 'present') return null;
    const composition = resolved.composition;
    if (composition === undefined) return null;
    if (!composition.sceneSlice.some(sceneDeclaresAudio)) return null;
    if (options.audioUnlockAdapter === undefined) return 'fail-loud';
    return buildUnlockGate(options.audioUnlockAdapter, composition);
  };

  /**
   * Composition-level chrome opt-out: when the head manifest entry's
   * `behavior.chrome === 'hidden'`, the deck owns its own atmospherics
   * and pulsar's chrome surface is hidden for the whole composition.
   * Clears any prior override when the deck doesn't declare it, so a
   * back-nav from a chrome-hidden deck to a chrome-on deck restores
   * the surface. Hoisted out of `buildLoad` to keep that function
   * within Sonar's cognitive-complexity budget (S3776).
   */
  const applyChromeOverride = (resolved: SceneNavigationTarget, mode: NavigationMode): void => {
    const chrome = options.chrome;
    if (chrome === undefined || chrome.setForcedVisibility === undefined) return;
    const head = resolved.composition?.manifestSlice[0];
    const headBehavior =
      head === null || typeof head !== 'object'
        ? undefined
        : (head as { readonly behavior?: { readonly chrome?: unknown } }).behavior;
    chrome.setForcedVisibility(headBehavior?.chrome === 'hidden' ? 'hidden' : null);
    chrome.applyMode(mode);
  };

  const buildLoad = (
    resolved: SceneNavigationTarget,
    target: NavigationTarget,
    unlockGate: UnlockGate | null,
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: existing pre-rule offender (cognitive complexity 18). buildLoad is the navigation-mode dispatch seam — derives effective mode, builds audio + presenter pipes, and threads abort signals; refactor tracked in docs/design/complexity-backlog.md.
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
    applyChromeOverride(resolved, mode);
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
    // PUL-F024 / PUL-F026 / ADR-004: the per-navigation audio service.
    // Built over `audioEngine`, scoped to `controller.signal` (abort ⇒
    // every sound stopped + unloaded), restricted to the URLs the slice
    // declared in `scene.audio` (PUL-F030 / ADR-029 — every audio entry
    // must also be in `scene.assets` so the preloader warmed it), and
    // with a per-mode `AudioOutputPolicy`:
    //  - `'silent'`   under `mode=screenshot` / `mode=paused` (audible
    //                 playback suppressed — ADR-019 / ADR-021).
    //  - `'log-cues'` under `mode=rehearsal` (audible playback
    //                 suppressed AND every accepted audio operation
    //                 is emitted to the workbench's optional
    //                 `onAudioCue` sink — PUL-F026 / ADR-004).
    //  - `'audible'`  otherwise (`present` / `standalone` / `loop` /
    //                 `scrub`).
    //
    // The rehearsal policy lives entirely on this audio-service seam
    // — there is no head-only runner-input hint, no slice truncation,
    // no resolver semantics — so "without altering timeline state"
    // (PUL-F026) is the structural invariant. The optional
    // `onAudioCue` sink is threaded through unconditionally; the
    // policy decides whether cues are emitted, so a non-rehearsal
    // navigation pays no per-op cost even when the workbench wired a
    // cue surface.
    //
    // Threaded into `ctx.audio` via `buildCtx`, alongside `mode`
    // (PUL-F012). Built AFTER the preloader so a preloader-factory
    // failure does not waste allocations, and wrapped in the same
    // rollback-then-surfaceError pattern so a throwing builder does
    // not leave stale stage attrs or skip the queue's error sink.
    const outputPolicy = audioOutputPolicyFor(mode);
    // PUL-F017 / ADR-020: under `mode=scrub` build the dynamic audio
    // cue gate ONCE and share the single instance between the audio
    // service (which consults `isEligible()` to suppress a cue's
    // output) and the timeline adapter (which toggles it by playhead
    // direction). It starts closed — a scrub master is held at its
    // cursor, not playing monotonically forward — and the GSAP adapter
    // opens it on `play()`. Absent for every other mode, so non-scrub
    // navigations build an ungated audio service exactly as before.
    const audioCueGate: CueGateControl | undefined =
      mode === 'scrub' ? createCueGate(false) : undefined;
    // issue #99: the loader threads a per-occurrence ctx factory rather
    // than a single ctx. `buildCtx` builds the navigation-scoped base
    // (stage / gsap / audio / mode / presenter / chrome) once; the
    // factory adds each occurrence's `SceneActivation` so a slice that
    // repeats a scene id gives every occurrence a distinct `ctx`.
    let buildSceneCtx: (activation: SceneActivation) => unknown;
    let audio: AudioService;
    // Per-navigation presenter pipe is built BEFORE buildCtx so the
    // controller can be threaded onto `ctx.presenter` for scenes that
    // subscribe to presenter `advance` commands directly (calgary-style
    // `while (!state.advanceSignal)` loop scenes). Declared here so the
    // try/catch can construct audio first (the pipe's mute handler
    // closes over audio), then ctx with both refs.
    let presenter: ReturnType<typeof createPresenterController> | undefined;
    let presenterAbort: AbortController | null = null;
    try {
      audio = createAudioService(audioEngine, {
        signal: controller.signal,
        outputPolicy,
        allowedSources: collectAudioSources(resolved),
        onError,
        ...(options.onAudioCue === undefined ? {} : { onCue: options.onAudioCue }),
        // PUL-F014 / ADR-004: the composition audio bed, played
        // underneath the slice — suppressed under `mode=standalone`,
        // where the scene runs as if no surrounding composition
        // existed. The resolver snapshots the declaration onto the
        // composition context; the loader is the mode-dispatch point
        // that decides bed vs no-bed, keeping the resolver mode-opaque.
        ...(resolved.composition?.audioBed === undefined
          ? {}
          : { bed: resolved.composition.audioBed }),
        bedSuppressed: mode === 'standalone',
        // PUL-F017 / ADR-020: the shared cue gate (scrub only). The
        // audio service consults it; the timeline adapter toggles it.
        ...(audioCueGate === undefined ? {} : { cueGate: audioCueGate }),
      });
      const pipe = buildPresenterPipe(mode, controller, audio);
      presenter = pipe.presenter;
      presenterAbort = pipe.presenterAbort;
      const baseCtx = options.buildCtx(mode, audio, presenter);
      buildSceneCtx = (activation) => ({ ...baseCtx, activation });
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
    // `presenter` / `presenterAbort` already built above (before
    // buildCtx) so the controller could be threaded onto `ctx.presenter`.
    const onSceneFailed = buildOnSceneFailed(
      controller.signal,
      mode,
      resolved.composition === undefined
        ? undefined
        : { id: resolved.composition.id, startIndex: resolved.composition.startIndex },
    );
    // PUL-F024 / ADR-004 + issue #99: occurrence-safe per-scene audio
    // teardown. A scene scopes a sound to itself with
    // `play(id, { group: <its-scene-id> })`; that group is shared by
    // every occurrence of the scene in the slice (`ctx.audio` is one
    // slice-scoped service). The runtime stops the group only when the
    // LAST occurrence of that id has been cleaned up — counting down
    // per scene id — so an earlier occurrence's cleanup never stops a
    // still-active sibling occurrence's audio. A single-occurrence
    // scene counts `1` and tears down on its only cleanup, unchanged.
    const remainingOccurrences = countSceneOccurrences(resolved);
    const onSceneCleaned = (activation: SceneActivation): void => {
      const left = (remainingOccurrences.get(activation.sceneId) ?? 1) - 1;
      remainingOccurrences.set(activation.sceneId, left);
      if (left <= 0) audio.stopGroup(activation.sceneId);
    };
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: existing pre-rule offender (cognitive complexity 21). runLifecycle wires every per-target option (preload, timeline, abort, presenter, screenshot, error envelope) into the scene-loader lifecycle; refactor tracked in docs/design/complexity-backlog.md.
    const runLifecycle = (): Promise<void> =>
      loadSceneNavigationTarget(resolved, {
        ctx: buildSceneCtx,
        preloadAssets,
        timeline: options.timeline,
        signal: controller.signal,
        ...(beat === undefined ? {} : { beat }),
        ...(onBeatMissing === undefined ? {} : { onBeatMissing }),
        ...(repeat === undefined ? {} : { repeat }),
        ...(hold === undefined ? {} : { hold }),
        ...(cueGate === undefined ? {} : { cueGate }),
        // PUL-F017 / ADR-020: the same gate handed to the audio service
        // above — the timeline adapter toggles it by playhead direction.
        ...(audioCueGate === undefined ? {} : { audioCueGate }),
        ...(screenshot === undefined ? {} : { screenshot }),
        // Forward `presenter` AND the `onError` sink so the
        // resolver's per-scene wrapper around `presenter` can
        // route runner-handler exceptions / unknown-kind drops
        // through the same diagnostic channel as every other
        // navigation-level error (codex review, cycle 2).
        ...(presenter === undefined ? {} : { presenter, onPresenterError: onError }),
        // PUL-F024 / ADR-004 + issue #99: runtime-guaranteed per-scene
        // audio teardown — see `onSceneCleaned` above. (`stopGroup` is
        // a no-op when the group is empty or the service is disposed.)
        onSceneCleaned,
        // PUL-F029 / ADR-028: scene-level error isolation. Each
        // isolated `create` / `timeline` / `cleanup` failure becomes
        // a stage attribute entry + `onError` call without halting
        // the active composition.
        onSceneFailed,
      });
    // PUL-F030 / ADR-029: when the gate applies, the settled promise
    // begins with the adapter await — the lifecycle runs only after
    // unlock succeeds AND the navigation has not been aborted. The
    // gate's signal IS the navigation signal, so supersession /
    // dispose / popstate aborts the gate; adapters that respect the
    // signal can reject deterministically. The audio service / ctx /
    // preloader are constructed BEFORE the gate (above), but none of
    // them touches the network or DOM until `loadSceneNavigationTarget`
    // calls `preloadAssets(scene)` and `create(ctx)` — so the gate
    // running first preserves the structural invariant "no lifecycle
    // work before unlock."
    const settled =
      unlockGate === null
        ? runLifecycle()
        : (async (): Promise<void> => {
            await unlockGate({
              signal: controller.signal,
              unlock: () => audioEngine.unlock(),
            });
            if (controller.signal.aborted) return;
            return runLifecycle();
          })();
    return {
      controller,
      settled,
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
        // PUL-F029 / ADR-028: preserve the absolute composition start
        // index even when the slice is truncated to its head, so a
        // failure diagnostic names the right manifest entry.
        startIndex: resolved.composition.startIndex,
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

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: existing pre-rule offender (cognitive complexity 23). runTarget is the per-navigation orchestrator — beat/mode grammar validation, dispatch routing across prompter / screenshot / present, and abort handling; refactor tracked in docs/design/complexity-backlog.md.
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
      // PUL-F030 / ADR-029: resolve the present-mode audio unlock
      // gate up front. The helper returns `'fail-loud'` when the gate
      // applies but no adapter is supplied (workbench-bootstrap
      // defect — the gate IS the structural defense), `null` when
      // the gate does not apply or there is no composition, and a
      // built unlock gate otherwise.
      const gateOrFailure = resolveUnlockGate(target, resolved);
      if (gateOrFailure === 'fail-loud') {
        resetStageAttrs();
        surfaceError(
          new Error(
            'audio unlock gate: present-mode composition declares audio but no audioUnlockAdapter was supplied — workbench bootstrap must wire one to satisfy PUL-F030 / ADR-029',
          ),
        );
        return;
      }
      load = buildLoad(runnable, target, gateOrFailure);
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

  /**
   * PUL-F031 / ADR-031: dispatch the workbench chrome surface for a
   * target event synchronously, returning any thrown error so the
   * caller can surface it after stage-attr reset.
   *
   * Called from {@link enqueue} BEFORE the queue serializes the event,
   * because chrome is workbench-owned and outside the scene-lifecycle
   * serialization invariant — flipping `present` → `standalone` /
   * `screenshot` MUST hide chrome immediately rather than waiting for
   * the prior load's `cleanup(ctx)` to drain (codex review, cycle 1,
   * one-off "suppressing-mode chrome updates wait for old cleanup").
   * The mode is re-validated through {@link validateModeGrammar} so a
   * forged `NavigationTarget` (non-parser caller) never reaches the
   * chrome adapter; `runTarget` will surface the same validation
   * error downstream so the operator sees one consistent diagnostic.
   *
   * Synchronous adapter throws (codex review, cycle 1, one-off
   * "chrome adapter failures bypass the loader error envelope") are
   * caught and routed through the same {@link surfaceError} envelope
   * as every other navigation diagnostic. `runOnce` defers the
   * surface until after `resetStageAttrs()` so the
   * `data-pulsar-navigation-error` attribute survives the post-abort
   * reset, AND skips the lifecycle for the failing event because
   * chrome is in an unknown state.
   */
  const dispatchChrome = (target: NavigationTarget): Error | null => {
    if (options.chrome === undefined) return null;
    if (validateModeGrammar(target) !== null) return null;
    try {
      options.chrome.applyMode(effectiveMode(target));
      return null;
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  };

  const runOnce = async (
    event: NavigationEvent,
    myGen: number,
    chromeErr: Error | null,
  ): Promise<void> => {
    // Drop superseded events before doing any visible work — both at
    // entry (handle → handle race) and after the abort-and-await yield
    // (slow cleanup observed by another enqueue). A chrome error from
    // a superseded enqueue is intentionally dropped here: the newer
    // event has already dispatched chrome (possibly successfully), so
    // the older error is moot.
    if (myGen !== generation || disposed) return;
    await abortAndAwait();
    if (myGen !== generation || disposed) return;
    resetStageAttrs();

    if (chromeErr !== null) {
      // Chrome dispatch failed at enqueue — surface through the same
      // envelope as grammar / resolution failures AND skip the
      // lifecycle for this event. Chrome is in an unknown state;
      // running scene lifecycle around an unsynchronized chrome
      // surface would compound the workbench bootstrap defect rather
      // than recover from it.
      surfaceError(chromeErr);
      return;
    }

    if (event.kind === 'error') {
      surfaceError(event.err);
      return;
    }
    await runTarget(event.target);
  };

  const enqueue = (event: NavigationEvent): Promise<void> => {
    if (disposed) return pending;
    // PUL-F031 / ADR-031: dispatch chrome SYNCHRONOUSLY at enqueue,
    // BEFORE the queue serializes. Workbench chrome is outside the
    // scene-lifecycle serialization invariant — a mode flip (present
    // → standalone) hides chrome immediately rather than waiting for
    // the prior load's cleanup. Errors are captured and forwarded to
    // `runOnce`, which surfaces them after `resetStageAttrs()` (so
    // the diagnostic attr is not wiped) and bails the lifecycle.
    const chromeErr = event.kind === 'target' ? dispatchChrome(event.target) : null;
    // Eagerly abort any in-flight load so the queued event can
    // proceed past `await load.settled` immediately. Without this, a
    // popstate-fired re-navigation would wait for the current load to
    // drain naturally — exactly the wrong behavior when the user
    // clicked back/forward.
    if (inFlight !== null) inFlight.controller.abort();
    const myGen = ++generation;
    pending = pending.then(
      () => runOnce(event, myGen, chromeErr),
      () => runOnce(event, myGen, chromeErr),
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
