// Scene loader — PUL-F008 (ADR-007 / ADR-013 / ADR-014).
//
// Drives parsed PUL-F007 `NavigationTarget`s through the
// scene-navigation dispatcher and composition-resolver lifecycle. Owns
// stage-attribute observability (ADR-013 "no silent fallback"),
// abort + cleanup-before-handoff, and a serialized navigation queue. It
// does NOT parse URLs (PUL-F007) or resolve scenes (`scene-navigation.ts`).

import type { AssetUrlPolicy } from './asset-preloader';
import {
  type AudioCueLogEntry,
  type AudioEngine,
  type AudioService,
  type CueGateControl,
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
import { profileFor } from './mode-profile';
import {
  type NavigationMode,
  type NavigationTarget,
  effectiveMode,
  validateBeatGrammar,
  validateModeGrammar,
} from './navigation';
import type { PresenterCommandSource, PresenterController } from './presenter';
import {
  type PrompterDispose,
  type PrompterRenderer,
  type PrompterScript,
  buildPrompterScript,
} from './prompter';
import type { SceneRegistry } from './registry';
import {
  buildNavigationServices,
  countSceneOccurrences,
  deriveNavigationSeed,
} from './scene-loader-ctx';
import {
  type AudioUnlockAdapter,
  type AudioUnlockContext,
  type UnlockGate,
  type WorkbenchChromeAdapter,
  applyChromeForTarget,
  resolveUnlockGate,
} from './scene-loader-guard';
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

/** Optional L2 chrome slot refs (template consumption only; engine stays L2-agnostic). */
export type WorkbenchChromeSlots = Readonly<Record<string, unknown>>;

/**
 * Scene context the workbench passes to every lifecycle hook. The
 * resolver never inspects it — it is purely a scene-to-environment
 * carrier. Stage / gsap / audio are injected dependencies so scenes
 * stay free of ambient `document` / GSAP / Howler globals (ADR-008 #2).
 */
export interface WorkbenchSceneCtx {
  /** The workbench stage element, or `null` when the runtime has no stage. */
  readonly stage: StageElement | null;
  /**
   * Per-navigation presenter controller (`mode=present` only). Auto-detaches
   * on the navigation `AbortSignal` so a forgetful subscriber cannot leak.
   */
  readonly presenter?: PresenterController;
  /** Optional L2 chrome slot refs; `undefined` for stage-only scenes. */
  readonly chrome?: WorkbenchChromeSlots;
  /** Effective workbench mode for this navigation (PUL-F012 / ADR-007). */
  readonly mode: NavigationMode;
  /** GSAP instance for `timeline(ctx)` (PUL-F022 / ADR-003); never imported directly. */
  readonly gsap: TimelineEngine['gsap'];
  /**
   * Per-navigation audio service (PUL-F024 / ADR-004); `silent` under
   * `mode=screenshot` / `mode=paused`. One service per navigation: shared
   * across the composition slice under `mode=present`, so sound ids and the
   * source allowlist are slice-scoped. A scene's `group` is scene-scoped
   * across repeated occurrences (issue #99); the loader stops the group only
   * after the LAST occurrence's `cleanup(ctx)`, never cutting a live sibling.
   */
  readonly audio: AudioService;
  /**
   * Deterministic seeded RNG (PUL-F018 / ADR-021), replacing the
   * PUL-Q001-banned `Math.random`. Seeded from bounded URL inputs (see
   * {@link deriveNavigationSeed}), never the clock/storage/process state, so
   * screenshot frames replay identically. Loader-contributed per occurrence:
   * each occurrence gets its own seed, so `buildCtx` omits `rng`.
   */
  readonly rng: () => number;
  /**
   * Stable per-occurrence identity (issue #99): `{ sceneId, entryIndex,
   * occurrence }`. Lets a scene own its occurrence's DOM/state without
   * colliding with a sibling occurrence of the same module (`occurrence` 0
   * = first/only use). Loader-contributed, so `buildCtx` omits it.
   */
  readonly activation: SceneActivation;
}

/**
 * Inputs to {@link createSceneLoader}. The loader does not own the
 * registries or lifecycle adapters; the caller injects them so they
 * stay swappable across bootstrap, screenshot tests, and Node automation.
 */
export interface SceneLoaderOptions {
  readonly scenes: SceneRegistry;
  readonly compositions: CompositionRegistry;
  /** May be `null` when the workbench has no stage (rare; e.g. Node tests). */
  readonly stage: StageElement | null;
  /**
   * Per-navigation scene-context builder (PUL-F012 / ADR-007: mode dispatch
   * lives at this seam). Called once per runnable navigation; the loader
   * adds each occurrence's `activation` (issue #99) and seeded `rng`
   * (PUL-F018) on top, so the return type omits both.
   */
  readonly buildCtx: (
    mode: NavigationMode,
    audio: AudioService,
    presenter?: PresenterController,
  ) => Omit<WorkbenchSceneCtx, 'activation' | 'rng'>;
  /**
   * Audio engine (PUL-F024 / ADR-004), a process singleton. Optional;
   * falls back to {@link import('./audio').noopAudioEngine} (silent) — an
   * inert seam, like {@link renderPrompter} / {@link presenterCommands}.
   */
  readonly audioEngine?: AudioEngine;
  /**
   * Asset URL policy shared with validation, preloading, and runtime audio
   * checks, so composition audio beds cannot bypass it when validation was
   * skipped.
   */
  readonly assetPolicy?: AssetUrlPolicy;
  /**
   * Cue-log sink (PUL-F026 / ADR-004). Threaded to each audio service; the
   * per-navigation output policy gates emission (`log-cues` under rehearsal,
   * `silent` under screenshot/paused). Optional inert seam when undefined.
   */
  readonly onAudioCue?: (entry: AudioCueLogEntry) => void;
  /**
   * Build a per-navigation asset preloader bound to that navigation's abort
   * signal, so back/forward during a long preload aborts in-flight fetches.
   */
  readonly createPreloader: (signal: AbortSignal) => AssetPreloader;
  /** Timeline composition/playback adapter — see {@link CompositionTimelineAdapter}. */
  readonly timeline: CompositionTimelineAdapter;
  /**
   * Captions renderer for `mode=prompter` (PUL-F019 / ADR-022). Contract:
   * a renderer that mounts persistent DOM MUST keep its promise pending
   * until `signal.aborted` and register teardown on abort — returning early
   * would orphan the captions UI (the loader clears `inFlight` once a load
   * settles, leaving nothing to drive cleanup). No-DOM stubs may return
   * synchronously. Optional inert seam when undefined; lifecycle suppression
   * (no preload/create/timeline/cleanup) is the PUL-F019 structural defense.
   */
  readonly renderPrompter?: PrompterRenderer;
  /**
   * Presenter command source (PUL-F020 / ADR-023; pause/resume via
   * PUL-F021 / ADR-024). Lives across navigations. Wrapped in a
   * per-navigation controller bound to the navigation signal ONLY when
   * `effectiveMode === 'present'` (ADR-007), so subscriptions cannot leak.
   * Optional inert seam when undefined.
   */
  readonly presenterCommands?: PresenterCommandSource;
  /**
   * Sink for navigation errors. Defaults to `console.error`; injectable so
   * tests observe logging without monkey-patching `console`. Errors still
   * surface on `data-pulsar-navigation-error` regardless.
   */
  readonly onError?: (err: unknown) => void;
  /**
   * Unlock adapter (PUL-F030 / ADR-029): collects one user gesture and
   * resolves once autoplay policy is satisfied. Invoked BEFORE preload /
   * create / timeline / playback so a present-mode composition never begins
   * with a suspended `AudioContext`. Triggered only when
   * `effectiveMode === 'present'` AND the target carries a composition slice
   * AND a scene declares audio; bound to the navigation signal; given
   * bounded semantic context only (ids, signal, one-shot `unlock()`), never
   * scene objects or URLs. When triggered with no adapter supplied the
   * loader fails loud (the gate IS the defense) — otherwise an inert seam.
   */
  readonly audioUnlockAdapter?: AudioUnlockAdapter;
  /**
   * Chrome controller (PUL-F031 / ADR-031). The loader calls
   * `applyMode(effectiveMode(target))` once per navigation, BEFORE
   * lifecycle work, so chrome visibility tracks the mode without flashing
   * an un-chromed frame. The single call is upstream of the per-scene loop,
   * so chrome persists across a composition's scenes. Chrome is
   * workbench-owned (ADR-007 / ADR-016 / PUL-A008); scenes never see a
   * handle. Optional inert seam when undefined.
   */
  readonly chrome?: WorkbenchChromeAdapter;
}

// Re-exported from `./scene-loader-guard` to keep the loader's public surface stable.
export type { AudioUnlockAdapter, AudioUnlockContext, WorkbenchChromeAdapter };

/**
 * Returned by {@link createSceneLoader}. `handle(target)` cancels any
 * in-flight load, awaits its cleanup, then runs the new target.
 * `idle()` drains the queue (tests). `dispose()` cancels the in-flight
 * load silently. `handleError(err)` records a parse failure on the
 * stage + `onError` without touching the lifecycle.
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
// PUL-F029 / ADR-028: per-scene lifecycle failures, kept separate from the
// fatal navigation-error surface. Comma-separated `<sceneId>:<phase>` in
// encounter order; occurrence > 0 namespaces as `<sceneId>#<n>:<phase>` (#99).
const ATTR_SCENE_FAILURES = 'data-pulsar-scene-failures';

/** Resolve when `signal` is aborted (or immediately if already aborted). */
function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/**
 * True when `err` is the resolver's own "aborted" wrapper for `signal` —
 * a rejection a new event intentionally caused. `AggregateError`s are
 * NOT pure aborts: cleanup failures during an aborted lifecycle must
 * still surface to the operator.
 */
function isPureAbort(err: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted &&
    err instanceof Error &&
    !(err instanceof AggregateError) &&
    /aborted/.test(err.message)
  );
}

