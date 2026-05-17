import { describe, expect, it, vi } from 'vitest';
import {
  type Caption,
  type CompositionTimelineAdapter,
  type CompositionTimelineRunOptions,
  type FakeStage,
  type LegacyRunInput,
  NAVIGATION_MODES,
  type NavigationMode,
  type NavigationTarget,
  type PrompterRenderer,
  type PrompterScript,
  type SceneLoaderOptions,
  type SceneModule,
  type SceneTimelineSegment,
  type StageElement,
  type TimelineRunCall,
  type WorkbenchSceneCtx,
  asTimeline,
  buildScene,
  buildStage,
  compositionIndexTarget,
  compositionSceneTarget,
  compositionTarget,
  createCompositionRegistry,
  createPresenterController,
  createSceneLoader,
  createSceneRegistry,
  gsap,
  noneTarget,
  noopTimeline,
  recordingTimeline,
  sceneTarget,
  stubCtx,
} from './scene-loader.helpers';

describe('createSceneLoader — navigation, errors & abort (PUL-F008)', () => {
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
        timeline: noopTimeline,
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
        timeline: noopTimeline,
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
        timeline: noopTimeline,
      });

      await loader.handle(compositionTarget('full-talk'));

      expect(stage.attrs.get('data-pulsar-scene-target')).toBe('intro');
      expect(stage.attrs.get('data-pulsar-composition-target')).toBe('full-talk');
      expect(stage.attrs.has('data-pulsar-navigation-error')).toBe(false);
      // ADR-025: the runtime mounts every scene in the slice, plays them
      // as one master timeline, then tears them down in reverse — so the
      // lifecycle order is "create-all, then cleanup-all" not
      // "create-then-cleanup per scene".
      expect(log).toEqual([
        'create:intro',
        'create:middle',
        'create:outro',
        'cleanup:outro',
        'cleanup:middle',
        'cleanup:intro',
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
        timeline: noopTimeline,
      });

      await loader.handle(compositionIndexTarget('full-talk', 1));

      expect(stage.attrs.get('data-pulsar-scene-target')).toBe('middle');
      expect(stage.attrs.get('data-pulsar-composition-target')).toBe('full-talk');
      expect(stage.attrs.has('data-pulsar-navigation-error')).toBe(false);
      expect(log).toEqual(['create:middle', 'create:outro', 'cleanup:outro', 'cleanup:middle']);
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
          timeline: noopTimeline,
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
          'create:scene-d',
          'cleanup:scene-d',
          'cleanup:scene-c',
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
          timeline: noopTimeline,
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
        timeline: noopTimeline,
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
        timeline: noopTimeline,
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
        timeline: noopTimeline,
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
        timeline: noopTimeline,
        onError: () => undefined,
      });

      await loader.handle(sceneTarget('missing'));

      const errorAttr = stage.attrs.get('data-pulsar-navigation-error');
      expect(errorAttr).toBeDefined();
      expect(errorAttr).toMatch(/scene navigation failed: scene "missing" is not registered/);
      expect(stage.attrs.has('data-pulsar-scene-target')).toBe(false);
    });

    it('routes a per-scene lifecycle throw to data-pulsar-scene-failures, NOT the fatal navigation-error attribute (PUL-F029)', async () => {
      // PUL-F029 / ADR-028: a thrown `create(ctx)` / `timeline(ctx)` /
      // `cleanup(ctx)` is a scene failure, not a fatal navigation
      // failure. The composition keeps moving and the diagnostic
      // lands on the per-scene stage attribute via `onSceneFailed`,
      // not on `data-pulsar-navigation-error` (which stays for
      // composition-wide failures: manifest, registry miss, preload,
      // timeline adapter `run` rejection, abort wrapper).
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

      expect(stage.attrs.get('data-pulsar-scene-target')).toBe('broken');
      expect(stage.attrs.has('data-pulsar-navigation-error')).toBe(false);
      expect(stage.attrs.get('data-pulsar-scene-failures')).toBe('broken:create');
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
        timeline: noopTimeline,
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
      const blockingRunner = (input: LegacyRunInput) => {
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
        timeline: asTimeline(blockingRunner),
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
      const blockingRunner = (input: LegacyRunInput) =>
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
        timeline: asTimeline(blockingRunner),
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
      const blockingRunner = (input: LegacyRunInput) => {
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
        timeline: asTimeline(blockingRunner),
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
      const blockingRunner = (input: LegacyRunInput) =>
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
        timeline: asTimeline(blockingRunner),
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
      const blockingRunner = (input: LegacyRunInput) => {
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
        timeline: asTimeline(blockingRunner),
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
        timeline: noopTimeline,
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
      // PUL-F029 / ADR-028 changes the surface here: the resolver no
      // longer folds an aborted lifecycle + cleanup failure into an
      // `AggregateError` the loader has to dissect. Instead, the
      // resolver fans out the cleanup failure through the loader's
      // `onSceneFailed` handler (which writes
      // `data-pulsar-scene-failures` and a `scene "broken" failed
      // during cleanup: …` Error to `onError`) and the abort wrapper
      // itself is suppressed by `isPureAbort`. The naive "any abort →
      // suppress" rule would still drop the cleanup half; the test
      // here pins that the per-scene cleanup failure stays visible.
      const broken = buildScene({
        id: 'broken',
        cleanup: () => {
          throw new Error('cleanup boom');
        },
      });
      // Only the FIRST runner invocation blocks; the follow-up
      // navigation runs through immediately so the test settles.
      let firstRunInvoked = false;
      const blockingRunner = (input: LegacyRunInput) => {
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
        timeline: asTimeline(blockingRunner),
        onError: (err) => {
          captured.push(err);
        },
      });

      void loader.handle(sceneTarget('broken'));
      await new Promise<void>((r) => setTimeout(r, 0));
      void loader.handle(sceneTarget('next'));
      await loader.idle();

      // The cleanup failure on `broken` MUST have surfaced through
      // `onError` (the loader's `onSceneFailed` handler routes there).
      // Exactly one onError call: the pure-abort wrapper is suppressed
      // by `isPureAbort` (scene-loader.ts:418-424), so the cleanup
      // failure is the only event reaching the workbench logger. The
      // earlier `>= 1` assertion let a future regression that double-
      // fires the abort through `onError` pass silently.
      expect(captured).toHaveLength(1);
      const cleanupError = captured.find(
        (e) => e instanceof Error && /cleanup boom/.test((e as Error).message),
      );
      expect(cleanupError).toBeDefined();
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
        timeline: noopTimeline,
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

    it('surfaces the scene id and every failing asset path BEFORE mounting the scene (PUL-Q009)', async () => {
      // PUL-Q009: when an asset declared by a scene fails to load
      // during preload, the runtime SHALL surface the failure with the
      // scene id and asset path before mounting the scene. The preload
      // throw path already names the scene id in the resolver wrapper;
      // the asset paths live in the AggregateError's per-asset
      // `errors[]`. The browser-visible surface (onError + the stage
      // attribute) MUST carry both so an operator does not see a
      // generic "preload failed" line for a multi-asset failure.
      const captured: unknown[] = [];
      const stage = buildStage();
      const createSpy = vi.fn();
      const intro = buildScene({
        id: 'intro',
        assets: ['/missing.png', '/broken.json'],
        create: createSpy,
      });
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        // Mimic the exact AggregateError shape `createAssetPreloader`
        // produces (asset-preloader.ts: per-asset Errors whose
        // `.message` carries the declared path, wrapped under a
        // composition-scoped aggregate message).
        createPreloader: () => () =>
          Promise.reject(
            new AggregateError(
              [
                new Error('asset "/missing.png": 404 Not Found'),
                new Error('asset "/broken.json": 500 Internal Server Error'),
              ],
              'composition asset preload failed: scene "intro"',
            ),
          ),
        timeline: noopTimeline,
        onError: (err) => {
          captured.push(err);
        },
      });

      await loader.handle(sceneTarget('intro'));

      // Clause "before mounting the scene": create(ctx) MUST NOT have
      // been called for the scene whose preload failed.
      expect(createSpy).not.toHaveBeenCalled();

      // onError fires with an Error whose message carries the scene id
      // AND every failing asset path.
      expect(captured).toHaveLength(1);
      const surfaced = captured[0] as Error;
      expect(surfaced).toBeInstanceOf(Error);
      expect(surfaced.message).toContain('scene "intro"');
      expect(surfaced.message).toContain('asset "/missing.png"');
      expect(surfaced.message).toContain('asset "/broken.json"');

      // The stage attribute (data-pulsar-navigation-error) carries the
      // same content so screenshot tooling / agents inspecting the DOM
      // see the same diagnostic the workbench logger gets.
      const stageMsg = stage.attrs.get('data-pulsar-navigation-error');
      expect(stageMsg).toBeDefined();
      expect(stageMsg).toContain('scene "intro"');
      expect(stageMsg).toContain('asset "/missing.png"');
      expect(stageMsg).toContain('asset "/broken.json"');
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
        timeline: noopTimeline,
      });

      loader.dispose();
      await loader.handle(sceneTarget('intro'));

      expect(log).toEqual([]);
    });
  });
});

