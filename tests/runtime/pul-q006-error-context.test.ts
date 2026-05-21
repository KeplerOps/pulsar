// PUL-Q006 — Error surfacing context.
//
// Cross-surface invariant suite. When the runtime surfaces an error,
// the error message SHALL include the scene id and (where applicable)
// the beat label or the timeline phase (`create`, `timeline`,
// `cleanup`).
//
// Each `it(...)` pins one surface so a regression at any one seam
// fails its own assertion. The surfaces are:
//
//   1. `buildOnSceneFailed` -> `onError`, for `create` / `timeline` /
//      `cleanup` lifecycle failures (`scene-loader.ts`,
//      `composition-resolver.ts` SceneFailureEvent path).
//   2. `data-pulsar-scene-failures` stage attribute, which is the
//      structured `<sceneId>:<phase>` mirror of the same event stream.
//   3. `buildOnBeatMissing`, for the URL `beat=<label>` missing-label
//      diagnostic.
//   4. Resolver wrap when `onSceneFailed` is NOT supplied (the legacy
//      AggregateError fallback path) — scene id + phase live in the
//      wrapping message.
//   5. Resolver wrap for a `preload` throw — scene id present, no
//      phase keyword (preload is not one of the three named phases;
//      the requirement's "where applicable" carve-out applies).
//   6. `assertSceneTimeline` `SceneTimelineLabelError` — scene id +
//      beat label in the rendered message.
//   7. `assertSceneTimeline` invalid-time `SceneTimelineLabelError` —
//      scene id + beat label in the rendered message.

import { describe, expect, it, vi } from 'vitest';

import {
  type CompositionTimelineAdapter,
  resolveComposition,
} from '../../src/runtime/composition-resolver';
import { describeErrorDetailed, formatSceneContext } from '../../src/runtime/error';
import { createSceneRegistry } from '../../src/runtime/registry';
import type { SceneModule } from '../../src/runtime/scene';
import { SceneTimelineLabelError, assertSceneTimeline } from '../../src/runtime/timeline';
import {
  type LegacyRunInput,
  asTimeline,
  buildScene,
  buildStage,
  compositionTarget,
  createCompositionRegistry,
  createSceneLoader,
  gsap,
  noopTimeline,
  sceneTarget,
  stubCtx,
} from './scene-loader.helpers';

// ---------------------------------------------------------------------------
// Surface 1 — `buildOnSceneFailed` -> `onError` (lifecycle failures)
// ---------------------------------------------------------------------------

describe('PUL-Q006 — lifecycle failure (onError)', () => {
  it.each(['create', 'timeline', 'cleanup'] as const)(
    'includes scene id and phase keyword "%s"',
    async (phase) => {
      const onError = vi.fn();
      const explode = (): never => {
        throw new Error('boom');
      };
      const overrides: Partial<SceneModule> = {};
      if (phase === 'create') overrides.create = explode;
      if (phase === 'timeline') overrides.timeline = explode;
      if (phase === 'cleanup') overrides.cleanup = explode;
      const broken = buildScene({ id: 'broken', ...overrides });
      const loader = createSceneLoader({
        scenes: createSceneRegistry([broken]),
        compositions: createCompositionRegistry([]),
        stage: buildStage().element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: noopTimeline,
        onError,
      });

      await loader.handle(sceneTarget('broken'));

      expect(onError).toHaveBeenCalled();
      const args = onError.mock.calls.map(([err]) => (err as Error).message);
      const message = args.find((m) => m.includes(`failed during ${phase}`));
      expect(message).toBeDefined();
      expect(message).toContain('scene "broken"');
      expect(message).toContain(`failed during ${phase}`);
    },
  );
});

// ---------------------------------------------------------------------------
// Surface 2 — `data-pulsar-scene-failures` stage attribute
// ---------------------------------------------------------------------------

describe('PUL-Q006 — scene-failures stage attribute', () => {
  it('renders <sceneId>:<phase> so the structured surface carries scene id and phase', async () => {
    const stage = buildStage();
    const broken = buildScene({
      id: 'broken',
      create: () => {
        throw new Error('boom');
      },
    });
    const loader = createSceneLoader({
      scenes: createSceneRegistry([broken]),
      compositions: createCompositionRegistry([]),
      stage: stage.element,
      buildCtx: stubCtx,
      createPreloader: () => () => undefined,
      timeline: noopTimeline,
      onError: () => undefined,
    });

    await loader.handle(sceneTarget('broken'));

    expect(stage.attrs.get('data-pulsar-scene-failures')).toBe('broken:create');
  });
});