// PUL-F018 / ADR-021: deterministic RNG seed seam (in `./scene-loader-ctx`),
// re-exported so the unit-test seam stays addressable on the loader's surface.
export { deriveNavigationSeed };

/** One in-flight load. `audio`/`presenterAbort` are `null` for prompter loads. */
interface InFlightLoad {
  readonly controller: AbortController;
  /** Settles when the lifecycle ends, or rejects on abort. */
  readonly settled: Promise<void>;
  /** Set when `dispose()` aborted the load — suppresses error UI on dispose. */
  silent: boolean;
  /** The navigation's audio service, so the loader can `stopAll()` on completion. */
  readonly audio: AudioService | null;
  /**
   * Separate signal for the presenter controller (PUL-F025 / ADR-023):
   * the navigation `controller` stays un-aborted on the happy path
   * (PUL-F013), while this aborts on supersession OR normal completion,
   * giving presenter subscriptions deterministic teardown on every path.
   */
  readonly presenterAbort: AbortController | null;
}

/**
 * One queued navigation event. Both kinds flow through the same queue so
 * cleanup-before-handoff and latest-event supersession apply uniformly to
 * PUL-F007's `pulsar:navigate` and `pulsar:navigate-error` events.
 */
type NavigationEvent =
  | { readonly kind: 'target'; readonly target: NavigationTarget }
  | { readonly kind: 'error'; readonly err: unknown };

