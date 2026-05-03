// Workbench entry — bootstraps Pulsar's runtime and activates URL
// navigation per PUL-F008 + ADR-013 + ADR-007.
//
// Lifecycle:
//
//  1. Mark the `#stage` element so the placeholder background is
//     visible while the runtime decides what (if anything) to load.
//  2. Build the scene and composition registries from the bundled
//     scene/composition modules. Both registries are immutable after
//     construction (ADR-008 #2 "manifests over flow control").
//  3. Hand them to a `WorkbenchNavigator` along with the lifecycle
//     adapters (PUL-F005 asset preloader; placeholder timeline runner
//     until ADR-003's GSAP runner lands). The navigator owns URL
//     parsing at startup AND on `popstate` (ADR-007), abort-and-
//     restart coordination so back/forward navigation cleans up the
//     active scene before the next one starts, and stage attribute
//     bookkeeping so reviewers/agents/screenshot automation can
//     observe what the runtime navigated to and any URL errors.
//  4. Trigger the initial navigation. Subsequent navigations fire
//     automatically via the popstate listener registered by the
//     navigator.

import { DEFAULT_COMPOSITION_ID, defaultComposition } from './compositions/default';
import { createAssetPreloader } from './runtime/asset-preloader';
import { createCompositionRegistry } from './runtime/composition-registry';
import type { SceneTimelineRunner } from './runtime/composition-resolver';
import { createSceneRegistry } from './runtime/registry';
import {
  type WorkbenchHost,
  type WorkbenchSceneCtx,
  createWorkbenchNavigator,
} from './runtime/workbench-navigator';
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

// Cast `globalThis` to the structural `WorkbenchHost` shape: in
// browsers `globalThis === window`, so `addEventListener('popstate',
// ...)` and `location` are present, but the `globalThis` type alone
// does not advertise them. A targeted structural cast is preferred
// over `window` to keep the bootstrap portable to non-browser hosts
// that polyfill the same surface.
const host = globalThis as unknown as WorkbenchHost;

const navigator = createWorkbenchNavigator({
  host,
  stage,
  sceneRegistry,
  compositionRegistry,
  ctx,
  preloadAssets,
  runTimeline,
});

await navigator.navigate();
