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

import { describe, expect, it } from 'vitest';
import { createCompositionRegistry } from '../../src/runtime/composition-registry';
import type { SceneTimelineRunner } from '../../src/runtime/composition-resolver';
import type { NavigationTarget } from '../../src/runtime/navigation';
import { createSceneRegistry } from '../../src/runtime/registry';
import type { SceneModule } from '../../src/runtime/scene';
import { type StageElement, createSceneLoader } from '../../src/runtime/scene-loader';

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
        ctx: {},
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
        ctx: {},
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
        ctx: {},
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
        ctx: {},
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
          ctx: {},
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
          ctx: {},
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
        ctx: {},
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
        ctx: {},
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
        ctx: {},
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
        ctx: {},
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
        ctx: {},
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
        ctx: {},
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
        ctx: {},
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
        ctx: {},
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
        ctx: {},
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
        ctx: {},
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
        ctx: {},
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
        ctx: {},
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
        ctx: {},
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
        ctx: {},
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
        ctx: {},
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
        ctx: {},
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
        ctx: {},
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
        ctx: {},
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
        ctx: {},
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
        ctx: {},
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
        ctx: {},
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
        ctx: {},
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
        ctx: {},
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
        ctx: {},
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
        ctx: {},
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
});