describe('createSceneLoader — PUL-F029 scene-level error isolation', () => {
  it('surfaces a `create` failure via onError and the scene-failures stage attribute without aborting the composition', async () => {
    const onError = vi.fn();
    const intro = buildScene({ id: 'intro' });
    const broken = buildScene({
      id: 'broken',
      create: () => {
        throw new Error('create kaboom');
      },
    });
    const outro = buildScene({ id: 'outro' });
    const stage = buildStage();
    const { adapter, calls } = recordingTimeline();
    const loader = createSceneLoader({
      scenes: createSceneRegistry([intro, broken, outro]),
      compositions: createCompositionRegistry([
        { id: 'full-talk', manifest: ['intro', 'broken', 'outro'] },
      ]),
      stage: stage.element,
      buildCtx: stubCtx,
      createPreloader: () => () => undefined,
      timeline: adapter,
      onError,
    });

    await loader.handle(compositionTarget('full-talk'));

    // The composition did NOT halt — adapter ran with intro + outro segments.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.segments.map((s) => s.id)).toEqual(['intro', 'outro']);
    // The fatal-navigation surface stayed clean (this was a per-scene failure).
    expect(stage.attrs.has('data-pulsar-navigation-error')).toBe(false);
    // The per-scene failure shows up on the new attribute and via onError.
    expect(stage.attrs.get('data-pulsar-scene-failures')).toBe('broken:create');
    expect(onError).toHaveBeenCalledTimes(1);
    const firstArg = onError.mock.calls[0]?.[0] as unknown;
    expect(firstArg).toBeInstanceOf(Error);
    expect((firstArg as Error).message).toContain('broken');
    expect((firstArg as Error).message).toContain('create');
  });

  it('lists multiple scene failures on the stage attribute in encounter order', async () => {
    const onError = vi.fn();
    const intro = buildScene({ id: 'intro' });
    const brokenCreate = buildScene({
      id: 'broken-create',
      create: () => {
        throw new Error('create kaboom');
      },
    });
    const brokenCleanup = buildScene({
      id: 'broken-cleanup',
      cleanup: () => {
        throw new Error('cleanup kaboom');
      },
    });
    const stage = buildStage();
    const loader = createSceneLoader({
      scenes: createSceneRegistry([intro, brokenCreate, brokenCleanup]),
      compositions: createCompositionRegistry([
        { id: 'mix', manifest: ['intro', 'broken-create', 'broken-cleanup'] },
      ]),
      stage: stage.element,
      buildCtx: stubCtx,
      createPreloader: () => () => undefined,
      timeline: noopTimeline,
      onError,
    });

    await loader.handle(compositionTarget('mix'));

    // Both failures listed; encounter order is mount-then-cleanup.
    expect(stage.attrs.get('data-pulsar-scene-failures')).toBe(
      'broken-create:create,broken-cleanup:cleanup',
    );
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('enriches the onError message with composition id, entry index, and mode (ADR-028 diagnostic contract)', async () => {
    const onError = vi.fn();
    const intro = buildScene({ id: 'intro' });
    const broken = buildScene({
      id: 'broken',
      create: () => {
        throw new Error('create kaboom');
      },
    });
    const loader = createSceneLoader({
      scenes: createSceneRegistry([intro, broken]),
      compositions: createCompositionRegistry([{ id: 'full-talk', manifest: ['intro', 'broken'] }]),
      stage: buildStage().element,
      buildCtx: stubCtx,
      createPreloader: () => () => undefined,
      timeline: noopTimeline,
      onError,
    });

    await loader.handle(compositionTarget('full-talk'));

    expect(onError).toHaveBeenCalledTimes(1);
    const arg = onError.mock.calls[0]?.[0] as Error;
    expect(arg.message).toContain('scene "broken"');
    expect(arg.message).toContain('failed during create');
    expect(arg.message).toContain('composition "full-talk"');
    expect(arg.message).toContain('entry [1]');
    expect(arg.message).toContain('mode "present"');
    expect(arg.message).toContain('create kaboom');
  });

  it('renders the absolute composition entry index when the slice started mid-manifest (codex review, cycle 2)', async () => {
    // Codex review cycle 2 finding: for `composition-scene` /
    // `composition-index` navigation the resolver receives a slice
    // starting mid-manifest; rendering its slice-relative
    // `entryIndex` as the public composition entry would send
    // operators to the wrong entry. The loader must add the absolute
    // start offset.
    const onError = vi.fn();
    const intro = buildScene({ id: 'intro' });
    const middle = buildScene({ id: 'middle' });
    const broken = buildScene({
      id: 'broken',
      create: () => {
        throw new Error('create kaboom');
      },
    });
    const loader = createSceneLoader({
      scenes: createSceneRegistry([intro, middle, broken]),
      compositions: createCompositionRegistry([
        { id: 'full-talk', manifest: ['intro', 'middle', 'broken'] },
      ]),
      stage: buildStage().element,
      buildCtx: stubCtx,
      createPreloader: () => () => undefined,
      timeline: noopTimeline,
      onError,
    });

    // Navigate starting at index 1: the resolver sees a slice
    // [middle, broken]. The `broken` scene's slice-relative index is
    // 1, but its absolute composition entry index is 2.
    await loader.handle(compositionIndexTarget('full-talk', 1));

    expect(onError).toHaveBeenCalledTimes(1);
    const arg = onError.mock.calls[0]?.[0] as Error;
    expect(arg.message).toContain('entry [2]');
    expect(arg.message).not.toContain('entry [1]');
  });

  it('resets the scene-failures attribute on the next navigation', async () => {
    const onError = vi.fn();
    const intro = buildScene({ id: 'intro' });
    const broken = buildScene({
      id: 'broken',
      create: () => {
        throw new Error('create kaboom');
      },
    });
    const clean = buildScene({ id: 'clean' });
    const stage = buildStage();
    const loader = createSceneLoader({
      scenes: createSceneRegistry([intro, broken, clean]),
      compositions: createCompositionRegistry([{ id: 'failing', manifest: ['intro', 'broken'] }]),
      stage: stage.element,
      buildCtx: stubCtx,
      createPreloader: () => () => undefined,
      timeline: noopTimeline,
      onError,
    });

    await loader.handle(compositionTarget('failing'));
    expect(stage.attrs.get('data-pulsar-scene-failures')).toBe('broken:create');

    await loader.handle(sceneTarget('clean'));
    expect(stage.attrs.has('data-pulsar-scene-failures')).toBe(false);
  });
});
