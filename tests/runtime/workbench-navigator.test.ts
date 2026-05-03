// WorkbenchNavigator (PUL-F008 + ADR-007).
//
// Exercises the navigator's URL-resolution + lifecycle dispatch +
// popstate handling without any DOM dependency. The navigator is the
// extracted testable unit `src/main.ts` calls; main.ts is a thin
// adapter on top.
//
// References:
//  - PUL-F008 — when `scene` is present, load the addressed scene.
//  - ADR-007 — runtime parses URL parameters at startup AND on popstate.
//  - ADR-013 — no silent fallback; navigation errors surface visibly.

import { describe, expect, it } from 'vitest';
import { createCompositionRegistry } from '../../src/runtime/composition-registry';
import type { SceneTimelineRunner } from '../../src/runtime/composition-resolver';
import { createSceneRegistry } from '../../src/runtime/registry';
import type { SceneModule } from '../../src/runtime/scene';
import {
  type StageElement,
  type WorkbenchHost,
  createWorkbenchNavigator,
} from '../../src/runtime/workbench-navigator';

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

interface FakeHost {
  readonly host: WorkbenchHost;
  setSearch(search: string): void;
  fireNavigation(): void;
  readonly listenerCount: () => number;
}

const buildHost = (initialSearch = ''): FakeHost => {
  let search = initialSearch;
  const listeners: Array<() => void> = [];
  return {
    host: {
      get location(): { readonly search: string } {
        return { search };
      },
      addEventListener: (_event, handler) => {
        listeners.push(handler);
      },
      removeEventListener: (_event, handler) => {
        const i = listeners.indexOf(handler);
        if (i !== -1) listeners.splice(i, 1);
      },
    },
    setSearch: (next) => {
      search = next;
    },
    fireNavigation: () => {
      for (const fn of listeners) fn();
    },
    listenerCount: () => listeners.length,
  };
};

const noopRunner: SceneTimelineRunner = () => undefined;

