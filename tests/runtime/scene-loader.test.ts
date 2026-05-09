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
import type { PrompterRenderer, PrompterScript } from '../../src/runtime/prompter';
import { createSceneRegistry } from '../../src/runtime/registry';
import type { Caption, SceneModule } from '../../src/runtime/scene';
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
  readonly title?: string;
  readonly captions?: readonly Caption[];
  readonly create?: SceneModule['create'];
  readonly timeline?: SceneModule['timeline'];
  readonly cleanup?: SceneModule['cleanup'];
}

const buildScene = (opts: BuildSceneOpts): SceneModule => ({
  id: opts.id,
  title: opts.title ?? opts.id,
  duration: 1000,
  tags: [],
  assets: [],
  captions: opts.captions ?? [],
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

    // PUL-F019 / ADR-022: under `mode=prompter` the loader bypasses
    // the resolver lifecycle structurally — `buildCtx` is NOT
    // invoked because there is no scene to mount. The
    // buildCtx-per-mode test therefore only applies to the six
    // lifecycle-running modes; prompter's "no buildCtx invocation"
    // invariant is pinned by the dedicated `prompter-mode caption-
    // view dispatch (PUL-F019)` block.
    const LIFECYCLE_MODES = NAVIGATION_MODES.filter((m) => m !== 'prompter');

    it.each(LIFECYCLE_MODES)(
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

    it('does NOT invoke buildCtx when target.mode is "prompter" (PUL-F019: lifecycle is structurally bypassed under prompter)', async () => {
      // The structural inverse of the lifecycle-mode test above —
      // pinned here so PUL-F012's mode-dispatch block is honest
      // about which modes actually run the lifecycle.
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

      await loader.handle({ locator: { kind: 'scene', scene: 'intro' }, mode: 'prompter' });

      expect(probe.modes).toEqual([]);
    });

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
      readonly runner: SceneTimelineRunner;
    }

    // Build a probe whose runner writes into the SAME log as the
    // scene's create/timeline/cleanup hooks. This is what makes the
    // transition-order test catch a regression that bypassed or
    // re-ordered `runTimeline` under `mode=present` — without the
    // runner observation, a "skip runTimeline for present" bug would
    // still emit `create → timeline → cleanup` and pass.
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
      const runner: SceneTimelineRunner = (input) => {
        log.push(`runTimeline:${input.scene.id}`);
      };
      return {
        log,
        scenes: [trace('scene-a'), trace('scene-b'), trace('scene-c')],
        compositionId,
        runner,
      };
    };

    it('runs every scene in a composition under `mode=present` with cleanup-before-next-create ordering AND `runTimeline` between timeline-factory and cleanup (pins the inter-scene-transition seam, NOT transition rendering)', async () => {
      // Inter-scene transition RENDERING is reserved by ADR-003's GSAP
      // runner and not implemented in this repo yet. What this test
      // pins is the lifecycle ordering the future runner will hang
      // transition rendering off: under `mode=present` the resolver
      // visits every entry in a composition slice in manifest order,
      // calls `runTimeline` between the timeline factory and cleanup,
      // and runs cleanup before the next entry's create (ADR-011 /
      // PUL-F004). The runner's `runTimeline:<id>` log entry catches
      // a regression that bypassed `runTimeline` under `mode=present`
      // — without it, "skip runTimeline for present" would still emit
      // create / timeline / cleanup and pass.
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
        runTimeline: probe.runner,
      });

      await loader.handle(presentTarget(probe.compositionId));

      expect(probe.log).toEqual([
        'create:scene-a',
        'timeline:scene-a',
        'runTimeline:scene-a',
        'cleanup:scene-a',
        'create:scene-b',
        'timeline:scene-b',
        'runTimeline:scene-b',
        'cleanup:scene-b',
        'create:scene-c',
        'timeline:scene-c',
        'runTimeline:scene-c',
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
        runTimeline: probe.runner,
      });

      await loader.handle(absentModeTarget(probe.compositionId));

      expect(probe.log).toEqual([
        'create:scene-a',
        'timeline:scene-a',
        'runTimeline:scene-a',
        'cleanup:scene-a',
        'create:scene-b',
        'timeline:scene-b',
        'runTimeline:scene-b',
        'cleanup:scene-b',
        'create:scene-c',
        'timeline:scene-c',
        'runTimeline:scene-c',
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

    it('forwards a non-undefined `AbortSignal` to the runner under `mode=present` AND under absent `mode` (pins the presenter-input seam, NOT presenter input itself)', async () => {
      // Actual presenter input is PUL-F020's deliverable. What this
      // test pins is the seam PUL-F020 will drive: the per-navigation
      // `AbortSignal` (PUL-F006 / ADR-011) reaches the timeline
      // runner's `input.signal` under `mode=present` AND under absent
      // `mode` (the URL form that defaults to `present` per
      // PUL-F012 / ADR-007). Asserting both forms catches a regression
      // that dropped signal forwarding for one but not the other —
      // e.g. an "if mode is explicitly present" branch that skipped
      // the absent-mode default.
      const captured: { mode: string; signalDefined: boolean; aborted: boolean }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneB = buildScene({ id: 'scene-b' });
      const stage = buildStage();
      let phase: 'explicit-present' | 'absent-mode' = 'explicit-present';
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
            mode: phase,
            signalDefined: input.signal !== undefined,
            aborted: input.signal?.aborted === true,
          });
        },
      });

      await loader.handle(presentTarget('full-talk'));
      phase = 'absent-mode';
      await loader.handle(absentModeTarget('full-talk'));

      // 2 scenes per navigation × 2 navigations = 4 entries. Every
      // single one must show a defined, un-aborted signal — proving
      // the seam reaches the runner identically for both URL forms
      // that select `present`.
      expect(captured).toEqual([
        { mode: 'explicit-present', signalDefined: true, aborted: false },
        { mode: 'explicit-present', signalDefined: true, aborted: false },
        { mode: 'absent-mode', signalDefined: true, aborted: false },
        { mode: 'absent-mode', signalDefined: true, aborted: false },
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
      // The runner resolves a deferred when its first call enters; the
      // test awaits that deferred (or a 1s timeout) instead of an
      // unbounded microtask spin so a regression that prevents the
      // runner from starting fails with a deterministic assertion
      // rather than hanging the test process.
      let runnerEntered: () => void = () => undefined;
      const runnerEnteredPromise = new Promise<void>((resolve) => {
        runnerEntered = resolve;
      });
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
        // test deterministically with the throw below — not via the
        // 5s test timeout the abort-listener path would otherwise
        // hit.
        runnerSignal = input.signal;
        runnerEntered();
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
      // Bounded wait: race the deferred against a 1s timeout. A
      // regression that prevents the runner from starting fails the
      // assertion below with `runnerCalls === 0`, not via the 5s test
      // timeout.
      const guard = new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), 1000);
      });
      const enteredOrTimeout = await Promise.race([
        runnerEnteredPromise.then(() => 'entered' as const),
        guard,
      ]);
      expect(enteredOrTimeout).toBe('entered');
      expect(runnerCalls).toBe(1);
      // Signal MUST be present by the time the runner parked on it;
      // assert before triggering the abort.
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

  describe('standalone-mode single-scene execution (PUL-F014)', () => {
    // PUL-F014 statement: in `mode=standalone`, the runtime SHALL render
    // a single scene with surrounding chrome, inter-scene transitions,
    // and audio bed suppressed; the scene SHALL run as if no surrounding
    // composition existed.
    //
    // Materially-implementable parts of the statement that this block
    // pins:
    //   - "Render a single scene" / "run as if no surrounding
    //     composition existed" — composition / composition+scene /
    //     composition+index targets resolve normally (composition
    //     validation still runs), but only the addressed head scene's
    //     lifecycle is executed. No following composition entry runs.
    //   - "Inter-scene transitions suppressed" — by virtue of
    //     single-scene execution there is no second scene to transition
    //     to; no later `runTimeline` call is made for the dropped
    //     slice. The suppression is structural.
    //   - `ctx.mode === 'standalone'` is exposed to every lifecycle
    //     hook of the head scene — the seam future chrome / audio
    //     surfaces (ADR-004 / future workbench-shell requirement) will
    //     read to decide their own suppression behavior. Today there is
    //     no chrome or audio bed in the repo to suppress, so no
    //     end-to-end suppression test is possible until those surfaces
    //     land.
    //   - No `data-pulsar-mode-*` suppression attribute is preemptively
    //     written under `standalone` (parity with ADR-016's invariant
    //     for `mode=present`; future modes are free to use that
    //     namespace if they actually need it).
    //
    // PUL-F014 stays DRAFT after this PR (ADR-017 records the
    // boundary; following the ADR-016 / PUL-F013 precedent). The
    // single-scene execution mechanism and the `ctx.mode` seam ARE
    // materially shipped; the three named suppression surfaces
    // (chrome, audio bed, inter-scene transitions) gate the
    // DRAFT → ACTIVE transition — each must land as a real surface
    // that actively reads `ctx.mode === 'standalone'` and suppresses,
    // with end-to-end tests alongside these seam tests.

    const standaloneCompositionTarget = (composition: string): NavigationTarget => ({
      locator: { kind: 'composition', composition },
      mode: 'standalone',
    });
    const standaloneCompositionSceneTarget = (
      composition: string,
      scene: string,
    ): NavigationTarget => ({
      locator: { kind: 'composition-scene', composition, scene },
      mode: 'standalone',
    });
    const standaloneCompositionIndexTarget = (
      composition: string,
      index: number,
    ): NavigationTarget => ({
      locator: { kind: 'composition-index', composition, index },
      mode: 'standalone',
    });
    const standaloneSceneTarget = (id: string): NavigationTarget => ({
      locator: { kind: 'scene', scene: id },
      mode: 'standalone',
    });

    interface LifecycleProbe {
      readonly log: string[];
      readonly scenes: readonly SceneModule[];
      readonly compositionId: string;
      readonly runner: SceneTimelineRunner;
    }

    // Probe whose runner ALSO writes into the same lifecycle log so a
    // regression that bypassed `runTimeline` for the head scene under
    // standalone (e.g. "skip the runner because it's standalone") would
    // be caught — without the runner observation, dropping `runTimeline`
    // entirely would still emit `create → timeline → cleanup` and pass.
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
      const runner: SceneTimelineRunner = (input) => {
        log.push(`runTimeline:${input.scene.id}`);
      };
      return {
        log,
        scenes: [trace('scene-a'), trace('scene-b'), trace('scene-c')],
        compositionId,
        runner,
      };
    };

    it('runs only the head scene of a `composition` target under `mode=standalone` (no following entries fire)', async () => {
      // The composition lists three scenes; under `mode=standalone` only
      // the first must execute. A regression that forgot to drop the
      // composition slice would emit lifecycle entries for scene-b and
      // scene-c too.
      const probe = buildLifecycleProbe();
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([...probe.scenes]),
        compositions: createCompositionRegistry([
          { id: probe.compositionId, manifest: probe.scenes.map((s) => s.id) },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: probe.runner,
      });

      await loader.handle(standaloneCompositionTarget(probe.compositionId));

      expect(probe.log).toEqual([
        'create:scene-a',
        'timeline:scene-a',
        'runTimeline:scene-a',
        'cleanup:scene-a',
      ]);
    });

    it('runs only the addressed scene of a `composition+scene` target under `mode=standalone`', async () => {
      const probe = buildLifecycleProbe();
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([...probe.scenes]),
        compositions: createCompositionRegistry([
          { id: probe.compositionId, manifest: probe.scenes.map((s) => s.id) },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: probe.runner,
      });

      await loader.handle(standaloneCompositionSceneTarget(probe.compositionId, 'scene-b'));

      expect(probe.log).toEqual([
        'create:scene-b',
        'timeline:scene-b',
        'runTimeline:scene-b',
        'cleanup:scene-b',
      ]);
    });

    it('runs only the entry at the requested index of a `composition+index` target under `mode=standalone` (skipping following entries — a last-index test would NOT catch a slice-truncation regression because the slice has no successors to skip)', async () => {
      // index=1 against [a, b, c] resolves to a slice [b, c]. Under
      // mode=standalone the loader must drop the trailing entry so
      // only scene-b runs; without the slice transform scene-c would
      // run too. Choosing a non-final index is what makes this test
      // a regression detector for the slice transform itself —
      // index=2 would slice to [c] and pass under any mode (no
      // successors), so it would fail to discriminate standalone from
      // present.
      const probe = buildLifecycleProbe();
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([...probe.scenes]),
        compositions: createCompositionRegistry([
          { id: probe.compositionId, manifest: probe.scenes.map((s) => s.id) },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: probe.runner,
      });

      await loader.handle(standaloneCompositionIndexTarget(probe.compositionId, 1));

      expect(probe.log).toEqual([
        'create:scene-b',
        'timeline:scene-b',
        'runTimeline:scene-b',
        'cleanup:scene-b',
      ]);
    });

    it('runs a direct `scene` target under `mode=standalone` unchanged (baseline parity — no slice to drop)', async () => {
      const probe = buildLifecycleProbe();
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([...probe.scenes]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: probe.runner,
      });

      await loader.handle(standaloneSceneTarget('scene-b'));

      expect(probe.log).toEqual([
        'create:scene-b',
        'timeline:scene-b',
        'runTimeline:scene-b',
        'cleanup:scene-b',
      ]);
    });

    it('forwards `beat` to the head scene runner under `mode=standalone` and surfaces missing-beat as a non-fatal diagnostic', async () => {
      // Beat semantics under standalone are identical to other modes:
      // the runner sees `headBeat` on its input, and a missing-label
      // call from the runner surfaces via `data-pulsar-navigation-error`
      // and `onError` without unmounting the scene. A regression that
      // dropped beat forwarding for standalone would lose the diagnostic
      // surface for single-scene authoring — exactly the use case this
      // mode targets.
      const captured: { sceneId: string; beat: string | undefined }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneB = buildScene({ id: 'scene-b' });
      const stage = buildStage();
      const errors: unknown[] = [];
      const runner: SceneTimelineRunner = (input) => {
        captured.push({ sceneId: input.scene.id, beat: input.beat });
        if (input.beat !== undefined && input.onBeatMissing !== undefined) {
          input.onBeatMissing();
        }
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB]),
        compositions: createCompositionRegistry([
          { id: 'full-talk', manifest: ['scene-a', 'scene-b'] },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: runner,
        onError: (err) => {
          errors.push(err);
        },
      });

      await loader.handle({
        locator: { kind: 'composition-scene', composition: 'full-talk', scene: 'scene-b' },
        mode: 'standalone',
        beat: 'midpoint',
      });

      // Only scene-b's runner ran (single-scene), with the beat
      // forwarded.
      expect(captured).toEqual([{ sceneId: 'scene-b', beat: 'midpoint' }]);
      // The missing-beat diagnostic surfaced via the loader's standard
      // path — `onError` invoked once with the loader's wrapping
      // message, and the stage attribute is set.
      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain('beat positioning failed');
      expect((errors[0] as Error).message).toContain('"midpoint"');
      expect(stage.attrs.get('data-pulsar-navigation-error')).toBeDefined();
    });

    it('exposes `ctx.mode === "standalone"` to every lifecycle hook of the head scene under all locator shapes', async () => {
      const seen: { phase: string; locatorKind: string; mode: unknown }[] = [];
      const recordMode =
        (phase: string, locatorKind: string) =>
        (ctx: unknown): unknown => {
          seen.push({ phase, locatorKind, mode: (ctx as { mode?: NavigationMode }).mode });
          return null;
        };
      // Build a single scene with phase recorders; we rebuild the loader
      // per locator-shape navigation so each navigation gets a fresh
      // recorder run without cross-contamination.
      const makeScene = (locatorKind: string): SceneModule =>
        buildScene({
          id: 'scene-a',
          create: recordMode('create', locatorKind),
          timeline: recordMode('timeline', locatorKind) as SceneModule['timeline'],
          cleanup: recordMode('cleanup', locatorKind),
        });
      const stage = buildStage();
      const buildLoader = (sceneId: string, locatorKind: string) =>
        createSceneLoader({
          scenes: createSceneRegistry([makeScene(locatorKind)]),
          compositions: createCompositionRegistry([{ id: 'full-talk', manifest: [sceneId] }]),
          stage: stage.element,
          buildCtx: (mode) => ({ stage: stage.element, mode }),
          createPreloader: () => () => undefined,
          runTimeline: noopRunner,
        });

      await buildLoader('scene-a', 'scene').handle(standaloneSceneTarget('scene-a'));
      await buildLoader('scene-a', 'composition').handle(standaloneCompositionTarget('full-talk'));
      await buildLoader('scene-a', 'composition-scene').handle(
        standaloneCompositionSceneTarget('full-talk', 'scene-a'),
      );
      await buildLoader('scene-a', 'composition-index').handle(
        standaloneCompositionIndexTarget('full-talk', 0),
      );

      // 3 hooks per navigation × 4 locator shapes = 12 entries; every
      // single one must carry `standalone`.
      expect(seen).toHaveLength(12);
      for (const entry of seen) {
        expect(entry.mode).toBe('standalone');
      }
    });

    it('writes both `data-pulsar-scene-target` and `data-pulsar-composition-target` for a composition target under `mode=standalone` (preserves observability of what the URL addressed)', async () => {
      const probe = buildLifecycleProbe();
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([...probe.scenes]),
        compositions: createCompositionRegistry([
          { id: probe.compositionId, manifest: probe.scenes.map((s) => s.id) },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: probe.runner,
      });

      await loader.handle(standaloneCompositionSceneTarget(probe.compositionId, 'scene-b'));

      expect(stage.attrs.get('data-pulsar-scene-target')).toBe('scene-b');
      expect(stage.attrs.get('data-pulsar-composition-target')).toBe(probe.compositionId);
    });

    it('writes no `data-pulsar-mode-*` suppression attribute on the stage under `mode=standalone`', async () => {
      // Mirrors ADR-016's invariant for `mode=present`. Future
      // chrome/audio adapters may use `data-pulsar-mode-*` if they need
      // a stage-level signal; PUL-F014 forbids the loader from
      // preemptively writing one.
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

      await loader.handle(standaloneSceneTarget('scene-a'));

      const modeAttrs = Array.from(stage.attrs.keys()).filter((name) =>
        name.startsWith('data-pulsar-mode-'),
      );
      expect(modeAttrs).toEqual([]);
    });

    it('surfaces composition-not-registered as a navigation error under `mode=standalone` (no silent fallback to direct scene lookup)', async () => {
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const errors: unknown[] = [];
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
        onError: (err) => {
          errors.push(err);
        },
      });

      await loader.handle(standaloneCompositionTarget('not-registered'));

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain(
        'composition "not-registered" is not registered',
      );
      expect(stage.attrs.get('data-pulsar-navigation-error')).toBeDefined();
    });

    it('surfaces composition-member error under `mode=standalone` for an unknown scene in `composition+scene`', async () => {
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneZ = buildScene({ id: 'scene-z' });
      const stage = buildStage();
      const errors: unknown[] = [];
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneZ]),
        compositions: createCompositionRegistry([{ id: 'full-talk', manifest: ['scene-a'] }]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
        onError: (err) => {
          errors.push(err);
        },
      });

      await loader.handle(standaloneCompositionSceneTarget('full-talk', 'scene-z'));

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain(
        'scene "scene-z" is not a member of composition "full-talk"',
      );
    });

    it('surfaces index-out-of-range under `mode=standalone`', async () => {
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const errors: unknown[] = [];
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([{ id: 'full-talk', manifest: ['scene-a'] }]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
        onError: (err) => {
          errors.push(err);
        },
      });

      await loader.handle(standaloneCompositionIndexTarget('full-talk', 5));

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain('index 5 is out of range');
    });

    it("preserves the addressed head entry's `range` and `behavior` overrides on the runner input under `mode=standalone` (composition+index with object-form entry)", async () => {
      // PUL-F014 / ADR-017: standalone is single-scene EXECUTION at the
      // addressed head, NOT direct-scene flattening. A regression that
      // dropped the composition slice entirely (instead of truncating
      // it to one entry) would lose the head entry's `range` /
      // `behavior` overrides — the runner would receive `range:
      // undefined, behavior: undefined` even though the URL named an
      // object-form entry that carries them. This test pins both
      // override slots through to the runner.
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneB = buildScene({ id: 'scene-b' });
      const sceneC = buildScene({ id: 'scene-c' });
      const stage = buildStage();
      const captured: {
        sceneId: string;
        range: unknown;
        behavior: unknown;
      }[] = [];
      const runner: SceneTimelineRunner = (input) => {
        captured.push({
          sceneId: input.scene.id,
          range: input.range,
          behavior: input.behavior,
        });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB, sceneC]),
        compositions: createCompositionRegistry([
          {
            id: 'full-talk',
            manifest: [
              'scene-a',
              { id: 'scene-b', range: 'hook', behavior: { hold: true } },
              'scene-c',
            ],
          },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: runner,
      });

      await loader.handle(standaloneCompositionIndexTarget('full-talk', 1));

      // Runner ran exactly once (single-scene execution) AND the
      // addressed entry's overrides reached `input.range` /
      // `input.behavior`. A regression that flattened to direct-scene
      // would show `range: undefined, behavior: undefined` here.
      expect(captured).toEqual([{ sceneId: 'scene-b', range: 'hook', behavior: { hold: true } }]);
    });

    it('runs cleanup exactly once for the head scene under `mode=standalone`, never for dropped slice entries', async () => {
      // A regression that dropped the slice for execution but left
      // following scenes in the synthesized registry could double-clean
      // or skip-clean. This test pins exactly-once cleanup on the head
      // scene and zero cleanup for the dropped entries.
      const cleaned: string[] = [];
      const trace = (id: string): SceneModule =>
        buildScene({
          id,
          cleanup: () => {
            cleaned.push(id);
          },
        });
      const scenes = [trace('scene-a'), trace('scene-b'), trace('scene-c')];
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry(scenes),
        compositions: createCompositionRegistry([
          { id: 'full-talk', manifest: scenes.map((s) => s.id) },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
      });

      await loader.handle(standaloneCompositionTarget('full-talk'));

      expect(cleaned).toEqual(['scene-a']);
    });
  });

  describe('loop-mode runner repeat-hint forwarding (PUL-F015)', () => {
    // PUL-F015 statement: in `mode=loop`, the runtime SHALL run the
    // addressed scene's timeline and restart it on completion.
    //
    // Materially-implementable parts of the statement that this block
    // pins (ADR-018 records the contract boundary):
    //   - The loader passes `repeat: 'until-aborted'` to the timeline
    //     runner adapter when `effectiveMode(target) === 'loop'`. The
    //     runner is responsible for honoring the hint (e.g. ADR-003's
    //     future GSAP runner uses `timeline.repeat(-1)`).
    //   - The hint is HEAD-ONLY: under composition targets the head
    //     scene's runner input carries `repeat`; following entries do
    //     not. (Following entries do not run anyway because a looping
    //     head's timeline never naturally completes — the head-only
    //     scoping is what keeps the contract honest if a future
    //     runner exposes a non-`'until-aborted'` repeat semantics.)
    //   - `ctx.mode === 'loop'` reaches every lifecycle hook of the
    //     head scene — the seam future runner / chrome / audio
    //     surfaces will read.
    //   - Other modes (`present`, `standalone`, `paused`, `scrub`,
    //     `screenshot`, `prompter`) and a `mode`-less URL DO NOT set
    //     `repeat`. A regression that broadcast `repeat` under any
    //     mode would break URLs that depend on no-repeat semantics
    //     (e.g. screenshot determinism).
    //   - No `data-pulsar-mode-*` suppression attribute is preemptively
    //     written under `loop` (parity with ADR-016 / ADR-017).
    //   - Composition validation (unregistered composition, unknown
    //     member scene, out-of-range index) STILL surfaces as a
    //     navigation error under `mode=loop` — no silent fallback to
    //     direct scene lookup.
    //   - Beat semantics under `mode=loop` are unchanged from PUL-F011:
    //     the head scene's runner sees `input.beat`; missing-label
    //     diagnostics surface via `data-pulsar-navigation-error` /
    //     `onError` without unmounting.
    //   - Object-form head entry's `range` / `behavior` overrides
    //     reach the runner unchanged. Loop is single-scene-timeline
    //     repeat at the head, NOT direct-scene flattening.
    //
    // PUL-F015 stays DRAFT after this PR (ADR-018 records the
    // boundary; following the ADR-016 / ADR-017 / PUL-F013 / PUL-F014
    // precedent). The seam — the loader passes `repeat: 'until-aborted'`
    // and `ctx.mode === 'loop'` — IS materially shipped. The actual
    // restart-on-completion behavior is the runner's contract:
    // ADR-003's GSAP runner reads `input.repeat` when it lands.
    // Until then, the placeholder runner has no real timeline (returns
    // `null`) and parks until abort — vacuously satisfying "restart
    // on completion" because no completion ever fires. ACTIVE
    // transitions when the GSAP runner actively reads
    // `input.repeat === 'until-aborted'` and restarts the timeline,
    // with an end-to-end test alongside these seam tests.

    const loopSceneTarget = (id: string): NavigationTarget => ({
      locator: { kind: 'scene', scene: id },
      mode: 'loop',
    });
    const loopCompositionTarget = (composition: string): NavigationTarget => ({
      locator: { kind: 'composition', composition },
      mode: 'loop',
    });
    const loopCompositionSceneTarget = (composition: string, scene: string): NavigationTarget => ({
      locator: { kind: 'composition-scene', composition, scene },
      mode: 'loop',
    });
    const loopCompositionIndexTarget = (composition: string, index: number): NavigationTarget => ({
      locator: { kind: 'composition-index', composition, index },
      mode: 'loop',
    });

    it('passes `repeat: "until-aborted"` to the runner for a `scene` target under `mode=loop`', async () => {
      // Direct-scene navigation is the simplest loop path: the
      // addressed scene IS the head, no slice resolution. A regression
      // that gated `repeat` on `target.composition` being defined
      // would silently drop the hint here.
      const captured: { sceneId: string; repeat: 'until-aborted' | undefined }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const runner: SceneTimelineRunner = (input) => {
        captured.push({ sceneId: input.scene.id, repeat: input.repeat });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: runner,
      });

      await loader.handle(loopSceneTarget('scene-a'));

      expect(captured).toEqual([{ sceneId: 'scene-a', repeat: 'until-aborted' }]);
    });

    it('runs only the head scene of a `composition` target under `mode=loop` (slice truncation; runner sees `repeat: "until-aborted"` for the head)', async () => {
      // PUL-F015 / ADR-018: loop truncates the validated composition
      // slice to the addressed head, parallel to standalone (ADR-017).
      // Truncation makes "no following entries run" a structural
      // guarantee — a runner bug or no-op runner under `mode=loop`
      // MUST NOT silently degrade into normal composition playback
      // (codex pre-push review). Use a non-final-index navigation so
      // the slice has successors that would be observable if
      // truncation were missing — last-index would slice to one
      // entry anyway and fail to discriminate.
      const captured: { sceneId: string; repeat: 'until-aborted' | undefined }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneB = buildScene({ id: 'scene-b' });
      const sceneC = buildScene({ id: 'scene-c' });
      const stage = buildStage();
      const runner: SceneTimelineRunner = (input) => {
        captured.push({ sceneId: input.scene.id, repeat: input.repeat });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB, sceneC]),
        compositions: createCompositionRegistry([
          { id: 'full-talk', manifest: ['scene-a', 'scene-b', 'scene-c'] },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: runner,
      });

      await loader.handle(loopCompositionIndexTarget('full-talk', 0));

      expect(captured).toEqual([{ sceneId: 'scene-a', repeat: 'until-aborted' }]);
    });

    it('runs only the addressed scene of a `composition+scene` target under `mode=loop`', async () => {
      // composition+scene targeting a non-final entry exercises the
      // slice transform from a different locator shape; pins parity
      // with the composition-target case above.
      const captured: { sceneId: string; repeat: 'until-aborted' | undefined }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneB = buildScene({ id: 'scene-b' });
      const sceneC = buildScene({ id: 'scene-c' });
      const stage = buildStage();
      const runner: SceneTimelineRunner = (input) => {
        captured.push({ sceneId: input.scene.id, repeat: input.repeat });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB, sceneC]),
        compositions: createCompositionRegistry([
          { id: 'full-talk', manifest: ['scene-a', 'scene-b', 'scene-c'] },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: runner,
      });

      await loader.handle(loopCompositionSceneTarget('full-talk', 'scene-b'));

      expect(captured).toEqual([{ sceneId: 'scene-b', repeat: 'until-aborted' }]);
    });

    it('runs cleanup exactly once for the head scene under `mode=loop`, never for dropped slice entries', async () => {
      // Same invariant as PUL-F014 (ADR-017) under standalone: a
      // regression that dropped the slice for execution but left
      // following scenes wired through the synthesized registry could
      // double-clean or skip-clean. Pin exactly-once cleanup on the
      // head and zero cleanup for the dropped entries.
      const cleaned: string[] = [];
      const trace = (id: string): SceneModule =>
        buildScene({
          id,
          cleanup: () => {
            cleaned.push(id);
          },
        });
      const scenes = [trace('scene-a'), trace('scene-b'), trace('scene-c')];
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry(scenes),
        compositions: createCompositionRegistry([
          { id: 'full-talk', manifest: scenes.map((s) => s.id) },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
      });

      await loader.handle(loopCompositionTarget('full-talk'));

      expect(cleaned).toEqual(['scene-a']);
    });

    it('omits the `repeat` key on the runner input when `mode=loop` is absent (key-presence semantics)', async () => {
      // The runner input uses key-presence semantics for optional
      // fields (parallel to `beat` / `range` / `behavior`): a runner
      // can branch on `'repeat' in input` rather than `=== undefined`.
      // A regression that always set `input.repeat = undefined` (or
      // any non-`'until-aborted'` value) under non-loop modes would
      // break that contract.
      const captured: { hasRepeat: boolean; repeat: unknown }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const runner: SceneTimelineRunner = (input) => {
        captured.push({ hasRepeat: 'repeat' in input, repeat: input.repeat });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: runner,
      });

      // No mode at all (defaults to `present`).
      await loader.handle(sceneTarget('scene-a'));

      expect(captured).toEqual([{ hasRepeat: false, repeat: undefined }]);
    });

    it('does not set `repeat` for any non-loop, lifecycle-running mode', async () => {
      // Walk the seven-mode allowlist (minus `loop` and `prompter`)
      // and confirm that none of them produce `repeat` on the
      // runner input. Catching every non-loop mode discriminates
      // against an over-broad fix that gated `repeat` on
      // `mode !== undefined` rather than `mode === 'loop'`.
      // Capturing the per-iteration mode alongside the
      // `'repeat' in input` flag means the assertion failure
      // identifies WHICH mode regressed, not just "some mode did."
      //
      // PUL-F019 / ADR-022: `prompter` does not invoke `runTimeline`
      // at all (lifecycle is structurally bypassed), so it cannot
      // appear in this test's `captured` array. The dedicated
      // `prompter-mode caption-view dispatch (PUL-F019)` block
      // pins prompter's no-runner invariant directly. Filtering
      // it out here keeps this test focused on lifecycle modes.
      const nonLoopLifecycleModes = NAVIGATION_MODES.filter(
        (m) => m !== 'loop' && m !== 'prompter',
      );
      const captured: { mode: NavigationMode; hasRepeat: boolean }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      for (const mode of nonLoopLifecycleModes) {
        const runner: SceneTimelineRunner = (input) => {
          captured.push({ mode, hasRepeat: 'repeat' in input });
        };
        const loader = createSceneLoader({
          scenes: createSceneRegistry([sceneA]),
          compositions: createCompositionRegistry([]),
          stage: stage.element,
          buildCtx: stubCtx,
          createPreloader: () => () => undefined,
          runTimeline: runner,
        });
        await loader.handle({ locator: { kind: 'scene', scene: 'scene-a' }, mode });
      }

      // One entry per non-loop lifecycle mode, each must have
      // `hasRepeat: false`. Building the expected array from
      // `nonLoopLifecycleModes` keeps the assertion in sync if the
      // mode allowlist ever changes.
      expect(captured).toEqual(nonLoopLifecycleModes.map((mode) => ({ mode, hasRepeat: false })));
    });

    it('exposes `ctx.mode === "loop"` to every lifecycle hook of the head scene under all locator shapes', async () => {
      // Parallel to the PUL-F014 standalone seam test. Future runner /
      // chrome / audio surfaces read `ctx.mode` to decide their own
      // repeat / suppression behavior; this test pins the seam end to
      // end across all four locator shapes that can appear under
      // `mode=loop`.
      const seen: { phase: string; locatorKind: string; mode: unknown }[] = [];
      const recordMode =
        (phase: string, locatorKind: string) =>
        (ctx: unknown): unknown => {
          seen.push({ phase, locatorKind, mode: (ctx as { mode?: NavigationMode }).mode });
          return null;
        };
      const makeScene = (locatorKind: string): SceneModule =>
        buildScene({
          id: 'scene-a',
          create: recordMode('create', locatorKind),
          timeline: recordMode('timeline', locatorKind) as SceneModule['timeline'],
          cleanup: recordMode('cleanup', locatorKind),
        });
      const stage = buildStage();
      const buildLoader = (sceneId: string, locatorKind: string) =>
        createSceneLoader({
          scenes: createSceneRegistry([makeScene(locatorKind)]),
          compositions: createCompositionRegistry([{ id: 'full-talk', manifest: [sceneId] }]),
          stage: stage.element,
          buildCtx: (mode) => ({ stage: stage.element, mode }),
          createPreloader: () => () => undefined,
          runTimeline: noopRunner,
        });

      await buildLoader('scene-a', 'scene').handle(loopSceneTarget('scene-a'));
      await buildLoader('scene-a', 'composition').handle(loopCompositionTarget('full-talk'));
      await buildLoader('scene-a', 'composition-scene').handle(
        loopCompositionSceneTarget('full-talk', 'scene-a'),
      );
      await buildLoader('scene-a', 'composition-index').handle(
        loopCompositionIndexTarget('full-talk', 0),
      );

      // 3 hooks per navigation × 4 locator shapes = 12 entries; every
      // single one must carry `loop`.
      expect(seen).toHaveLength(12);
      for (const entry of seen) {
        expect(entry.mode).toBe('loop');
      }
    });

    it('forwards `beat` to the head scene runner alongside `repeat` under `mode=loop`, and surfaces missing-beat as a non-fatal diagnostic', async () => {
      // PUL-F011 / PUL-F015 are independent: a URL like
      // `?scene=x&beat=hook&mode=loop` must deliver both `beat` and
      // `repeat` to the runner. A regression that paired them — e.g.
      // dropping `repeat` when `beat` is supplied — would silently
      // break loop-mode navigation when a beat is also requested.
      const captured: {
        sceneId: string;
        beat: string | undefined;
        repeat: 'until-aborted' | undefined;
      }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const errors: unknown[] = [];
      const runner: SceneTimelineRunner = (input) => {
        captured.push({
          sceneId: input.scene.id,
          beat: input.beat,
          repeat: input.repeat,
        });
        if (input.beat !== undefined && input.onBeatMissing !== undefined) {
          input.onBeatMissing();
        }
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: runner,
        onError: (err) => {
          errors.push(err);
        },
      });

      await loader.handle({
        locator: { kind: 'scene', scene: 'scene-a' },
        mode: 'loop',
        beat: 'midpoint',
      });

      expect(captured).toEqual([{ sceneId: 'scene-a', beat: 'midpoint', repeat: 'until-aborted' }]);
      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain('beat positioning failed');
      expect((errors[0] as Error).message).toContain('"midpoint"');
      expect(stage.attrs.get('data-pulsar-navigation-error')).toBeDefined();
    });

    it('writes no `data-pulsar-mode-*` suppression attribute on the stage under `mode=loop`', async () => {
      // Mirrors ADR-016 / ADR-017 invariant. PUL-F015 forbids the
      // loader from preemptively writing a stage attribute for loop
      // mode; runner-side or future-surface-side signaling lives at
      // those surfaces, not at the loader.
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

      await loader.handle(loopSceneTarget('scene-a'));

      const modeAttrs = Array.from(stage.attrs.keys()).filter((name) =>
        name.startsWith('data-pulsar-mode-'),
      );
      expect(modeAttrs).toEqual([]);
    });

    it('surfaces composition-not-registered as a navigation error under `mode=loop` (no silent fallback)', async () => {
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const errors: unknown[] = [];
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
        onError: (err) => {
          errors.push(err);
        },
      });

      await loader.handle(loopCompositionTarget('not-registered'));

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain(
        'composition "not-registered" is not registered',
      );
      expect(stage.attrs.get('data-pulsar-navigation-error')).toBeDefined();
    });

    it('surfaces composition-member error under `mode=loop` for an unknown scene in `composition+scene`', async () => {
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneZ = buildScene({ id: 'scene-z' });
      const stage = buildStage();
      const errors: unknown[] = [];
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneZ]),
        compositions: createCompositionRegistry([{ id: 'full-talk', manifest: ['scene-a'] }]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
        onError: (err) => {
          errors.push(err);
        },
      });

      await loader.handle(loopCompositionSceneTarget('full-talk', 'scene-z'));

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain(
        'scene "scene-z" is not a member of composition "full-talk"',
      );
    });

    it('surfaces index-out-of-range under `mode=loop`', async () => {
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const errors: unknown[] = [];
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([{ id: 'full-talk', manifest: ['scene-a'] }]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
        onError: (err) => {
          errors.push(err);
        },
      });

      await loader.handle(loopCompositionIndexTarget('full-talk', 5));

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain('index 5 is out of range');
    });

    it("preserves the addressed head entry's `range` and `behavior` overrides on the runner input under `mode=loop` (composition+index with object-form entry)", async () => {
      // PUL-F015 / ADR-018: loop truncates the validated composition
      // slice to the addressed head and forwards `repeat` to that
      // head's runner input. The slice is TRUNCATED rather than
      // flattened — a flat `{ scene }` would lose object-form
      // `range` / `behavior` overrides on the head entry, turning
      // loop into direct-scene flattening (parity with ADR-017's
      // standalone invariant). This pins all three slots — `range`,
      // `behavior`, and `repeat` — through to the head runner, plus
      // the truncation itself (the runner runs exactly once).
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneB = buildScene({ id: 'scene-b' });
      const sceneC = buildScene({ id: 'scene-c' });
      const stage = buildStage();
      const captured: {
        sceneId: string;
        range: unknown;
        behavior: unknown;
        repeat: unknown;
      }[] = [];
      const runner: SceneTimelineRunner = (input) => {
        captured.push({
          sceneId: input.scene.id,
          range: input.range,
          behavior: input.behavior,
          repeat: input.repeat,
        });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB, sceneC]),
        compositions: createCompositionRegistry([
          {
            id: 'full-talk',
            manifest: [
              'scene-a',
              { id: 'scene-b', range: 'hook', behavior: { hold: true } },
              'scene-c',
            ],
          },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: runner,
      });

      await loader.handle(loopCompositionIndexTarget('full-talk', 1));

      // Single runner invocation (truncation), with overrides AND
      // `repeat` reaching the head's runner input together. A
      // regression that flattened to direct-scene would show
      // `range: undefined, behavior: undefined`; a regression that
      // dropped truncation would show a second invocation for
      // scene-c.
      expect(captured).toEqual([
        {
          sceneId: 'scene-b',
          range: 'hook',
          behavior: { hold: true },
          repeat: 'until-aborted',
        },
      ]);
    });
  });

  describe('paused-mode runner hold-hint forwarding (PUL-F016)', () => {
    // PUL-F016 statement: in `mode=paused`, the runtime SHALL mount
    // the addressed scene and hold it at its first frame without
    // advancing the timeline.
    //
    // Materially-implementable parts of the statement that this
    // block pins (ADR-019 records the contract boundary):
    //   - The loader passes `hold: 'first-frame'` to the timeline
    //     runner adapter when `effectiveMode(target) === 'paused'`.
    //     The runner is responsible for honoring the hint (e.g.
    //     ADR-003's future GSAP runner uses `timeline.pause()` at
    //     time 0).
    //   - The hint is HEAD-ONLY: under composition targets the head
    //     scene's runner input carries `hold`; following entries do
    //     not. Following entries do not run at all because the slice
    //     is truncated to the addressed head — same structural
    //     defense ADR-018 records for `mode=loop`.
    //   - `ctx.mode === 'paused'` reaches every lifecycle hook of
    //     the head scene — the seam future runner / chrome / audio
    //     surfaces will read.
    //   - Other modes (`present`, `standalone`, `loop`, `scrub`,
    //     `screenshot`, `prompter`) and a `mode`-less URL DO NOT
    //     set `hold`. A regression that broadcast `hold` under any
    //     mode would break URLs that depend on no-hold semantics
    //     (e.g. normal playback under `present`).
    //   - No `data-pulsar-mode-*` suppression attribute is preempt-
    //     ively written under `paused` (parity with ADR-016/017/018).
    //   - Composition validation (unregistered composition, unknown
    //     member scene, out-of-range index) STILL surfaces as a
    //     navigation error under `mode=paused` — no silent fallback
    //     to direct scene lookup.
    //   - Beat semantics under `mode=paused` are unchanged from
    //     PUL-F011 at the loader: the head scene's runner sees
    //     `input.beat`; missing-label diagnostics surface via
    //     `data-pulsar-navigation-error` / `onError` without
    //     unmounting. ADR-019 records the runner-side policy that
    //     `hold='first-frame'` wins over `beat` when both are
    //     present, but that is a runner-side semantic, not a
    //     loader-side filter — the loader forwards both.
    //   - Object-form head entry's `range` / `behavior` overrides
    //     reach the runner unchanged. Paused is single-scene-mount
    //     with held timeline at the head, NOT direct-scene
    //     flattening.
    //
    // PUL-F016 stays DRAFT after this PR (ADR-019 records the
    // boundary; following the ADR-016 / ADR-017 / ADR-018 / PUL-F013
    // / PUL-F014 / PUL-F015 precedent). The seam — the loader passes
    // `hold: 'first-frame'` and `ctx.mode === 'paused'` — IS
    // materially shipped. The actual hold-at-first-frame behavior is
    // the runner's contract: ADR-003's GSAP runner reads
    // `input.hold` when it lands. Until then, the placeholder runner
    // has no real timeline (returns `null`) and parks until abort —
    // vacuously satisfying "hold it at its first frame without
    // advancing" because no frame ever advances. ACTIVE transitions
    // when the GSAP runner actively reads `input.hold ===
    // 'first-frame'` and pauses the timeline at time 0, with an
    // end-to-end test alongside these seam tests.

    const pausedSceneTarget = (id: string): NavigationTarget => ({
      locator: { kind: 'scene', scene: id },
      mode: 'paused',
    });
    const pausedCompositionTarget = (composition: string): NavigationTarget => ({
      locator: { kind: 'composition', composition },
      mode: 'paused',
    });
    const pausedCompositionSceneTarget = (
      composition: string,
      scene: string,
    ): NavigationTarget => ({
      locator: { kind: 'composition-scene', composition, scene },
      mode: 'paused',
    });
    const pausedCompositionIndexTarget = (
      composition: string,
      index: number,
    ): NavigationTarget => ({
      locator: { kind: 'composition-index', composition, index },
      mode: 'paused',
    });

    it('passes `hold: "first-frame"` to the runner for a `scene` target under `mode=paused`', async () => {
      // Direct-scene navigation is the simplest paused path: the
      // addressed scene IS the head, no slice resolution. A
      // regression that gated `hold` on `target.composition` being
      // defined would silently drop the hint here.
      const captured: { sceneId: string; hold: 'first-frame' | undefined }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const runner: SceneTimelineRunner = (input) => {
        captured.push({ sceneId: input.scene.id, hold: input.hold });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: runner,
      });

      await loader.handle(pausedSceneTarget('scene-a'));

      expect(captured).toEqual([{ sceneId: 'scene-a', hold: 'first-frame' }]);
    });

    it('runs only the head scene of a `composition` target under `mode=paused` (slice truncation; runner sees `hold: "first-frame"` for the head)', async () => {
      // PUL-F016 / ADR-019: paused truncates the validated
      // composition slice to the addressed head, parallel to
      // standalone (ADR-017) and loop (ADR-018). Truncation makes
      // "no following entries run" a structural guarantee — a
      // runner bug or no-op runner under `mode=paused` MUST NOT
      // silently degrade into normal composition playback. Use a
      // non-final-index navigation so the slice has successors that
      // would be observable if truncation were missing.
      const captured: { sceneId: string; hold: 'first-frame' | undefined }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneB = buildScene({ id: 'scene-b' });
      const sceneC = buildScene({ id: 'scene-c' });
      const stage = buildStage();
      const runner: SceneTimelineRunner = (input) => {
        captured.push({ sceneId: input.scene.id, hold: input.hold });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB, sceneC]),
        compositions: createCompositionRegistry([
          { id: 'full-talk', manifest: ['scene-a', 'scene-b', 'scene-c'] },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: runner,
      });

      await loader.handle(pausedCompositionIndexTarget('full-talk', 0));

      expect(captured).toEqual([{ sceneId: 'scene-a', hold: 'first-frame' }]);
    });

    it('runs only the addressed scene of a `composition+scene` target under `mode=paused`', async () => {
      // composition+scene targeting a non-final entry exercises the
      // slice transform from a different locator shape; pins parity
      // with the composition-target case above.
      const captured: { sceneId: string; hold: 'first-frame' | undefined }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneB = buildScene({ id: 'scene-b' });
      const sceneC = buildScene({ id: 'scene-c' });
      const stage = buildStage();
      const runner: SceneTimelineRunner = (input) => {
        captured.push({ sceneId: input.scene.id, hold: input.hold });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB, sceneC]),
        compositions: createCompositionRegistry([
          { id: 'full-talk', manifest: ['scene-a', 'scene-b', 'scene-c'] },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: runner,
      });

      await loader.handle(pausedCompositionSceneTarget('full-talk', 'scene-b'));

      expect(captured).toEqual([{ sceneId: 'scene-b', hold: 'first-frame' }]);
    });

    it('runs cleanup exactly once for the head scene under `mode=paused`, never for dropped slice entries', async () => {
      // Same invariant as PUL-F014 (ADR-017) under standalone and
      // PUL-F015 (ADR-018) under loop: a regression that dropped
      // the slice for execution but left following scenes wired
      // through the synthesized registry could double-clean or
      // skip-clean. Pin exactly-once cleanup on the head and zero
      // cleanup for the dropped entries.
      const cleaned: string[] = [];
      const trace = (id: string): SceneModule =>
        buildScene({
          id,
          cleanup: () => {
            cleaned.push(id);
          },
        });
      const scenes = [trace('scene-a'), trace('scene-b'), trace('scene-c')];
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry(scenes),
        compositions: createCompositionRegistry([
          { id: 'full-talk', manifest: scenes.map((s) => s.id) },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
      });

      await loader.handle(pausedCompositionTarget('full-talk'));

      expect(cleaned).toEqual(['scene-a']);
    });

    it('a hold-until-abort runner under `mode=paused` keeps the head scene mounted until a new navigation supersedes it; cleanup fires only on abort, not on `hold` arrival (pins the runner-side pending-until-abort contract through the loader+resolver+navigation flow)', async () => {
      // ADR-019 makes pending-until-abort a structural part of the
      // hold contract: `resolveComposition()` awaits `runTimeline()`
      // and then runs `cleanup(ctx)`. A runner that observes
      // `input.hold === 'first-frame'`, calls `seek(0)` + `pause()`,
      // and resolves synchronously would let the resolver advance
      // to cleanup one turn after mount — the scene would unmount
      // immediately, contradicting "hold." This test models the
      // correct runner contract (pend until `input.signal.aborted`)
      // and pins the loader+resolver+navigation flow so a
      // regression that, for instance, made the resolver bypass
      // `runTimeline` under `hold`, or that dropped signal
      // forwarding to the runner under paused, would fail here.
      //
      // The placeholder runner in `src/main.ts` already follows
      // this shape (parks until abort with no real timeline);
      // ADR-003's GSAP runner must continue to follow it under
      // `hold`. The runner-side scene-author guarantee — "the
      // timeline does not advance" — is what the GSAP runner PR
      // additionally pins; this test pins the structural
      // mount-then-hold-then-abort-then-cleanup ordering, which is
      // a necessary precondition for the scene-author guarantee.
      const events: string[] = [];
      // Per-scene "runner entered" gates so the test can deterministic-
      // ally wait for the head scene's runner to reach the held state
      // without relying on a fragile microtask count. The lifecycle is
      // many-awaits-deep (queue → abortAndAwait → runOnce → runTarget
      // → loadSceneNavigationTarget → resolveComposition → runScene →
      // await create → await timeline → await runTimeline), so a fixed
      // `await Promise.resolve()` count is brittle.
      const enteredGates = new Map<string, Promise<void>>();
      const enteredResolvers = new Map<string, () => void>();
      const enteredGate = (id: string): Promise<void> => {
        const existing = enteredGates.get(id);
        if (existing !== undefined) return existing;
        let resolver: () => void = () => undefined;
        const promise = new Promise<void>((resolve) => {
          resolver = resolve;
        });
        enteredGates.set(id, promise);
        enteredResolvers.set(id, resolver);
        return promise;
      };
      // Pre-create the head's gate so the test code below can `await
      // enteredGate('scene-a')` even before the runner has run.
      enteredGate('scene-a');
      enteredGate('scene-b');
      const sceneA = buildScene({
        id: 'scene-a',
        create: () => {
          events.push('create:scene-a');
        },
        timeline: () => {
          events.push('timeline:scene-a');
          return null;
        },
        cleanup: () => {
          events.push('cleanup:scene-a');
        },
      });
      const sceneB = buildScene({
        id: 'scene-b',
        create: () => {
          events.push('create:scene-b');
        },
        timeline: () => {
          events.push('timeline:scene-b');
          return null;
        },
        cleanup: () => {
          events.push('cleanup:scene-b');
        },
      });
      const stage = buildStage();
      const runnerObservations: { sceneId: string; hold: unknown; hasSignal: boolean }[] = [];
      const heldRunner: SceneTimelineRunner = (input) =>
        new Promise<void>((resolve) => {
          runnerObservations.push({
            sceneId: input.scene.id,
            hold: input.hold,
            hasSignal: input.signal !== undefined,
          });
          events.push(`runTimeline-enter:${input.scene.id}`);
          enteredResolvers.get(input.scene.id)?.();
          // Pend until the per-navigation signal aborts. This is the
          // shape the placeholder runner uses today and the shape
          // ADR-019 requires of the future GSAP runner under `hold`.
          // Without `input.signal`, the test misuses the contract.
          if (input.signal === undefined) {
            // Defensive: assert the seam exists. A regression that
            // dropped signal forwarding under paused would surface
            // here rather than via the test-runner timeout.
            throw new Error('expected `input.signal` to be forwarded under `mode=paused`');
          }
          input.signal.addEventListener(
            'abort',
            () => {
              events.push(`runTimeline-aborted:${input.scene.id}`);
              resolve();
            },
            { once: true },
          );
        });
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: heldRunner,
      });

      // Launch the paused navigation but do NOT await — the runner
      // is designed to pend, so awaiting here would hang. Instead,
      // drive a second navigation that aborts the first.
      const firstSettled = loader.handle(pausedSceneTarget('scene-a'));

      // Wait deterministically for the runner to enter. The gate
      // resolves the moment the runner observes its scene.
      await enteredGate('scene-a');

      // The held state: scene-a mounted, runner entered and
      // pending, NO cleanup yet. A regression that let cleanup run
      // immediately under `hold` would show `cleanup:scene-a` here.
      expect(events).toEqual(['create:scene-a', 'timeline:scene-a', 'runTimeline-enter:scene-a']);
      expect(runnerObservations).toEqual([
        { sceneId: 'scene-a', hold: 'first-frame', hasSignal: true },
      ]);

      // Now navigate elsewhere. The loader aborts the in-flight
      // load, the runner's signal listener fires, and cleanup runs
      // for scene-a before scene-b's lifecycle starts. The second
      // navigation is to a non-paused target so its runner sees
      // `'hold' in input === false`; we still use the heldRunner so
      // we can verify the lifecycle ordering before disposing.
      const secondSettled = loader.handle(sceneTarget('scene-b'));
      await enteredGate('scene-b');

      // Expected ordering up to scene-b entering its runner:
      // paused mount → held runner → abort → cleanup of scene-a →
      // mount of scene-b → held runner for scene-b.
      expect(events).toEqual([
        'create:scene-a',
        'timeline:scene-a',
        'runTimeline-enter:scene-a',
        'runTimeline-aborted:scene-a',
        'cleanup:scene-a',
        'create:scene-b',
        'timeline:scene-b',
        'runTimeline-enter:scene-b',
      ]);

      // Dispose to release scene-b's runner gate so the test does
      // not leak a pending promise. Cleanup for scene-b fires after
      // dispose-triggered abort.
      loader.dispose();
      await firstSettled;
      await secondSettled;
      await loader.idle();

      expect(events).toEqual([
        'create:scene-a',
        'timeline:scene-a',
        'runTimeline-enter:scene-a',
        'runTimeline-aborted:scene-a',
        'cleanup:scene-a',
        'create:scene-b',
        'timeline:scene-b',
        'runTimeline-enter:scene-b',
        'runTimeline-aborted:scene-b',
        'cleanup:scene-b',
      ]);
    });

    it('omits the `hold` key on the runner input when `mode=paused` is absent (key-presence semantics)', async () => {
      // The runner input uses key-presence semantics for optional
      // fields (parallel to `beat` / `repeat` / `range` /
      // `behavior`): a runner can branch on `'hold' in input`
      // rather than `=== undefined`. A regression that always set
      // `input.hold = undefined` (or any non-`'first-frame'` value)
      // under non-paused modes would break that contract.
      const captured: { hasHold: boolean; hold: unknown }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const runner: SceneTimelineRunner = (input) => {
        captured.push({ hasHold: 'hold' in input, hold: input.hold });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: runner,
      });

      // No mode at all (defaults to `present`).
      await loader.handle(sceneTarget('scene-a'));

      expect(captured).toEqual([{ hasHold: false, hold: undefined }]);
    });

    it('does not set `hold` for any non-paused, lifecycle-running mode', async () => {
      // Walk the seven-mode allowlist (minus `paused` and
      // `prompter`) and confirm that none of them produce `hold` on
      // the runner input. Catching every non-paused mode
      // discriminates against an over-broad fix that gated `hold` on
      // `mode !== undefined` rather than `mode === 'paused'`.
      // Capturing the per-iteration mode alongside the
      // `'hold' in input` flag means the assertion failure
      // identifies WHICH mode regressed, not just "some mode did."
      //
      // PUL-F019 / ADR-022: `prompter` does not invoke `runTimeline`
      // (lifecycle bypassed); the dedicated F019 block pins that
      // invariant. Filter prompter out here so this test stays
      // focused on lifecycle-running modes.
      const nonPausedLifecycleModes = NAVIGATION_MODES.filter(
        (m) => m !== 'paused' && m !== 'prompter',
      );
      const captured: { mode: NavigationMode; hasHold: boolean }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      for (const mode of nonPausedLifecycleModes) {
        const runner: SceneTimelineRunner = (input) => {
          captured.push({ mode, hasHold: 'hold' in input });
        };
        const loader = createSceneLoader({
          scenes: createSceneRegistry([sceneA]),
          compositions: createCompositionRegistry([]),
          stage: stage.element,
          buildCtx: stubCtx,
          createPreloader: () => () => undefined,
          runTimeline: runner,
        });
        await loader.handle({ locator: { kind: 'scene', scene: 'scene-a' }, mode });
      }

      // One entry per non-paused lifecycle mode, each must have
      // `hasHold: false`. Building the expected array from
      // `nonPausedLifecycleModes` keeps the assertion in sync if the
      // mode allowlist ever changes.
      expect(captured).toEqual(nonPausedLifecycleModes.map((mode) => ({ mode, hasHold: false })));
    });

    it('exposes `ctx.mode === "paused"` to every lifecycle hook of the head scene under all locator shapes', async () => {
      // Parallel to the PUL-F014 standalone and PUL-F015 loop seam
      // tests. Future runner / chrome / audio surfaces read
      // `ctx.mode` to decide their own behavior; this test pins the
      // seam end to end across all four locator shapes that can
      // appear under `mode=paused`.
      const seen: { phase: string; locatorKind: string; mode: unknown }[] = [];
      const recordMode =
        (phase: string, locatorKind: string) =>
        (ctx: unknown): unknown => {
          seen.push({ phase, locatorKind, mode: (ctx as { mode?: NavigationMode }).mode });
          return null;
        };
      const makeScene = (locatorKind: string): SceneModule =>
        buildScene({
          id: 'scene-a',
          create: recordMode('create', locatorKind),
          timeline: recordMode('timeline', locatorKind) as SceneModule['timeline'],
          cleanup: recordMode('cleanup', locatorKind),
        });
      const stage = buildStage();
      const buildLoader = (sceneId: string, locatorKind: string) =>
        createSceneLoader({
          scenes: createSceneRegistry([makeScene(locatorKind)]),
          compositions: createCompositionRegistry([{ id: 'full-talk', manifest: [sceneId] }]),
          stage: stage.element,
          buildCtx: (mode) => ({ stage: stage.element, mode }),
          createPreloader: () => () => undefined,
          runTimeline: noopRunner,
        });

      await buildLoader('scene-a', 'scene').handle(pausedSceneTarget('scene-a'));
      await buildLoader('scene-a', 'composition').handle(pausedCompositionTarget('full-talk'));
      await buildLoader('scene-a', 'composition-scene').handle(
        pausedCompositionSceneTarget('full-talk', 'scene-a'),
      );
      await buildLoader('scene-a', 'composition-index').handle(
        pausedCompositionIndexTarget('full-talk', 0),
      );

      // 3 hooks per navigation × 4 locator shapes = 12 entries;
      // every single one must carry `paused`.
      expect(seen).toHaveLength(12);
      for (const entry of seen) {
        expect(entry.mode).toBe('paused');
      }
    });

    it('forwards `beat` to the head scene runner alongside `hold` under `mode=paused`, and surfaces missing-beat as a non-fatal diagnostic', async () => {
      // PUL-F011 / PUL-F016 are independent at the loader: a URL
      // like `?scene=x&beat=hook&mode=paused` must deliver both
      // `beat` and `hold` to the runner. ADR-019 records the
      // runner-side policy that `hold` wins over `beat` (paused is
      // first-frame; `mode=scrub` is the inspection mode for
      // beat-targeting), but that policy is the runner's contract,
      // not a loader-side filter. A regression that paired the
      // fields at the loader — e.g. dropping `hold` when `beat` is
      // supplied — would silently break paused-mode navigation
      // when a beat is also requested.
      const captured: {
        sceneId: string;
        beat: string | undefined;
        hold: 'first-frame' | undefined;
      }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const errors: unknown[] = [];
      const runner: SceneTimelineRunner = (input) => {
        captured.push({
          sceneId: input.scene.id,
          beat: input.beat,
          hold: input.hold,
        });
        if (input.beat !== undefined && input.onBeatMissing !== undefined) {
          input.onBeatMissing();
        }
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: runner,
        onError: (err) => {
          errors.push(err);
        },
      });

      await loader.handle({
        locator: { kind: 'scene', scene: 'scene-a' },
        mode: 'paused',
        beat: 'midpoint',
      });

      expect(captured).toEqual([{ sceneId: 'scene-a', beat: 'midpoint', hold: 'first-frame' }]);
      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain('beat positioning failed');
      expect((errors[0] as Error).message).toContain('"midpoint"');
      expect(stage.attrs.get('data-pulsar-navigation-error')).toBeDefined();
    });

    it('writes no `data-pulsar-mode-*` suppression attribute on the stage under `mode=paused`', async () => {
      // Mirrors ADR-016 / ADR-017 / ADR-018 invariant. PUL-F016
      // forbids the loader from preemptively writing a stage
      // attribute for paused mode; runner-side or future-surface-
      // side signaling lives at those surfaces, not at the loader.
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

      await loader.handle(pausedSceneTarget('scene-a'));

      const modeAttrs = Array.from(stage.attrs.keys()).filter((name) =>
        name.startsWith('data-pulsar-mode-'),
      );
      expect(modeAttrs).toEqual([]);
    });

    it('writes both `data-pulsar-scene-target` and `data-pulsar-composition-target` for a composition target under `mode=paused` (preserves observability of what the URL addressed)', async () => {
      // The stage attrs communicate "what was addressed," not "what
      // ran." Truncation drops following entries from execution but
      // does not drop the composition id from the stage attrs —
      // mirrors the standalone / loop invariant.
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
        runTimeline: noopRunner,
      });

      await loader.handle(pausedCompositionSceneTarget('full-talk', 'scene-b'));

      expect(stage.attrs.get('data-pulsar-scene-target')).toBe('scene-b');
      expect(stage.attrs.get('data-pulsar-composition-target')).toBe('full-talk');
    });

    it('surfaces composition-not-registered as a navigation error under `mode=paused` (no silent fallback)', async () => {
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const errors: unknown[] = [];
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
        onError: (err) => {
          errors.push(err);
        },
      });

      await loader.handle(pausedCompositionTarget('not-registered'));

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain(
        'composition "not-registered" is not registered',
      );
      expect(stage.attrs.get('data-pulsar-navigation-error')).toBeDefined();
    });

    it('surfaces composition-member error under `mode=paused` for an unknown scene in `composition+scene`', async () => {
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneZ = buildScene({ id: 'scene-z' });
      const stage = buildStage();
      const errors: unknown[] = [];
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneZ]),
        compositions: createCompositionRegistry([{ id: 'full-talk', manifest: ['scene-a'] }]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
        onError: (err) => {
          errors.push(err);
        },
      });

      await loader.handle(pausedCompositionSceneTarget('full-talk', 'scene-z'));

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain(
        'scene "scene-z" is not a member of composition "full-talk"',
      );
    });

    it('surfaces index-out-of-range under `mode=paused`', async () => {
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const errors: unknown[] = [];
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([{ id: 'full-talk', manifest: ['scene-a'] }]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
        onError: (err) => {
          errors.push(err);
        },
      });

      await loader.handle(pausedCompositionIndexTarget('full-talk', 5));

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain('index 5 is out of range');
    });

    it("preserves the addressed head entry's `range` and `behavior` overrides on the runner input under `mode=paused` (composition+index with object-form entry)", async () => {
      // PUL-F016 / ADR-019: paused truncates the validated
      // composition slice to the addressed head and forwards `hold`
      // to that head's runner input. The slice is TRUNCATED rather
      // than flattened — a flat `{ scene }` would lose object-form
      // `range` / `behavior` overrides on the head entry, turning
      // paused into direct-scene flattening (parity with ADR-017's
      // standalone and ADR-018's loop invariant). This pins all
      // three slots — `range`, `behavior`, and `hold` — through to
      // the head runner, plus the truncation itself (the runner
      // runs exactly once).
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneB = buildScene({ id: 'scene-b' });
      const sceneC = buildScene({ id: 'scene-c' });
      const stage = buildStage();
      const captured: {
        sceneId: string;
        range: unknown;
        behavior: unknown;
        hold: unknown;
      }[] = [];
      const runner: SceneTimelineRunner = (input) => {
        captured.push({
          sceneId: input.scene.id,
          range: input.range,
          behavior: input.behavior,
          hold: input.hold,
        });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB, sceneC]),
        compositions: createCompositionRegistry([
          {
            id: 'full-talk',
            manifest: [
              'scene-a',
              { id: 'scene-b', range: 'hook', behavior: { hold: true } },
              'scene-c',
            ],
          },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: runner,
      });

      await loader.handle(pausedCompositionIndexTarget('full-talk', 1));

      // Single runner invocation (truncation), with overrides AND
      // `hold` reaching the head's runner input together. A
      // regression that flattened to direct-scene would show
      // `range: undefined, behavior: undefined`; a regression that
      // dropped truncation would show a second invocation for
      // scene-c.
      expect(captured).toEqual([
        {
          sceneId: 'scene-b',
          range: 'hook',
          behavior: { hold: true },
          hold: 'first-frame',
        },
      ]);
    });
  });

  describe('scrub-mode runner cue-gate-hint forwarding (PUL-F017)', () => {
    // PUL-F017 statement: in `mode=scrub`, the runtime SHALL display
    // timeline controls allowing the user to scrub forward, backward,
    // and to named beats. Audio cues SHALL fire only on monotonic
    // forward playback.
    //
    // Materially-implementable parts of the statement that this
    // block pins (ADR-020 records the contract boundary):
    //   - The loader passes `cueGate: 'monotonic-forward'` to the
    //     timeline runner adapter when
    //     `effectiveMode(target) === 'scrub'`. The runner is
    //     responsible for honoring the hint (e.g. ADR-003's future
    //     GSAP runner gates audio-cue firing by direction; ADR-004's
    //     future Howler integration is the consumer).
    //   - The hint is HEAD-ONLY: under composition targets the head
    //     scene's runner input carries `cueGate`; following entries
    //     do not. Following entries do not run at all because the
    //     slice is truncated to the addressed head — same structural
    //     defense ADR-018 / ADR-019 record for `mode=loop` /
    //     `mode=paused`.
    //   - `ctx.mode === 'scrub'` reaches every lifecycle hook of the
    //     head scene — the seam the future scrub-controls UI surface
    //     will read.
    //   - Other modes (`present`, `standalone`, `loop`, `paused`,
    //     `screenshot`, `prompter`) and a `mode`-less URL DO NOT set
    //     `cueGate`. A regression that broadcast `cueGate` under any
    //     mode would break URLs that depend on no-cue-gating
    //     semantics (e.g. normal playback under `present`).
    //   - No `data-pulsar-mode-*` suppression attribute is preempt-
    //     ively written under `scrub` (parity with ADR-016 / ADR-017
    //     / ADR-018 / ADR-019).
    //   - Composition validation (unregistered composition, unknown
    //     member scene, out-of-range index) STILL surfaces as a
    //     navigation error under `mode=scrub` — no silent fallback to
    //     direct scene lookup.
    //   - Beat semantics under `mode=scrub` are unchanged from
    //     PUL-F011 at the loader: the head scene's runner sees
    //     `input.beat`; missing-label diagnostics surface via
    //     `data-pulsar-navigation-error` / `onError` without
    //     unmounting. PUL-F017 explicitly names "to named beats" as
    //     part of scrub's UX, so beat forwarding under `scrub` is
    //     the natural scrub-to-beat path the future controls UI will
    //     drive.
    //   - Object-form head entry's `range` / `behavior` overrides
    //     reach the runner unchanged. Scrub is single-scene-mount
    //     with cue-gated playback at the head, NOT direct-scene
    //     flattening.
    //
    // PUL-F017 stays DRAFT after this PR (ADR-020 records the
    // boundary; following the ADR-016 / ADR-017 / ADR-018 / ADR-019 /
    // PUL-F013 / PUL-F014 / PUL-F015 / PUL-F016 precedent). The seam
    // — the loader passes `cueGate: 'monotonic-forward'` and
    // `ctx.mode === 'scrub'` — IS materially shipped. The actual
    // monotonic-forward cue-gating behavior is the runner's contract
    // (ADR-003's GSAP runner + ADR-004's audio engine when they
    // land) and the timeline-controls UI is a future workbench
    // chrome surface; both are required for ACTIVE.

    const scrubSceneTarget = (id: string): NavigationTarget => ({
      locator: { kind: 'scene', scene: id },
      mode: 'scrub',
    });
    const scrubCompositionTarget = (composition: string): NavigationTarget => ({
      locator: { kind: 'composition', composition },
      mode: 'scrub',
    });
    const scrubCompositionSceneTarget = (composition: string, scene: string): NavigationTarget => ({
      locator: { kind: 'composition-scene', composition, scene },
      mode: 'scrub',
    });
    const scrubCompositionIndexTarget = (composition: string, index: number): NavigationTarget => ({
      locator: { kind: 'composition-index', composition, index },
      mode: 'scrub',
    });

    it('passes `cueGate: "monotonic-forward"` to the runner for a `scene` target under `mode=scrub`', async () => {
      // Direct-scene navigation is the simplest scrub path: the
      // addressed scene IS the head, no slice resolution. A
      // regression that gated `cueGate` on `target.composition`
      // being defined would silently drop the hint here.
      const captured: { sceneId: string; cueGate: 'monotonic-forward' | undefined }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const runner: SceneTimelineRunner = (input) => {
        captured.push({ sceneId: input.scene.id, cueGate: input.cueGate });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: runner,
      });

      await loader.handle(scrubSceneTarget('scene-a'));

      expect(captured).toEqual([{ sceneId: 'scene-a', cueGate: 'monotonic-forward' }]);
    });

    it('runs only the head scene of a `composition` target under `mode=scrub` (slice truncation; runner sees `cueGate: "monotonic-forward"` for the head)', async () => {
      // PUL-F017 / ADR-020: scrub truncates the validated
      // composition slice to the addressed head, parallel to
      // standalone (ADR-017), loop (ADR-018), and paused (ADR-019).
      // Truncation makes "no following entries run" a structural
      // guarantee — a runner bug or no-op runner under `mode=scrub`
      // MUST NOT silently degrade into normal composition playback.
      // Use a non-final-index navigation so the slice has successors
      // that would be observable if truncation were missing.
      const captured: { sceneId: string; cueGate: 'monotonic-forward' | undefined }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneB = buildScene({ id: 'scene-b' });
      const sceneC = buildScene({ id: 'scene-c' });
      const stage = buildStage();
      const runner: SceneTimelineRunner = (input) => {
        captured.push({ sceneId: input.scene.id, cueGate: input.cueGate });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB, sceneC]),
        compositions: createCompositionRegistry([
          { id: 'full-talk', manifest: ['scene-a', 'scene-b', 'scene-c'] },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: runner,
      });

      await loader.handle(scrubCompositionIndexTarget('full-talk', 0));

      expect(captured).toEqual([{ sceneId: 'scene-a', cueGate: 'monotonic-forward' }]);
    });

    it('runs only the addressed scene of a `composition+scene` target under `mode=scrub`', async () => {
      // composition+scene targeting a non-final entry exercises the
      // slice transform from a different locator shape; pins parity
      // with the composition-target case above.
      const captured: { sceneId: string; cueGate: 'monotonic-forward' | undefined }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneB = buildScene({ id: 'scene-b' });
      const sceneC = buildScene({ id: 'scene-c' });
      const stage = buildStage();
      const runner: SceneTimelineRunner = (input) => {
        captured.push({ sceneId: input.scene.id, cueGate: input.cueGate });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB, sceneC]),
        compositions: createCompositionRegistry([
          { id: 'full-talk', manifest: ['scene-a', 'scene-b', 'scene-c'] },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: runner,
      });

      await loader.handle(scrubCompositionSceneTarget('full-talk', 'scene-b'));

      expect(captured).toEqual([{ sceneId: 'scene-b', cueGate: 'monotonic-forward' }]);
    });

    it('runs cleanup exactly once for the head scene under `mode=scrub`, never for dropped slice entries', async () => {
      // Same invariant as PUL-F014 (ADR-017) under standalone,
      // PUL-F015 (ADR-018) under loop, PUL-F016 (ADR-019) under
      // paused: a regression that dropped the slice for execution
      // but left following scenes wired through the synthesized
      // registry could double-clean or skip-clean. Pin
      // exactly-once cleanup on the head and zero cleanup for the
      // dropped entries.
      const cleaned: string[] = [];
      const trace = (id: string): SceneModule =>
        buildScene({
          id,
          cleanup: () => {
            cleaned.push(id);
          },
        });
      const scenes = [trace('scene-a'), trace('scene-b'), trace('scene-c')];
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry(scenes),
        compositions: createCompositionRegistry([
          { id: 'full-talk', manifest: scenes.map((s) => s.id) },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
      });

      await loader.handle(scrubCompositionTarget('full-talk'));

      expect(cleaned).toEqual(['scene-a']);
    });

    it('omits the `cueGate` key on the runner input when `mode=scrub` is absent (key-presence semantics)', async () => {
      // The runner input uses key-presence semantics for optional
      // fields (parallel to `beat` / `repeat` / `hold` / `range` /
      // `behavior`): a runner can branch on `'cueGate' in input`
      // rather than `=== undefined`. A regression that always set
      // `input.cueGate = undefined` (or any non-`'monotonic-forward'`
      // value) under non-scrub modes would break that contract.
      const captured: { hasCueGate: boolean; cueGate: unknown }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const runner: SceneTimelineRunner = (input) => {
        captured.push({ hasCueGate: 'cueGate' in input, cueGate: input.cueGate });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: runner,
      });

      // No mode at all (defaults to `present`).
      await loader.handle(sceneTarget('scene-a'));

      expect(captured).toEqual([{ hasCueGate: false, cueGate: undefined }]);
    });

    it('does not set `cueGate` for any non-scrub, lifecycle-running mode', async () => {
      // Walk the seven-mode allowlist (minus `scrub` and `prompter`)
      // and confirm that none of them produce `cueGate` on the
      // runner input. Catching every non-scrub mode discriminates
      // against an over-broad fix that gated `cueGate` on
      // `mode !== undefined` rather than `mode === 'scrub'`.
      // Capturing the per-iteration mode alongside the
      // `'cueGate' in input` flag means the assertion failure
      // identifies WHICH mode regressed, not just "some mode did."
      //
      // PUL-F019 / ADR-022: `prompter` does not invoke `runTimeline`
      // (lifecycle bypassed); the dedicated F019 block pins that
      // invariant.
      const nonScrubLifecycleModes = NAVIGATION_MODES.filter(
        (m) => m !== 'scrub' && m !== 'prompter',
      );
      const captured: { mode: NavigationMode; hasCueGate: boolean }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      for (const mode of nonScrubLifecycleModes) {
        const runner: SceneTimelineRunner = (input) => {
          captured.push({ mode, hasCueGate: 'cueGate' in input });
        };
        const loader = createSceneLoader({
          scenes: createSceneRegistry([sceneA]),
          compositions: createCompositionRegistry([]),
          stage: stage.element,
          buildCtx: stubCtx,
          createPreloader: () => () => undefined,
          runTimeline: runner,
        });
        await loader.handle({ locator: { kind: 'scene', scene: 'scene-a' }, mode });
      }

      // One entry per non-scrub lifecycle mode, each must have
      // `hasCueGate: false`. Building the expected array from
      // `nonScrubLifecycleModes` keeps the assertion in sync if the
      // mode allowlist ever changes.
      expect(captured).toEqual(nonScrubLifecycleModes.map((mode) => ({ mode, hasCueGate: false })));
    });

    it('exposes `ctx.mode === "scrub"` to every lifecycle hook of the head scene under all locator shapes', async () => {
      // Parallel to the PUL-F014 standalone, PUL-F015 loop, and
      // PUL-F016 paused seam tests. Future runner / chrome / audio
      // surfaces (specifically the timeline-controls UI named in the
      // PUL-F017 statement) read `ctx.mode` to decide their own
      // behavior; this test pins the seam end to end across all four
      // locator shapes that can appear under `mode=scrub`.
      const seen: { phase: string; locatorKind: string; mode: unknown }[] = [];
      const recordMode =
        (phase: string, locatorKind: string) =>
        (ctx: unknown): unknown => {
          seen.push({ phase, locatorKind, mode: (ctx as { mode?: NavigationMode }).mode });
          return null;
        };
      const makeScene = (locatorKind: string): SceneModule =>
        buildScene({
          id: 'scene-a',
          create: recordMode('create', locatorKind),
          timeline: recordMode('timeline', locatorKind) as SceneModule['timeline'],
          cleanup: recordMode('cleanup', locatorKind),
        });
      const stage = buildStage();
      const buildLoader = (sceneId: string, locatorKind: string) =>
        createSceneLoader({
          scenes: createSceneRegistry([makeScene(locatorKind)]),
          compositions: createCompositionRegistry([{ id: 'full-talk', manifest: [sceneId] }]),
          stage: stage.element,
          buildCtx: (mode) => ({ stage: stage.element, mode }),
          createPreloader: () => () => undefined,
          runTimeline: noopRunner,
        });

      await buildLoader('scene-a', 'scene').handle(scrubSceneTarget('scene-a'));
      await buildLoader('scene-a', 'composition').handle(scrubCompositionTarget('full-talk'));
      await buildLoader('scene-a', 'composition-scene').handle(
        scrubCompositionSceneTarget('full-talk', 'scene-a'),
      );
      await buildLoader('scene-a', 'composition-index').handle(
        scrubCompositionIndexTarget('full-talk', 0),
      );

      // 3 hooks per navigation × 4 locator shapes = 12 entries;
      // every single one must carry `scrub`.
      expect(seen).toHaveLength(12);
      for (const entry of seen) {
        expect(entry.mode).toBe('scrub');
      }
    });

    it('forwards `beat` to the head scene runner alongside `cueGate` under `mode=scrub`, and surfaces missing-beat as a non-fatal diagnostic', async () => {
      // PUL-F011 / PUL-F017 are independent at the loader: a URL
      // like `?scene=x&beat=hook&mode=scrub` must deliver both
      // `beat` and `cueGate` to the runner. PUL-F017 explicitly
      // mentions "named beats" as part of scrub's UX, so a
      // regression that dropped `beat` when `mode=scrub` is set
      // would silently break the natural scrub-to-beat path.
      const captured: {
        sceneId: string;
        beat: string | undefined;
        cueGate: 'monotonic-forward' | undefined;
      }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const errors: unknown[] = [];
      const runner: SceneTimelineRunner = (input) => {
        captured.push({
          sceneId: input.scene.id,
          beat: input.beat,
          cueGate: input.cueGate,
        });
        if (input.beat !== undefined && input.onBeatMissing !== undefined) {
          input.onBeatMissing();
        }
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: runner,
        onError: (err) => {
          errors.push(err);
        },
      });

      await loader.handle({
        locator: { kind: 'scene', scene: 'scene-a' },
        mode: 'scrub',
        beat: 'midpoint',
      });

      expect(captured).toEqual([
        { sceneId: 'scene-a', beat: 'midpoint', cueGate: 'monotonic-forward' },
      ]);
      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain('beat positioning failed');
      expect((errors[0] as Error).message).toContain('"midpoint"');
      expect(stage.attrs.get('data-pulsar-navigation-error')).toBeDefined();
    });

    it('writes no `data-pulsar-mode-*` suppression attribute on the stage under `mode=scrub`', async () => {
      // Mirrors ADR-016 / ADR-017 / ADR-018 / ADR-019 invariant.
      // PUL-F017 forbids the loader from preemptively writing a
      // stage attribute for scrub mode; runner-side or future-
      // surface-side signaling (the controls UI) lives at those
      // surfaces, not at the loader.
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

      await loader.handle(scrubSceneTarget('scene-a'));

      const modeAttrs = Array.from(stage.attrs.keys()).filter((name) =>
        name.startsWith('data-pulsar-mode-'),
      );
      expect(modeAttrs).toEqual([]);
    });

    it('writes both `data-pulsar-scene-target` and `data-pulsar-composition-target` for a composition target under `mode=scrub` (preserves observability of what the URL addressed)', async () => {
      // The stage attrs communicate "what was addressed," not "what
      // ran." Truncation drops following entries from execution but
      // does not drop the composition id from the stage attrs —
      // mirrors the standalone / loop / paused invariant.
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
        runTimeline: noopRunner,
      });

      await loader.handle(scrubCompositionSceneTarget('full-talk', 'scene-b'));

      expect(stage.attrs.get('data-pulsar-scene-target')).toBe('scene-b');
      expect(stage.attrs.get('data-pulsar-composition-target')).toBe('full-talk');
    });

    it('surfaces composition-not-registered as a navigation error under `mode=scrub` (no silent fallback)', async () => {
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const errors: unknown[] = [];
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
        onError: (err) => {
          errors.push(err);
        },
      });

      await loader.handle(scrubCompositionTarget('not-registered'));

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain(
        'composition "not-registered" is not registered',
      );
      expect(stage.attrs.get('data-pulsar-navigation-error')).toBeDefined();
    });

    it('surfaces composition-member error under `mode=scrub` for an unknown scene in `composition+scene`', async () => {
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneZ = buildScene({ id: 'scene-z' });
      const stage = buildStage();
      const errors: unknown[] = [];
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneZ]),
        compositions: createCompositionRegistry([{ id: 'full-talk', manifest: ['scene-a'] }]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
        onError: (err) => {
          errors.push(err);
        },
      });

      await loader.handle(scrubCompositionSceneTarget('full-talk', 'scene-z'));

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain(
        'scene "scene-z" is not a member of composition "full-talk"',
      );
    });

    it('surfaces index-out-of-range under `mode=scrub`', async () => {
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const errors: unknown[] = [];
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([{ id: 'full-talk', manifest: ['scene-a'] }]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
        onError: (err) => {
          errors.push(err);
        },
      });

      await loader.handle(scrubCompositionIndexTarget('full-talk', 5));

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain('index 5 is out of range');
    });

    it("preserves the addressed head entry's `range` and `behavior` overrides on the runner input under `mode=scrub` (composition+index with object-form entry)", async () => {
      // PUL-F017 / ADR-020: scrub truncates the validated
      // composition slice to the addressed head and forwards
      // `cueGate` to that head's runner input. The slice is
      // TRUNCATED rather than flattened — a flat `{ scene }` would
      // lose object-form `range` / `behavior` overrides on the head
      // entry, turning scrub into direct-scene flattening (parity
      // with ADR-017's standalone, ADR-018's loop, and ADR-019's
      // paused invariant). This pins all three slots — `range`,
      // `behavior`, and `cueGate` — through to the head runner,
      // plus the truncation itself (the runner runs exactly once).
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneB = buildScene({ id: 'scene-b' });
      const sceneC = buildScene({ id: 'scene-c' });
      const stage = buildStage();
      const captured: {
        sceneId: string;
        range: unknown;
        behavior: unknown;
        cueGate: unknown;
      }[] = [];
      const runner: SceneTimelineRunner = (input) => {
        captured.push({
          sceneId: input.scene.id,
          range: input.range,
          behavior: input.behavior,
          cueGate: input.cueGate,
        });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB, sceneC]),
        compositions: createCompositionRegistry([
          {
            id: 'full-talk',
            manifest: [
              'scene-a',
              { id: 'scene-b', range: 'hook', behavior: { hold: true } },
              'scene-c',
            ],
          },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: runner,
      });

      await loader.handle(scrubCompositionIndexTarget('full-talk', 1));

      expect(captured).toEqual([
        {
          sceneId: 'scene-b',
          range: 'hook',
          behavior: { hold: true },
          cueGate: 'monotonic-forward',
        },
      ]);
    });
  });

  describe('screenshot-mode runner capture-hint forwarding (PUL-F018)', () => {
    // PUL-F018 statement: in `mode=screenshot`, the runtime SHALL
    // render the addressed scene at the addressed beat (or first
    // frame if no beat) with all asset preloads resolved, no
    // animation in progress, all audio suppressed, and any
    // randomness sourced from a deterministic seed.
    //
    // Materially-implementable parts of the statement that this
    // block pins (ADR-021 records the contract boundary):
    //   - The loader passes `screenshot: 'capture'` to the
    //     timeline runner adapter when
    //     `effectiveMode(target) === 'screenshot'`. The runner is
    //     responsible for honoring the bundle (frame freeze at
    //     beat-or-zero, no animation, all audio suppressed,
    //     deterministic seed).
    //   - The hint is HEAD-ONLY: under composition targets the head
    //     scene's runner input carries `screenshot`; following
    //     entries do not. Following entries do not run at all
    //     because the slice is truncated to the addressed head —
    //     same structural defense ADR-018 / ADR-019 / ADR-020 record
    //     for `mode=loop` / `mode=paused` / `mode=scrub`.
    //   - `ctx.mode === 'screenshot'` reaches every lifecycle hook
    //     of the head scene — the seam future capture tooling reads
    //     when it observes the stage.
    //   - Other modes (`present`, `standalone`, `loop`, `paused`,
    //     `scrub`, `prompter`) and a `mode`-less URL DO NOT set
    //     `screenshot`. A regression that broadcast `screenshot`
    //     under any mode would break URLs that depend on normal
    //     playback semantics.
    //   - No `data-pulsar-mode-*` suppression attribute is preempt-
    //     ively written under `screenshot` (parity with ADR-016 /
    //     ADR-017 / ADR-018 / ADR-019 / ADR-020).
    //   - Composition validation (unregistered composition, unknown
    //     member scene, out-of-range index) STILL surfaces as a
    //     navigation error under `mode=screenshot` — no silent
    //     fallback to direct scene lookup.
    //   - Beat semantics under `mode=screenshot` are honored as the
    //     captured-frame anchor: PUL-F018 explicitly says "at the
    //     addressed beat (or first frame if no beat)," unlike
    //     `mode=paused` where ADR-019 records "first frame wins."
    //     The loader forwards `input.beat` alongside
    //     `input.screenshot`; missing-label diagnostics surface
    //     via `data-pulsar-navigation-error` / `onError` without
    //     unmounting.
    //   - Object-form head entry's `range` / `behavior` overrides
    //     reach the runner unchanged. Screenshot is single-scene-
    //     mount with deterministic capture at the head, NOT
    //     direct-scene flattening.
    //
    // PUL-F018 stays DRAFT after this PR (ADR-021 records the
    // boundary; following the ADR-016 / ADR-017 / ADR-018 / ADR-019
    // / ADR-020 / PUL-F013 / PUL-F014 / PUL-F015 / PUL-F016 /
    // PUL-F017 precedent). The seam — the loader passes
    // `screenshot: 'capture'` and `ctx.mode === 'screenshot'` — IS
    // materially shipped. The actual capture-bundle behavior
    // (frame freeze, audio suppression, deterministic randomness)
    // is the runner's contract (ADR-003's GSAP runner + ADR-004's
    // audio engine + a deterministic-randomness convention when
    // they land); all three are required for ACTIVE.

    const screenshotSceneTarget = (id: string): NavigationTarget => ({
      locator: { kind: 'scene', scene: id },
      mode: 'screenshot',
    });
    const screenshotCompositionTarget = (composition: string): NavigationTarget => ({
      locator: { kind: 'composition', composition },
      mode: 'screenshot',
    });
    const screenshotCompositionSceneTarget = (
      composition: string,
      scene: string,
    ): NavigationTarget => ({
      locator: { kind: 'composition-scene', composition, scene },
      mode: 'screenshot',
    });
    const screenshotCompositionIndexTarget = (
      composition: string,
      index: number,
    ): NavigationTarget => ({
      locator: { kind: 'composition-index', composition, index },
      mode: 'screenshot',
    });

    it('passes `screenshot: "capture"` to the runner for a `scene` target under `mode=screenshot`', async () => {
      // Direct-scene navigation is the simplest screenshot path:
      // the addressed scene IS the head, no slice resolution. A
      // regression that gated `screenshot` on `target.composition`
      // being defined would silently drop the hint here.
      const captured: { sceneId: string; screenshot: 'capture' | undefined }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const runner: SceneTimelineRunner = (input) => {
        captured.push({ sceneId: input.scene.id, screenshot: input.screenshot });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: runner,
      });

      await loader.handle(screenshotSceneTarget('scene-a'));

      expect(captured).toEqual([{ sceneId: 'scene-a', screenshot: 'capture' }]);
    });

    it('runs only the head scene of a `composition` target under `mode=screenshot` (slice truncation; runner sees `screenshot: "capture"` for the head)', async () => {
      // PUL-F018 / ADR-021: screenshot truncates the validated
      // composition slice to the addressed head, parallel to
      // standalone (ADR-017), loop (ADR-018), paused (ADR-019), and
      // scrub (ADR-020). Truncation makes "no following entries
      // run" a structural guarantee — a runner bug or no-op runner
      // under `mode=screenshot` MUST NOT silently degrade into
      // normal composition playback. The plain `composition`
      // locator (no scene id, no index) exercises the path that
      // resolves the head from the manifest's first entry; a
      // regression that only dropped `screenshot: 'capture'` for
      // this locator (vs the composition+index path the next test
      // covers) would slip past a test that named itself
      // "composition target" but actually used composition+index.
      const captured: { sceneId: string; screenshot: 'capture' | undefined }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneB = buildScene({ id: 'scene-b' });
      const sceneC = buildScene({ id: 'scene-c' });
      const stage = buildStage();
      const runner: SceneTimelineRunner = (input) => {
        captured.push({ sceneId: input.scene.id, screenshot: input.screenshot });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB, sceneC]),
        compositions: createCompositionRegistry([
          { id: 'full-talk', manifest: ['scene-a', 'scene-b', 'scene-c'] },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: runner,
      });

      await loader.handle(screenshotCompositionTarget('full-talk'));

      expect(captured).toEqual([{ sceneId: 'scene-a', screenshot: 'capture' }]);
    });

    it('runs only the head scene of a `composition+index` target under `mode=screenshot` (slice truncation pinned for the index locator too)', async () => {
      // The composition+index locator exercises the slice-from-N
      // path; pins parity with the plain composition target above.
      // Use a non-final-index navigation so the slice has
      // successors that would be observable if truncation were
      // missing.
      const captured: { sceneId: string; screenshot: 'capture' | undefined }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneB = buildScene({ id: 'scene-b' });
      const sceneC = buildScene({ id: 'scene-c' });
      const stage = buildStage();
      const runner: SceneTimelineRunner = (input) => {
        captured.push({ sceneId: input.scene.id, screenshot: input.screenshot });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB, sceneC]),
        compositions: createCompositionRegistry([
          { id: 'full-talk', manifest: ['scene-a', 'scene-b', 'scene-c'] },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: runner,
      });

      await loader.handle(screenshotCompositionIndexTarget('full-talk', 0));

      expect(captured).toEqual([{ sceneId: 'scene-a', screenshot: 'capture' }]);
    });

    it('runs only the addressed scene of a `composition+scene` target under `mode=screenshot`', async () => {
      // composition+scene targeting a non-final entry exercises the
      // slice transform from a different locator shape; pins parity
      // with the composition-target case above.
      const captured: { sceneId: string; screenshot: 'capture' | undefined }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneB = buildScene({ id: 'scene-b' });
      const sceneC = buildScene({ id: 'scene-c' });
      const stage = buildStage();
      const runner: SceneTimelineRunner = (input) => {
        captured.push({ sceneId: input.scene.id, screenshot: input.screenshot });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB, sceneC]),
        compositions: createCompositionRegistry([
          { id: 'full-talk', manifest: ['scene-a', 'scene-b', 'scene-c'] },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: runner,
      });

      await loader.handle(screenshotCompositionSceneTarget('full-talk', 'scene-b'));

      expect(captured).toEqual([{ sceneId: 'scene-b', screenshot: 'capture' }]);
    });

    it('runs cleanup exactly once for the head scene under `mode=screenshot`, never for dropped slice entries', async () => {
      // Same invariant as PUL-F014 (ADR-017) under standalone,
      // PUL-F015 (ADR-018) under loop, PUL-F016 (ADR-019) under
      // paused, PUL-F017 (ADR-020) under scrub: a regression that
      // dropped the slice for execution but left following scenes
      // wired through the synthesized registry could double-clean
      // or skip-clean. Pin exactly-once cleanup on the head and
      // zero cleanup for the dropped entries.
      const cleaned: string[] = [];
      const trace = (id: string): SceneModule =>
        buildScene({
          id,
          cleanup: () => {
            cleaned.push(id);
          },
        });
      const scenes = [trace('scene-a'), trace('scene-b'), trace('scene-c')];
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry(scenes),
        compositions: createCompositionRegistry([
          { id: 'full-talk', manifest: scenes.map((s) => s.id) },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
      });

      await loader.handle(screenshotCompositionTarget('full-talk'));

      expect(cleaned).toEqual(['scene-a']);
    });

    it('omits the `screenshot` key on the runner input when `mode=screenshot` is absent (key-presence semantics)', async () => {
      // The runner input uses key-presence semantics for optional
      // fields (parallel to `beat` / `repeat` / `hold` / `cueGate`
      // / `range` / `behavior`): a runner can branch on
      // `'screenshot' in input` rather than `=== undefined`. A
      // regression that always set `input.screenshot = undefined`
      // (or any non-`'capture'` value) under non-screenshot modes
      // would break that contract.
      const captured: { hasScreenshot: boolean; screenshot: unknown }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const runner: SceneTimelineRunner = (input) => {
        captured.push({ hasScreenshot: 'screenshot' in input, screenshot: input.screenshot });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: runner,
      });

      // No mode at all (defaults to `present`).
      await loader.handle(sceneTarget('scene-a'));

      expect(captured).toEqual([{ hasScreenshot: false, screenshot: undefined }]);
    });

    it('does not set `screenshot` for any non-screenshot, lifecycle-running mode', async () => {
      // Walk the seven-mode allowlist (minus `screenshot` and
      // `prompter`) and confirm that none of them produce
      // `screenshot` on the runner input. Catching every
      // non-screenshot mode discriminates against an over-broad fix
      // that gated `screenshot` on `mode !== undefined` rather than
      // `mode === 'screenshot'`. Capturing the per-iteration mode
      // alongside the `'screenshot' in input` flag means the
      // assertion failure identifies WHICH mode regressed, not
      // just "some mode did."
      //
      // PUL-F019 / ADR-022: `prompter` does not invoke `runTimeline`
      // (lifecycle bypassed); the dedicated F019 block pins that
      // invariant.
      const nonScreenshotLifecycleModes = NAVIGATION_MODES.filter(
        (m) => m !== 'screenshot' && m !== 'prompter',
      );
      const captured: { mode: NavigationMode; hasScreenshot: boolean }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      for (const mode of nonScreenshotLifecycleModes) {
        const runner: SceneTimelineRunner = (input) => {
          captured.push({ mode, hasScreenshot: 'screenshot' in input });
        };
        const loader = createSceneLoader({
          scenes: createSceneRegistry([sceneA]),
          compositions: createCompositionRegistry([]),
          stage: stage.element,
          buildCtx: stubCtx,
          createPreloader: () => () => undefined,
          runTimeline: runner,
        });
        await loader.handle({ locator: { kind: 'scene', scene: 'scene-a' }, mode });
      }

      // One entry per non-screenshot lifecycle mode, each must have
      // `hasScreenshot: false`. Building the expected array from
      // `nonScreenshotLifecycleModes` keeps the assertion in sync if
      // the mode allowlist ever changes.
      expect(captured).toEqual(
        nonScreenshotLifecycleModes.map((mode) => ({ mode, hasScreenshot: false })),
      );
    });

    it('exposes `ctx.mode === "screenshot"` to every lifecycle hook of the head scene under all locator shapes', async () => {
      // Parallel to the PUL-F014 standalone, PUL-F015 loop,
      // PUL-F016 paused, and PUL-F017 scrub seam tests. Future
      // capture tooling that observes the runtime reads `ctx.mode`
      // (or the equivalent stage seam) to decide its own behavior;
      // this test pins the seam end to end across all four locator
      // shapes that can appear under `mode=screenshot`.
      const seen: { phase: string; locatorKind: string; mode: unknown }[] = [];
      const recordMode =
        (phase: string, locatorKind: string) =>
        (ctx: unknown): unknown => {
          seen.push({ phase, locatorKind, mode: (ctx as { mode?: NavigationMode }).mode });
          return null;
        };
      const makeScene = (locatorKind: string): SceneModule =>
        buildScene({
          id: 'scene-a',
          create: recordMode('create', locatorKind),
          timeline: recordMode('timeline', locatorKind) as SceneModule['timeline'],
          cleanup: recordMode('cleanup', locatorKind),
        });
      const stage = buildStage();
      const buildLoader = (sceneId: string, locatorKind: string) =>
        createSceneLoader({
          scenes: createSceneRegistry([makeScene(locatorKind)]),
          compositions: createCompositionRegistry([{ id: 'full-talk', manifest: [sceneId] }]),
          stage: stage.element,
          buildCtx: (mode) => ({ stage: stage.element, mode }),
          createPreloader: () => () => undefined,
          runTimeline: noopRunner,
        });

      await buildLoader('scene-a', 'scene').handle(screenshotSceneTarget('scene-a'));
      await buildLoader('scene-a', 'composition').handle(screenshotCompositionTarget('full-talk'));
      await buildLoader('scene-a', 'composition-scene').handle(
        screenshotCompositionSceneTarget('full-talk', 'scene-a'),
      );
      await buildLoader('scene-a', 'composition-index').handle(
        screenshotCompositionIndexTarget('full-talk', 0),
      );

      // 3 hooks per navigation × 4 locator shapes = 12 entries;
      // every single one must carry `screenshot`.
      expect(seen).toHaveLength(12);
      for (const entry of seen) {
        expect(entry.mode).toBe('screenshot');
      }
    });

    it('forwards `beat` to the head scene runner alongside `screenshot` under `mode=screenshot`, and surfaces missing-beat as a non-fatal diagnostic', async () => {
      // PUL-F018 explicitly says "at the addressed beat (or first
      // frame if no beat)," so a URL like
      // `?scene=x&beat=midpoint&mode=screenshot` must deliver both
      // `beat` and `screenshot` to the runner. Unlike `mode=paused`
      // (ADR-019: "first frame wins"), screenshot HONORS the beat
      // as the addressed-frame anchor; the runner seeks to the
      // beat and then freezes. A regression that dropped `beat`
      // when `mode=screenshot` is set would silently break the
      // natural deterministic-frame-capture-at-named-beat path
      // PUL-F018 names directly.
      const captured: {
        sceneId: string;
        beat: string | undefined;
        screenshot: 'capture' | undefined;
      }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const errors: unknown[] = [];
      const runner: SceneTimelineRunner = (input) => {
        captured.push({
          sceneId: input.scene.id,
          beat: input.beat,
          screenshot: input.screenshot,
        });
        if (input.beat !== undefined && input.onBeatMissing !== undefined) {
          input.onBeatMissing();
        }
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: runner,
        onError: (err) => {
          errors.push(err);
        },
      });

      await loader.handle({
        locator: { kind: 'scene', scene: 'scene-a' },
        mode: 'screenshot',
        beat: 'midpoint',
      });

      expect(captured).toEqual([{ sceneId: 'scene-a', beat: 'midpoint', screenshot: 'capture' }]);
      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain('beat positioning failed');
      expect((errors[0] as Error).message).toContain('"midpoint"');
      expect(stage.attrs.get('data-pulsar-navigation-error')).toBeDefined();
    });

    it('writes no `data-pulsar-mode-*` suppression attribute on the stage under `mode=screenshot`', async () => {
      // Mirrors ADR-016 / ADR-017 / ADR-018 / ADR-019 / ADR-020
      // invariant. PUL-F018 forbids the loader from preemptively
      // writing a stage attribute for screenshot mode; runner-side
      // or future-tooling-side signaling lives at those surfaces,
      // not at the loader.
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

      await loader.handle(screenshotSceneTarget('scene-a'));

      const modeAttrs = Array.from(stage.attrs.keys()).filter((name) =>
        name.startsWith('data-pulsar-mode-'),
      );
      expect(modeAttrs).toEqual([]);
    });

    it('writes both `data-pulsar-scene-target` and `data-pulsar-composition-target` for a composition target under `mode=screenshot` (preserves observability of what the URL addressed)', async () => {
      // The stage attrs communicate "what was addressed," not "what
      // ran." Truncation drops following entries from execution
      // but does not drop the composition id from the stage attrs
      // — mirrors the standalone / loop / paused / scrub
      // invariant.
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
        runTimeline: noopRunner,
      });

      await loader.handle(screenshotCompositionSceneTarget('full-talk', 'scene-b'));

      expect(stage.attrs.get('data-pulsar-scene-target')).toBe('scene-b');
      expect(stage.attrs.get('data-pulsar-composition-target')).toBe('full-talk');
    });

    it('surfaces composition-not-registered as a navigation error under `mode=screenshot` (no silent fallback)', async () => {
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const errors: unknown[] = [];
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
        onError: (err) => {
          errors.push(err);
        },
      });

      await loader.handle(screenshotCompositionTarget('not-registered'));

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain(
        'composition "not-registered" is not registered',
      );
      expect(stage.attrs.get('data-pulsar-navigation-error')).toBeDefined();
    });

    it('surfaces composition-member error under `mode=screenshot` for an unknown scene in `composition+scene`', async () => {
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneZ = buildScene({ id: 'scene-z' });
      const stage = buildStage();
      const errors: unknown[] = [];
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneZ]),
        compositions: createCompositionRegistry([{ id: 'full-talk', manifest: ['scene-a'] }]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
        onError: (err) => {
          errors.push(err);
        },
      });

      await loader.handle(screenshotCompositionSceneTarget('full-talk', 'scene-z'));

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain(
        'scene "scene-z" is not a member of composition "full-talk"',
      );
    });

    it('surfaces index-out-of-range under `mode=screenshot`', async () => {
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const errors: unknown[] = [];
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([{ id: 'full-talk', manifest: ['scene-a'] }]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
        onError: (err) => {
          errors.push(err);
        },
      });

      await loader.handle(screenshotCompositionIndexTarget('full-talk', 5));

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain('index 5 is out of range');
    });

    it("preserves the addressed head entry's `range` and `behavior` overrides on the runner input under `mode=screenshot` (composition+index with object-form entry)", async () => {
      // PUL-F018 / ADR-021: screenshot truncates the validated
      // composition slice to the addressed head and forwards
      // `screenshot` to that head's runner input. The slice is
      // TRUNCATED rather than flattened — a flat `{ scene }` would
      // lose object-form `range` / `behavior` overrides on the
      // head entry, turning screenshot into direct-scene
      // flattening (parity with ADR-017's standalone, ADR-018's
      // loop, ADR-019's paused, and ADR-020's scrub invariant).
      // This pins all three slots — `range`, `behavior`, and
      // `screenshot` — through to the head runner, plus the
      // truncation itself (the runner runs exactly once).
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneB = buildScene({ id: 'scene-b' });
      const sceneC = buildScene({ id: 'scene-c' });
      const stage = buildStage();
      const captured: {
        sceneId: string;
        range: unknown;
        behavior: unknown;
        screenshot: unknown;
      }[] = [];
      const runner: SceneTimelineRunner = (input) => {
        captured.push({
          sceneId: input.scene.id,
          range: input.range,
          behavior: input.behavior,
          screenshot: input.screenshot,
        });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB, sceneC]),
        compositions: createCompositionRegistry([
          {
            id: 'full-talk',
            manifest: [
              'scene-a',
              { id: 'scene-b', range: 'midpoint', behavior: { hold: true } },
              'scene-c',
            ],
          },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: runner,
      });

      await loader.handle(screenshotCompositionIndexTarget('full-talk', 1));

      expect(captured).toEqual([
        {
          sceneId: 'scene-b',
          range: 'midpoint',
          behavior: { hold: true },
          screenshot: 'capture',
        },
      ]);
    });
  });

  describe('prompter-mode caption-view dispatch (PUL-F019)', () => {
    // PUL-F019 statement: in `mode=prompter`, the runtime SHALL render
    // a script/caption view derived from the captions metadata of the
    // addressed scene or composition. Visual rendering of the scene
    // SHALL be suppressed.
    //
    // Materially-implementable parts of the statement that this block
    // pins (ADR-022 records the contract boundary):
    //   - Visual rendering is suppressed STRUCTURALLY: under
    //     `mode=prompter` the loader does NOT invoke `createPreloader`,
    //     does NOT invoke `runTimeline`, and does NOT mount the scene
    //     (no `create` / `timeline` / `cleanup`). The captions data
    //     path runs INSTEAD of the resolver lifecycle. CSS-hiding an
    //     already-rendered scene would not satisfy the requirement —
    //     the codex preflight guardrails for PUL-F019 explicitly call
    //     this out.
    //   - The captions view is derived from the captions metadata of
    //     the addressed scene OR composition. The slice is NOT
    //     truncated under composition addressing — every entry's
    //     captions are aggregated, in dispatch order. This is the
    //     structural difference from `mode=loop` / `mode=paused` /
    //     `mode=scrub` / `mode=screenshot`, which truncate to head
    //     because their lifecycle promise is "no following entries
    //     run." Under prompter the lifecycle doesn't run AT ALL, so
    //     the truncation defense from the other modes does not apply.
    //   - The loader hands the computed `PrompterScript` to an
    //     optional `renderPrompter` adapter on `SceneLoaderOptions`.
    //     A workbench bootstrap that has not yet wired a captions UI
    //     omits the field; the loader still suppresses the lifecycle
    //     (the structural defense) but invokes no renderer. Production
    //     bootstrap supplies a concrete renderer when the UI surface
    //     lands.
    //   - Stage attrs (`data-pulsar-scene-target`,
    //     `data-pulsar-composition-target`) are still set so external
    //     observers see what was addressed. NO `data-pulsar-mode-*`
    //     preemptive attribute (parity with ADR-016 / ADR-017 /
    //     ADR-018 / ADR-019 / ADR-020 / ADR-021).
    //   - Composition validation (unregistered composition, unknown
    //     member scene, out-of-range index) STILL surfaces as a
    //     navigation error under `mode=prompter` — no silent fallback
    //     to direct scene lookup.
    //   - Other modes (`present`, `standalone`, `loop`, `paused`,
    //     `scrub`, `screenshot`) and a `mode`-less URL DO NOT invoke
    //     `renderPrompter`. A regression that broadcast prompter
    //     dispatch under any mode would suppress lifecycle for normal
    //     playback URLs.
    //
    // PUL-F019 stays DRAFT after this PR (ADR-022 records the
    // boundary; following the ADR-016 / ADR-017 / ADR-018 / ADR-019 /
    // ADR-020 / ADR-021 / PUL-F013 / PUL-F014 / PUL-F015 / PUL-F016 /
    // PUL-F017 / PUL-F018 precedent). The seam — the loader bypasses
    // the lifecycle and hands a `PrompterScript` to the adapter — IS
    // materially shipped. The visible captions/script UI is the
    // future workbench surface, gated on the DRAFT → ACTIVE
    // transition.

    const prompterSceneTarget = (id: string): NavigationTarget => ({
      locator: { kind: 'scene', scene: id },
      mode: 'prompter',
    });
    const prompterCompositionTarget = (composition: string): NavigationTarget => ({
      locator: { kind: 'composition', composition },
      mode: 'prompter',
    });
    const prompterCompositionSceneTarget = (
      composition: string,
      scene: string,
    ): NavigationTarget => ({
      locator: { kind: 'composition-scene', composition, scene },
      mode: 'prompter',
    });
    const prompterCompositionIndexTarget = (
      composition: string,
      index: number,
    ): NavigationTarget => ({
      locator: { kind: 'composition-index', composition, index },
      mode: 'prompter',
    });

    interface LifecycleProbe {
      readonly log: string[];
      readonly preloaderInvocations: number;
      readonly buildCtxInvocations: number;
    }

    // Probe that records every lifecycle observation across every
    // boundary the lifecycle would touch under non-prompter modes:
    //   - `createPreloader` (asset pipeline)
    //   - `buildCtx` (per-navigation ctx — its very invocation means
    //     the loader is on the lifecycle path)
    //   - `runTimeline` (runner adapter)
    //   - scene `create` / `timeline` / `cleanup` (lifecycle hooks)
    // Under `mode=prompter` every counter / log entry MUST stay zero.
    // The codex guardrails for PUL-F019 explicitly call out asset
    // pipeline + scene renderer + canvas/stage + media playback +
    // animation loop as side effects to avoid; an under-watched test
    // (e.g. one that only checked `runTimeline`) would miss an
    // ABI regression that started running the preloader under
    // prompter — exactly the `asset pipeline` clause of the guardrails.

    type ProbeOpts = {
      readonly probe: LifecycleProbe;
      readonly preloader: () => Promise<void>;
      readonly runner: SceneTimelineRunner;
      readonly buildCtxFn: (mode: NavigationMode) => WorkbenchSceneCtx;
      readonly scenes: readonly SceneModule[];
    };

    const buildLifecycleProbe = (): ProbeOpts => {
      const log: string[] = [];
      const probe: { -readonly [K in keyof LifecycleProbe]: LifecycleProbe[K] } = {
        log,
        preloaderInvocations: 0,
        buildCtxInvocations: 0,
      };
      const trace = (id: string, captions?: readonly Caption[]): SceneModule =>
        buildScene({
          id,
          title: id,
          captions: captions ?? [],
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
      const runner: SceneTimelineRunner = (input) => {
        log.push(`runTimeline:${input.scene.id}`);
      };
      const preloader = (): Promise<void> => {
        probe.preloaderInvocations += 1;
        return Promise.resolve();
      };
      const buildCtxFn = (mode: NavigationMode): WorkbenchSceneCtx => {
        probe.buildCtxInvocations += 1;
        return { stage: null, mode };
      };
      const scenes = [
        trace('scene-a', [{ at: 0, text: 'A1' }]),
        trace('scene-b', [{ at: 0, text: 'B1' }]),
        trace('scene-c', [{ at: 0, text: 'C1' }]),
      ];
      return { probe, preloader, runner, buildCtxFn, scenes };
    };

    it('suppresses every lifecycle side effect under `mode=prompter` (no preloader, no buildCtx, no runner, no scene hooks)', async () => {
      // The structural-suppression guarantee. A regression that
      // dispatched prompter through `loadSceneNavigationTarget`
      // (the same path other modes use) would emit lifecycle entries
      // for the head scene AND increment the preloader and buildCtx
      // counters; this test would surface every one of those
      // regressions.
      const { probe, preloader, runner, buildCtxFn, scenes } = buildLifecycleProbe();
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([...scenes]),
        compositions: createCompositionRegistry([
          { id: 'full-talk', manifest: scenes.map((s) => s.id) },
        ]),
        stage: stage.element,
        buildCtx: buildCtxFn,
        createPreloader: () => preloader,
        runTimeline: runner,
      });

      await loader.handle(prompterCompositionTarget('full-talk'));

      expect(probe.log).toEqual([]);
      expect(probe.preloaderInvocations).toBe(0);
      expect(probe.buildCtxInvocations).toBe(0);
    });

    it('invokes `renderPrompter` with a script aggregating captions across the FULL composition slice (NOT truncated to head)', async () => {
      // Captions span every entry in the composition slice. The
      // composition list has three scenes; under prompter every
      // scene's captions must reach the renderer in manifest order.
      // A regression that copy-pasted truncation from F015–F018
      // would observe only the head scene's captions in the script.
      // PUL-F019 explicitly says "addressed scene OR composition,"
      // and ADR-022 records the no-truncation policy as the
      // structural difference.
      const sceneA = buildScene({
        id: 'scene-a',
        title: 'Alpha',
        captions: [
          { at: 0, text: 'A1' },
          { at: 100, text: 'A2' },
        ],
      });
      const sceneB = buildScene({
        id: 'scene-b',
        title: 'Bravo',
        captions: [{ at: 0, text: 'B1' }],
      });
      const sceneC = buildScene({
        id: 'scene-c',
        title: 'Charlie',
        captions: [{ at: 0, text: 'C1' }],
      });
      const stage = buildStage();
      const captured: PrompterScript[] = [];
      const renderPrompter: PrompterRenderer = (script) => {
        captured.push(script);
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB, sceneC]),
        compositions: createCompositionRegistry([
          { id: 'full-talk', manifest: ['scene-a', 'scene-b', 'scene-c'] },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
        renderPrompter,
      });

      await loader.handle(prompterCompositionTarget('full-talk'));

      expect(captured).toHaveLength(1);
      expect(captured[0]).toEqual({
        composition: { id: 'full-talk' },
        entries: [
          {
            sceneId: 'scene-a',
            title: 'Alpha',
            captions: [
              { at: 0, text: 'A1' },
              { at: 100, text: 'A2' },
            ],
          },
          { sceneId: 'scene-b', title: 'Bravo', captions: [{ at: 0, text: 'B1' }] },
          { sceneId: 'scene-c', title: 'Charlie', captions: [{ at: 0, text: 'C1' }] },
        ],
      });
    });

    it('invokes `renderPrompter` with a single-scene script for a `scene` target under `mode=prompter`', async () => {
      // Direct-scene addressing — no composition context. The script
      // has one entry and no `composition` field. A regression that
      // assumed every prompter dispatch had a composition would
      // either crash on `target.composition!.id` or produce a
      // misleading script. Pin the single-scene shape explicitly.
      const sceneA = buildScene({
        id: 'scene-a',
        captions: [{ at: 250, text: 'hello' }],
      });
      const stage = buildStage();
      const captured: PrompterScript[] = [];
      const renderPrompter: PrompterRenderer = (script) => {
        captured.push(script);
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
        renderPrompter,
      });

      await loader.handle(prompterSceneTarget('scene-a'));

      expect(captured).toHaveLength(1);
      expect(captured[0]?.entries).toEqual([
        { sceneId: 'scene-a', title: 'scene-a', captions: [{ at: 250, text: 'hello' }] },
      ]);
      expect(captured[0] && 'composition' in captured[0]).toBe(false);
    });

    it('starts the prompter slice at the addressed scene under `composition+scene` non-head', async () => {
      // The dispatcher already snapshots the slice from the addressed
      // scene onward (PUL-F008 / ADR-014). The prompter view honors
      // that — entries match the slice, NOT the full composition.
      // A regression that walked back to the composition's first
      // entry would surface skipped-scene captions. Choose a non-head
      // start so the test discriminates against "always full
      // composition."
      const sceneA = buildScene({ id: 'scene-a', captions: [{ at: 0, text: 'skipped' }] });
      const sceneB = buildScene({
        id: 'scene-b',
        title: 'Bravo',
        captions: [{ at: 0, text: 'kept' }],
      });
      const sceneC = buildScene({
        id: 'scene-c',
        title: 'Charlie',
        captions: [{ at: 0, text: 'also kept' }],
      });
      const stage = buildStage();
      const captured: PrompterScript[] = [];
      const renderPrompter: PrompterRenderer = (script) => {
        captured.push(script);
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB, sceneC]),
        compositions: createCompositionRegistry([
          { id: 'full-talk', manifest: ['scene-a', 'scene-b', 'scene-c'] },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
        renderPrompter,
      });

      await loader.handle(prompterCompositionSceneTarget('full-talk', 'scene-b'));

      expect(captured).toHaveLength(1);
      expect(captured[0]?.entries.map((e) => e.sceneId)).toEqual(['scene-b', 'scene-c']);
    });

    it('starts the prompter slice at the requested index under `composition+index`', async () => {
      // index=1 against [a, b, c] resolves to slice [b, c]. Non-final
      // index discriminates against a regression that re-walked from
      // 0 (would surface scene-a) AND a regression that always sliced
      // to length 1 (would drop scene-c). Choosing index=1 catches
      // both.
      const sceneA = buildScene({ id: 'scene-a', captions: [{ at: 0, text: 'A' }] });
      const sceneB = buildScene({ id: 'scene-b', captions: [{ at: 0, text: 'B' }] });
      const sceneC = buildScene({ id: 'scene-c', captions: [{ at: 0, text: 'C' }] });
      const stage = buildStage();
      const captured: PrompterScript[] = [];
      const renderPrompter: PrompterRenderer = (script) => {
        captured.push(script);
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB, sceneC]),
        compositions: createCompositionRegistry([
          { id: 'full-talk', manifest: ['scene-a', 'scene-b', 'scene-c'] },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
        renderPrompter,
      });

      await loader.handle(prompterCompositionIndexTarget('full-talk', 1));

      expect(captured).toHaveLength(1);
      expect(captured[0]?.entries.map((e) => e.sceneId)).toEqual(['scene-b', 'scene-c']);
    });

    it('does not invoke `renderPrompter` for any non-prompter mode', async () => {
      // Walk the seven-mode allowlist (minus `prompter`) and confirm
      // that none of them invoke the prompter renderer. A regression
      // that gated `renderPrompter` on `mode !== undefined` (instead
      // of `mode === 'prompter'`) would call the renderer for
      // standalone / loop / paused / scrub / screenshot under URL
      // navigations that should run the lifecycle. The renderer's
      // invocation count IS the assertion — not the count of any
      // particular mode — because the regression is "renderer fires
      // when it shouldn't."
      const nonPrompterModes = NAVIGATION_MODES.filter((m) => m !== 'prompter');
      const calls: PrompterScript[] = [];
      const renderPrompter: PrompterRenderer = (script) => {
        calls.push(script);
      };
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      for (const mode of nonPrompterModes) {
        const loader = createSceneLoader({
          scenes: createSceneRegistry([sceneA]),
          compositions: createCompositionRegistry([]),
          stage: stage.element,
          buildCtx: stubCtx,
          createPreloader: () => () => undefined,
          runTimeline: noopRunner,
          renderPrompter,
        });
        await loader.handle({ locator: { kind: 'scene', scene: 'scene-a' }, mode });
      }
      // No mode at all (defaults to `present`).
      const loaderNoMode = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
        renderPrompter,
      });
      await loaderNoMode.handle(sceneTarget('scene-a'));

      expect(calls).toEqual([]);
    });

    it('still suppresses the lifecycle when `renderPrompter` is omitted (graceful degradation)', async () => {
      // A workbench bootstrap that has not yet wired a captions UI
      // omits the field. The loader's structural-suppression
      // guarantee is independent of the renderer's presence — under
      // `mode=prompter` the lifecycle is bypassed regardless. The
      // captions data path simply has no consumer until the UI lands.
      // A regression that skipped suppression when `renderPrompter`
      // was absent would surface lifecycle entries here.
      const { probe, preloader, runner, buildCtxFn, scenes } = buildLifecycleProbe();
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([...scenes]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: buildCtxFn,
        createPreloader: () => preloader,
        runTimeline: runner,
        // renderPrompter omitted on purpose.
      });

      await loader.handle(prompterSceneTarget('scene-a'));

      expect(probe.log).toEqual([]);
      expect(probe.preloaderInvocations).toBe(0);
      expect(probe.buildCtxInvocations).toBe(0);
    });

    it('writes `data-pulsar-scene-target` and `data-pulsar-composition-target` for a composition-prompter target (preserves observability of what was addressed)', async () => {
      // Stage attrs communicate "what was addressed," not "what runs."
      // Suppressed lifecycle does NOT mean suppressed observability —
      // an external observer (agent, future tooling) reading the
      // stage must still see what URL the runtime navigated to.
      // Mirrors the standalone / loop / paused / scrub / screenshot
      // invariant.
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
        runTimeline: noopRunner,
        renderPrompter: () => undefined,
      });

      await loader.handle(prompterCompositionSceneTarget('full-talk', 'scene-b'));

      expect(stage.attrs.get('data-pulsar-scene-target')).toBe('scene-b');
      expect(stage.attrs.get('data-pulsar-composition-target')).toBe('full-talk');
    });

    it('writes no `data-pulsar-mode-*` suppression attribute on the stage under `mode=prompter`', async () => {
      // Mirrors ADR-016 / ADR-017 / ADR-018 / ADR-019 / ADR-020 /
      // ADR-021. ADR-022 keeps the same invariant: the prompter UI
      // surface (when it lands) is free to write its own stage
      // attributes, but the loader does NOT preemptively claim a
      // `data-pulsar-mode-*` namespace.
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
        renderPrompter: () => undefined,
      });

      await loader.handle(prompterSceneTarget('scene-a'));

      const modeAttrs = Array.from(stage.attrs.keys()).filter((name) =>
        name.startsWith('data-pulsar-mode-'),
      );
      expect(modeAttrs).toEqual([]);
    });

    it('surfaces composition-not-registered as a navigation error under `mode=prompter` (no silent fallback)', async () => {
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const errors: unknown[] = [];
      const calls: PrompterScript[] = [];
      const renderPrompter: PrompterRenderer = (script) => {
        calls.push(script);
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
        onError: (err) => {
          errors.push(err);
        },
        renderPrompter,
      });

      await loader.handle(prompterCompositionTarget('not-registered'));

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain(
        'composition "not-registered" is not registered',
      );
      expect(stage.attrs.get('data-pulsar-navigation-error')).toBeDefined();
      expect(calls).toEqual([]);
    });

    it('surfaces composition-member error under `mode=prompter` for an unknown scene in `composition+scene` (renderPrompter is NOT called on error paths)', async () => {
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneZ = buildScene({ id: 'scene-z' });
      const stage = buildStage();
      const errors: unknown[] = [];
      const calls: PrompterScript[] = [];
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneZ]),
        compositions: createCompositionRegistry([{ id: 'full-talk', manifest: ['scene-a'] }]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
        onError: (err) => {
          errors.push(err);
        },
        renderPrompter: (script) => {
          calls.push(script);
        },
      });

      await loader.handle(prompterCompositionSceneTarget('full-talk', 'scene-z'));

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain(
        'scene "scene-z" is not a member of composition "full-talk"',
      );
      expect(calls).toEqual([]);
    });

    it('surfaces index-out-of-range under `mode=prompter`', async () => {
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const errors: unknown[] = [];
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([{ id: 'full-talk', manifest: ['scene-a'] }]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
        onError: (err) => {
          errors.push(err);
        },
        renderPrompter: () => undefined,
      });

      await loader.handle(prompterCompositionIndexTarget('full-talk', 5));

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain('index 5 is out of range');
    });

    it('does not invoke `renderPrompter` for `kind: "none"` under `mode=prompter` (nothing addressed, nothing to render)', async () => {
      // `?mode=prompter` with no scene or composition target resolves
      // to `kind: 'none'`. There is no addressed metadata to derive
      // captions from, so the loader should run no renderer. A
      // regression that synthesized an empty script for `none`
      // targets would cause the captions UI to flash an empty view
      // on every popstate without an addressed scene.
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const calls: PrompterScript[] = [];
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
        renderPrompter: (script) => {
          calls.push(script);
        },
      });

      await loader.handle({ locator: { kind: 'none' }, mode: 'prompter' });

      expect(calls).toEqual([]);
    });

    it("invokes a renderer's PrompterDispose callback after abort when the navigation is superseded", async () => {
      // ADR-022's renderer contract (enforceable, not docs-only): a
      // renderer that mounts persistent DOM returns a
      // `PrompterDispose` callback (`() => void | Promise<void>`).
      // The loader OWNS the cleanup sequencing: it parks until
      // `signal.aborted` fires (next navigation, dispose(), etc.),
      // then invokes the callback. This test pins the loader's
      // call to dispose specifically — without the loader-driven
      // sequencing, a renderer that mounted DOM and returned a
      // dispose function would never see it called.
      const teardown: string[] = [];
      const sceneA = buildScene({ id: 'scene-a', captions: [{ at: 0, text: 'a' }] });
      const sceneB = buildScene({ id: 'scene-b', captions: [{ at: 0, text: 'b' }] });
      const stage = buildStage();
      const renderPrompter: PrompterRenderer = (script) => {
        if (script.entries[0]?.sceneId === 'scene-b') {
          // Second navigation: trivial renderer (no DOM mounted),
          // returns void. Lets `loader.idle()` settle without a
          // third navigation supersession.
          return undefined;
        }
        // First navigation: simulate "mount captions DOM" and
        // return the dispose callback the loader will invoke
        // after abort.
        return () => {
          teardown.push('dispose:scene-a');
        };
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
        renderPrompter,
      });

      void loader.handle(prompterSceneTarget('scene-a'));
      // Yield so the first dispatch's renderer returns its dispose
      // callback to the loader before the second navigation
      // supersedes it.
      await new Promise<void>((r) => setTimeout(r, 0));
      void loader.handle(prompterSceneTarget('scene-b'));
      await loader.idle();

      expect(teardown).toEqual(['dispose:scene-a']);
    });

    it('awaits an async PrompterDispose callback before settling the dispatch', async () => {
      // The dispose callback may be async (e.g. waiting for a CSS
      // transition before unmounting captions DOM). The loader
      // MUST await it before resolving the dispatch — otherwise
      // the next navigation's dispatch could overlap with the
      // previous renderer's lingering teardown. Pin async dispose
      // explicitly: after the supersession, the
      // present-mode-runner's create only fires AFTER the prompter
      // dispatch's async dispose completes.
      const order: string[] = [];
      const sceneA = buildScene({ id: 'scene-a', captions: [{ at: 0, text: 'a' }] });
      const sceneB = buildScene({
        id: 'scene-b',
        create: () => {
          order.push('create:scene-b');
        },
      });
      const stage = buildStage();
      const renderPrompter: PrompterRenderer = () => async () => {
        // Async teardown — yields to the microtask queue twice
        // before completing, so a regression that didn't await
        // dispose would let scene-b's create run first.
        await Promise.resolve();
        await Promise.resolve();
        order.push('dispose:scene-a');
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
        renderPrompter,
      });

      void loader.handle(prompterSceneTarget('scene-a'));
      await new Promise<void>((r) => setTimeout(r, 0));
      // Second navigation is `mode=present` (default) — its
      // lifecycle running BEFORE prompter dispose would fail this
      // assertion.
      void loader.handle(sceneTarget('scene-b'));
      await loader.idle();

      expect(order).toEqual(['dispose:scene-a', 'create:scene-b']);
    });

    it('does not park when the renderer returns void (no persistent state mounted)', async () => {
      // The void-return path of the contract: renderer mounted
      // nothing, dispatch is fully complete after the renderer's
      // promise resolves. `loader.idle()` should settle WITHOUT a
      // second navigation aborting the dispatch. A regression that
      // always parked would hang `idle()` here (vitest's per-test
      // timeout would surface the hang as a failure).
      //
      // Beyond the no-hang behavior, also verify that the renderer
      // was invoked exactly once and that `loader.idle()` is
      // settled by the time we observe it (proving the dispatch
      // completed, not that idle() simply returned the still-
      // pending queue promise).
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      let renderCount = 0;
      const renderPrompter: PrompterRenderer = () => {
        renderCount += 1;
        return undefined;
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
        renderPrompter,
      });

      // Single navigation — no supersession, no abort. With void
      // return, idle() must still settle.
      await loader.handle(prompterSceneTarget('scene-a'));
      const idleSettled = await Promise.race([
        loader.idle().then(() => 'settled' as const),
        new Promise<'pending'>((r) => setTimeout(() => r('pending'), 0)),
      ]);

      expect(renderCount).toBe(1);
      expect(idleSettled).toBe('settled');
    });

    it('aborts a long-running `renderPrompter` when superseded by another navigation (the renderer signal honors abort)', async () => {
      // `renderPrompter` is awaited by the loader's serialized queue
      // — same shape as `runTimeline`. A renderer that doesn't honor
      // `signal` would hold up the next navigation forever. The
      // loader aborts the in-flight signal eagerly on enqueue (parity
      // with `runTimeline`'s abort path). The renderer's signal-tied
      // promise resolves on abort, allowing the next navigation to
      // proceed. A regression that forgot to abort prompter would
      // surface here as a hung second navigation (vitest's per-test
      // timeout makes the hang an explicit failure).
      //
      // The test must yield between the two `handle()` calls so the
      // first navigation actually starts running its renderer before
      // the second navigation aborts it. Without the yield, latest-
      // event supersession (in `runOnce`) would drop event 1 before
      // it ran — that is correct behavior for back-to-back enqueues
      // but would not exercise the abort path this test pins.
      const sceneA = buildScene({ id: 'scene-a', captions: [{ at: 0, text: 'first' }] });
      const sceneB = buildScene({ id: 'scene-b', captions: [{ at: 0, text: 'second' }] });
      const stage = buildStage();
      const seenScripts: PrompterScript[] = [];
      // The first navigation's renderer parks until abort (so the
      // second navigation has something to abort). The second
      // navigation's renderer returns immediately, so loader.idle()
      // settles instead of hanging on a non-existent third
      // navigation.
      const renderPrompter: PrompterRenderer = (script, signal) => {
        seenScripts.push(script);
        if (script.entries[0]?.sceneId === 'scene-a') {
          return new Promise<undefined>((resolve) => {
            if (signal.aborted) {
              resolve(undefined);
              return;
            }
            signal.addEventListener('abort', () => resolve(undefined), { once: true });
          });
        }
        return undefined;
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline: noopRunner,
        renderPrompter,
      });

      void loader.handle(prompterSceneTarget('scene-a'));
      // Yield to the microtask queue so the first navigation enters
      // its renderer (and registers the abort listener) before the
      // second navigation enqueues and aborts it.
      await new Promise<void>((r) => setTimeout(r, 0));
      void loader.handle(prompterSceneTarget('scene-b'));
      await loader.idle();

      // Both renders were entered (the second only after the first
      // aborted). A regression that didn't abort the first would
      // hang the second indefinitely.
      expect(seenScripts.map((s) => s.entries[0]?.sceneId)).toEqual(['scene-a', 'scene-b']);
    });

    it('cleans up an in-flight non-prompter scene before dispatching prompter (cleanup-before-handoff across mode boundary)', async () => {
      // Navigating from `mode=present` (running scene) to
      // `mode=prompter` MUST run the previous scene's `cleanup`
      // before the prompter renderer fires. The loader's
      // abort-and-await pattern already delivers this for any two
      // navigations; this test pins it specifically across the
      // present→prompter boundary, which is the most common
      // workbench trigger (a reviewer pivots from playback to
      // captions review without reloading).
      //
      // Yield between the two `handle()` calls so the first
      // navigation actually mounts before the second supersedes it
      // — without the yield, latest-event supersession would drop
      // the present-mode lifecycle entirely and there would be no
      // cleanup to observe.
      const order: string[] = [];
      const sceneA = buildScene({
        id: 'scene-a',
        create: () => {
          order.push('create:scene-a');
        },
        cleanup: () => {
          order.push('cleanup:scene-a');
        },
      });
      const sceneB = buildScene({ id: 'scene-b', captions: [{ at: 0, text: 'b' }] });
      const stage = buildStage();
      // First navigation: a runner that parks until abort so the
      // loader observes an in-flight scene at the moment the prompter
      // navigation enqueues. Second navigation: prompter; its
      // renderer logs its turn order to confirm cleanup ran first.
      const runTimeline: SceneTimelineRunner = (input) =>
        new Promise<void>((resolve) => {
          if (input.signal?.aborted === true) {
            resolve();
            return;
          }
          input.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      const renderPrompter: PrompterRenderer = () => {
        order.push('renderPrompter:scene-b');
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        runTimeline,
        renderPrompter,
      });

      void loader.handle(sceneTarget('scene-a')); // mode=present (default)
      // Yield so scene-a's lifecycle starts (create runs, runner
      // parks waiting for abort).
      await new Promise<void>((r) => setTimeout(r, 0));
      void loader.handle(prompterSceneTarget('scene-b'));
      await loader.idle();

      // create:scene-a → (abort fires) → cleanup:scene-a → then
      // renderPrompter:scene-b. The relative order pins
      // cleanup-before-handoff across the present→prompter boundary.
      expect(order).toEqual(['create:scene-a', 'cleanup:scene-a', 'renderPrompter:scene-b']);
    });
  });
});