// ---------------------------------------------------------------------------
// Surface 3 — `buildOnBeatMissing`
// ---------------------------------------------------------------------------

describe('PUL-Q006 — missing beat (onError)', () => {
  it('includes scene id and beat label', async () => {
    const onError = vi.fn();
    const stage = buildStage();
    const intro = buildScene({ id: 'intro' });
    const loader = createSceneLoader({
      scenes: createSceneRegistry([intro]),
      compositions: createCompositionRegistry([]),
      stage: stage.element,
      buildCtx: stubCtx,
      createPreloader: () => () => undefined,
      timeline: asTimeline((input: LegacyRunInput) => {
        input.onBeatMissing?.();
      }),
      onError,
    });

    await loader.handle({ locator: { kind: 'scene', scene: 'intro' }, beat: 'unknown-label' });

    const messages = onError.mock.calls.map(([err]) => (err as Error).message);
    const beatMessage = messages.find((m) => m.includes('beat positioning failed'));
    expect(beatMessage).toBeDefined();
    expect(beatMessage).toContain('scene "intro"');
    expect(beatMessage).toContain('beat "unknown-label"');
  });
});

// ---------------------------------------------------------------------------
// Surface 4 — resolver wrap (legacy aggregate path, no `onSceneFailed`)
// ---------------------------------------------------------------------------

