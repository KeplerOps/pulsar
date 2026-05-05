// PUL-F008 scene loader — state machine that consumes PUL-F007's
// `NavigationTarget` events and drives the lifecycle.
//
// Exercises the loader's queue + abort + stage-attribute coordination
// without any DOM dependency. The loader is the testable unit
// `src/main.ts` calls once it has F007's parsed target.
//
// References:
//  - PUL-F008 — load the addressed scene through the lifecycle.
//  - ADR-014 — scene navigation dispatch + cleanup-before-handoff.
//  - ADR-013 — URL grammar boundary; F007 supplies NavigationTarget.

import { describe, expect, it, vi } from 'vitest';
import { createCompositionRegistry } from '../../src/runtime/composition-registry';
import type { SceneTimelineRunner } from '../../src/runtime/composition-resolver';
import {
  NAVIGATION_MODES,
  type NavigationMode,
  type NavigationTarget,
} from '../../src/runtime/navigation';
import { createSceneRegistry } from '../../src/runtime/registry';
import type { SceneModule } from '../../src/runtime/scene';
import {
  type StageElement,
  type WorkbenchSceneCtx,
  createSceneLoader,
} from '../../src/runtime/scene-loader';

// Default ctx builder for tests that don't care about ctx contents:
// produces a minimal WorkbenchSceneCtx with a null stage and the
// effective mode the loader supplies. PUL-F012 tightened the loader's
// `buildCtx` return type to `WorkbenchSceneCtx`, so a `() => ({})`
// stub no longer satisfies the type.
const stubCtx = (mode: NavigationMode): WorkbenchSceneCtx => ({ stage: null, mode });

interface BuildSceneOpts {
  readonly id: string;
  readonly create?: SceneModule['create'];
  readonly timeline?: SceneModule['timeline'];
  readonly cleanup?: SceneModule['cleanup'];
}

const buildScene = (opts: BuildSceneOpts): SceneModule => ({
  id: opts.id,
  title: opts.id,
  duration: 1000,
  tags: [],
  assets: [],
  captions: [],
  defaultNext: null,
  standalone: true,
  trailerSafe: false,
  create: opts.create ?? (() => undefined),
  timeline: opts.timeline ?? (() => undefined),
  cleanup: opts.cleanup ?? (() => undefined),
});

interface FakeStage {
  readonly attrs: Map<string, string>;
  readonly element: StageElement;
}

const buildStage = (): FakeStage => {
  const attrs = new Map<string, string>();
  return {
    attrs,
    element: {
      setAttribute: (name, value) => attrs.set(name, value),
      removeAttribute: (name) => attrs.delete(name),
    },
  };
};

const sceneTarget = (id: string): NavigationTarget => ({
  locator: { kind: 'scene', scene: id },
});
const compositionTarget = (composition: string): NavigationTarget => ({
  locator: { kind: 'composition', composition },
});
const compositionSceneTarget = (composition: string, scene: string): NavigationTarget => ({
  locator: { kind: 'composition-scene', composition, scene },
});
const compositionIndexTarget = (composition: string, index: number): NavigationTarget => ({
  locator: { kind: 'composition-index', composition, index },
});
const noneTarget: NavigationTarget = { locator: { kind: 'none' } };

const noopRunner: SceneTimelineRunner = () => undefined;

