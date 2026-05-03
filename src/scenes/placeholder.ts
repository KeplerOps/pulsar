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
// The lifecycle hooks tag the `#stage` element via a `data-pulsar-
// scene-lifecycle` attribute so reviewers, agents, and screenshot
// regression can verify that each phase ran. The DOM mutations are
// idempotent — `cleanup` removes the attribute so subsequent scene
// loads start from a clean state.
//
// The scene is `standalone: true` (it does not assume surrounding
// composition context) and `trailerSafe: false` (it has nothing
// trailer-worthy to show).

import type { SceneModule } from '../runtime/scene';

const STAGE_SELECTOR = '#stage';
const LIFECYCLE_ATTR = 'data-pulsar-scene-lifecycle';

const writeLifecycle = (phase: 'create' | 'timeline' | 'cleanup'): void => {
  // The scene runs in the browser; in Node-side tests `document` is
  // undefined, so guard rather than crash.
  if (typeof document === 'undefined') return;
  const stage = document.querySelector(STAGE_SELECTOR);
  if (phase === 'cleanup') {
    stage?.removeAttribute(LIFECYCLE_ATTR);
    return;
  }
  stage?.setAttribute(LIFECYCLE_ATTR, phase);
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
  create: () => {
    writeLifecycle('create');
  },
  timeline: () => {
    writeLifecycle('timeline');
    return null;
  },
  cleanup: () => {
    writeLifecycle('cleanup');
  },
};
