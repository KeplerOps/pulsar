// Placeholder scene module — the runtime's first registered scene.
//
// PUL-F008's URL navigation requires at least one registered scene
// for `?scene=<id>` to resolve to anything. The placeholder scene
// gives the workbench an addressable target until requirement-driven
// scenes (talk content, demo scenes, fixtures) start landing in
// `src/scenes/`. It is the smallest scene module that satisfies the
// PUL-F001 contract: stable id, kebab-case format, the three
// lifecycle hooks, and metadata fields.
//
// The lifecycle hooks tag the workbench stage via a
// `data-pulsar-scene-lifecycle` attribute so reviewers, agents, and
// screenshot regression can verify that each phase ran. The DOM
// mutations are idempotent — `cleanup` removes the attribute so
// subsequent scene loads start from a clean state.
//
// The scene reads the stage handle out of `ctx`, NOT from the global
// `document`, so the lifecycle hooks are pure functions of their
// inputs and run unchanged in Node-side tests. The workbench bootstrap
// (`src/main.ts`) supplies the ctx; future scenes follow the same
// pattern.
//
// The scene is `standalone: true` (it does not assume surrounding
// composition context) and `trailerSafe: false` (it has nothing
// trailer-worthy to show).

import type { SceneModule } from '../runtime/scene';
import type { WorkbenchSceneCtx } from '../runtime/scene-loader';

const LIFECYCLE_ATTR = 'data-pulsar-scene-lifecycle';

const isWorkbenchCtx = (value: unknown): value is WorkbenchSceneCtx =>
  typeof value === 'object' && value !== null && 'stage' in value;

const writeLifecycle = (ctx: unknown, phase: 'create' | 'timeline' | 'cleanup'): void => {
  if (!isWorkbenchCtx(ctx)) return;
  const stage = ctx.stage;
  if (stage === null) return;
  if (phase === 'cleanup') {
    stage.removeAttribute(LIFECYCLE_ATTR);
    return;
  }
  stage.setAttribute(LIFECYCLE_ATTR, phase);
};

export const placeholderScene: SceneModule = {
  id: 'placeholder',
  title: 'Placeholder',
  duration: null,
  tags: ['placeholder'],
  assets: [],
  captions: [],
  defaultNext: null,
  standalone: true,
  trailerSafe: false,
  create: (ctx) => {
    writeLifecycle(ctx, 'create');
  },
  timeline: (ctx) => {
    writeLifecycle(ctx, 'timeline');
    return null;
  },
  cleanup: (ctx) => {
    writeLifecycle(ctx, 'cleanup');
  },
};