describe('createWorkbenchNavigator (PUL-F008 + ADR-007)', () => {
  describe('startup navigation', () => {
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
      const fakeHost = buildHost('?scene=intro');
      const navigator = createWorkbenchNavigator({
        host: fakeHost.host,
        stage: stage.element,
        sceneRegistry: createSceneRegistry([intro]),
        compositionRegistry: createCompositionRegistry([]),
        ctx: {},
        preloadAssets: () => undefined,
        runTimeline: noopRunner,
      });

      await navigator.navigate();

      expect(stage.attrs.get('data-pulsar-scene-target')).toBe('intro');
      expect(stage.attrs.has('data-pulsar-navigation-error')).toBe(false);
      expect(log).toEqual(['create', 'cleanup']);
    });

    it('records the composition id when `?composition=X&scene=Y` resolves', async () => {
      const intro = buildScene({ id: 'intro' });
      const middle = buildScene({ id: 'middle' });
      const stage = buildStage();
      const fakeHost = buildHost('?composition=full-talk&scene=middle');
      const navigator = createWorkbenchNavigator({
        host: fakeHost.host,
        stage: stage.element,
        sceneRegistry: createSceneRegistry([intro, middle]),
        compositionRegistry: createCompositionRegistry([
          { id: 'full-talk', manifest: ['intro', 'middle'] },
        ]),
        ctx: {},
        preloadAssets: () => undefined,
        runTimeline: noopRunner,
      });

      await navigator.navigate();

      expect(stage.attrs.get('data-pulsar-scene-target')).toBe('middle');
      expect(stage.attrs.get('data-pulsar-composition-target')).toBe('full-talk');
    });

    it('is a no-op when neither `scene` nor `composition` is present', async () => {
      const stage = buildStage();
      const fakeHost = buildHost('?mode=screenshot');
      const navigator = createWorkbenchNavigator({
        host: fakeHost.host,
        stage: stage.element,
        sceneRegistry: createSceneRegistry([buildScene({ id: 'intro' })]),
        compositionRegistry: createCompositionRegistry([]),
        ctx: {},
        preloadAssets: () => undefined,
        runTimeline: noopRunner,
      });

      await navigator.navigate();

      expect(stage.attrs.has('data-pulsar-scene-target')).toBe(false);
      expect(stage.attrs.has('data-pulsar-composition-target')).toBe(false);
      expect(stage.attrs.has('data-pulsar-navigation-error')).toBe(false);
    });
  });

  describe('error surfacing — ADR-013 no silent fallback', () => {
    it('sets `data-pulsar-navigation-error` when the URL names an unregistered scene', async () => {
      const stage = buildStage();
      const fakeHost = buildHost('?scene=missing');
      const navigator = createWorkbenchNavigator({
        host: fakeHost.host,
        stage: stage.element,
        sceneRegistry: createSceneRegistry([buildScene({ id: 'intro' })]),
        compositionRegistry: createCompositionRegistry([]),
        ctx: {},
        preloadAssets: () => undefined,
        runTimeline: noopRunner,
      });

      await navigator.navigate();

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
      const fakeHost = buildHost('?scene=broken');
      const navigator = createWorkbenchNavigator({
        host: fakeHost.host,
        stage: stage.element,
        sceneRegistry: createSceneRegistry([broken]),
        compositionRegistry: createCompositionRegistry([]),
        ctx: {},
        preloadAssets: () => undefined,
        runTimeline: noopRunner,
      });

      await navigator.navigate();

      expect(stage.attrs.get('data-pulsar-scene-target')).toBe('broken');
      expect(stage.attrs.get('data-pulsar-navigation-error')).toMatch(
        /composition resolution failed: scene "broken" create threw/,
      );
    });

    it('clears stale stage attributes from the previous navigation before resolving the next URL', async () => {
      const intro = buildScene({ id: 'intro' });
      const stage = buildStage();
      stage.attrs.set('data-pulsar-scene-target', 'old');
      stage.attrs.set('data-pulsar-composition-target', 'old');
      stage.attrs.set('data-pulsar-navigation-error', 'old');
      const fakeHost = buildHost('?scene=intro');
      const navigator = createWorkbenchNavigator({
        host: fakeHost.host,
        stage: stage.element,
        sceneRegistry: createSceneRegistry([intro]),
        compositionRegistry: createCompositionRegistry([]),
        ctx: {},
        preloadAssets: () => undefined,
        runTimeline: noopRunner,
      });

      await navigator.navigate();

      expect(stage.attrs.get('data-pulsar-scene-target')).toBe('intro');
      expect(stage.attrs.has('data-pulsar-composition-target')).toBe(false);
      expect(stage.attrs.has('data-pulsar-navigation-error')).toBe(false);
    });
  });

  describe('popstate (ADR-007)', () => {
    it('registers a popstate listener on construction and removes it on dispose', () => {
      const fakeHost = buildHost();
      const navigator = createWorkbenchNavigator({
        host: fakeHost.host,
        stage: buildStage().element,
        sceneRegistry: createSceneRegistry([buildScene({ id: 'intro' })]),
        compositionRegistry: createCompositionRegistry([]),
        ctx: {},
        preloadAssets: () => undefined,
        runTimeline: noopRunner,
      });

      expect(fakeHost.listenerCount()).toBe(1);
      navigator.dispose();
      expect(fakeHost.listenerCount()).toBe(0);
    });

    it('re-runs URL resolution on popstate', async () => {
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
      const stage = buildStage();
      const fakeHost = buildHost('?scene=intro');
      const navigator = createWorkbenchNavigator({
        host: fakeHost.host,
        stage: stage.element,
        sceneRegistry: createSceneRegistry([intro, middle]),
        compositionRegistry: createCompositionRegistry([]),
        ctx: {},
        preloadAssets: () => undefined,
        runTimeline: noopRunner,
      });

      await navigator.navigate();
      expect(stage.attrs.get('data-pulsar-scene-target')).toBe('intro');

      // User clicks back/forward → host's location changes → popstate fires.
      fakeHost.setSearch('?scene=middle');
      fakeHost.fireNavigation();
      await navigator.idle();

      expect(stage.attrs.get('data-pulsar-scene-target')).toBe('middle');
      // intro must have been cleaned up before middle started.
      expect(log).toEqual(['intro:create', 'intro:cleanup', 'middle:create', 'middle:cleanup']);
    });

    it('aborts an in-flight load when popstate fires mid-lifecycle', async () => {
      // Set up a scene whose timeline runner blocks until the test
      // releases it. While the runner is awaiting, fire popstate to
      // navigate elsewhere; the abort signal forwarded through
      // `loadSceneNavigationTarget` should propagate, the runner
      // should observe it, and cleanup should fire before the new
      // navigation begins.
      const log: string[] = [];
      let releaseFirst: (() => void) | null = null;
      const firstRunnerPromise = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
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
          // First call: block on the released promise OR until aborted.
          return new Promise<void>((resolve, reject) => {
            const onAbort = (): void => {
              reject(input.signal?.reason ?? new Error('aborted'));
            };
            input.signal?.addEventListener('abort', onAbort, { once: true });
            void firstRunnerPromise.then(() => {
              input.signal?.removeEventListener('abort', onAbort);
              resolve();
            });
          });
        }
        // Second call: return immediately.
        return undefined;
      };

      const stage = buildStage();
      const fakeHost = buildHost('?scene=intro');
      const navigator = createWorkbenchNavigator({
        host: fakeHost.host,
        stage: stage.element,
        sceneRegistry: createSceneRegistry([intro, middle]),
        compositionRegistry: createCompositionRegistry([]),
        ctx: {},
        preloadAssets: () => undefined,
        runTimeline: blockingRunner,
      });

      // Kick off the first navigation but don't await it (blocked).
      void navigator.navigate();
      // Yield so the runner is invoked and is now awaiting its promise.
      await new Promise<void>((r) => setTimeout(r, 0));
      expect(log).toEqual(['intro:create']);

      // Now fire popstate to a different scene. The navigator should
      // abort the in-flight load before kicking off the new one.
      fakeHost.setSearch('?scene=middle');
      fakeHost.fireNavigation();

      // Wait for the navigator to settle.
      await navigator.idle();
      // releaseFirst is no longer needed because the runner observed the abort.
      // (`releaseFirst` is bound but never called — capture it to pacify TS no-unused; resolved via abort.)
      void releaseFirst;

      // Order should be: intro create → intro cleanup (via abort) → middle create → middle cleanup.
      expect(log).toEqual(['intro:create', 'intro:cleanup', 'middle:create', 'middle:cleanup']);
      expect(stage.attrs.get('data-pulsar-scene-target')).toBe('middle');
    });

    it('dispose() aborts an in-flight load', async () => {
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
      const fakeHost = buildHost('?scene=intro');
      const navigator = createWorkbenchNavigator({
        host: fakeHost.host,
        stage: buildStage().element,
        sceneRegistry: createSceneRegistry([intro]),
        compositionRegistry: createCompositionRegistry([]),
        ctx: {},
        preloadAssets: () => undefined,
        runTimeline: blockingRunner,
      });

      void navigator.navigate();
      await new Promise<void>((r) => setTimeout(r, 0));
      expect(log).toEqual(['intro:create']);

      navigator.dispose();
      await navigator.idle();

      expect(log).toEqual(['intro:create', 'intro:cleanup']);
      expect(fakeHost.listenerCount()).toBe(0);
    });
  });
});
