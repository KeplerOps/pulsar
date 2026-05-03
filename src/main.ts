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
// stream-drains them ahead of `create(ctx)`.
const preloadAssets = createAssetPreloader();

// Timeline runner placeholder. The composition resolver awaits the
// runner before invoking `cleanup(ctx)`, so an empty runner cleanly
// completes the lifecycle. ADR-003's GSAP runner replaces this slot
// when the timeline engine lands.
const runTimeline: SceneTimelineRunner = () => undefined;

// Scene context carries the stage handle so scene lifecycle hooks
// can mutate the DOM through an injected dependency rather than
// reaching for the global `document` (ADR-008 #2 — explicit
// dependencies over ambient globals).
const ctx: WorkbenchSceneCtx = { stage };

const loader = createSceneLoader({
  scenes: sceneRegistry,
  compositions: compositionRegistry,
  stage,
  ctx,
  preloadAssets,
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
