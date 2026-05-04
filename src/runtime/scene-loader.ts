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

import type { CompositionRegistry } from './composition-registry';
import type { AssetPreloader, SceneTimelineRunner } from './composition-resolver';
import { describeError } from './error';
import { KEBAB_IDENTIFIER_FORM, isKebabIdentifier } from './identifier';
import type { NavigationTarget } from './navigation';
import type { SceneRegistry } from './registry';
import {
  type SceneNavigationTarget,
  loadSceneNavigationTarget,
  resolveSceneNavigation,
} from './scene-navigation';

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
 * Future requirements (timeline engine, audio engine, mode dispatch)
 * extend this shape with `gsap`, `audio`, `mode`, etc. per ADR-003 /
 * ADR-004 / ADR-007. The runtime resolver itself never inspects
 * ctx — it is purely a scene-to-environment carrier.
 */
export interface WorkbenchSceneCtx {
  /** The workbench stage element, or `null` when the runtime has no stage. */
  readonly stage: StageElement | null;
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
  /** Opaque scene context forwarded to every lifecycle hook. */
  readonly ctx: unknown;
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
  /** Timeline-execution adapter — see {@link SceneTimelineRunner}. */
  readonly runTimeline: SceneTimelineRunner;
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
 * One in-flight load: the abort signal that cancels it, the promise
 * that settles when the lifecycle ends (or rejects on abort), and the
 * abort-detection flag used to suppress the "rejection is an error"
 * branch when the rejection was an intentional abort.
 */
interface InFlightLoad {
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  /** Set when `dispose()` aborted the load — suppresses error UI on dispose. */
  silent: boolean;
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
      // runner is forbidden from throwing or rejecting on missing
      // labels (the resolver would treat that as a lifecycle failure
      // and unmount the scene). The injected `onError` sink is
      // user-supplied, so an exception from it would propagate back
      // through the runner's `onBeatMissing()` invocation, into the
      // resolver's `await runTimeline(...)`, and trigger the
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
    beat: string | undefined,
  ): InFlightLoad | null => {
    const controller = new AbortController();
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
    const onBeatMissing = buildOnBeatMissing(beat, resolved.scene.id, controller.signal);
    return {
      controller,
      settled: loadSceneNavigationTarget(resolved, {
        ctx: options.ctx,
        preloadAssets,
        runTimeline: options.runTimeline,
        signal: controller.signal,
        ...(beat === undefined ? {} : { beat }),
        ...(onBeatMissing === undefined ? {} : { onBeatMissing }),
      }),
      silent: false,
    };
  };

  const runTarget = async (target: NavigationTarget): Promise<void> => {
    const beatErr = validateBeatGrammar(target);
    if (beatErr !== null) {
      surfaceError(beatErr);
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

    const load = buildLoad(resolved, target.beat);
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
