// Workbench entry — bootstraps Pulsar's runtime and activates URL
// navigation per PUL-F007 (URL grammar parser) + PUL-F008 (scene
// navigation dispatch) + ADR-007 + ADR-013 + ADR-014.
//
// Lifecycle:
//
//  1. Mark the `#stage` element so the placeholder background is
//     visible while the runtime decides what (if anything) to load.
//  2. Build the scene and composition registries from the bundled
//     scene/composition modules. Both registries are immutable after
//     construction (ADR-008 #2 "manifests over flow control").
//  3. Build a `SceneLoader` (PUL-F008) wired to those registries plus
//     the lifecycle adapters (PUL-F005 asset preloader; placeholder
//     timeline runner until ADR-003's GSAP runner lands).
//  4. Subscribe to the parsed-target events PUL-F007's
//     `bootstrapNavigation` dispatches: `pulsar:navigate` carries a
//     parsed `NavigationTarget`, `pulsar:navigate-error` carries a
//     grammar `Error`. Both are translated into loader calls so URL
//     parameters are honored at startup and on every `popstate`
//     (ADR-007).
//  5. Vite HMR re-evaluating the entry module disposes the previous
//     popstate listener AND the loader's in-flight load, so re-eval
//     does not stack duplicate listeners or strand a half-loaded
//     scene.

import { DEFAULT_COMPOSITION_ID, defaultComposition } from './compositions/default';
import { createAssetPreloader } from './runtime/asset-preloader';
import { createCompositionRegistry } from './runtime/composition-registry';
import type { SceneTimelineRunner } from './runtime/composition-resolver';
import {
  type NavigationMode,
  type NavigationTarget,
  PULSAR_NAVIGATE_ERROR_EVENT_TYPE,
  PULSAR_NAVIGATE_EVENT_TYPE,
  bootstrapNavigation,
} from './runtime/navigation';
import { createSceneRegistry } from './runtime/registry';
import { type WorkbenchSceneCtx, createSceneLoader } from './runtime/scene-loader';
import { placeholderScene } from './scenes/placeholder';

const stage = document.querySelector('#stage');
stage?.setAttribute('data-pulsar', 'placeholder');

const sceneRegistry = createSceneRegistry([placeholderScene]);
const compositionRegistry = createCompositionRegistry([
  { id: DEFAULT_COMPOSITION_ID, manifest: defaultComposition },
]);

// PUL-F005 asset preloader. The placeholder scene declares no assets,
// so the preloader is a structural no-op today; once scenes start
// declaring URLs the same wire-up validates schemes, fetches, and
// stream-drains them ahead of `create(ctx)`. The factory shape lets
// the loader build a fresh preloader per navigation with an
// `AbortSignal` that cancels the in-flight `fetch` calls when the
// user clicks back/forward mid-preload.
const createPreloader = (signal: AbortSignal): ReturnType<typeof createAssetPreloader> =>
  createAssetPreloader({ init: { signal } });

// Timeline runner placeholder. The composition resolver awaits the
// runner before invoking `cleanup(ctx)`, so a runner that resolves
// immediately would cause every URL-loaded scene to mount and clean
// up in the same turn — the addressed scene would not stay on stage
// after startup. The placeholder instead resolves only when the
// per-navigation `AbortSignal` aborts (popstate, dispose, or a new
// handle()), so each loaded scene remains active until the next
// navigation. ADR-003's GSAP runner replaces this slot when the
// timeline engine lands; until then this stand-in honors the
// "scene stays loaded between navigations" workbench expectation.
//
// PUL-F011 / ADR-015: when the URL carries `beat=<label>`, the runner
// is responsible for label existence. The placeholder timeline returns
// `null` (no labels), so EVERY URL beat is a missing-label diagnostic
// by definition — `input.onBeatMissing?.()` is the correct response
// here. The runner does NOT throw or reject; the loader's callback
// writes `data-pulsar-navigation-error` and the scene stays mounted at
// its initial timeline position. ADR-003's GSAP runner replaces this
// stand-in with `timeline.labels[input.beat]`-style seeking when the
// engine lands; until then the placeholder honestly reports "no
// labels" rather than silently ignoring the URL.
//
// Abort ordering: the abort check runs BEFORE the missing-beat
// diagnostic so a navigation that was superseded between
// `scene.timeline(ctx)` resolution and the runner's first turn does
// not surface a stale diagnostic for a disposed/aborted load.
const runTimeline: SceneTimelineRunner = (input) =>
  new Promise<void>((resolve) => {
    if (input.signal?.aborted === true) {
      resolve();
      return;
    }
    if (input.beat !== undefined) {
      input.onBeatMissing?.();
    }
    if (input.signal === undefined) {
      // No abort path was wired (e.g. test harness without a
      // signal); treat as a no-op so we don't wait forever.
      resolve();
      return;
    }
    input.signal.addEventListener(
      'abort',
      () => {
        resolve();
      },
      { once: true },
    );
  });

// Scene context carries the stage handle plus the per-navigation
// effective workbench mode (PUL-F012 / ADR-007). The loader calls
// this builder once per navigation that produces a runnable target,
// passing the effective mode it derived from the URL via
// `effectiveMode`. Constructing ctx per navigation enforces ADR-007's
// "URL is the only source of mode" rule by construction — there is no
// long-lived ctx slot for a previous mode to linger in. ADR-008 #2
// (explicit dependencies over ambient globals) is satisfied as before
// by passing `stage` through ctx rather than reaching for `document`.
const buildCtx = (mode: NavigationMode): WorkbenchSceneCtx => ({ stage, mode });

const loader = createSceneLoader({
  scenes: sceneRegistry,
  compositions: compositionRegistry,
  stage,
  buildCtx,
  createPreloader,
  runTimeline,
});

const onNavigate = (event: Event): void => {
  const target = (event as CustomEvent<NavigationTarget>).detail;
  void loader.handle(target);
};
const onNavigateError = (event: Event): void => {
  loader.handleError((event as CustomEvent<Error>).detail);
};

globalThis.addEventListener(PULSAR_NAVIGATE_EVENT_TYPE, onNavigate);
globalThis.addEventListener(PULSAR_NAVIGATE_ERROR_EVENT_TYPE, onNavigateError);

const disposeNavigation = bootstrapNavigation(globalThis);

// Dev-only: when Vite HMR replaces this entry module, dispose the
// previous popstate listener AND the loader's in-flight load so
// re-evaluation does not stack duplicate listeners or strand a
// half-loaded scene. `import.meta.hot` is undefined in production
// builds.
import.meta.hot?.dispose(() => {
  disposeNavigation();
  globalThis.removeEventListener(PULSAR_NAVIGATE_EVENT_TYPE, onNavigate);
  globalThis.removeEventListener(PULSAR_NAVIGATE_ERROR_EVENT_TYPE, onNavigateError);
  loader.dispose();
});