describe('PUL-Q006 — resolver wrap (no onSceneFailed)', () => {
  it.each(['create', 'timeline', 'cleanup'] as const)(
    'wraps a scene "%s" throw so the rendered chain carries scene id and phase',
    async (phase) => {
      const explode = (): never => {
        throw new Error('kaboom');
      };
      const overrides: Partial<SceneModule> = {};
      if (phase === 'create') overrides.create = explode;
      if (phase === 'timeline') overrides.timeline = explode;
      if (phase === 'cleanup') overrides.cleanup = explode;
      const broken = buildScene({ id: 'broken', ...overrides });
      const registry = createSceneRegistry([broken]);
      const timeline: CompositionTimelineAdapter = { run: () => Promise.resolve() };

      // Without an `onSceneFailed` callback, the resolver re-raises an
      // AggregateError whose `errors[0]` is the per-scene wrap. The
      // public surface (`describeErrorDetailed`, used by
      // `scene-loader.surfaceError`) walks both — both the top-level
      // wrap AND the per-finding wrap must reach the operator.
      let caught: unknown;
      try {
        await resolveComposition({
          registry,
          manifest: ['broken'],
          ctx: () => undefined,
          preloadAssets: () => undefined,
          timeline,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AggregateError);
      const rendered = describeErrorDetailed(caught);
      expect(rendered).toContain('scene "broken"');
      expect(rendered).toContain(`${phase} threw`);
    },
  );
});

// ---------------------------------------------------------------------------
// Surface 5 — resolver wrap (preload throw, no phase clause)
// ---------------------------------------------------------------------------

describe('PUL-Q006 — resolver wrap (preload throw)', () => {
  it('includes scene id; preload is not a named lifecycle phase so no phase clause is required', async () => {
    const intro = buildScene({ id: 'intro' });
    const registry = createSceneRegistry([intro]);
    const timeline: CompositionTimelineAdapter = { run: () => Promise.resolve() };

    await expect(
      resolveComposition({
        registry,
        manifest: ['intro'],
        ctx: () => undefined,
        preloadAssets: () => {
          throw new Error('preload kaboom');
        },
        timeline,
      }),
    ).rejects.toThrow(/composition resolution failed: scene "intro" preloadAssets threw:/);
  });
});

// ---------------------------------------------------------------------------
// Surface 6 — `assertSceneTimeline` invalid beat label
// ---------------------------------------------------------------------------

describe('PUL-Q006 — assertSceneTimeline (invalid beat label)', () => {
  it('throws with scene id and the offending beat label in the message', () => {
    const tl = gsap.timeline({ paused: true });
    tl.to({}, { duration: 1 });
    tl.addLabel('Not Kebab', 0.5);
    try {
      assertSceneTimeline(tl, 'intro');
      throw new Error('expected SceneTimelineLabelError');
    } catch (err) {
      expect(err).toBeInstanceOf(SceneTimelineLabelError);
      const message = (err as Error).message;
      expect(message).toContain('scene "intro"');
      expect(message).toContain('"Not Kebab"');
      // Phase keyword "timeline" present in the prose.
      expect(message).toContain('timeline');
    }
  });
});

// ---------------------------------------------------------------------------
// Surface 7 — `assertSceneTimeline` beat time out of range
// ---------------------------------------------------------------------------

describe('PUL-Q006 — assertSceneTimeline (invalid beat time)', () => {
  it('throws with scene id and the offending beat label in the message', () => {
    const tl = gsap.timeline({ paused: true });
    tl.to({}, { duration: 1 });
    tl.addLabel('peak', 99);
    try {
      assertSceneTimeline(tl, 'intro');
      throw new Error('expected SceneTimelineLabelError');
    } catch (err) {
      expect(err).toBeInstanceOf(SceneTimelineLabelError);
      const message = (err as Error).message;
      expect(message).toContain('scene "intro"');
      expect(message).toContain('"peak"');
      expect(message).toContain('timeline');
    }
  });
});

// ---------------------------------------------------------------------------
// `formatSceneContext` is the canonical helper; surface-level templates
// that compose it programmatically should produce the same shape.
// ---------------------------------------------------------------------------

describe('PUL-Q006 — formatSceneContext as the canonical seam', () => {
  it('produces a prefix that contains the scene id', () => {
    expect(formatSceneContext({ sceneId: 'intro' })).toContain('scene "intro"');
  });

  it('produces a prefix that contains scene id and phase keyword', () => {
    const prefix = formatSceneContext({ sceneId: 'intro', phase: 'create' });
    expect(prefix).toContain('scene "intro"');
    expect(prefix).toContain('create');
  });

  it('produces a prefix that contains scene id and beat label', () => {
    const prefix = formatSceneContext({ sceneId: 'intro', beat: 'hook' });
    expect(prefix).toContain('scene "intro"');
    expect(prefix).toContain('"hook"');
  });

  it('renders the occurrence ordinal for a repeated scene id and stays bare for occurrence 0 (issue #99)', () => {
    // Occurrence 0 (first / only use) renders identically to a
    // single-occurrence scene — single-occurrence diagnostics are
    // unchanged.
    expect(formatSceneContext({ sceneId: 'intro', occurrence: 0 })).toBe('scene "intro"');
    expect(formatSceneContext({ sceneId: 'intro', phase: 'create', occurrence: 0 })).toBe(
      formatSceneContext({ sceneId: 'intro', phase: 'create' }),
    );
    // A later occurrence carries the ordinal so repeated scene ids are
    // distinguishable on the public diagnostic surface.
    const repeated = formatSceneContext({ sceneId: 'intro', phase: 'create', occurrence: 2 });
    expect(repeated).toContain('scene "intro"');
    expect(repeated).toContain('occurrence 2');
    expect(repeated).toContain('create');
  });

  it('produces a prefix that contains scene id when used by the loader (cleanup failures during a composition)', async () => {
    const onError = vi.fn();
    const intro = buildScene({
      id: 'intro',
      cleanup: () => {
        throw new Error('cleanup boom');
      },
    });
    const loader = createSceneLoader({
      scenes: createSceneRegistry([intro]),
      compositions: createCompositionRegistry([{ id: 'mix', manifest: ['intro'] }]),
      stage: buildStage().element,
      buildCtx: stubCtx,
      createPreloader: () => () => undefined,
      timeline: noopTimeline,
      onError,
    });

    await loader.handle(compositionTarget('mix'));

    const messages = onError.mock.calls.map(([err]) => (err as Error).message);
    const cleanupMessage = messages.find((m) => m.includes('failed during cleanup'));
    expect(cleanupMessage).toBeDefined();
    expect(cleanupMessage).toContain('scene "intro"');
    expect(cleanupMessage).toContain('failed during cleanup');
    expect(cleanupMessage).toContain('cleanup boom');
  });
});
