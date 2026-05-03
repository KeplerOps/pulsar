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

import { describeError } from './error';
import type { NavigationTarget } from './navigation';
import {
  type LoadSceneNavigationTargetOptions,
  type ResolveSceneNavigationOptions,
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
export interface SceneLoaderOptions
  extends ResolveSceneNavigationOptions,
    Omit<LoadSceneNavigationTargetOptions, 'signal'> {
  /** May be `null` when the workbench has no stage (rare; e.g. Node tests). */
  readonly stage: StageElement | null;
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

export function createSceneLoader(options: SceneLoaderOptions): SceneLoader {
  const { stage } = options;
  const onError = options.onError ?? ((err) => console.error(err));
  let inFlight: InFlightLoad | null = null;
  let disposed = false;
  // `pending` chains every navigation so concurrent calls run in
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

  const runOnce = async (target: NavigationTarget): Promise<void> => {
    // Cancel any in-flight load and wait for its cleanup before
    // starting fresh. This is the popstate-during-load path.
    await abortAndAwait();
    if (disposed) return;
    resetStageAttrs();

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

    const controller = new AbortController();
    const load: InFlightLoad = {
      controller,
      settled: loadSceneNavigationTarget(resolved, {
        ctx: options.ctx,
        preloadAssets: options.preloadAssets,
        runTimeline: options.runTimeline,
        signal: controller.signal,
      }),
      silent: false,
    };
    inFlight = load;

    try {
      await load.settled;
    } catch (err) {
      // Don't surface an error caused by our own abort — the new
      // navigation that triggered it owns the visible state.
      if (!load.silent && !load.controller.signal.aborted) {
        surfaceError(err);
      }
    } finally {
      if (inFlight === load) inFlight = null;
    }
  };

  const enqueue = (target: NavigationTarget): Promise<void> => {
    if (disposed) return pending;
    // Abort the in-flight load eagerly so the queued navigation can
    // proceed past `await load.settled` immediately. Without this,
    // a popstate-fired re-navigation would wait for the current load
    // to drain naturally — which is exactly the wrong behavior when
    // the user clicked back/forward.
    if (inFlight !== null) inFlight.controller.abort();
    pending = pending.then(
      () => runOnce(target),
      () => runOnce(target),
    );
    return pending;
  };

  const handleError = (err: unknown): void => {
    if (disposed) return;
    // Parse errors don't queue against the navigation chain — they
    // surface immediately on the stage so reviewers see the broken
    // URL even if a previous scene is still mid-cleanup. Reset
    // success-state attrs so the stage doesn't lie about which scene
    // is loaded.
    clearStageAttr(ATTR_SCENE);
    clearStageAttr(ATTR_COMPOSITION);
    surfaceError(err);
  };

  return {
    handle: enqueue,
    handleError,
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
