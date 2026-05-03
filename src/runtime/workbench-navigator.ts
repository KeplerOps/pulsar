// Workbench navigator — PUL-F008 + ADR-007.
//
// The navigator is the testable unit `src/main.ts` calls. It owns:
//
//  - URL resolution at startup (PUL-F008's "when `scene` is present").
//  - URL resolution on `popstate` (ADR-007's "the runtime parses URL
//    parameters at startup AND on popstate").
//  - Stage attribute coordination so reviewers, agents, and screenshot
//    automation can inspect what the runtime navigated to (or what
//    error a malformed URL produced — ADR-013's "no silent fallback").
//  - Lifecycle abort + dependency on the previous scene's cleanup
//    completing before the next scene starts. Implemented via an
//    `AbortController` per navigation so popstate always sees a clean
//    handoff: the previous scene's `cleanup(ctx)` runs before the new
//    scene's preload begins.
//
// The navigator deliberately depends on injected `host` / `stage`
// surfaces rather than `window` / `document` directly so the entire
// state machine is unit-testable in Node's vitest environment with
// no DOM polyfills.
//
// References:
//  - PUL-F008 — when `scene` is present, load the addressed scene.
//  - ADR-007 — runtime parses URL parameters at startup AND popstate;
//    URL parameters fully determine state (no localStorage / cookies).
//  - ADR-013 — no silent fallback; navigation errors surface visibly.

import type { CompositionRegistry } from './composition-registry';
import type { AssetPreloader, SceneTimelineRunner } from './composition-resolver';
import { describeError } from './error';
import type { SceneRegistry } from './registry';
import { type SceneNavigationTarget, resolveSceneNavigationTarget } from './url-navigation';
import { loadSceneNavigationTarget } from './url-navigation-bridge';

/** The minimal subset of `window` the navigator needs. */
export interface WorkbenchHost {
  /** Source of truth for URL state — `globalThis.location` in production. */
  readonly location: { readonly search: string };
  addEventListener(event: 'popstate', handler: () => void): void;
  removeEventListener(event: 'popstate', handler: () => void): void;
}

/** The minimal subset of an HTMLElement the navigator writes to. */
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
 * extend this shape with `gsap`, `audio`, `mode`, etc. Per ADR-003 /
 * ADR-004 / ADR-007. The runtime resolver itself never inspects
 * ctx — it is purely a scene-to-environment carrier.
 */
export interface WorkbenchSceneCtx {
  /** The workbench stage element, or `null` when the runtime has no stage. */
  readonly stage: StageElement | null;
}

/**
 * Inputs to {@link createWorkbenchNavigator}. The navigator does not
 * own the registries or the lifecycle adapters; the caller provides
 * them so they stay swappable across browser bootstrap, screenshot
 * tests, and Node-side automation.
 */
export interface WorkbenchNavigatorOptions {
  readonly host: WorkbenchHost;
  /** May be `null` when the workbench has no stage (rare; e.g. Node tests). */
  readonly stage: StageElement | null;
  readonly sceneRegistry: SceneRegistry;
  readonly compositionRegistry: CompositionRegistry;
  readonly ctx: unknown;
  readonly preloadAssets: AssetPreloader;
  readonly runTimeline: SceneTimelineRunner;
  /**
   * Sink for navigation errors (URL parse failure, registry miss,
   * lifecycle phase throw). Defaults to `console.error` in production
   * but is injectable so tests can observe error logging without
   * monkey-patching `console`. Errors are still surfaced to the stage
   * via `data-pulsar-navigation-error` regardless of this hook.
   */
  readonly onError?: (err: unknown) => void;
}

/**
 * Returned by {@link createWorkbenchNavigator}. The caller invokes
 * `navigate()` once at startup; subsequent `popstate` events trigger
 * automatic re-navigation. Use `idle()` to wait for any in-flight or
 * queued navigation to settle (e.g. in tests). Use `dispose()` to
 * remove the popstate listener and abort any in-flight load.
 */
export interface WorkbenchNavigator {
  navigate(): Promise<void>;
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

export function createWorkbenchNavigator(options: WorkbenchNavigatorOptions): WorkbenchNavigator {
  const { host, stage } = options;
  const onError = options.onError ?? ((err) => console.error(err));
  let inFlight: InFlightLoad | null = null;
  // `pending` chains every `navigate()` so popstate-fired and direct
  // calls run in submission order without overlapping.
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

  const runOnce = async (): Promise<void> => {
    // Cancel any in-flight load and wait for its cleanup before
    // starting fresh. This is the popstate-during-load path.
    await abortAndAwait();
    resetStageAttrs();

    let target: SceneNavigationTarget | null;
    try {
      target = resolveSceneNavigationTarget(
        host.location,
        options.sceneRegistry,
        options.compositionRegistry,
      );
    } catch (err) {
      onError(err);
      setStageAttr(ATTR_ERROR, describeError(err));
      return;
    }

    if (target === null) return;

    setStageAttr(ATTR_SCENE, target.scene.id);
    if (target.composition !== undefined) {
      setStageAttr(ATTR_COMPOSITION, target.composition.id);
    }

    const controller = new AbortController();
    const load: InFlightLoad = {
      controller,
      settled: loadSceneNavigationTarget(target, {
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
        onError(err);
        setStageAttr(ATTR_ERROR, describeError(err));
      }
    } finally {
      if (inFlight === load) inFlight = null;
    }
  };

  const enqueue = (): Promise<void> => {
    // Abort the in-flight load eagerly so the queued navigation can
    // proceed past `await load.settled` immediately. Without this,
    // a popstate-fired re-navigation would wait for the current load
    // to drain naturally — which is exactly the wrong behavior when
    // the user clicked back/forward.
    if (inFlight !== null) inFlight.controller.abort();
    pending = pending.then(runOnce, runOnce);
    return pending;
  };

  const onPopState = (): void => {
    void enqueue();
  };
  host.addEventListener('popstate', onPopState);

  return {
    navigate: enqueue,
    idle: () => pending,
    dispose: () => {
      host.removeEventListener('popstate', onPopState);
      if (inFlight !== null) {
        inFlight.silent = true;
        inFlight.controller.abort();
      }
    },
  };
}