describe('createSceneLoader (PUL-F008)', () => {
  describe('handle(target) — startup / popstate path', () => {
    it('records the addressed scene id on the stage and runs the lifecycle', async () => {
      const log: string[] = [];
      const intro = buildScene({
        id: 'intro',
        create: () => {
          log.push('create');
        },
        cleanup: () => {
          log.push('cleanup');
        },
      });
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
      });

      await loader.handle(sceneTarget('intro'));

      expect(stage.attrs.get('data-pulsar-scene-target')).toBe('intro');
      expect(stage.attrs.has('data-pulsar-navigation-error')).toBe(false);
      expect(log).toEqual(['create', 'cleanup']);
    });

    it('records the composition id when the locator addresses a composition+scene', async () => {
      const intro = buildScene({ id: 'intro' });
      const middle = buildScene({ id: 'middle' });
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro, middle]),
        compositions: createCompositionRegistry([
          { id: 'full-talk', manifest: ['intro', 'middle'] },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
      });

      await loader.handle(compositionSceneTarget('full-talk', 'middle'));

      expect(stage.attrs.get('data-pulsar-scene-target')).toBe('middle');
      expect(stage.attrs.get('data-pulsar-composition-target')).toBe('full-talk');
    });

    it('loads the composition manifest from index 0 when the locator is `kind: "composition"` (PUL-F009)', async () => {
      // Canonical PUL-F009 case: `?composition=full-talk` (no scene,
      // no index). The runtime resolves the addressed composition
      // manifest and uses it as the navigation context — every entry
      // in the slice runs through the existing PUL-F004 lifecycle in
      // manifest order, the head scene is recorded on the stage
      // (`manifest[0]`), and the composition stage attribute records
      // the composition id. Each scene's create/cleanup is observed so
      // the test would catch a regression that collapsed the locator
      // into a single-scene load and dropped the manifest slice.
      const log: string[] = [];
      const trace = (id: string): SceneModule =>
        buildScene({
          id,
          create: () => {
            log.push(`create:${id}`);
          },
          cleanup: () => {
            log.push(`cleanup:${id}`);
          },
        });
      const intro = trace('intro');
      const middle = trace('middle');
      const outro = trace('outro');
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro, middle, outro]),
        compositions: createCompositionRegistry([
          { id: 'full-talk', manifest: ['intro', 'middle', 'outro'] },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
      });

      await loader.handle(compositionTarget('full-talk'));

      expect(stage.attrs.get('data-pulsar-scene-target')).toBe('intro');
      expect(stage.attrs.get('data-pulsar-composition-target')).toBe('full-talk');
      expect(stage.attrs.has('data-pulsar-navigation-error')).toBe(false);
      expect(log).toEqual([
        'create:intro',
        'cleanup:intro',
        'create:middle',
        'cleanup:middle',
        'create:outro',
        'cleanup:outro',
      ]);
    });

    it('loads the composition slice from the addressed index when the locator is `kind: "composition-index"` (PUL-F009)', async () => {
      // PUL-F009 with `?composition=full-talk&index=1`: the manifest
      // slice starts at the addressed entry and continues to the end,
      // so head scene is `manifest[1]` and every entry from there
      // forward runs in order. The 3-entry manifest with `index=1`
      // distinguishes "slice from addressed index onward" from a
      // single-scene load of `manifest[1]`: the latter would skip
      // `outro`.
      const log: string[] = [];
      const trace = (id: string): SceneModule =>
        buildScene({
          id,
          create: () => {
            log.push(`create:${id}`);
          },
          cleanup: () => {
            log.push(`cleanup:${id}`);
          },
        });
      const intro = trace('intro');
      const middle = trace('middle');
      const outro = trace('outro');
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro, middle, outro]),
        compositions: createCompositionRegistry([
          { id: 'full-talk', manifest: ['intro', 'middle', 'outro'] },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
      });

      await loader.handle(compositionIndexTarget('full-talk', 1));

      expect(stage.attrs.get('data-pulsar-scene-target')).toBe('middle');
      expect(stage.attrs.get('data-pulsar-composition-target')).toBe('full-talk');
      expect(stage.attrs.has('data-pulsar-navigation-error')).toBe(false);
      expect(log).toEqual(['create:middle', 'cleanup:middle', 'create:outro', 'cleanup:outro']);
    });

    describe('composition + index positions playback (PUL-F010)', () => {
      // PUL-F010: when the `index` URL parameter is present alongside a
      // `composition`, the runtime SHALL position playback at the given
      // zero-based index within the composition. The dispatcher and
      // parser already implement this end-to-end (PUL-F007 / F008);
      // these anchors pin the requirement-specific contract — *the
      // index parameter selects the head position, zero-based* — at
      // the loader boundary so a future refactor cannot silently break
      // it. They would catch a regression that collapses
      // `composition-index` to `kind: 'composition'` (head always at
      // index 0), an off-by-one on `manifest[index]`, or a single-load
      // of `manifest[index]` that drops trailing entries.
      it('selects manifest[index] as the head when index > 1', async () => {
        // 4-entry manifest with `index=2` proves zero-based positional
        // semantics for N > 1: PUL-F009's anchor uses `index=1`, which
        // does not distinguish "selected entry 1" from "off-by-one
        // landed on entry 1". Index 2 in a 4-entry composition lands
        // on the third entry and must include the fourth on slice.
        const log: string[] = [];
        const trace = (id: string): SceneModule =>
          buildScene({
            id,
            create: () => {
              log.push(`create:${id}`);
            },
            cleanup: () => {
              log.push(`cleanup:${id}`);
            },
          });
        const a = trace('scene-a');
        const b = trace('scene-b');
        const c = trace('scene-c');
        const d = trace('scene-d');
        const stage = buildStage();
        const loader = createSceneLoader({
          scenes: createSceneRegistry([a, b, c, d]),
          compositions: createCompositionRegistry([
            { id: 'trailer', manifest: ['scene-a', 'scene-b', 'scene-c', 'scene-d'] },
          ]),
          stage: stage.element,
          buildCtx: stubCtx,
          createPreloader: () => () => undefined,
          runTimeline: noopRunner,
        });

        await loader.handle(compositionIndexTarget('trailer', 2));

        expect(stage.attrs.get('data-pulsar-scene-target')).toBe('scene-c');
        expect(stage.attrs.get('data-pulsar-composition-target')).toBe('trailer');
        expect(stage.attrs.has('data-pulsar-navigation-error')).toBe(false);
        // No `scene-a` or `scene-b` in the log proves the slice did
        // NOT start from the beginning; the trailing `scene-d` proves
        // the slice continued from index 2 to the end (not a single-
        // scene load of `manifest[2]`).
        expect(log).toEqual([
          'create:scene-c',
          'cleanup:scene-c',
          'create:scene-d',
          'cleanup:scene-d',
        ]);
      });

      it('different indices on the same composition select different heads', async () => {
        // Two sequential navigations on the same loader instance
        // against the same composition. The composition id is constant
        // — the only thing that changes is the `index`. If the index
        // were ignored (e.g. dispatcher collapsed `composition-index`
        // to `kind: 'composition'`), both navigations would land at
        // `manifest[0]` and this test would fail. This pins the
        // positional contract: `index`, not `composition`, decides
        // *where* in the composition playback starts.
        const a = buildScene({ id: 'scene-a' });
        const b = buildScene({ id: 'scene-b' });
        const c = buildScene({ id: 'scene-c' });
        const stage = buildStage();
        const loader = createSceneLoader({
          scenes: createSceneRegistry([a, b, c]),
          compositions: createCompositionRegistry([
            { id: 'full-talk', manifest: ['scene-a', 'scene-b', 'scene-c'] },
          ]),
          stage: stage.element,
          buildCtx: stubCtx,
          createPreloader: () => () => undefined,
          runTimeline: noopRunner,
        });

        await loader.handle(compositionIndexTarget('full-talk', 0));
        expect(stage.attrs.get('data-pulsar-scene-target')).toBe('scene-a');

        await loader.handle(compositionIndexTarget('full-talk', 2));
        expect(stage.attrs.get('data-pulsar-scene-target')).toBe('scene-c');
        expect(stage.attrs.get('data-pulsar-composition-target')).toBe('full-talk');
        expect(stage.attrs.has('data-pulsar-navigation-error')).toBe(false);
      });
    });

    it('is a no-op for `kind: "none"` (no scene to load)', async () => {
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([buildScene({ id: 'intro' })]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
      });

      await loader.handle(noneTarget);

      expect(stage.attrs.has('data-pulsar-scene-target')).toBe(false);
      expect(stage.attrs.has('data-pulsar-composition-target')).toBe(false);
      expect(stage.attrs.has('data-pulsar-navigation-error')).toBe(false);
    });

    it('clears stale stage attributes from the previous navigation before resolving the next target', async () => {
      const intro = buildScene({ id: 'intro' });
      const stage = buildStage();
      stage.attrs.set('data-pulsar-scene-target', 'old');
      stage.attrs.set('data-pulsar-composition-target', 'old');
      stage.attrs.set('data-pulsar-navigation-error', 'old');
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
      });

      await loader.handle(sceneTarget('intro'));

      expect(stage.attrs.get('data-pulsar-scene-target')).toBe('intro');
      expect(stage.attrs.has('data-pulsar-composition-target')).toBe(false);
      expect(stage.attrs.has('data-pulsar-navigation-error')).toBe(false);
    });
  });

  describe('error surfacing — ADR-013 no silent fallback', () => {
    it('routes navigation errors through the injected `onError` hook', async () => {
      const captured: unknown[] = [];
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([buildScene({ id: 'intro' })]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
        onError: (err) => {
          captured.push(err);
        },
      });

      await loader.handle(sceneTarget('missing'));

      expect(captured).toHaveLength(1);
      expect((captured[0] as Error).message).toMatch(
        /scene navigation failed: scene "missing" is not registered/,
      );
      expect(stage.attrs.get('data-pulsar-navigation-error')).toMatch(
        /scene navigation failed: scene "missing" is not registered/,
      );
    });

    it('sets `data-pulsar-navigation-error` when the URL names an unregistered scene', async () => {
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([buildScene({ id: 'intro' })]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
        onError: () => undefined,
      });

      await loader.handle(sceneTarget('missing'));

      const errorAttr = stage.attrs.get('data-pulsar-navigation-error');
      expect(errorAttr).toBeDefined();
      expect(errorAttr).toMatch(/scene navigation failed: scene "missing" is not registered/);
      expect(stage.attrs.has('data-pulsar-scene-target')).toBe(false);
    });

    it('sets `data-pulsar-navigation-error` when a lifecycle phase throws', async () => {
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
        runTimeline: noopRunner,
        onError: () => undefined,
      });

      await loader.handle(sceneTarget('broken'));

      expect(stage.attrs.get('data-pulsar-scene-target')).toBe('broken');
      expect(stage.attrs.get('data-pulsar-navigation-error')).toMatch(
        /composition resolution failed: scene "broken" create threw/,
      );
    });

    it('handleError(err) sets the error attribute and clears any stale scene attributes', async () => {
      const stage = buildStage();
      stage.attrs.set('data-pulsar-scene-target', 'previous');
      stage.attrs.set('data-pulsar-composition-target', 'previous');
      const captured: unknown[] = [];
      const loader = createSceneLoader({
        scenes: createSceneRegistry([buildScene({ id: 'intro' })]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
        onError: (err) => {
          captured.push(err);
        },
      });
      const parseErr = new Error('navigation grammar is invalid: repeated query parameter "scene"');

      loader.handleError(parseErr);
      // handleError queues through the navigation pipeline so it runs
      // after any in-flight cleanup; the assertions below are about
      // the post-drain state.
      await loader.idle();

      expect(captured).toEqual([parseErr]);
      expect(stage.attrs.has('data-pulsar-scene-target')).toBe(false);
      expect(stage.attrs.has('data-pulsar-composition-target')).toBe(false);
      expect(stage.attrs.get('data-pulsar-navigation-error')).toBe(parseErr.message);
    });
  });

  describe('lifecycle abort & cleanup-before-handoff', () => {
    it('aborts an in-flight load when a new handle() arrives mid-lifecycle', async () => {
      const log: string[] = [];
      const intro = buildScene({
        id: 'intro',
        create: () => {
          log.push('intro:create');
        },
        cleanup: () => {
          log.push('intro:cleanup');
        },
      });
      const middle = buildScene({
        id: 'middle',
        create: () => {
          log.push('middle:create');
        },
        cleanup: () => {
          log.push('middle:cleanup');
        },
      });
      let firstRunInvoked = false;
      const blockingRunner: SceneTimelineRunner = (input) => {
        if (!firstRunInvoked) {
          firstRunInvoked = true;
          return new Promise<void>((_resolve, reject) => {
            input.signal?.addEventListener(
              'abort',
              () => {
                reject(input.signal?.reason ?? new Error('aborted'));
              },
              { once: true },
            );
          });
        }
        return undefined;
      };

      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro, middle]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: blockingRunner,
      });

      void loader.handle(sceneTarget('intro'));
      await new Promise<void>((r) => setTimeout(r, 0));
      expect(log).toEqual(['intro:create']);

      void loader.handle(sceneTarget('middle'));
      await loader.idle();

      expect(log).toEqual(['intro:create', 'intro:cleanup', 'middle:create', 'middle:cleanup']);
      expect(stage.attrs.get('data-pulsar-scene-target')).toBe('middle');
    });

    it('dispose() aborts an in-flight load silently', async () => {
      const log: string[] = [];
      const intro = buildScene({
        id: 'intro',
        create: () => {
          log.push('intro:create');
        },
        cleanup: () => {
          log.push('intro:cleanup');
        },
      });
      const blockingRunner: SceneTimelineRunner = (input) =>
        new Promise<void>((_resolve, reject) => {
          input.signal?.addEventListener(
            'abort',
            () => {
              reject(input.signal?.reason ?? new Error('aborted'));
            },
            { once: true },
          );
        });
      const captured: unknown[] = [];
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: blockingRunner,
        onError: (err) => {
          captured.push(err);
        },
      });

      void loader.handle(sceneTarget('intro'));
      await new Promise<void>((r) => setTimeout(r, 0));
      expect(log).toEqual(['intro:create']);

      loader.dispose();
      await loader.idle();

      // Cleanup ran (mandatory invariant), but onError was NOT called
      // (silent dispose).
      expect(log).toEqual(['intro:create', 'intro:cleanup']);
      expect(captured).toEqual([]);
    });

    it('drops superseded queued targets — rapid handle(B) then handle(C) skips B and runs only C', async () => {
      // While A is in flight, queue B then C. C supersedes B; the
      // loader must drop B from the queue rather than running A → B → C.
      // Without latest-target semantics, C aborts A but B still runs to
      // completion before C, loading a URL that is no longer current.
      const log: string[] = [];
      const make = (id: string): SceneModule =>
        buildScene({
          id,
          create: () => {
            log.push(`${id}:create`);
          },
          cleanup: () => {
            log.push(`${id}:cleanup`);
          },
        });
      const a = make('a');
      const b = make('b');
      const c = make('c');
      let firstRunInvoked = false;
      const blockingRunner: SceneTimelineRunner = (input) => {
        if (!firstRunInvoked) {
          firstRunInvoked = true;
          return new Promise<void>((_resolve, reject) => {
            input.signal?.addEventListener(
              'abort',
              () => reject(input.signal?.reason ?? new Error('aborted')),
              { once: true },
            );
          });
        }
        return undefined;
      };

      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([a, b, c]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: blockingRunner,
      });

      void loader.handle(sceneTarget('a'));
      await new Promise<void>((r) => setTimeout(r, 0));
      expect(log).toEqual(['a:create']);

      // Queue B then C in immediate succession — C must supersede B.
      void loader.handle(sceneTarget('b'));
      void loader.handle(sceneTarget('c'));
      await loader.idle();

      // B must NEVER have run; only A (aborted with cleanup) and C.
      expect(log).toEqual(['a:create', 'a:cleanup', 'c:create', 'c:cleanup']);
      expect(stage.attrs.get('data-pulsar-scene-target')).toBe('c');
    });

    it('handleError(err) aborts the active scene before surfacing the error', async () => {
      // PUL-F007 dispatches `pulsar:navigate-error` for malformed
      // URLs. When the URL becomes malformed *during* a scene's
      // lifecycle, the active scene must be aborted and cleaned up
      // before the error attribute is set — otherwise the previous
      // scene keeps running while the stage advertises a navigation
      // failure.
      const log: string[] = [];
      const intro = buildScene({
        id: 'intro',
        create: () => {
          log.push('intro:create');
        },
        cleanup: () => {
          log.push('intro:cleanup');
        },
      });
      const blockingRunner: SceneTimelineRunner = (input) =>
        new Promise<void>((_resolve, reject) => {
          input.signal?.addEventListener(
            'abort',
            () => reject(input.signal?.reason ?? new Error('aborted')),
            { once: true },
          );
        });
      const stage = buildStage();
      const captured: unknown[] = [];
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: blockingRunner,
        onError: (err) => {
          captured.push(err);
        },
      });

      void loader.handle(sceneTarget('intro'));
      await new Promise<void>((r) => setTimeout(r, 0));
      expect(log).toEqual(['intro:create']);

      const parseErr = new Error('navigation grammar is invalid: ...');
      loader.handleError(parseErr);
      await loader.idle();

      // intro must have been aborted+cleaned up before the error attr
      // landed; the stage now reflects only the error.
      expect(log).toEqual(['intro:create', 'intro:cleanup']);
      expect(captured).toEqual([parseErr]);
      expect(stage.attrs.get('data-pulsar-navigation-error')).toBe(parseErr.message);
      expect(stage.attrs.has('data-pulsar-scene-target')).toBe(false);
    });

    it('handleError supersedes queued targets — queued navigation does not later overwrite the error', async () => {
      const log: string[] = [];
      const intro = buildScene({
        id: 'intro',
        create: () => {
          log.push('intro:create');
        },
        cleanup: () => {
          log.push('intro:cleanup');
        },
      });
      const middle = buildScene({
        id: 'middle',
        create: () => {
          log.push('middle:create');
        },
      });
      let firstRunInvoked = false;
      const blockingRunner: SceneTimelineRunner = (input) => {
        if (!firstRunInvoked) {
          firstRunInvoked = true;
          return new Promise<void>((_resolve, reject) => {
            input.signal?.addEventListener(
              'abort',
              () => reject(input.signal?.reason ?? new Error('aborted')),
              { once: true },
            );
          });
        }
        return undefined;
      };
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro, middle]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: blockingRunner,
        onError: () => undefined,
      });

      void loader.handle(sceneTarget('intro'));
      await new Promise<void>((r) => setTimeout(r, 0));
      expect(log).toEqual(['intro:create']);

      // Queue a target then immediately fire a parse error — the
      // error supersedes the queued target so middle never runs.
      void loader.handle(sceneTarget('middle'));
      loader.handleError(new Error('navigation grammar is invalid: bad url'));
      await loader.idle();

      expect(log).toEqual(['intro:create', 'intro:cleanup']);
      expect(stage.attrs.get('data-pulsar-navigation-error')).toMatch(/bad url/);
      expect(stage.attrs.has('data-pulsar-scene-target')).toBe(false);
    });

    it("builds a per-navigation preloader bound to that navigation's abort signal", async () => {
      // PUL-F005's `createAssetPreloader` accepts an `init.signal` so
      // the per-asset `fetch` calls can be aborted. The loader must
      // create one preloader per navigation, threading the
      // navigation's abort controller's signal through, so back/
      // forward during a long preload cancels the in-flight fetches
      // instead of waiting for the old preload to finish.
      const observedSignals: (AbortSignal | undefined)[] = [];
      const intro = buildScene({ id: 'intro' });
      const middle = buildScene({ id: 'middle' });
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro, middle]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: (signal) => {
          observedSignals.push(signal);
          return () => undefined;
        },
        runTimeline: noopRunner,
      });

      await loader.handle(sceneTarget('intro'));
      await loader.handle(sceneTarget('middle'));

      // One preloader per navigation, each bound to its own signal.
      expect(observedSignals).toHaveLength(2);
      expect(observedSignals[0]).toBeInstanceOf(AbortSignal);
      expect(observedSignals[1]).toBeInstanceOf(AbortSignal);
      expect(observedSignals[0]).not.toBe(observedSignals[1]);
    });

    it('surfaces cleanup failures even when the lifecycle was aborted (multi-fault visibility)', async () => {
      // The resolver throws an `AggregateError` when an aborted
      // lifecycle ALSO has a cleanup failure. The naive "any abort →
      // suppress" rule would drop the cleanup half from both stage
      // state and `onError`. The loader must surface AggregateErrors
      // even when its own controller aborted the load.
      const broken = buildScene({
        id: 'broken',
        cleanup: () => {
          throw new Error('cleanup boom');
        },
      });
      // Only the FIRST runner invocation blocks; the follow-up
      // navigation runs through immediately so the test settles.
      let firstRunInvoked = false;
      const blockingRunner: SceneTimelineRunner = (input) => {
        if (firstRunInvoked) return undefined;
        firstRunInvoked = true;
        return new Promise<void>((_resolve, reject) => {
          input.signal?.addEventListener(
            'abort',
            () => reject(input.signal?.reason ?? new Error('aborted')),
            { once: true },
          );
        });
      };
      const stage = buildStage();
      const captured: unknown[] = [];
      const loader = createSceneLoader({
        scenes: createSceneRegistry([broken, buildScene({ id: 'next' })]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: blockingRunner,
        onError: (err) => {
          captured.push(err);
        },
      });

      void loader.handle(sceneTarget('broken'));
      await new Promise<void>((r) => setTimeout(r, 0));
      void loader.handle(sceneTarget('next'));
      await loader.idle();

      // The cleanup failure on `broken` MUST have surfaced — it's a
      // real bug the operator needs to see, not a routine abort.
      expect(captured.length).toBeGreaterThanOrEqual(1);
      const surfaced = captured.find(
        (e) => e instanceof Error && /cleanup boom/.test((e as Error).message),
      );
      expect(surfaced).toBeDefined();
    });

    it('routes synchronous `createPreloader` failures through onError and the stage error attribute', async () => {
      // If `createPreloader(signal)` throws synchronously (e.g. the
      // PUL-F005 factory rejects an invalid `init`), the loader must
      // surface it through the documented error path — `onError` +
      // `data-pulsar-navigation-error` — instead of letting the
      // throw escape and leaving partial scene-target attributes on
      // the stage with a rejected queue promise.
      const captured: unknown[] = [];
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([buildScene({ id: 'intro' })]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => {
          throw new Error('preloader factory blew up');
        },
        runTimeline: noopRunner,
        onError: (err) => {
          captured.push(err);
        },
      });

      await loader.handle(sceneTarget('intro'));

      // Error surfaced through the loader's documented hook.
      expect(captured).toHaveLength(1);
      expect((captured[0] as Error).message).toBe('preloader factory blew up');
      // Stage advertises the error and is NOT lying about an
      // already-loaded scene.
      expect(stage.attrs.get('data-pulsar-navigation-error')).toBe('preloader factory blew up');
      expect(stage.attrs.has('data-pulsar-scene-target')).toBe(false);
    });

    it('handle() after dispose() is a no-op', async () => {
      const log: string[] = [];
      const intro = buildScene({
        id: 'intro',
        create: () => {
          log.push('create');
        },
      });
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro]),
        compositions: createCompositionRegistry([]),
        stage: buildStage().element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
      });

      loader.dispose();
      await loader.handle(sceneTarget('intro'));

      expect(log).toEqual([]);
    });
  });

  describe('beat positioning (PUL-F011)', () => {
    // PUL-F011: when `beat=<label>` is present, the runtime SHALL
    // position the active scene's timeline at the named label; if the
    // label does not exist, surface an error and remain at the scene's
    // first beat. ADR-015 places label existence + seeking in the
    // timeline-runner boundary; the loader's job is to:
    //   (a) extract `target.beat` and forward it to the runner;
    //   (b) provide an `onBeatMissing` callback that writes the
    //       `data-pulsar-navigation-error` attribute + calls `onError`
    //       WITHOUT unmounting the scene (no rejection through the
    //       resolver, which would trigger cleanup).

    const sceneTargetWithBeat = (id: string, beat: string): NavigationTarget => ({
      locator: { kind: 'scene', scene: id },
      beat,
    });

    it('forwards `beat` from the parsed navigation target to the runner', async () => {
      const seen: { beat?: string }[] = [];
      const intro = buildScene({ id: 'intro' });
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: (input) => {
          const captured: { beat?: string } = {};
          if ('beat' in input) captured.beat = input.beat;
          seen.push(captured);
        },
      });

      await loader.handle(sceneTargetWithBeat('intro', 'hook'));

      expect(seen).toEqual([{ beat: 'hook' }]);
    });

    it('keeps the scene mounted while the runner is still active after onBeatMissing (PUL-F011 "remain at the scene\'s first beat")', async () => {
      // The substantive PUL-F011 invariant: a missing-label diagnostic
      // MUST NOT cause the scene to be unmounted. Reading "create then
      // cleanup" alone is insufficient evidence — that just describes
      // any normal lifecycle. The test instead holds the runner pending
      // (so the scene is "live"), observes the diagnostic surfaced AND
      // the scene is still mounted (cleanup has NOT yet fired), then
      // releases the runner and confirms cleanup ran on natural exit.
      // This pins that the missing-beat path does NOT short-circuit the
      // resolver into an early cleanup.
      const captured: unknown[] = [];
      const lifecycleLog: string[] = [];
      let resolveRunner: (() => void) | undefined;
      const runnerGate = new Promise<void>((res) => {
        resolveRunner = res;
      });
      let runnerEntered: (() => void) | undefined;
      const runnerEnteredBarrier = new Promise<void>((res) => {
        runnerEntered = res;
      });
      const intro = buildScene({
        id: 'intro',
        create: () => {
          lifecycleLog.push('create');
        },
        cleanup: () => {
          lifecycleLog.push('cleanup');
        },
      });
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: async (input) => {
          // Simulate an unknown timeline label: runner reports the
          // diagnostic via `onBeatMissing`, signals the test that
          // it has entered, and stays alive (await gate). The
          // runner MUST NOT throw — that would trigger cleanup and
          // unmount the scene per PUL-F006.
          input.onBeatMissing?.();
          runnerEntered?.();
          await runnerGate;
        },
        onError: (err) => {
          captured.push(err);
        },
      });

      const handlePromise = loader.handle(sceneTargetWithBeat('intro', 'unknown-label'));

      // Block until the runner has fired the diagnostic and is
      // awaiting the gate. This synchronizes the assertions to a
      // deterministic lifecycle point — independent of how many
      // microtasks the queue / dispatcher / resolver chain costs.
      await runnerEnteredBarrier;

      // While the runner is still pending: scene IS mounted (create
      // fired, cleanup has NOT), the diagnostic IS surfaced. This is
      // the substantive "remain at the scene's first beat" assertion.
      expect(lifecycleLog).toEqual(['create']);
      expect(stage.attrs.get('data-pulsar-scene-target')).toBe('intro');
      expect(stage.attrs.get('data-pulsar-navigation-error')).toBe(
        'beat positioning failed: beat "unknown-label" does not exist in scene "intro"',
      );
      expect(captured).toHaveLength(1);
      expect((captured[0] as Error).message).toBe(
        'beat positioning failed: beat "unknown-label" does not exist in scene "intro"',
      );

      // Release the runner so the lifecycle completes naturally.
      // Cleanup runs only now — proves the diagnostic did NOT
      // short-circuit into an early unmount.
      resolveRunner?.();
      await handlePromise;
      expect(lifecycleLog).toEqual(['create', 'cleanup']);
    });

    it('suppresses a missing-beat diagnostic if the runner reports after the load was aborted by a superseding navigation (signal.aborted guard)', async () => {
      // Defense parallel to `isPureAbort` for fatal-error suppression:
      // a runner that calls `onBeatMissing` AFTER its navigation was
      // superseded (popstate / new handle() / dispose) must NOT write
      // a diagnostic for the dead navigation. Otherwise the stage
      // would carry the previous URL's beat error after the next
      // navigation completed. This test specifically exercises the
      // `signal.aborted` branch of the closure (NOT the `disposed`
      // branch — that's covered by the dispose-then-fire variant).
      const captured: unknown[] = [];
      const intro = buildScene({ id: 'intro' });
      const stage = buildStage();
      let capturedOnBeatMissing: (() => void) | undefined;
      let resolveFirstRunner: (() => void) | undefined;
      const firstRunnerGate = new Promise<void>((res) => {
        resolveFirstRunner = res;
      });
      let firstRunnerEntered: (() => void) | undefined;
      const firstRunnerEnteredBarrier = new Promise<void>((res) => {
        firstRunnerEntered = res;
      });
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: async (input) => {
          if (input.beat !== undefined) {
            // Capture the callback but do not fire it yet. The first
            // navigation is held open via the gate, then aborted by
            // the second handle() below; we'll fire the captured
            // callback AFTER the abort so the closure sees
            // `signal.aborted === true` (and `disposed === false`).
            capturedOnBeatMissing = input.onBeatMissing;
            firstRunnerEntered?.();
            await firstRunnerGate;
          }
        },
        onError: (err) => {
          captured.push(err);
        },
      });

      // Start the first navigation but do NOT await it — the runner
      // is parked on `firstRunnerGate`.
      const firstHandle = loader.handle(sceneTargetWithBeat('intro', 'unknown-label'));
      await firstRunnerEnteredBarrier;

      // Enqueue a second navigation. `enqueue()` aborts the in-flight
      // load via `inFlight.controller.abort()` — that flips the first
      // navigation's signal.aborted to true. The second navigation
      // proceeds to wait for the first to settle (it won't, until we
      // release the gate below).
      const secondHandle = loader.handle(sceneTarget('intro'));

      // The first runner's signal is now aborted. Fire its captured
      // callback — the closure must observe `signal.aborted === true`
      // and no-op (the loader is NOT disposed). Without the guard,
      // this would write `data-pulsar-navigation-error` for a dead
      // navigation.
      capturedOnBeatMissing?.();

      // Release the first runner's gate so the lifecycle drains and
      // the second navigation can proceed.
      resolveFirstRunner?.();
      await firstHandle;
      await secondHandle;

      // Stage carries the second navigation's scene (`intro` with no
      // beat) and no error attribute — the stale beat-missing was
      // suppressed.
      expect(captured).toEqual([]);
      expect(stage.attrs.get('data-pulsar-scene-target')).toBe('intro');
      expect(stage.attrs.has('data-pulsar-navigation-error')).toBe(false);
    });

    it('suppresses a missing-beat diagnostic if the runner reports after dispose (disposed guard)', async () => {
      // Sibling of the signal.aborted test above — proves the
      // `disposed` branch of the closure independently.
      const captured: unknown[] = [];
      const intro = buildScene({ id: 'intro' });
      const stage = buildStage();
      let capturedOnBeatMissing: (() => void) | undefined;
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: (input) => {
          // Capture but don't fire; the runner exits immediately so
          // the lifecycle settles. Then dispose; then fire.
          capturedOnBeatMissing = input.onBeatMissing;
        },
        onError: (err) => {
          captured.push(err);
        },
      });

      await loader.handle(sceneTargetWithBeat('intro', 'unknown-label'));
      // Drop the diagnostic the runner DID surface during the first
      // navigation — focus the test on a SECOND, late call.
      stage.attrs.delete('data-pulsar-navigation-error');
      captured.length = 0;

      loader.dispose();
      capturedOnBeatMissing?.();

      expect(captured).toEqual([]);
      expect(stage.attrs.has('data-pulsar-navigation-error')).toBe(false);
    });

    it('keeps the missing-beat path non-fatal when the injected onError sink throws', async () => {
      // PUL-F011 / ADR-015: the diagnostic callback is contractually
      // non-fatal — the runner is forbidden from throwing on missing
      // labels. The injected `onError` sink is user-supplied, so an
      // exception from it must NOT propagate back through
      // `input.onBeatMissing()` into the resolver (which would treat
      // it as a lifecycle failure and unmount the scene). Cleanup is
      // therefore the natural lifecycle exit, NOT a phase-error
      // wrap, when onError throws.
      const lifecycleLog: string[] = [];
      const intro = buildScene({
        id: 'intro',
        create: () => {
          lifecycleLog.push('create');
        },
        cleanup: () => {
          lifecycleLog.push('cleanup');
        },
      });
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: (input) => {
          input.onBeatMissing?.();
          // If onBeatMissing's surfaceError had thrown out, this
          // line would not execute and the runner would surface a
          // rejection — the assertion below would catch it.
        },
        onError: () => {
          throw new Error('user-injected logger blew up');
        },
      });

      await expect(
        loader.handle(sceneTargetWithBeat('intro', 'unknown-label')),
      ).resolves.toBeUndefined();

      // Lifecycle ran end-to-end as expected for a successful
      // missing-beat exit. cleanup fired naturally; no extra
      // phase-error wrap, no AggregateError, no rejection.
      expect(lifecycleLog).toEqual(['create', 'cleanup']);
    });

    it('only fires the diagnostic once per navigation even if the runner calls onBeatMissing repeatedly', async () => {
      // A buggy runner (or a future GSAP integration that retries on
      // each beat-not-found) must not spam the error sink. Once-only
      // gating matches every other surfaceError call in the loader.
      const captured: unknown[] = [];
      const intro = buildScene({ id: 'intro' });
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: (input) => {
          input.onBeatMissing?.();
          input.onBeatMissing?.();
          input.onBeatMissing?.();
        },
        onError: (err) => {
          captured.push(err);
        },
      });

      await loader.handle(sceneTargetWithBeat('intro', 'unknown-label'));

      expect(captured).toHaveLength(1);
    });

    it('rejects a constructed target whose `beat` value is not kebab-case (defense-in-depth for parser)', async () => {
      // The parser validates `beat` shape; the loader re-validates so
      // a hand-built `NavigationTarget` (event-detail unmarshaling,
      // programmatic navigation) cannot bypass kebab-case enforcement.
      const captured: unknown[] = [];
      const intro = buildScene({ id: 'intro' });
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
        onError: (err) => {
          captured.push(err);
        },
      });

      const malformed: NavigationTarget = {
        locator: { kind: 'scene', scene: 'intro' },
        // `Bad Label` has uppercase + space — invalid kebab.
        // Cast to string is needed because the type annotation on
        // `beat` is `string`, but parser enforcement makes any
        // non-kebab beat unreachable in normal flow.
        beat: 'Bad Label' as unknown as string,
      };

      await loader.handle(malformed);

      expect(stage.attrs.has('data-pulsar-scene-target')).toBe(false);
      expect(stage.attrs.get('data-pulsar-navigation-error')).toMatch(
        /^navigation grammar is invalid: "beat" must be a non-empty lowercase kebab-case string/,
      );
      expect(captured).toHaveLength(1);
    });

    it('a successful beat (runner does NOT invoke onBeatMissing) leaves the error attribute absent', async () => {
      const intro = buildScene({ id: 'intro' });
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: () => undefined, // simulates successful seek
      });

      await loader.handle(sceneTargetWithBeat('intro', 'hook'));

      expect(stage.attrs.get('data-pulsar-scene-target')).toBe('intro');
      expect(stage.attrs.has('data-pulsar-navigation-error')).toBe(false);
    });

    it('rejects a constructed `composition`-only target with `beat` (defense-in-depth for ADR-013)', async () => {
      // `parseNavigationSearch` already rejects `composition=<id>&beat=<label>`,
      // but `NavigationTarget` is an exported type and a non-parser
      // caller could construct one directly. The loader re-enforces
      // the rule before any side effect so a hand-built target does
      // not bypass the grammar invariant the parser would have caught.
      const captured: unknown[] = [];
      const intro = buildScene({ id: 'intro' });
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro]),
        compositions: createCompositionRegistry([{ id: 'full-talk', manifest: ['intro'] }]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
        onError: (err) => {
          captured.push(err);
        },
      });

      const compositionOnlyWithBeat: NavigationTarget = {
        locator: { kind: 'composition', composition: 'full-talk' },
        beat: 'hook',
      };

      await loader.handle(compositionOnlyWithBeat);

      expect(stage.attrs.has('data-pulsar-scene-target')).toBe(false);
      expect(stage.attrs.has('data-pulsar-composition-target')).toBe(false);
      expect(stage.attrs.get('data-pulsar-navigation-error')).toMatch(
        /^navigation grammar is invalid: "beat" requires a scene-like target/,
      );
      expect(captured).toHaveLength(1);
    });

    it('targets without `beat` carry no `beat` or `onBeatMissing` on the run input', async () => {
      const seen: { beatPresent: boolean; onBeatMissingPresent: boolean }[] = [];
      const intro = buildScene({ id: 'intro' });
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: (input) => {
          seen.push({
            beatPresent: 'beat' in input,
            onBeatMissingPresent: 'onBeatMissing' in input,
          });
        },
      });

      await loader.handle(sceneTarget('intro'));

      expect(seen).toEqual([{ beatPresent: false, onBeatMissingPresent: false }]);
    });
  });

  describe('mode dispatch (PUL-F012)', () => {
    // PUL-F012 / ADR-007: when the parsed `NavigationTarget` carries
    // `mode`, the loader selects the corresponding workbench mode.
    // Absent `mode` defaults to `'present'`. Mode dispatch lives in
    // the runtime core (this loader), not in scenes — the loader
    // calls `options.buildCtx(effectiveMode)` once per navigation,
    // and the returned ctx (carrying `mode`) is what scenes see.
    //
    // The "URL is the only source" rule (no localStorage,
    // sessionStorage, cookies, history.state, cached state) is pinned
    // by the across-navigation no-leak test below: a navigation that
    // sets a non-`present` mode must not influence a subsequent
    // `mode`-less navigation's effective mode.

    interface ModeProbe {
      readonly modes: NavigationMode[];
      readonly buildCtx: (mode: NavigationMode) => WorkbenchSceneCtx;
    }

    const buildModeProbe = (): ModeProbe => {
      const modes: NavigationMode[] = [];
      return {
        modes,
        buildCtx: vi.fn((mode: NavigationMode): WorkbenchSceneCtx => {
          modes.push(mode);
          return { stage: null, mode };
        }),
      };
    };

    it.each(NAVIGATION_MODES)(
      'invokes buildCtx with %s when target.mode is %s (clause 1: explicit mode is selected)',
      async (mode) => {
        const intro = buildScene({ id: 'intro' });
        const stage = buildStage();
        const probe = buildModeProbe();
        const loader = createSceneLoader({
          scenes: createSceneRegistry([intro]),
          compositions: createCompositionRegistry([]),
          stage: stage.element,
          buildCtx: probe.buildCtx,
          createPreloader: () => () => undefined,
          runTimeline: noopRunner,
        });

        await loader.handle({ locator: { kind: 'scene', scene: 'intro' }, mode });

        expect(probe.modes).toEqual([mode]);
      },
    );

    it('invokes buildCtx with "present" when target.mode is absent (clause 2: default is present)', async () => {
      const intro = buildScene({ id: 'intro' });
      const stage = buildStage();
      const probe = buildModeProbe();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: probe.buildCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
      });

      await loader.handle(sceneTarget('intro'));

      expect(probe.modes).toEqual(['present']);
    });

    it('the ctx threaded into the lifecycle carries the effective mode', async () => {
      // The ctx the loader hands the lifecycle MUST carry the mode
      // value returned by buildCtx — proves the per-navigation ctx
      // (not a stale cached one) is what scenes receive on every
      // hook (`create` / `timeline` / `cleanup`).
      const seen: { phase: string; mode: unknown }[] = [];
      const recordMode = (phase: string) => (ctx: unknown) => {
        seen.push({
          phase,
          mode: (ctx as { mode?: NavigationMode }).mode,
        });
      };
      const intro = buildScene({
        id: 'intro',
        create: recordMode('create'),
        timeline: ((ctx: unknown) => {
          recordMode('timeline')(ctx);
        }) as SceneModule['timeline'],
        cleanup: recordMode('cleanup'),
      });
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: (mode) => ({ stage: stage.element, mode }),
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
      });

      await loader.handle({ locator: { kind: 'scene', scene: 'intro' }, mode: 'screenshot' });

      expect(seen).toEqual([
        { phase: 'create', mode: 'screenshot' },
        { phase: 'timeline', mode: 'screenshot' },
        { phase: 'cleanup', mode: 'screenshot' },
      ]);
    });

    it('a previous non-present mode does not leak into a later mode-less navigation (ADR-007 risk-table)', async () => {
      // ADR-007 risk-table: "A previous non-`present` mode leaks into
      // a URL without `mode`" — mitigation: "Treat omitted `mode` as a
      // fresh `present` selection on every startup and `popstate`; do
      // not cache the last effective mode." This is the canonical
      // regression test: load with mode=screenshot, then load with no
      // mode, and verify the second navigation's ctx carries `present`,
      // NOT `screenshot`.
      //
      // Two assertions in one test: (a) the probe's `buildCtx` was
      // called with the right effective mode at each step, AND (b) the
      // ctx that actually reaches the second scene's lifecycle hooks
      // carries `mode: 'present'`. The second assertion guards against
      // a regression that calls `buildCtx('present')` correctly but
      // accidentally reuses the previously-built `{ mode: 'screenshot' }`
      // ctx — that bug would pass the input-only assertion but leak the
      // stale mode to the runner / scene.
      const seen: { sceneId: string; mode: unknown }[] = [];
      const recordCreate =
        (sceneId: string) =>
        (ctx: unknown): void => {
          seen.push({ sceneId, mode: (ctx as { mode?: NavigationMode }).mode });
        };
      const intro = buildScene({ id: 'intro', create: recordCreate('intro') });
      const outro = buildScene({ id: 'outro', create: recordCreate('outro') });
      const stage = buildStage();
      const probe = buildModeProbe();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro, outro]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: probe.buildCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
      });

      await loader.handle({ locator: { kind: 'scene', scene: 'intro' }, mode: 'screenshot' });
      await loader.handle({ locator: { kind: 'scene', scene: 'outro' } });

      expect(probe.modes).toEqual(['screenshot', 'present']);
      expect(seen).toEqual([
        { sceneId: 'intro', mode: 'screenshot' },
        { sceneId: 'outro', mode: 'present' },
      ]);
    });

    it('does not invoke buildCtx when the locator is `kind: "none"` (no scene mounts)', async () => {
      // The runtime does not mount any scene for `?` (no explicit
      // target), so the per-navigation ctx is never assembled — there
      // is nothing to hand it to. Without this contract, an "always
      // build ctx" loader would invoke the workbench's `buildCtx` for
      // every popstate even when no lifecycle ran, which makes
      // ctx-build cost (e.g. async stage allocation) charge the no-op
      // path.
      const intro = buildScene({ id: 'intro' });
      const stage = buildStage();
      const probe = buildModeProbe();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: probe.buildCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
      });

      await loader.handle(noneTarget);

      expect(probe.modes).toEqual([]);
    });

    it('does not invoke buildCtx on parse-error events (handleError path)', async () => {
      // The error path writes the navigation-error attribute and runs
      // `onError`; no lifecycle runs, so no ctx is needed. Asserting
      // `buildCtx` was not invoked stops a regression that
      // pre-emptively built ctx on the error path (wasted allocation
      // and a misleading "fresh navigation" signal to mode listeners).
      const stage = buildStage();
      const probe = buildModeProbe();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: probe.buildCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
        onError: () => undefined,
      });

      loader.handleError(new Error('navigation grammar is invalid: parse failure'));
      await loader.idle();

      expect(probe.modes).toEqual([]);
    });

    it('rejects a constructed target with an unknown mode (defense-in-depth for ADR-007)', async () => {
      // `parseNavigationSearch` already rejects unknown modes, but
      // `NavigationTarget` is an exported type and a non-parser caller
      // could construct one directly. The loader re-enforces the
      // ADR-007 mode allowlist before any side effect so a hand-built
      // target does not bypass the grammar invariant the parser would
      // have caught — same defense-in-depth pattern used for `beat`.
      const captured: unknown[] = [];
      const intro = buildScene({ id: 'intro' });
      const stage = buildStage();
      const probe = buildModeProbe();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: probe.buildCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
        onError: (err) => {
          captured.push(err);
        },
      });

      const malformedMode: NavigationTarget = {
        locator: { kind: 'scene', scene: 'intro' },
        mode: 'shouty-mode' as unknown as NavigationMode,
      };

      await loader.handle(malformedMode);

      expect(probe.modes).toEqual([]);
      expect(stage.attrs.has('data-pulsar-scene-target')).toBe(false);
      expect(stage.attrs.get('data-pulsar-navigation-error')).toMatch(
        /^navigation grammar is invalid: "mode"/,
      );
      expect(captured).toHaveLength(1);
    });

    it('surfaces a buildCtx exception via onError and resets stage attrs (no stale targets)', async () => {
      // A throwing builder must NOT leave stale `data-pulsar-scene-target`
      // / `data-pulsar-composition-target` attrs on the stage, must
      // surface the error through the configured `onError` sink, and
      // must keep the navigation queue healthy (subsequent handle()
      // calls succeed). Without this contract, a workbench with a
      // crashing ctx-builder would lie to the operator about a
      // half-loaded scene and reject every queued navigation.
      const captured: unknown[] = [];
      const intro = buildScene({ id: 'intro' });
      const outro = buildScene({ id: 'outro' });
      const stage = buildStage();
      let ctxCalls = 0;
      const buildCtx = (mode: NavigationMode): WorkbenchSceneCtx => {
        ctxCalls += 1;
        if (ctxCalls === 1) {
          throw new Error('builder bug');
        }
        return { stage: null, mode };
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro, outro]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
        onError: (err) => {
          captured.push(err);
        },
      });

      await loader.handle(sceneTarget('intro'));

      expect(stage.attrs.has('data-pulsar-scene-target')).toBe(false);
      expect(stage.attrs.has('data-pulsar-composition-target')).toBe(false);
      expect(stage.attrs.get('data-pulsar-navigation-error')).toMatch(/builder bug/);
      expect(captured).toHaveLength(1);
      expect((captured[0] as Error).message).toBe('builder bug');

      // The queue is still healthy: a subsequent navigation runs
      // through the lifecycle normally.
      await loader.handle(sceneTarget('outro'));
      expect(stage.attrs.get('data-pulsar-scene-target')).toBe('outro');
    });

    it('aborts the per-load AbortController when buildCtx throws (no signal-tied resource leak)', async () => {
      // The preloader factory has already received the controller's
      // signal before buildCtx runs. If buildCtx then throws, the
      // controller would otherwise be GC'd in the never-aborted state
      // and any abort-keyed listener registered against the signal
      // (e.g. a fetch listener) would never see cancellation. Pin
      // that the loader explicitly aborts on the buildCtx-throw path.
      let capturedSignal: AbortSignal | undefined;
      const intro = buildScene({ id: 'intro' });
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: () => {
          throw new Error('builder bug');
        },
        createPreloader: (signal) => {
          capturedSignal = signal;
          return () => undefined;
        },
        runTimeline: noopRunner,
        onError: () => undefined,
      });

      await loader.handle(sceneTarget('intro'));

      expect(capturedSignal).toBeDefined();
      expect(capturedSignal?.aborted).toBe(true);
    });

    it('does not invoke buildCtx when the preloader factory throws (no wasted builder allocation)', async () => {
      // ADR-007 / PUL-F012 ordering: the loader builds the preloader
      // FIRST. If the preloader factory throws, no lifecycle runs and
      // no cleanup will consume any ctx. Asserting `buildCtx` was not
      // invoked stops a regression that pre-emptively ran the builder
      // (wasted side effects, plus a misleading "fresh navigation"
      // signal to mode listeners).
      const intro = buildScene({ id: 'intro' });
      const stage = buildStage();
      const probe = buildModeProbe();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: probe.buildCtx,
        createPreloader: () => {
          throw new Error('preloader factory bug');
        },
        runTimeline: noopRunner,
        onError: () => undefined,
      });

      await loader.handle(sceneTarget('intro'));

      expect(probe.modes).toEqual([]);
    });

    it('does not invoke buildCtx when scene resolution fails (no lifecycle, no ctx)', async () => {
      // A target that names an unregistered scene fails resolution
      // before the lifecycle starts. There is no ctx-handoff to do
      // because nothing is mounted; charging buildCtx in this path
      // would be wasted work and could leak mode-aware listeners on
      // failed navigations.
      const stage = buildStage();
      const probe = buildModeProbe();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: probe.buildCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
        onError: () => undefined,
      });

      await loader.handle(sceneTarget('does-not-exist'));

      expect(probe.modes).toEqual([]);
    });
  });

  describe('present-mode adapter seams (PUL-F013 boundary, NOT a PUL-F013 implementation)', () => {
    // PUL-F013 statement: in `mode=present`, the runtime SHALL render
    // full chrome, audio, and inter-scene transitions, and SHALL respond
    // to presenter input. NONE of the four facets has a corresponding
    // rendering / input surface in this repo today — chrome is a future
    // workbench-shell requirement, audio is reserved by ADR-004
    // (Howler.js), inter-scene transition RENDERING is reserved by
    // ADR-003 (GSAP timeline runner), and actual presenter input is
    // PUL-F020 / PUL-F021 / PUL-F025. The tests below DO NOT pin
    // PUL-F013's clauses end to end — they pin the underlying adapter
    // seams those four future surfaces will plug into, asserted under
    // `mode=present` so a future regression cannot quietly disable a
    // seam for the present value.
    //
    // PUL-F013 stays DRAFT until every facet its statement names
    // lands as a real rendering / input surface that adds its own
    // end-to-end "X renders / responds under mode=present" test
    // alongside these seam tests. ADR-016 records the boundary.
    //
    // The seams pinned here:
    //
    //   - The composition resolver's structural cleanup-before-next-
    //     create ordering — the lifecycle hook the GSAP runner will
    //     hang inter-scene transition rendering off (ADR-003 / ADR-011
    //     / PUL-F004).
    //   - The per-navigation `AbortSignal` forwarded to the runner —
    //     the seam PUL-F020 / F021 / F025 will drive when actual
    //     presenter input arrives (PUL-F006 / ADR-011).
    //   - `ctx.mode === 'present'` carried into every lifecycle hook —
    //     the hint chrome and audio surfaces will read when each lands
    //     (PUL-F012 / ADR-007).
    //   - Absence of any preemptive `data-pulsar-mode-*` suppression
    //     attribute on the stage under `present`.

    const presentTarget = (composition: string, index = 0): NavigationTarget => ({
      locator: { kind: 'composition-index', composition, index },
      mode: 'present',
    });
    const absentModeTarget = (composition: string, index = 0): NavigationTarget => ({
      locator: { kind: 'composition-index', composition, index },
    });

    interface LifecycleProbe {
      readonly log: string[];
      readonly scenes: readonly SceneModule[];
      readonly compositionId: string;
    }

    const buildLifecycleProbe = (compositionId = 'full-talk'): LifecycleProbe => {
      const log: string[] = [];
      const trace = (id: string): SceneModule =>
        buildScene({
          id,
          create: () => {
            log.push(`create:${id}`);
          },
          timeline: () => {
            log.push(`timeline:${id}`);
            return null;
          },
          cleanup: () => {
            log.push(`cleanup:${id}`);
          },
        });
      return {
        log,
        scenes: [trace('scene-a'), trace('scene-b'), trace('scene-c')],
        compositionId,
      };
    };

    it('runs every scene in a composition under `mode=present` with cleanup-before-next-create ordering (pins the inter-scene-transition seam, NOT transition rendering)', async () => {
      // Inter-scene transition RENDERING is reserved by ADR-003's GSAP
      // runner and not implemented in this repo yet. What this test
      // pins is the lifecycle ordering the future runner will hang
      // transition rendering off: under `mode=present` the resolver
      // visits every entry in a composition slice in manifest order
      // and runs cleanup before the next entry's create (ADR-011 /
      // PUL-F004). A regression that collapsed `mode=present` to a
      // single-scene load — or that re-ordered cleanup after the next
      // create — would fail here and break every future inter-scene
      // transition before it ships.
      const probe = buildLifecycleProbe();
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([...probe.scenes]),
        compositions: createCompositionRegistry([
          {
            id: probe.compositionId,
            manifest: probe.scenes.map((s) => s.id),
          },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
      });

      await loader.handle(presentTarget(probe.compositionId));

      expect(probe.log).toEqual([
        'create:scene-a',
        'timeline:scene-a',
        'cleanup:scene-a',
        'create:scene-b',
        'timeline:scene-b',
        'cleanup:scene-b',
        'create:scene-c',
        'timeline:scene-c',
        'cleanup:scene-c',
      ]);
      expect(stage.attrs.get('data-pulsar-scene-target')).toBe('scene-a');
      expect(stage.attrs.get('data-pulsar-composition-target')).toBe(probe.compositionId);
    });

    it('produces the same multi-scene lifecycle when `mode` is absent (clause: present is the default)', async () => {
      // PUL-F013 is paired with PUL-F012's "absent mode defaults to
      // present" contract: a URL with no `mode=` parameter selects the
      // same behavior as an explicit `mode=present`. Pinning a separate
      // run of the multi-scene flow without `mode` proves the runtime
      // does not branch on "explicit vs default" present in any way that
      // would let PUL-F013 drift between the two.
      const probe = buildLifecycleProbe();
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([...probe.scenes]),
        compositions: createCompositionRegistry([
          {
            id: probe.compositionId,
            manifest: probe.scenes.map((s) => s.id),
          },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
      });

      await loader.handle(absentModeTarget(probe.compositionId));

      expect(probe.log).toEqual([
        'create:scene-a',
        'timeline:scene-a',
        'cleanup:scene-a',
        'create:scene-b',
        'timeline:scene-b',
        'cleanup:scene-b',
        'create:scene-c',
        'timeline:scene-c',
        'cleanup:scene-c',
      ]);
    });

    it('exposes `ctx.mode === "present"` in every lifecycle hook for both explicit and absent mode (mode-hint contract clauses 1/2 will consume)', async () => {
      // Chrome and audio rendering, when those subsystems land, will
      // read `ctx.mode` to decide whether to render / play. Pinning that
      // every lifecycle hook in a multi-scene flow under `mode=present`
      // (and absent mode) sees `ctx.mode === 'present'` is the
      // executable form of "the runtime exposes the present hint to
      // every scene that runs under it" — a regression that built ctx
      // once per loader (instead of once per navigation) would leak the
      // wrong mode into later hooks here.
      const seen: { phase: string; sceneId: string; mode: unknown }[] = [];
      const recordMode =
        (phase: string, sceneId: string) =>
        (ctx: unknown): unknown => {
          seen.push({ phase, sceneId, mode: (ctx as { mode?: NavigationMode }).mode });
          return null;
        };
      const sceneA = buildScene({
        id: 'scene-a',
        create: recordMode('create', 'scene-a'),
        timeline: recordMode('timeline', 'scene-a') as SceneModule['timeline'],
        cleanup: recordMode('cleanup', 'scene-a'),
      });
      const sceneB = buildScene({
        id: 'scene-b',
        create: recordMode('create', 'scene-b'),
        timeline: recordMode('timeline', 'scene-b') as SceneModule['timeline'],
        cleanup: recordMode('cleanup', 'scene-b'),
      });
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB]),
        compositions: createCompositionRegistry([
          { id: 'full-talk', manifest: ['scene-a', 'scene-b'] },
        ]),
        stage: stage.element,
        buildCtx: (mode) => ({ stage: stage.element, mode }),
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
      });

      await loader.handle(presentTarget('full-talk'));
      await loader.handle(absentModeTarget('full-talk'));

      // 6 hooks per navigation × 2 navigations = 12 entries; every
      // single one carries `present`. The two-navigation shape also
      // catches a regression where mode is captured into a closure once
      // and reused across navigations.
      expect(seen).toHaveLength(12);
      for (const entry of seen) {
        expect(entry.mode).toBe('present');
      }
    });

    it('forwards a non-undefined `AbortSignal` to the runner under `mode=present` (pins the presenter-input seam, NOT presenter input itself)', async () => {
      // Actual presenter input is PUL-F020's deliverable. What this
      // test pins is the seam PUL-F020 will drive: the per-navigation
      // `AbortSignal` (PUL-F006 / ADR-011) reaches the timeline
      // runner's `input.signal` under `mode=present`. A regression
      // that dropped the signal forwarding for present mode would
      // disconnect the seam before PUL-F020 even lands.
      const captured: { signalDefined: boolean; aborted: boolean }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneB = buildScene({ id: 'scene-b' });
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB]),
        compositions: createCompositionRegistry([
          { id: 'full-talk', manifest: ['scene-a', 'scene-b'] },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: (input) => {
          captured.push({
            signalDefined: input.signal !== undefined,
            aborted: input.signal?.aborted === true,
          });
        },
      });

      await loader.handle(presentTarget('full-talk'));

      // One entry per scene the runner saw. Both must show a defined,
      // un-aborted signal at the moment the runner observed it.
      expect(captured).toEqual([
        { signalDefined: true, aborted: false },
        { signalDefined: true, aborted: false },
      ]);
    });

    it('an in-flight abort under `mode=present` flips `signal.aborted` and triggers cleanup (pins the abort-to-cleanup connectedness PUL-F020 will drive)', async () => {
      // Actual presenter input is PUL-F020's deliverable; here we
      // pin the connectedness of the abort seam end to end under
      // `mode=present`: when the per-navigation `AbortController` is
      // aborted (PUL-F020 will drive this from a presenter control;
      // the loader drives it from a superseding handle() in this
      // test), the runner observes `signal.aborted === true`, the
      // runner's promise can resolve from that signal, and the
      // resolver's mandatory-cleanup invariant runs `cleanup(ctx)`
      // on the in-flight scene. Without this connectedness, every
      // future presenter-driven abort would either leak the signal
      // or skip cleanup.
      //
      // Determinism: the test asserts the runner observed a defined
      // signal BEFORE parking on the abort gate, so a regression that
      // dropped signal forwarding fails fast with an assertion rather
      // than via the test-runner timeout.
      const cleanupRan: string[] = [];
      let runnerSignal: AbortSignal | undefined;
      // First runner call holds open until aborted; subsequent calls
      // (the superseding navigation's runner) resolve immediately so
      // the test does not hang waiting for an interrupt that never
      // arrives.
      let runnerCalls = 0;
      const runner: SceneTimelineRunner = (input) => {
        runnerCalls += 1;
        if (runnerCalls !== 1) return undefined;
        // Capture and assert signal presence synchronously, before
        // returning the gate promise. A missing signal fails the
        // test deterministically with the assertion below — not via
        // the 5s test timeout the abort-listener path would otherwise
        // hit.
        runnerSignal = input.signal;
        if (runnerSignal === undefined) {
          throw new Error('mode=present did not forward a signal to the runner');
        }
        const signal = runnerSignal;
        return new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      };
      const sceneA = buildScene({
        id: 'scene-a',
        cleanup: () => {
          cleanupRan.push('scene-a');
        },
      });
      const sceneB = buildScene({
        id: 'scene-b',
        cleanup: () => {
          cleanupRan.push('scene-b');
        },
      });
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: runner,
        onError: () => undefined,
      });

      // First navigation: scene-a starts and the runner parks waiting
      // for abort. We do NOT await this handle — we want the runner
      // sitting on the gate when the abort arrives.
      const first = loader.handle({
        locator: { kind: 'scene', scene: 'scene-a' },
        mode: 'present',
      });
      while (runnerCalls === 0) {
        await Promise.resolve();
      }
      // Signal MUST be present by the time the runner parked on it;
      // assert before triggering the abort so a regression fails here
      // rather than via timeout.
      expect(runnerSignal).toBeDefined();
      expect(runnerSignal?.aborted).toBe(false);

      // Second navigation: simulates the presenter / popstate trigger
      // that PUL-F020 will drive. The loader aborts the first load.
      const second = loader.handle({
        locator: { kind: 'scene', scene: 'scene-b' },
        mode: 'present',
      });

      await first;
      await second;

      expect(runnerSignal?.aborted).toBe(true);
      // scene-a's cleanup ran (mandatory cleanup on every scene exit
      // — PUL-F006). scene-b's cleanup ran on its normal-advance exit
      // because the second navigation also completed.
      expect(cleanupRan).toContain('scene-a');
      expect(cleanupRan).toContain('scene-b');
    });

    it('writes no `data-pulsar-mode-*` suppression attribute on the stage under `mode=present`', async () => {
      // The PUL-F013 invariant is narrow: under `mode=present` the
      // loader MUST NOT preemptively write a suppression-style stage
      // attribute under the `data-pulsar-mode-` namespace (e.g.
      // `data-pulsar-mode-suppress-chrome`, `data-pulsar-mode-mute`).
      // Future modes that DO suppress facets are free to do so
      // through this namespace; PUL-F013 forbids it for `present`.
      // The assertion is scoped to that namespace only — adding
      // unrelated diagnostics or observability attributes (e.g. a
      // future `data-pulsar-state-*`) does not break this test.
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
      });

      await loader.handle({ locator: { kind: 'scene', scene: 'scene-a' }, mode: 'present' });

      const modeAttrs = Array.from(stage.attrs.keys()).filter((name) =>
        name.startsWith('data-pulsar-mode-'),
      );
      expect(modeAttrs).toEqual([]);
    });
  });
});