export function createSceneLoader(options: SceneLoaderOptions): SceneLoader {
  const { stage } = options;
  const onError = options.onError ?? ((err) => console.error(err));
  // PUL-F024 / ADR-004: silent no-op engine when no backend is wired.
  const audioEngine = options.audioEngine ?? noopAudioEngine;
  let inFlight: InFlightLoad | null = null;
  let disposed = false;
  // Latest-event generation: every enqueue bumps it; queued events whose
  // generation is no longer current skip themselves, so a B→C race while A
  // is in flight does not run a superseded B.
  let generation = 0;
  // Chains every navigation event so handlers run in submission order
  // without overlapping stage mutations.
  let pending: Promise<void> = Promise.resolve();

  const resetStageAttrs = (): void => {
    stage?.removeAttribute(ATTR_SCENE);
    stage?.removeAttribute(ATTR_COMPOSITION);
    stage?.removeAttribute(ATTR_ERROR);
    stage?.removeAttribute(ATTR_SCENE_FAILURES);
  };

  /**
   * Build the per-navigation `onSceneFailed` handler (PUL-F029 / ADR-028).
   * Augments the public diagnostic with composition id + mode; `event.cause`
   * stays programmatic and is never serialized (ADR-028: no raw causes).
   * Entries dedup per (id, occurrence, phase) in encounter order (#99).
   *
   * Two-tier suppression: stage-attr writes are suppressed on `signal.aborted`
   * (a superseded navigation must not stomp the new state) or `disposed`;
   * `onError` still fires on abort (cleanup-phase failures stay visible) and
   * is suppressed only when fully `disposed`.
   */
  const buildOnSceneFailed = (
    signal: AbortSignal,
    mode: NavigationMode,
    composition: { readonly id: string; readonly startIndex: number } | undefined,
  ): ((event: SceneFailureEvent) => void) => {
    const entries: string[] = [];
    const seen = new Set<string>();
    const renderMessage = (event: SceneFailureEvent): string => {
      // PUL-Q006 / ADR-028: scene id + phase + occurrence via the canonical
      // `formatSceneContext` helper (occurrence 0 renders bare).
      const prefix = formatSceneContext({
        sceneId: event.sceneId,
        phase: event.phase,
        occurrence: event.occurrence,
      });
      // Absolute composition entry index (slice start + slice-relative): a
      // mid-manifest slice would otherwise name the wrong entry.
      const compositionSuffix =
        composition === undefined
          ? ''
          : ` (composition "${composition.id}" entry [${composition.startIndex + event.entryIndex}])`;
      return `${prefix}${compositionSuffix} under mode "${mode}": ${event.message}`;
    };
    return (event: SceneFailureEvent): void => {
      if (disposed) return;
      if (!signal.aborted) {
        // issue #99: namespace by occurrence via the canonical
        // `sceneSegmentLabel` (occurrence 0 renders bare) so repeated-id
        // failures in the same phase stay distinguishable.
        const key = `${sceneSegmentLabel(event.sceneId, event.occurrence)}:${event.phase}`;
        if (!seen.has(key)) {
          seen.add(key);
          entries.push(key);
          stage?.setAttribute(ATTR_SCENE_FAILURES, entries.join(','));
        }
      }
      try {
        onError(new Error(renderMessage(event)));
      } catch {
        // A caller-supplied `onError` throw must not propagate back through
        // the resolver's `onSceneFailed` (which would abort surviving scenes).
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
    // PUL-Q009: render through the bounded multi-cause walker so a preload
    // AggregateError surfaces the scene id + every failing asset path. When
    // the walker adds nothing, pass the original through unchanged so
    // consumers comparing error identity / .message see no change.
    const rendered = describeErrorDetailed(err);
    const surfaced =
      err instanceof Error && err.message === rendered ? err : new Error(rendered, { cause: err });
    onError(surfaced);
    stage?.setAttribute(ATTR_ERROR, rendered);
  };

  /**
   * PUL-F011 / ADR-015: non-fatal callback for `beat=<label>` misses.
   * Writes the diagnostic without throwing, so a missing label does NOT
   * reject the resolver (which would unmount the scene). Returns
   * `undefined` when no beat was supplied. Guarded by `signal.aborted`
   * (a stale runner must not write for a superseded navigation),
   * `disposed`, and a once-only `fired` flag.
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
      // Swallow so the surface stays non-fatal even if the caller-supplied
      // `onError` throws (which would otherwise reach the resolver's
      // `timeline.run` await and trigger cleanup-then-throw — PUL-F011).
      try {
        // PUL-Q006: route through the canonical `formatSceneContext` helper.
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

  // Instance deps for `buildNavigationServices` (`./scene-loader-ctx`),
  // bound once and reused per navigation.
  const navigationServicesDeps = {
    audioEngine,
    ...(options.assetPolicy ? { assetPolicy: options.assetPolicy } : {}),
    ...(options.onAudioCue ? { onAudioCue: options.onAudioCue } : {}),
    ...(options.presenterCommands ? { presenterCommands: options.presenterCommands } : {}),
    onError,
    buildCtx: options.buildCtx,
  };

  /**
   * Composition-level chrome policy (PUL-F031 / ADR-031), bound to this
   * loader's chrome adapter + registries. No-op when no chrome adapter
   * was supplied. See `applyChromeForTarget` in `./scene-loader-guard`.
   */
  const dispatchChromeForTarget = (target: NavigationTarget): void => {
    const chrome = options.chrome;
    if (chrome === undefined) return;
    applyChromeForTarget(
      chrome,
      { scenes: options.scenes, compositions: options.compositions },
      target,
    );
  };

  /**
   * Build the resolver run-input for one navigation: ctx factory,
   * preloader, beat callbacks, mode-profile runner hints, scrub cue gate,
   * presenter controller, occurrence-safe audio teardown, and scene-level
   * failure isolation (PUL-F029). See {@link loadSceneNavigationTarget}.
   */
  const buildRunInput = (
    resolved: SceneNavigationTarget,
    services: ReturnType<typeof buildNavigationServices>,
    preloadAssets: AssetPreloader,
    signal: AbortSignal,
    mode: NavigationMode,
    beat: string | undefined,
    audioCueGate: CueGateControl | undefined,
  ): Parameters<typeof loadSceneNavigationTarget>[1] => {
    const onBeatMissing = buildOnBeatMissing(beat, resolved.scene.id, signal);
    const onSceneFailed = buildOnSceneFailed(
      signal,
      mode,
      resolved.composition === undefined
        ? undefined
        : { id: resolved.composition.id, startIndex: resolved.composition.startIndex },
    );
    // issue #99: occurrence-safe per-scene audio teardown — the
    // scene-scoped group is stopped only when the LAST occurrence of
    // that id has been cleaned up.
    const remainingOccurrences = countSceneOccurrences(resolved);
    const onSceneCleaned = (activation: SceneActivation): void => {
      const left = (remainingOccurrences.get(activation.sceneId) ?? 1) - 1;
      remainingOccurrences.set(activation.sceneId, left);
      if (left <= 0) services.audio.stopGroup(activation.sceneId);
    };
    return {
      ctx: services.buildSceneCtx,
      preloadAssets,
      timeline: options.timeline,
      signal,
      ...(beat === undefined ? {} : { beat }),
      ...(onBeatMissing ? { onBeatMissing } : {}),
      // Head-scene runner hints from the mode profile; empty for modes
      // that set none.
      ...profileFor(mode).runnerHints,
      ...(audioCueGate ? { audioCueGate } : {}),
      ...(services.presenter ? { presenter: services.presenter, onPresenterError: onError } : {}),
      onSceneCleaned,
      onSceneFailed,
    };
  };

  const buildLoad = (
    resolved: SceneNavigationTarget,
    target: NavigationTarget,
    unlockGate: UnlockGate | null,
  ): InFlightLoad | null => {
    const controller = new AbortController();
    // PUL-F012 / ADR-007: re-derive mode from the parsed target (URL-only)
    // every navigation, so a previous non-`present` mode cannot leak.
    const mode = effectiveMode(target);
    const profile = profileFor(mode);
    let preloadAssets: AssetPreloader;
    try {
      preloadAssets = options.createPreloader(controller.signal);
    } catch (err) {
      // Roll back the success-state attrs so the stage doesn't lie.
      resetStageAttrs();
      surfaceError(err);
      return null;
    }
    // PUL-F017 / ADR-020: one cue gate shared between the audio service and
    // the timeline adapter under `mode=scrub`. Starts closed; the GSAP
    // adapter opens it on `play()`.
    const audioCueGate: CueGateControl | undefined = profile.buildScrubCueGate
      ? createCueGate(false)
      : undefined;
    // Build the per-navigation services AFTER the preloader, same
    // rollback-then-surface pattern. Abort the controller first on throw so
    // any signal-tied resource observes cancellation rather than leaking.
    let services: ReturnType<typeof buildNavigationServices>;
    try {
      services = buildNavigationServices(
        navigationServicesDeps,
        resolved,
        target,
        mode,
        controller,
        audioCueGate,
      );
    } catch (err) {
      controller.abort();
      resetStageAttrs();
      surfaceError(err);
      return null;
    }
    const runInput = buildRunInput(
      resolved,
      services,
      preloadAssets,
      controller.signal,
      mode,
      target.beat,
      audioCueGate,
    );
    const runLifecycle = (): Promise<void> => loadSceneNavigationTarget(resolved, runInput);
    // PUL-F030 / ADR-029: when the gate applies, the lifecycle runs only
    // after unlock succeeds and the navigation has not been aborted. No
    // service above touches the network/DOM until the lifecycle starts, so
    // gating first preserves the "no lifecycle work before unlock" invariant.
    const settled =
      unlockGate === null
        ? runLifecycle()
        : runGatedLifecycle(unlockGate, controller, runLifecycle);
    return {
      controller,
      settled,
      silent: false,
      audio: services.audio,
      presenterAbort: services.presenterAbort,
    };
  };

  /**
   * PUL-F030 / ADR-029: await the unlock gate, then run the lifecycle
   * only if the navigation has not been superseded.
   */
  const runGatedLifecycle = async (
    unlockGate: UnlockGate,
    controller: AbortController,
    runLifecycle: () => Promise<void>,
  ): Promise<void> => {
    await unlockGate({ signal: controller.signal, unlock: () => audioEngine.unlock() });
    if (controller.signal.aborted) return;
    return runLifecycle();
  };

  /**
   * Truncate the validated composition slice to its addressed head entry
   * for single-scene modes (standalone / loop / paused / scrub /
   * screenshot — PUL-F014..F018, ADR-017..021). This makes "no following
   * entries run" a structural guarantee independent of the runner-side
   * hint. TRUNCATED rather than dropped so the head entry's `range` /
   * `behavior` overrides (ADR-002 / ADR-011) still reach the runner. The
   * caller's stage attrs reflect what the URL ADDRESSED, not what runs.
   */
  const applySingleSceneSlice = (
    resolved: SceneNavigationTarget,
    target: NavigationTarget,
  ): SceneNavigationTarget => {
    const mode = effectiveMode(target);
    if (!profileFor(mode).singleScene || resolved.composition === undefined) {
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
        ...(resolved.composition.audioBed ? { audioBed: resolved.composition.audioBed } : {}),
        // PUL-F029 / ADR-028: preserve the absolute composition start
        // index even when the slice is truncated to its head, so a
        // failure diagnostic names the right manifest entry.
        startIndex: resolved.composition.startIndex,
      },
    };
  };

  /**
   * Run a `mode=prompter` dispatch: invoke the renderer; if it returned a
   * {@link PrompterDispose} callback, park until abort then run it.
   */
  const dispatchPrompter = async (
    renderer: PrompterRenderer,
    script: PrompterScript,
    signal: AbortSignal,
  ): Promise<void> => {
    const result = await renderer(script, signal);
    if (typeof result !== 'function') {
      // Nothing persistent mounted — dispatch is complete; do not park.
      return;
    }
    // Renderer mounted persistent state: park until abort, then dispose.
    const dispose: PrompterDispose = result;
    await waitForAbort(signal);
    await dispose();
  };

  /**
   * PUL-F019 / ADR-022: build the in-flight record for a `mode=prompter`
   * dispatch. Routes through the captions data path INSTEAD of the resolver
   * lifecycle (no preload/create/timeline/cleanup — the structural defense).
   * Resolves immediately when `renderPrompter` is undefined.
   */
  const buildPrompterLoad = (resolved: SceneNavigationTarget): InFlightLoad => {
    const controller = new AbortController();
    const renderer = options.renderPrompter;
    // No scene mounts under prompter, so there is no audio service (`null`).
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

  /**
   * Dispatch a non-prompter load: truncate the slice for single-scene
   * modes (PUL-F014..F018), resolve the present-mode unlock gate
   * (PUL-F030), and build the load. Returns `null` when the gate fails
   * loud (no adapter supplied) or the load builder bailed.
   */
  const dispatchLifecycleLoad = (
    resolved: SceneNavigationTarget,
    target: NavigationTarget,
  ): InFlightLoad | null => {
    const runnable = applySingleSceneSlice(resolved, target);
    const gateOrFailure = resolveUnlockGate(options.audioUnlockAdapter, target, resolved);
    if (gateOrFailure === 'fail-loud') {
      resetStageAttrs();
      surfaceError(
        new Error(
          'audio unlock gate: present-mode composition declares audio but no audioUnlockAdapter was supplied — workbench bootstrap must wire one to satisfy PUL-F030 / ADR-029',
        ),
      );
      return null;
    }
    return buildLoad(runnable, target, gateOrFailure);
  };

  /**
   * Await the in-flight load to settle, then run the per-navigation
   * teardown exactly once. Suppresses only the resolver's own "aborted"
   * wrapper (the superseding event owns the visible state); every other
   * error — including multi-fault `AggregateError`s — still surfaces.
   */
  const awaitLoad = async (load: InFlightLoad): Promise<void> => {
    try {
      await load.settled;
    } catch (err) {
      if (!load.silent && !isPureAbort(err, load.controller.signal)) {
        surfaceError(err);
      }
    } finally {
      // PUL-F024 / ADR-004: navigation over — stop + unload its sounds (idempotent).
      load.audio?.stopAll();
      // PUL-F025 / ADR-023: tear down presenter subscriptions on the happy
      // path via the separate `presenterAbort` signal, so the navigation
      // signal's "un-aborted on success" invariant (PUL-F013) is preserved.
      load.presenterAbort?.abort();
      if (inFlight === load) inFlight = null;
    }
  };

  const runTarget = async (target: NavigationTarget): Promise<void> => {
    // Defense-in-depth grammar re-check for programmatic targets (ADR-013
    // beat / ADR-007 mode); the parser already enforces these on URL input.
    const grammarErr = validateBeatGrammar(target) ?? validateModeGrammar(target);
    if (grammarErr !== null) {
      surfaceError(grammarErr);
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

    stage?.setAttribute(ATTR_SCENE, resolved.scene.id);
    if (resolved.composition !== undefined) {
      stage?.setAttribute(ATTR_COMPOSITION, resolved.composition.id);
    }

    // PUL-F019 / ADR-022: `mode=prompter` bypasses the resolver lifecycle
    // (no scene mounts) and routes through the captions data path instead.
    const load =
      effectiveMode(target) === 'prompter'
        ? buildPrompterLoad(resolved)
        : dispatchLifecycleLoad(resolved, target);
    if (load === null) return;
    inFlight = load;
    await awaitLoad(load);
  };

  /**
   * PUL-F031 / ADR-031: dispatch chrome synchronously, returning any
   * thrown error for the caller to surface after stage-attr reset.
   *
   * Called from {@link enqueue} BEFORE the queue serializes, because
   * chrome is outside the scene-lifecycle serialization invariant — a
   * `present` → `standalone` / `screenshot` flip MUST hide chrome
   * immediately, not after the prior load's `cleanup(ctx)` drains. Mode
   * is re-validated so a forged target never reaches the adapter; adapter
   * throws route through {@link surfaceError} and skip the lifecycle
   * (chrome is in an unknown state).
   */
  const dispatchChrome = (target: NavigationTarget): Error | null => {
    if (options.chrome === undefined) return null;
    if (validateModeGrammar(target) !== null) return null;
    try {
      dispatchChromeForTarget(target);
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
    // Drop superseded events before any visible work — at entry and after
    // the abort-and-await yield. A superseded enqueue's chrome error is
    // moot (the newer event already dispatched chrome).
    if (myGen !== generation || disposed) return;
    await abortAndAwait();
    if (myGen !== generation || disposed) return;
    resetStageAttrs();

    if (chromeErr !== null) {
      // Chrome dispatch failed at enqueue — surface and skip the lifecycle;
      // chrome is in an unknown state.
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
    // PUL-F031 / ADR-031: dispatch chrome SYNCHRONOUSLY at enqueue, before
    // the queue serializes, so a mode flip hides chrome immediately rather
    // than after the prior load's cleanup. Errors are forwarded to `runOnce`.
    const chromeErr = event.kind === 'target' ? dispatchChrome(event.target) : null;
    // Eagerly abort any in-flight load so the queued event proceeds past
    // `await load.settled` immediately (popstate back/forward must not wait).
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
