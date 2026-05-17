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

import { NAVIGATION_MODES } from '../runtime/navigation';
import type { SceneModule } from '../runtime/scene';
import type { WorkbenchSceneCtx } from '../runtime/scene-loader';

const LIFECYCLE_ATTR = 'data-pulsar-scene-lifecycle';

// PUL-F012 added `mode`; PUL-F022 added `gsap` (ADR-003). The
// placeholder scene only reads `ctx.stage` (and validates `mode`
// defensively), so the predicate narrows to that subset — `stage`
// must be `null` or an object exposing `setAttribute` /
// `removeAttribute`, and `mode` must be in `NAVIGATION_MODES`.
// Narrowing on a partial stage check would pass a malformed
// `{ stage: {}, mode: 'present' }` that later crashes inside
// `writeLifecycle` when it tries to call `stage.setAttribute`,
// contradicting the no-op-on-malformed-ctx contract these scene hooks
// document. `ctx.gsap` is not validated here because this scene does
// not touch it — a future scene that builds a timeline validates
// `gsap` in its own ctx predicate.
type PlaceholderCtx = Pick<WorkbenchSceneCtx, 'stage' | 'mode'>;

const isStageShape = (stage: unknown): stage is WorkbenchSceneCtx['stage'] => {
  if (stage === null) return true;
  if (typeof stage !== 'object') return false;
  const candidate = stage as Partial<Record<'setAttribute' | 'removeAttribute', unknown>>;
  return (
    typeof candidate.setAttribute === 'function' && typeof candidate.removeAttribute === 'function'
  );
};

const isWorkbenchCtx = (value: unknown): value is PlaceholderCtx => {
  if (typeof value !== 'object' || value === null) return false;
  if (!('stage' in value) || !('mode' in value)) return false;
  const { stage, mode } = value;
  if (!isStageShape(stage)) return false;
  return typeof mode === 'string' && (NAVIGATION_MODES as readonly string[]).includes(mode);
};

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
  audio: [],
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
