// Workbench entry — bootstraps Pulsar's runtime and activates URL
// navigation per PUL-F008 + ADR-013.
//
// Lifecycle on every load:
//
//  1. Mark the `#stage` element so the placeholder background is
//     visible while the runtime decides what (if anything) to load.
//  2. Build the scene and composition registries from the bundled
//     scene/composition modules. Both registries are immutable after
//     construction (ADR-008 #2 "manifests over flow control").
//  3. Parse `globalThis.location` once via
//     `resolveSceneNavigationTarget`. URL state is authoritative
//     (ADR-013) — no localStorage / cookie fallback.
//  4. When a navigation target resolves, record the addressed scene
//     id (and composition id, when present) on the stage so reviewers
//     and agents can verify the URL was honored, then drive the scene
//     through the existing composition resolver lifecycle via
//     `loadSceneNavigationTarget`. PUL-F005's asset preloader provides
//     the preload adapter; the timeline runner is a placeholder until
//     ADR-003's GSAP runner lands.
//  5. Surface any URL parse, registry-miss, or lifecycle error to the
//     console so invalid URLs and broken scenes fail loudly per
//     ADR-013's "no silent fallback" principle.

import { defaultComposition } from './compositions/default';
import { createAssetPreloader } from './runtime/asset-preloader';
import { createCompositionRegistry } from './runtime/composition-registry';
import type { SceneTimelineRunner } from './runtime/composition-resolver';
import { createSceneRegistry } from './runtime/registry';
import {
  type SceneNavigationTarget,
  loadSceneNavigationTarget,
  resolveSceneNavigationTarget,
} from './runtime/url-navigation';
import { placeholderScene } from './scenes/placeholder';

const stage = document.querySelector('#stage');
stage?.setAttribute('data-pulsar', 'placeholder');

const sceneRegistry = createSceneRegistry([placeholderScene]);
const compositionRegistry = createCompositionRegistry([
  { id: 'default', manifest: defaultComposition },
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

let target: SceneNavigationTarget | null = null;
try {
  target = resolveSceneNavigationTarget(globalThis.location, sceneRegistry, compositionRegistry);
} catch (err) {
  console.error(err);
}

if (target !== null) {
  stage?.setAttribute('data-pulsar-scene-target', target.scene.id);
  if (target.composition !== undefined) {
    stage?.setAttribute('data-pulsar-composition-target', target.composition.id);
  }

  try {
    await loadSceneNavigationTarget(target, {
      ctx: {},
      preloadAssets,
      runTimeline,
    });
  } catch (err) {
    console.error(err);
  }
}
