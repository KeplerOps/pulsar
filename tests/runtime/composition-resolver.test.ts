import { describe, expect, it } from 'vitest';
import type { CompositionManifest } from '../../src/runtime/composition';
import {
  type AssetPreloader,
  type ResolveCompositionOptions,
  type SceneTimelineRunInput,
  type SceneTimelineRunner,
  resolveComposition,
} from '../../src/runtime/composition-resolver';
import { createSceneRegistry } from '../../src/runtime/registry';
import type { SceneModule } from '../../src/runtime/scene';

// Each lifecycle hook + preloader + runner pushes a record into a
// shared array so tests can assert ordering directly. The shape carries
// just enough to identify which hook fired for which scene.
interface CallRecord {
  readonly hook: 'preload' | 'create' | 'timeline' | 'runTimeline' | 'cleanup';
  readonly sceneId: string;
  readonly ctx?: unknown;
  readonly value?: unknown;
}

interface BuildSceneOpts {
  readonly id: string;
  readonly assets?: readonly string[];
  readonly create?: SceneModule['create'];
  readonly timeline?: SceneModule['timeline'];
  readonly cleanup?: SceneModule['cleanup'];
}

const buildScene = (opts: BuildSceneOpts): SceneModule => ({
  id: opts.id,
  title: opts.id,
  duration: 1000,
  tags: [],
  assets: opts.assets ?? [],
  captions: [],
  defaultNext: null,
  standalone: false,
  trailerSafe: false,
  create: opts.create ?? (() => undefined),
  timeline: opts.timeline ?? (() => undefined),
  cleanup: opts.cleanup ?? (() => undefined),
});

interface Harness {
  readonly log: CallRecord[];
  readonly options: ResolveCompositionOptions;
}

interface HarnessOpts {
  readonly scenes: readonly BuildSceneOpts[];
  readonly manifest: CompositionManifest;
  readonly ctx?: unknown;
  readonly preloadAssets?: AssetPreloader;
  readonly runTimeline?: SceneTimelineRunner;
}

const buildHarness = (opts: HarnessOpts): Harness => {
  const log: CallRecord[] = [];
  const sceneById = new Map<string, SceneModule>();
  const wrappedScenes = opts.scenes.map((s) => {
    const create =
      s.create ??
      ((ctx) => {
        log.push({ hook: 'create', sceneId: s.id, ctx });
      });
    const timeline =
      s.timeline ??
      ((ctx) => {
        log.push({ hook: 'timeline', sceneId: s.id, ctx });
        return `${s.id}-timeline-value`;
      });
    const cleanup =
      s.cleanup ??
      ((ctx) => {
        log.push({ hook: 'cleanup', sceneId: s.id, ctx });
      });
    const scene = buildScene(
      s.assets === undefined
        ? { id: s.id, create, timeline, cleanup }
        : { id: s.id, assets: s.assets, create, timeline, cleanup },
    );
    sceneById.set(s.id, scene);
    return scene;
  });
  const registry = createSceneRegistry(wrappedScenes);
  const ctx = opts.ctx ?? { tag: 'ctx' };
  const preloadAssets: AssetPreloader =
    opts.preloadAssets ??
    ((scene) => {
      log.push({ hook: 'preload', sceneId: scene.id });
    });
  const runTimeline: SceneTimelineRunner =
    opts.runTimeline ??
    (({ scene, timeline }) => {
      log.push({ hook: 'runTimeline', sceneId: scene.id, value: timeline });
    });
  return {
    log,
    options: { registry, manifest: opts.manifest, ctx, preloadAssets, runTimeline },
  };
};

describe('resolveComposition (PUL-F004)', () => {
  describe('manifest defense (boundary)', () => {
    it('throws the assertCompositionManifest grammar when the manifest is not an array', async () => {
      const { options } = buildHarness({ scenes: [], manifest: [] });
      await expect(
        resolveComposition({
          ...options,
          manifest: 'not an array' as unknown as CompositionManifest,
        }),
      ).rejects.toThrow(/^composition manifest is invalid:/);
    });

    it('throws the assertCompositionManifest grammar when an entry is malformed', async () => {
      const { options } = buildHarness({ scenes: [], manifest: [] });
      await expect(
        resolveComposition({
          ...options,
          manifest: ['NOT-KEBAB'] as unknown as CompositionManifest,
        }),
      ).rejects.toThrow(/^composition entry \[0\] is invalid: id must be/);
    });
  });

  describe('clause (a) — every referenced scene id exists in the registry', () => {
    it('resolves an empty manifest with no preload / runner / scene-hook calls', async () => {
      const { log, options } = buildHarness({ scenes: [], manifest: [] });
      await expect(resolveComposition(options)).resolves.toBeUndefined();
      expect(log).toEqual([]);
    });

    it('throws an actionable error naming a single missing id and its entry index', async () => {
      const { options } = buildHarness({
        scenes: [{ id: 'scene-a' }],
        manifest: ['scene-a', 'missing-scene'],
      });
      await expect(resolveComposition(options)).rejects.toThrow(
        /^composition resolution failed: unknown scene id\(s\): "missing-scene" \(entry \[1\]\) — not registered$/,
      );
    });

    it('aggregates every missing id (in entry order) in a single error', async () => {
      const { options } = buildHarness({
        scenes: [{ id: 'scene-a' }],
        manifest: ['missing-x', 'scene-a', { id: 'missing-y' }, 'missing-z'],
      });
      await expect(resolveComposition(options)).rejects.toThrow(
        /^composition resolution failed: unknown scene id\(s\): "missing-x" \(entry \[0\]\), "missing-y" \(entry \[2\]\), "missing-z" \(entry \[3\]\) — not registered$/,
      );
    });

    it('catches a missing id on an object entry the same as a bare-string entry', async () => {
      const { options } = buildHarness({
        scenes: [{ id: 'scene-a' }],
        manifest: [{ id: 'object-missing' }],
      });
      await expect(resolveComposition(options)).rejects.toThrow(
        /^composition resolution failed: unknown scene id\(s\): "object-missing" \(entry \[0\]\) — not registered$/,
      );
    });

    it('runs id pre-flight before any preload / create / timeline / cleanup', async () => {
      const { log, options } = buildHarness({
        scenes: [{ id: 'scene-a' }],
        manifest: ['scene-a', 'missing-scene'],
      });
      await expect(resolveComposition(options)).rejects.toThrow();
      expect(log).toEqual([]);
    });
  });

  describe('clause (b) — preload assets declared by each scene', () => {
    it('calls preloadAssets once per entry, with the scene module, in manifest order', async () => {
      const preloadCalls: SceneModule[] = [];
      const { options } = buildHarness({
        scenes: [
          { id: 'scene-a', assets: ['a1.png'] },
          { id: 'scene-b', assets: ['b1.png', 'b2.png'] },
        ],
        manifest: ['scene-a', 'scene-b'],
        preloadAssets: (scene) => {
          preloadCalls.push(scene);
        },
      });
      await resolveComposition(options);
      expect(preloadCalls.map((s) => ({ id: s.id, assets: s.assets }))).toEqual([
        { id: 'scene-a', assets: ['a1.png'] },
        { id: 'scene-b', assets: ['b1.png', 'b2.png'] },
      ]);
    });

    it("completes scene N's preload before calling scene N's create", async () => {
      const log: string[] = [];
      let resolvePreloadA: (() => void) | undefined;
      const preloadAGate = new Promise<void>((res) => {
        resolvePreloadA = res;
      });
      const { options } = buildHarness({
        scenes: [
          {
            id: 'scene-a',
            create: () => {
              log.push('create-a');
            },
          },
        ],
        manifest: ['scene-a'],
        preloadAssets: async (scene) => {
          log.push(`preload-${scene.id}-start`);
          if (scene.id === 'scene-a') {
            await preloadAGate;
          }
          log.push(`preload-${scene.id}-end`);
        },
      });
      const resolverPromise = resolveComposition(options);
      // Flush microtasks until the preloader adapter has started, so the
      // assertion does not depend on the number of internal await hops
      // between resolveComposition and the adapter.
      while (log.length === 0) {
        await Promise.resolve();
      }
      expect(log).toEqual(['preload-scene-a-start']);
      resolvePreloadA?.();
      await resolverPromise;
      expect(log).toEqual(['preload-scene-a-start', 'preload-scene-a-end', 'create-a']);
    });

    it('aborts when preloadAssets rejects: no create / timeline / cleanup; subsequent scenes not visited', async () => {
      const log: string[] = [];
      const { options } = buildHarness({
        scenes: [
          {
            id: 'scene-a',
            create: () => {
              log.push('create-a');
            },
            timeline: () => {
              log.push('timeline-a');
            },
            cleanup: () => {
              log.push('cleanup-a');
            },
          },
          {
            id: 'scene-b',
            create: () => {
              log.push('create-b');
            },
          },
        ],
        manifest: ['scene-a', 'scene-b'],
        preloadAssets: (scene) => {
          log.push(`preload-${scene.id}`);
          if (scene.id === 'scene-a') {
            throw new Error('asset 404');
          }
        },
      });
      await expect(resolveComposition(options)).rejects.toThrow(
        /^composition resolution failed: scene "scene-a" preloadAssets threw: asset 404$/,
      );
      expect(log).toEqual(['preload-scene-a']);
    });

    it('preserves the original preload error as Error.cause', async () => {
      const root = new Error('asset 404');
      const { options } = buildHarness({
        scenes: [{ id: 'scene-a' }],
        manifest: ['scene-a'],
        preloadAssets: () => {
          throw root;
        },
      });
      try {
        await resolveComposition(options);
        expect.unreachable('expected preload error to propagate');
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).cause).toBe(root);
      }
    });
  });

  describe('clause (c) — mount each scene via create(ctx)', () => {
    it('calls create with ctx, in manifest order, after that scene preload completes', async () => {
      const ctx = { id: 'shared-ctx' };
      const createCalls: { sceneId: string; ctx: unknown }[] = [];
      const { options } = buildHarness({
        scenes: [
          {
            id: 'scene-a',
            create: (c) => {
              createCalls.push({ sceneId: 'scene-a', ctx: c });
            },
          },
          {
            id: 'scene-b',
            create: (c) => {
              createCalls.push({ sceneId: 'scene-b', ctx: c });
            },
          },
        ],
        manifest: ['scene-a', 'scene-b'],
        ctx,
      });
      await resolveComposition(options);
      expect(createCalls).toEqual([
        { sceneId: 'scene-a', ctx },
        { sceneId: 'scene-b', ctx },
      ]);
    });

    it('still calls cleanup when create rejects (resources may have been partially acquired); subsequent scenes not visited; create error re-raised', async () => {
      const log: string[] = [];
      const { options } = buildHarness({
        scenes: [
          {
            id: 'scene-a',
            create: () => {
              log.push('create-a');
              throw new Error('mount failed');
            },
            timeline: () => {
              log.push('timeline-a');
            },
            cleanup: () => {
              log.push('cleanup-a');
            },
          },
          {
            id: 'scene-b',
            create: () => {
              log.push('create-b');
            },
          },
        ],
        manifest: ['scene-a', 'scene-b'],
      });
      await expect(resolveComposition(options)).rejects.toThrow(
        /^composition resolution failed: scene "scene-a" create threw: mount failed$/,
      );
      expect(log).toEqual(['create-a', 'cleanup-a']);
    });
  });

  describe('clause (d) — run its timeline', () => {
    it('passes scene.timeline(ctx) value through to runTimeline(scene, value)', async () => {
      const sentinel = { kind: 'timeline-handle', label: 'fake-gsap-timeline' };
      const runCalls: { sceneId: string; value: unknown }[] = [];
      const { options } = buildHarness({
        scenes: [
          {
            id: 'scene-a',
            timeline: () => sentinel,
          },
        ],
        manifest: ['scene-a'],
        runTimeline: ({ scene, timeline }) => {
          runCalls.push({ sceneId: scene.id, value: timeline });
        },
      });
      await resolveComposition(options);
      expect(runCalls).toEqual([{ sceneId: 'scene-a', value: sentinel }]);
    });

    it('awaits an async (Promise-returning) scene.timeline factory before handing the resolved value to runTimeline', async () => {
      const sentinel = { kind: 'resolved-timeline' };
      const runCalls: { sceneId: string; value: unknown }[] = [];
      const { options } = buildHarness({
        scenes: [
          {
            id: 'scene-a',
            timeline: async () => sentinel,
          },
        ],
        manifest: ['scene-a'],
        runTimeline: ({ scene, timeline }) => {
          runCalls.push({ sceneId: scene.id, value: timeline });
        },
      });
      await resolveComposition(options);
      // Runner must receive the resolved sentinel object, not a Promise.
      expect(runCalls).toHaveLength(1);
      const onlyCall = runCalls[0];
      expect(onlyCall).toBeDefined();
      expect(onlyCall?.sceneId).toBe('scene-a');
      expect(onlyCall?.value).toBe(sentinel);
      expect(onlyCall?.value instanceof Promise).toBe(false);
    });

    it('forwards range / behavior overrides from object entries to runTimeline', async () => {
      const runCalls: SceneTimelineRunInput[] = [];
      const { options } = buildHarness({
        scenes: [{ id: 'scene-a' }, { id: 'scene-b' }],
        manifest: ['scene-a', { id: 'scene-b', range: ['intro', 'outro'], behavior: { speed: 2 } }],
        runTimeline: (input) => {
          runCalls.push(input);
        },
      });
      await resolveComposition(options);
      expect(runCalls).toHaveLength(2);
      const aCall = runCalls[0];
      const bCall = runCalls[1];
      expect(aCall).toBeDefined();
      expect(aCall?.scene.id).toBe('scene-a');
      expect(aCall?.range).toBeUndefined();
      expect(aCall?.behavior).toBeUndefined();
      expect(bCall).toBeDefined();
      expect(bCall?.scene.id).toBe('scene-b');
      expect(bCall?.range).toEqual(['intro', 'outro']);
      expect(bCall?.behavior).toEqual({ speed: 2 });
    });

    it('awaits runTimeline before calling cleanup', async () => {
      const log: string[] = [];
      let resolveRun: (() => void) | undefined;
      const runGate = new Promise<void>((res) => {
        resolveRun = res;
      });
      const { options } = buildHarness({
        scenes: [
          {
            id: 'scene-a',
            cleanup: () => {
              log.push('cleanup-a');
            },
          },
        ],
        manifest: ['scene-a'],
        runTimeline: async ({ scene }) => {
          log.push(`runTimeline-${scene.id}-start`);
          await runGate;
          log.push(`runTimeline-${scene.id}-end`);
        },
      });
      const resolverPromise = resolveComposition(options);
      // Flush microtasks until runTimeline has started executing, so
      // the assertion does not depend on the number of internal await
      // hops between resolveComposition and the runner adapter.
      while (log.length === 0) {
        await Promise.resolve();
      }
      expect(log).toEqual(['runTimeline-scene-a-start']);
      resolveRun?.();
      await resolverPromise;
      expect(log).toEqual(['runTimeline-scene-a-start', 'runTimeline-scene-a-end', 'cleanup-a']);
    });

    it('still calls cleanup when runTimeline rejects; subsequent scenes not visited; timeline error re-raised', async () => {
      const log: string[] = [];
      const { options } = buildHarness({
        scenes: [
          {
            id: 'scene-a',
            cleanup: () => {
              log.push('cleanup-a');
            },
          },
          {
            id: 'scene-b',
            create: () => {
              log.push('create-b');
            },
          },
        ],
        manifest: ['scene-a', 'scene-b'],
        runTimeline: ({ scene }) => {
          if (scene.id === 'scene-a') {
            throw new Error('gsap exploded');
          }
        },
      });
      await expect(resolveComposition(options)).rejects.toThrow(
        /^composition resolution failed: scene "scene-a" timeline threw: gsap exploded$/,
      );
      expect(log).toEqual(['cleanup-a']);
    });

    it('still calls cleanup when scene.timeline(ctx) itself throws', async () => {
      const log: string[] = [];
      const { options } = buildHarness({
        scenes: [
          {
            id: 'scene-a',
            timeline: () => {
              throw new Error('timeline ctor failed');
            },
            cleanup: () => {
              log.push('cleanup-a');
            },
          },
        ],
        manifest: ['scene-a'],
      });
      await expect(resolveComposition(options)).rejects.toThrow(
        /^composition resolution failed: scene "scene-a" timeline threw: timeline ctor failed$/,
      );
      expect(log).toEqual(['cleanup-a']);
    });
  });

  describe('clause (e) — cleanup before next mount', () => {
    it('calls cleanup with ctx after a successful timeline', async () => {
      const ctx = { id: 'cleanup-ctx' };
      const cleanupArgs: unknown[] = [];
      const { options } = buildHarness({
        scenes: [
          {
            id: 'scene-a',
            cleanup: (c) => {
              cleanupArgs.push(c);
            },
          },
        ],
        manifest: ['scene-a'],
        ctx,
      });
      await resolveComposition(options);
      expect(cleanupArgs).toEqual([ctx]);
    });

    it('orders preload → create → timeline → runTimeline → cleanup before the next preload (3-scene happy path)', async () => {
      const { log, options } = buildHarness({
        scenes: [{ id: 'scene-a' }, { id: 'scene-b' }, { id: 'scene-c' }],
        manifest: ['scene-a', 'scene-b', 'scene-c'],
      });
      await resolveComposition(options);
      expect(log.map((c) => `${c.hook}:${c.sceneId}`)).toEqual([
        'preload:scene-a',
        'create:scene-a',
        'timeline:scene-a',
        'runTimeline:scene-a',
        'cleanup:scene-a',
        'preload:scene-b',
        'create:scene-b',
        'timeline:scene-b',
        'runTimeline:scene-b',
        'cleanup:scene-b',
        'preload:scene-c',
        'create:scene-c',
        'timeline:scene-c',
        'runTimeline:scene-c',
        'cleanup:scene-c',
      ]);
    });

    it('re-raises a cleanup-only failure (timeline succeeded)', async () => {
      const root = new Error('cleanup boom');
      const { options } = buildHarness({
        scenes: [
          {
            id: 'scene-a',
            cleanup: () => {
              throw root;
            },
          },
        ],
        manifest: ['scene-a'],
      });
      try {
        await resolveComposition(options);
        expect.unreachable('expected cleanup-only failure to propagate');
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(
          /^composition resolution failed: scene "scene-a" cleanup threw: cleanup boom$/,
        );
        expect((err as Error).cause).toBe(root);
      }
    });

    it('throws an AggregateError carrying both the timeline error and the cleanup error when both fail (no caller-error mutation)', async () => {
      const timelineErr = new Error('runner failed');
      const cleanupErr = new Error('and so did cleanup');
      const { options } = buildHarness({
        scenes: [
          {
            id: 'scene-a',
            cleanup: () => {
              throw cleanupErr;
            },
          },
        ],
        manifest: ['scene-a'],
        runTimeline: () => {
          throw timelineErr;
        },
      });
      try {
        await resolveComposition(options);
        expect.unreachable('expected combined failure to propagate');
      } catch (err) {
        expect(err).toBeInstanceOf(AggregateError);
        const top = err as AggregateError;
        expect(top.message).toMatch(
          /^composition resolution failed: scene "scene-a" timeline threw: runner failed \(cleanup also failed: and so did cleanup\)$/,
        );
        expect(top.errors).toEqual([timelineErr, cleanupErr]);
        // The resolver must NOT mutate the caller-supplied errors.
        expect((timelineErr as Error & { cause?: unknown }).cause).toBeUndefined();
        expect((cleanupErr as Error & { cause?: unknown }).cause).toBeUndefined();
      }
    });

    it('throws an AggregateError carrying both the create error and the cleanup error when both fail (no caller-error mutation)', async () => {
      const createErr = new Error('mount blew up');
      const cleanupErr = new Error('cleanup also blew up');
      const { options } = buildHarness({
        scenes: [
          {
            id: 'scene-a',
            create: () => {
              throw createErr;
            },
            cleanup: () => {
              throw cleanupErr;
            },
          },
        ],
        manifest: ['scene-a'],
      });
      try {
        await resolveComposition(options);
        expect.unreachable('expected combined failure to propagate');
      } catch (err) {
        expect(err).toBeInstanceOf(AggregateError);
        const top = err as AggregateError;
        expect(top.message).toMatch(
          /^composition resolution failed: scene "scene-a" create threw: mount blew up \(cleanup also failed: cleanup also blew up\)$/,
        );
        expect(top.errors).toEqual([createErr, cleanupErr]);
        expect((createErr as Error & { cause?: unknown }).cause).toBeUndefined();
        expect((cleanupErr as Error & { cause?: unknown }).cause).toBeUndefined();
      }
    });

    it('preserves a non-Error throw + cleanup failure together (no upcasting required)', async () => {
      const stringThrow = 'create blew up but threw a string, not an Error';
      const cleanupErr = new Error('cleanup error');
      const { options } = buildHarness({
        scenes: [
          {
            id: 'scene-a',
            create: () => {
              throw stringThrow;
            },
            cleanup: () => {
              throw cleanupErr;
            },
          },
        ],
        manifest: ['scene-a'],
      });
      try {
        await resolveComposition(options);
        expect.unreachable('expected combined failure to propagate');
      } catch (err) {
        expect(err).toBeInstanceOf(AggregateError);
        const top = err as AggregateError;
        // String throw appears in the message verbatim and is preserved
        // in errors[] alongside the cleanup error.
        expect(top.message).toMatch(
          /^composition resolution failed: scene "scene-a" create threw: create blew up but threw a string, not an Error \(cleanup also failed: cleanup error\)$/,
        );
        expect(top.errors).toEqual([stringThrow, cleanupErr]);
      }
    });
  });

  describe('lifecycle hook return-value handling', () => {
    it('handles synchronous (non-Promise) return values for create / timeline / cleanup the same as async ones', async () => {
      const log: string[] = [];
      const { options } = buildHarness({
        scenes: [
          {
            id: 'scene-a',
            create: () => {
              log.push('sync-create');
              return undefined;
            },
            timeline: () => {
              log.push('sync-timeline');
              return 42;
            },
            cleanup: () => {
              log.push('sync-cleanup');
              return undefined;
            },
          },
        ],
        manifest: ['scene-a'],
        runTimeline: ({ timeline }) => {
          log.push(`runTimeline-received-${String(timeline)}`);
        },
      });
      await resolveComposition(options);
      expect(log).toEqual([
        'sync-create',
        'sync-timeline',
        'runTimeline-received-42',
        'sync-cleanup',
      ]);
    });
  });

  describe('manifest snapshot (codex review: snapshot before lifecycle side effects)', () => {
    it('iterates a snapshot of the manifest — caller mutations during a lifecycle hook do not retarget later entries', async () => {
      const visited: string[] = [];
      // Mutable manifest the test will retarget mid-flight.
      const mutableManifest: { id: string }[] = [
        { id: 'scene-a' },
        { id: 'scene-b' },
        { id: 'scene-c' },
      ];
      const { options } = buildHarness({
        scenes: [
          {
            id: 'scene-a',
            create: () => {
              visited.push('scene-a');
              // Mutate the caller-owned manifest after the resolver has
              // already started iterating it. If the resolver re-read
              // the manifest for steps 1 and 2 we'd see "unknown scene
              // id" failures here. The snapshot path makes this a
              // no-op for the resolver.
              mutableManifest[1] = { id: 'unregistered-substitute' };
              mutableManifest[2] = { id: 'also-unregistered' };
            },
          },
          {
            id: 'scene-b',
            create: () => {
              visited.push('scene-b');
            },
          },
          {
            id: 'scene-c',
            create: () => {
              visited.push('scene-c');
            },
          },
        ],
        manifest: mutableManifest as unknown as CompositionManifest,
      });
      await expect(resolveComposition(options)).resolves.toBeUndefined();
      expect(visited).toEqual(['scene-a', 'scene-b', 'scene-c']);
    });
  });

  describe('non-Error throw paths (codex review: do not use undefined as failure sentinel)', () => {
    // `throw undefined` and `Promise.reject(undefined)` are both legal
    // JS. The resolver must still treat them as failures. These tests
    // pin that: dropping the boolean failure flags in favor of
    // `phaseError !== undefined` would silently swallow these cases.
    it('treats `throw undefined` from create as a failure (no scene-completed pretense)', async () => {
      const cleanupCalls: number[] = [];
      const { options } = buildHarness({
        scenes: [
          {
            id: 'scene-a',
            create: () => {
              throw undefined;
            },
            cleanup: () => {
              cleanupCalls.push(1);
            },
          },
        ],
        manifest: ['scene-a'],
      });
      await expect(resolveComposition(options)).rejects.toThrow(
        /^composition resolution failed: scene "scene-a" create threw: undefined$/,
      );
      // Cleanup must still run because create was attempted.
      expect(cleanupCalls).toEqual([1]);
    });

    it('treats `Promise.reject(undefined)` from runTimeline as a failure', async () => {
      const cleanupCalls: number[] = [];
      const { options } = buildHarness({
        scenes: [
          {
            id: 'scene-a',
            cleanup: () => {
              cleanupCalls.push(1);
            },
          },
        ],
        manifest: ['scene-a'],
        runTimeline: () => Promise.reject(undefined),
      });
      await expect(resolveComposition(options)).rejects.toThrow(
        /^composition resolution failed: scene "scene-a" timeline threw: undefined$/,
      );
      expect(cleanupCalls).toEqual([1]);
    });

    it('treats `throw undefined` from cleanup as a failure', async () => {
      const { options } = buildHarness({
        scenes: [
          {
            id: 'scene-a',
            cleanup: () => {
              throw undefined;
            },
          },
        ],
        manifest: ['scene-a'],
      });
      await expect(resolveComposition(options)).rejects.toThrow(
        /^composition resolution failed: scene "scene-a" cleanup threw: undefined$/,
      );
    });

    it('treats `throw undefined` from preloadAssets as a failure (no create / cleanup)', async () => {
      const log: string[] = [];
      const { options } = buildHarness({
        scenes: [
          {
            id: 'scene-a',
            create: () => {
              log.push('create');
            },
            cleanup: () => {
              log.push('cleanup');
            },
          },
        ],
        manifest: ['scene-a'],
        preloadAssets: () => {
          throw undefined;
        },
      });
      await expect(resolveComposition(options)).rejects.toThrow(
        /^composition resolution failed: scene "scene-a" preloadAssets threw: undefined$/,
      );
      expect(log).toEqual([]);
    });
  });

  describe('manifest entry shapes', () => {
    it('accepts object entries with range / behavior overrides without reading either field', async () => {
      const log: string[] = [];
      const { options } = buildHarness({
        scenes: [
          {
            id: 'scene-a',
            create: () => {
              log.push('create-a');
            },
            cleanup: () => {
              log.push('cleanup-a');
            },
          },
        ],
        manifest: [
          {
            id: 'scene-a',
            range: ['intro', 'outro'],
            behavior: { speed: 2, loop: true },
          },
        ],
      });
      await resolveComposition(options);
      // The resolver must not interpret range/behavior in PUL-F004 — it
      // just runs the scene's normal lifecycle. Lifecycle hooks fire
      // exactly once (no special handling triggered by the override
      // fields).
      expect(log).toEqual(['create-a', 'cleanup-a']);
    });

    it('runs repeated scene ids as repeated lifecycle entries (no dedup) — codex preflight invariant', async () => {
      const calls: string[] = [];
      const { options } = buildHarness({
        scenes: [
          {
            id: 'scene-a',
            create: () => {
              calls.push('create-a');
            },
            cleanup: () => {
              calls.push('cleanup-a');
            },
          },
        ],
        manifest: ['scene-a', 'scene-a', 'scene-a'],
      });
      await resolveComposition(options);
      expect(calls).toEqual([
        'create-a',
        'cleanup-a',
        'create-a',
        'cleanup-a',
        'create-a',
        'cleanup-a',
      ]);
    });

    it('drives the ADR-002 trailer fixture (object entries with range overrides) end-to-end in order', async () => {
      const { log, options } = buildHarness({
        scenes: [{ id: 'scene-a' }, { id: 'scene-c' }],
        // Literal copy of ADR-002 §Composition manifests `trailer`
        // example. Both entries are object form; bare-string mixing is
        // exercised separately below to keep this assertion honest
        // about which fixture path it pins.
        manifest: [
          { id: 'scene-a', range: ['intro', 'hook'] },
          { id: 'scene-c', range: 'payoff' },
        ],
      });
      await resolveComposition(options);
      expect(log.map((c) => `${c.hook}:${c.sceneId}`)).toEqual([
        'preload:scene-a',
        'create:scene-a',
        'timeline:scene-a',
        'runTimeline:scene-a',
        'cleanup:scene-a',
        'preload:scene-c',
        'create:scene-c',
        'timeline:scene-c',
        'runTimeline:scene-c',
        'cleanup:scene-c',
      ]);
    });

    it('drives a manifest mixing bare-string and object entries end-to-end in declared order', async () => {
      const { log, options } = buildHarness({
        scenes: [{ id: 'scene-a' }, { id: 'scene-b' }, { id: 'scene-c' }],
        manifest: [
          'scene-a',
          { id: 'scene-b', range: 'beat-1', behavior: { mode: 'demo' } },
          'scene-c',
        ],
      });
      await resolveComposition(options);
      expect(log.map((c) => `${c.hook}:${c.sceneId}`)).toEqual([
        'preload:scene-a',
        'create:scene-a',
        'timeline:scene-a',
        'runTimeline:scene-a',
        'cleanup:scene-a',
        'preload:scene-b',
        'create:scene-b',
        'timeline:scene-b',
        'runTimeline:scene-b',
        'cleanup:scene-b',
        'preload:scene-c',
        'create:scene-c',
        'timeline:scene-c',
        'runTimeline:scene-c',
        'cleanup:scene-c',
      ]);
    });
  });
});

describe('per-scene cleanup invocation (PUL-F006)', () => {
  // PUL-F006: "The runtime SHALL invoke `cleanup(ctx)` on every scene
  // exit, including normal advance, presenter skip, runtime error
  // within the scene, and composition end."
  //
  // The composition resolver shipped under PUL-F004 already centralizes
  // cleanup invocation in `runScene` (unconditional second try/catch
  // around `scene.cleanup(ctx)`). These tests anchor the four named
  // exit paths to PUL-F006 so the invariant cannot regress quietly,
  // and pin the codex-preflight "exactly once per scene activation"
  // axis that the PUL-F004 tests only assert by ordering.
  //
  // ADR-011 explicitly defers AbortSignal-based cancellation to the
  // wave-1 re-evaluation around PUL-F020 (presenter controls). PUL-F006
  // does not implement a presenter-skip mechanism; it ensures the
  // cleanup invariant the wave-1 mechanism will rely on. Presenter
  // skip is therefore modeled here as a cooperative early return from
  // the injected runner adapter — the same shape PUL-F020 will use
  // when it lands.

  const cleanupCount = (entries: readonly CallRecord[], sceneId: string): number =>
    entries.filter((c) => c.hook === 'cleanup' && c.sceneId === sceneId).length;

  it('normal advance: cleanup runs exactly once per scene as the resolver advances through a multi-scene composition, strictly before the next scene preload', async () => {
    const { log, options } = buildHarness({
      scenes: [{ id: 'scene-a' }, { id: 'scene-b' }, { id: 'scene-c' }],
      manifest: ['scene-a', 'scene-b', 'scene-c'],
    });
    await resolveComposition(options);
    expect(cleanupCount(log, 'scene-a')).toBe(1);
    expect(cleanupCount(log, 'scene-b')).toBe(1);
    expect(cleanupCount(log, 'scene-c')).toBe(1);
    expect(log.map((c) => `${c.hook}:${c.sceneId}`)).toEqual([
      'preload:scene-a',
      'create:scene-a',
      'timeline:scene-a',
      'runTimeline:scene-a',
      'cleanup:scene-a',
      'preload:scene-b',
      'create:scene-b',
      'timeline:scene-b',
      'runTimeline:scene-b',
      'cleanup:scene-b',
      'preload:scene-c',
      'create:scene-c',
      'timeline:scene-c',
      'runTimeline:scene-c',
      'cleanup:scene-c',
    ]);
  });

  it('presenter skip mid-scene via AbortSignal: runner throws via signal.throwIfAborted, cleanup still runs exactly once for the active scene, subsequent scenes are not visited', async () => {
    // PUL-F006 presenter-skip exit path with a real cancellation
    // contract. The caller supplies an AbortSignal; the runner observes
    // it via SceneTimelineRunInput.signal and bails. The resolver's
    // cleanup-always invariant (runScene's unconditional second
    // try/catch) still fires for the active scene, then the abort
    // propagates and subsequent scenes are not visited.
    const controller = new AbortController();
    let runnerSawSignal = false;
    const { log, options } = buildHarness({
      scenes: [{ id: 'scene-a' }, { id: 'scene-b' }],
      manifest: ['scene-a', 'scene-b'],
      runTimeline: ({ signal }) => {
        runnerSawSignal = signal !== undefined;
        // Simulate a presenter skip cue mid-runner.
        controller.abort(new Error('skip cue'));
        // Honor the signal cooperatively.
        signal?.throwIfAborted();
        // unreachable past throwIfAborted
      },
    });
    await expect(resolveComposition({ ...options, signal: controller.signal })).rejects.toThrow();
    expect(runnerSawSignal).toBe(true);
    // Active scene's cleanup ran exactly once — the cleanup-always
    // invariant holds even when the runner aborts.
    expect(cleanupCount(log, 'scene-a')).toBe(1);
    // Scene B was never visited (no preload, no create, no cleanup).
    expect(log.filter((c) => c.sceneId === 'scene-b')).toEqual([]);
  });

  it('presenter skip between scenes via AbortSignal: signal aborted after scene-a completes, scene-b is not preloaded or mounted', async () => {
    // PUL-F006 inter-scene skip path. Scene A runs to completion
    // (including cleanup); the signal is aborted just after. The
    // resolver re-checks the signal between scenes and refuses to
    // visit scene B. The error message names the previously-completed
    // scene so callers can correlate.
    const controller = new AbortController();
    const { log, options } = buildHarness({
      scenes: [{ id: 'scene-a' }, { id: 'scene-b' }],
      manifest: ['scene-a', 'scene-b'],
      runTimeline: ({ scene }) => {
        if (scene.id === 'scene-a') {
          log.push({ hook: 'runTimeline', sceneId: scene.id });
          // Abort fires DURING scene-a's runner, but the resolver
          // does not check the signal again until scene-a's cleanup
          // has completed and the loop is about to preload scene-b.
          controller.abort(new Error('end of scene a, skip rest'));
          return;
        }
      },
    });
    await expect(resolveComposition({ ...options, signal: controller.signal })).rejects.toThrow(
      /^composition resolution failed: aborted between scenes after "scene-a"$/,
    );
    // Scene A had its full lifecycle including cleanup.
    expect(cleanupCount(log, 'scene-a')).toBe(1);
    expect(log.filter((c) => c.sceneId === 'scene-a').map((c) => c.hook)).toEqual([
      'preload',
      'create',
      'timeline',
      'runTimeline',
      'cleanup',
    ]);
    // Scene B was never visited.
    expect(log.filter((c) => c.sceneId === 'scene-b')).toEqual([]);
  });

  it('presenter skip during async preload: signal abort observed after preload completes prevents scene activation; preloaded scene is not created, cleanup is not invoked', async () => {
    // PUL-F006 post-preload signal check (codex review hardening).
    // Async preload can take arbitrary wall-clock time during which
    // the caller may abort. Without the post-preload check, the
    // resolver would still mount and run the scene even though
    // cancellation was requested mid-preload. This test pins that
    // the resolver re-checks the signal between preload completion
    // and scene activation.
    const controller = new AbortController();
    const { log, options } = buildHarness({
      scenes: [{ id: 'scene-a' }],
      manifest: ['scene-a'],
      preloadAssets: async (scene) => {
        log.push({ hook: 'preload', sceneId: scene.id });
        // Simulate an async preload that completes after the signal
        // has been aborted by some external presenter event.
        controller.abort(new Error('skip during preload'));
        await Promise.resolve();
      },
    });
    await expect(resolveComposition({ ...options, signal: controller.signal })).rejects.toThrow(
      /^composition resolution failed: aborted after preloading "scene-a", before scene activation$/,
    );
    // Preload happened (the preloader ran to completion before the
    // resolver re-checked the signal), but the scene was never
    // activated — no create, no timeline, no cleanup.
    expect(log.map((c) => c.hook)).toEqual(['preload']);
  });

  it('presenter skip pre-start (signal already aborted on entry): no scene is mounted, no cleanup is invoked, resolver throws immediately', async () => {
    // Edge of the PUL-F006 skip contract: the caller may abort the
    // signal before resolveComposition is ever called. The resolver
    // must not start any scene — there is nothing to clean up because
    // nothing was activated.
    const controller = new AbortController();
    controller.abort(new Error('aborted before invocation'));
    const { log, options } = buildHarness({
      scenes: [{ id: 'scene-a' }],
      manifest: ['scene-a'],
    });
    await expect(resolveComposition({ ...options, signal: controller.signal })).rejects.toThrow(
      /^composition resolution failed: aborted before any scene was visited$/,
    );
    // Nothing was touched — no preload, no create, no cleanup.
    expect(log).toEqual([]);
  });

  it("composition end: the final scene's cleanup is the terminal lifecycle call (no preload, create, timeline, or cleanup after it)", async () => {
    const { log, options } = buildHarness({
      scenes: [{ id: 'scene-a' }, { id: 'scene-b' }],
      manifest: ['scene-a', 'scene-b'],
    });
    await resolveComposition(options);
    const lastCall = log[log.length - 1];
    expect(lastCall).toBeDefined();
    expect(lastCall?.hook).toBe('cleanup');
    expect(lastCall?.sceneId).toBe('scene-b');
    expect(cleanupCount(log, 'scene-a')).toBe(1);
    expect(cleanupCount(log, 'scene-b')).toBe(1);
  });

  it('runtime error during create: cleanup of the failing scene fires exactly once, subsequent scenes are not visited', async () => {
    const { log, options } = buildHarness({
      scenes: [
        {
          id: 'scene-a',
          create: () => {
            throw new Error('create boom');
          },
        },
        { id: 'scene-b' },
      ],
      manifest: ['scene-a', 'scene-b'],
    });
    await expect(resolveComposition(options)).rejects.toThrow();
    expect(cleanupCount(log, 'scene-a')).toBe(1);
    expect(log.filter((c) => c.sceneId === 'scene-b')).toEqual([]);
  });

  it('runtime error during timeline factory: cleanup of the failing scene fires exactly once', async () => {
    const { log, options } = buildHarness({
      scenes: [
        {
          id: 'scene-a',
          timeline: () => {
            throw new Error('timeline boom');
          },
        },
      ],
      manifest: ['scene-a'],
    });
    await expect(resolveComposition(options)).rejects.toThrow();
    expect(cleanupCount(log, 'scene-a')).toBe(1);
  });

  it('runtime error during runner: cleanup of the failing scene fires exactly once', async () => {
    const { log, options } = buildHarness({
      scenes: [{ id: 'scene-a' }],
      manifest: ['scene-a'],
      runTimeline: () => {
        throw new Error('runner boom');
      },
    });
    await expect(resolveComposition(options)).rejects.toThrow();
    expect(cleanupCount(log, 'scene-a')).toBe(1);
  });

  it('exactly once per occurrence: a manifest with the same scene id repeated yields one cleanup per occurrence (no dedup, no double-fire)', async () => {
    const { log, options } = buildHarness({
      scenes: [{ id: 'scene-a' }],
      manifest: ['scene-a', 'scene-a', 'scene-a'],
    });
    await resolveComposition(options);
    expect(cleanupCount(log, 'scene-a')).toBe(3);
    expect(log.map((c) => `${c.hook}:${c.sceneId}`)).toEqual([
      'preload:scene-a',
      'create:scene-a',
      'timeline:scene-a',
      'runTimeline:scene-a',
      'cleanup:scene-a',
      'preload:scene-a',
      'create:scene-a',
      'timeline:scene-a',
      'runTimeline:scene-a',
      'cleanup:scene-a',
      'preload:scene-a',
      'create:scene-a',
      'timeline:scene-a',
      'runTimeline:scene-a',
      'cleanup:scene-a',
    ]);
  });
});

describe('URL beat positioning forwarding (PUL-F011)', () => {
  // PUL-F011: when `beat=<label>` is present, the runtime SHALL position
  // the active scene's timeline at the named label; if the label does
  // not exist, surface an error and remain at the scene's first beat.
  // ADR-015 places label existence and seeking in the timeline-runner
  // boundary. The resolver's job is forwarding URL beat state to the
  // head scene's run input only; subsequent scenes in a composition
  // slice do not receive `beat` (per ADR-015, `beat` targets the
  // active head scene only).

  it("forwards `headBeat` to plan[0]'s run input only — subsequent scenes get no beat", async () => {
    const runCalls: SceneTimelineRunInput[] = [];
    const { options } = buildHarness({
      scenes: [{ id: 'scene-a' }, { id: 'scene-b' }],
      manifest: ['scene-a', 'scene-b'],
      runTimeline: (input) => {
        runCalls.push(input);
      },
    });
    await resolveComposition({ ...options, headBeat: 'hook', onBeatMissing: () => undefined });
    expect(runCalls).toHaveLength(2);
    expect(runCalls[0]?.scene.id).toBe('scene-a');
    expect(runCalls[0]?.beat).toBe('hook');
    expect(runCalls[1]?.scene.id).toBe('scene-b');
    expect(runCalls[1]?.beat).toBeUndefined();
    // The `'beat' in input` check parallels how `range` / `behavior`
    // are omitted when absent — the runner's branching can rely on key
    // presence rather than checking for `undefined` separately.
    expect('beat' in (runCalls[1] as object)).toBe(false);
  });

  it("forwards `onBeatMissing` to plan[0]'s run input only — subsequent scenes get no callback", async () => {
    const callbacks: (SceneTimelineRunInput['onBeatMissing'] | undefined)[] = [];
    const sentinel = (): void => undefined;
    const { options } = buildHarness({
      scenes: [{ id: 'scene-a' }, { id: 'scene-b' }],
      manifest: ['scene-a', 'scene-b'],
      runTimeline: (input) => {
        callbacks.push(input.onBeatMissing);
      },
    });
    await resolveComposition({ ...options, headBeat: 'hook', onBeatMissing: sentinel });
    expect(callbacks[0]).toBe(sentinel);
    expect(callbacks[1]).toBeUndefined();
  });

  it('does not attach `beat` or `onBeatMissing` keys when neither option is supplied', async () => {
    const runCalls: SceneTimelineRunInput[] = [];
    const { options } = buildHarness({
      scenes: [{ id: 'scene-a' }],
      manifest: ['scene-a'],
      runTimeline: (input) => {
        runCalls.push(input);
      },
    });
    await resolveComposition(options);
    expect(runCalls).toHaveLength(1);
    expect('beat' in (runCalls[0] as object)).toBe(false);
    expect('onBeatMissing' in (runCalls[0] as object)).toBe(false);
  });

  it('does not attach `onBeatMissing` when `headBeat` is absent (paired contract)', async () => {
    // The callback is meaningless without a beat to trigger it. If a
    // caller passes `onBeatMissing` alone, the resolver drops it so
    // the runner never sees `input.onBeatMissing` with no
    // `input.beat` (an impossible state per the documented contract).
    const runCalls: SceneTimelineRunInput[] = [];
    const { options } = buildHarness({
      scenes: [{ id: 'scene-a' }],
      manifest: ['scene-a'],
      runTimeline: (input) => {
        runCalls.push(input);
      },
    });
    await resolveComposition({ ...options, onBeatMissing: () => undefined });
    expect(runCalls).toHaveLength(1);
    expect('beat' in (runCalls[0] as object)).toBe(false);
    expect('onBeatMissing' in (runCalls[0] as object)).toBe(false);
  });

  it('throws when `headBeat` is supplied without `onBeatMissing` (paired-required contract)', async () => {
    // PUL-F011 / ADR-015: a `headBeat` without an `onBeatMissing`
    // would silently lose the missing-label diagnostic the runner
    // is contracted to surface. The resolver fails fast at the
    // boundary rather than running a doomed lifecycle that reports
    // nothing.
    const { options } = buildHarness({
      scenes: [{ id: 'scene-a' }],
      manifest: ['scene-a'],
    });
    await expect(resolveComposition({ ...options, headBeat: 'hook' })).rejects.toThrow(
      /^composition resolution failed: "onBeatMissing" is required when "headBeat" is supplied/,
    );
  });

  it('does not interpret `headBeat` itself — a runner that silently consumes it does not error', async () => {
    // Resolver delegates label-existence checking to the runner per
    // ADR-015. A runner that receives `beat: 'unknown-label'` and
    // returns void normally must NOT cause the resolver to throw or
    // skip cleanup.
    const cleanupCalls: string[] = [];
    const { options } = buildHarness({
      scenes: [
        {
          id: 'scene-a',
          cleanup: () => {
            cleanupCalls.push('scene-a');
          },
        },
      ],
      manifest: ['scene-a'],
      runTimeline: () => undefined,
    });
    await expect(
      resolveComposition({
        ...options,
        headBeat: 'never-defined',
        onBeatMissing: () => undefined,
      }),
    ).resolves.toBeUndefined();
    expect(cleanupCalls).toEqual(['scene-a']);
  });
});

describe('URL loop-mode runner repeat-hint forwarding (PUL-F015)', () => {
  // PUL-F015: in `mode=loop`, the runtime SHALL run the addressed
  // scene's timeline and restart it on completion. ADR-018 places
  // mode dispatch at the loader and the repeat semantics at the
  // timeline-runner adapter. The resolver's job is forwarding the
  // URL-derived `headRepeat` hint to the head scene's run input only;
  // subsequent scenes in a composition slice do not receive `repeat`
  // because the head's looping timeline never naturally completes —
  // following entries cannot run. The resolver does NOT interpret
  // `headRepeat` itself; honoring "restart on completion" is the
  // runner's contract.

  it("forwards `headRepeat` to plan[0]'s run input only — subsequent scenes get no repeat", async () => {
    const runCalls: SceneTimelineRunInput[] = [];
    const { options } = buildHarness({
      scenes: [{ id: 'scene-a' }, { id: 'scene-b' }],
      manifest: ['scene-a', 'scene-b'],
      runTimeline: (input) => {
        runCalls.push(input);
      },
    });
    await resolveComposition({ ...options, headRepeat: 'until-aborted' });
    expect(runCalls).toHaveLength(2);
    expect(runCalls[0]?.scene.id).toBe('scene-a');
    expect(runCalls[0]?.repeat).toBe('until-aborted');
    expect(runCalls[1]?.scene.id).toBe('scene-b');
    expect(runCalls[1]?.repeat).toBeUndefined();
    // Parallel to `beat` / `range` / `behavior`: the key is OMITTED
    // from the input object when absent, not set to `undefined`. The
    // runner can branch on `'repeat' in input` rather than checking
    // for `undefined`.
    expect('repeat' in (runCalls[1] as object)).toBe(false);
  });

  it('does not attach `repeat` when `headRepeat` is absent', async () => {
    const runCalls: SceneTimelineRunInput[] = [];
    const { options } = buildHarness({
      scenes: [{ id: 'scene-a' }],
      manifest: ['scene-a'],
      runTimeline: (input) => {
        runCalls.push(input);
      },
    });
    await resolveComposition(options);
    expect(runCalls).toHaveLength(1);
    expect('repeat' in (runCalls[0] as object)).toBe(false);
  });

  it('does not interpret `headRepeat` itself — a runner that ignores the hint and returns normally does not error', async () => {
    // Resolver delegates restart-on-completion to the runner per
    // ADR-018. A runner that receives `repeat: 'until-aborted'` and
    // returns void normally (e.g. the placeholder runner that has no
    // real timeline to repeat) must NOT cause the resolver to throw
    // or skip cleanup.
    const cleanupCalls: string[] = [];
    const { options } = buildHarness({
      scenes: [
        {
          id: 'scene-a',
          cleanup: () => {
            cleanupCalls.push('scene-a');
          },
        },
      ],
      manifest: ['scene-a'],
      runTimeline: () => undefined,
    });
    await expect(
      resolveComposition({
        ...options,
        headRepeat: 'until-aborted',
      }),
    ).resolves.toBeUndefined();
    expect(cleanupCalls).toEqual(['scene-a']);
  });

  it('forwards `headRepeat` alongside `headBeat` independently — both reach plan[0] without coupling', async () => {
    // `headRepeat` and `headBeat` are two independent head-only
    // forwardings (PUL-F011 and PUL-F015). A regression that paired
    // them — e.g. requiring `headBeat` whenever `headRepeat` is set,
    // or vice versa — would break URLs like `?scene=x&beat=hook&mode=loop`.
    const runCalls: SceneTimelineRunInput[] = [];
    const { options } = buildHarness({
      scenes: [{ id: 'scene-a' }],
      manifest: ['scene-a'],
      runTimeline: (input) => {
        runCalls.push(input);
      },
    });
    await resolveComposition({
      ...options,
      headBeat: 'hook',
      onBeatMissing: () => undefined,
      headRepeat: 'until-aborted',
    });
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]?.beat).toBe('hook');
    expect(runCalls[0]?.repeat).toBe('until-aborted');
  });
});

describe('URL paused-mode runner hold-hint forwarding (PUL-F016)', () => {
  // PUL-F016: in `mode=paused`, the runtime SHALL mount the addressed
  // scene and hold it at its first frame without advancing the
  // timeline. ADR-019 places mode dispatch at the loader and the
  // hold-at-first-frame semantics at the timeline-runner adapter. The
  // resolver's job is forwarding the URL-derived `headHold` hint to
  // the head scene's run input only; subsequent scenes in a
  // composition slice do not receive `hold` because the head's
  // timeline never advances under paused — following entries cannot
  // run. The resolver does NOT interpret `headHold` itself; honoring
  // hold-at-first-frame is the runner's contract.

  it("forwards `headHold` to plan[0]'s run input only — subsequent scenes get no hold", async () => {
    const runCalls: SceneTimelineRunInput[] = [];
    const { options } = buildHarness({
      scenes: [{ id: 'scene-a' }, { id: 'scene-b' }],
      manifest: ['scene-a', 'scene-b'],
      runTimeline: (input) => {
        runCalls.push(input);
      },
    });
    await resolveComposition({ ...options, headHold: 'first-frame' });
    expect(runCalls).toHaveLength(2);
    expect(runCalls[0]?.scene.id).toBe('scene-a');
    expect(runCalls[0]?.hold).toBe('first-frame');
    expect(runCalls[1]?.scene.id).toBe('scene-b');
    expect(runCalls[1]?.hold).toBeUndefined();
    // Parallel to `beat` / `repeat` / `range` / `behavior`: the key is
    // OMITTED from the input object when absent, not set to
    // `undefined`. The runner can branch on `'hold' in input` rather
    // than checking for `undefined`.
    expect('hold' in (runCalls[1] as object)).toBe(false);
  });

  it('does not attach `hold` when `headHold` is absent', async () => {
    const runCalls: SceneTimelineRunInput[] = [];
    const { options } = buildHarness({
      scenes: [{ id: 'scene-a' }],
      manifest: ['scene-a'],
      runTimeline: (input) => {
        runCalls.push(input);
      },
    });
    await resolveComposition(options);
    expect(runCalls).toHaveLength(1);
    expect('hold' in (runCalls[0] as object)).toBe(false);
  });

  it('does not interpret `headHold` itself — a runner that ignores the hint and returns normally does not error', async () => {
    // Resolver delegates hold-at-first-frame to the runner per
    // ADR-019. A runner that receives `hold: 'first-frame'` and
    // returns void normally (e.g. the placeholder runner that has no
    // real timeline to pause) must NOT cause the resolver to throw or
    // skip cleanup.
    const cleanupCalls: string[] = [];
    const { options } = buildHarness({
      scenes: [
        {
          id: 'scene-a',
          cleanup: () => {
            cleanupCalls.push('scene-a');
          },
        },
      ],
      manifest: ['scene-a'],
      runTimeline: () => undefined,
    });
    await expect(
      resolveComposition({
        ...options,
        headHold: 'first-frame',
      }),
    ).resolves.toBeUndefined();
    expect(cleanupCalls).toEqual(['scene-a']);
  });

  it('forwards `headHold` alongside `headBeat` and `headRepeat` independently — all three reach plan[0] without coupling', async () => {
    // `headHold`, `headBeat`, and `headRepeat` are three independent
    // head-only forwardings (PUL-F016, PUL-F011, PUL-F015). A
    // regression that paired them — e.g. requiring `headBeat` or
    // `headRepeat` whenever `headHold` is set — would break URLs like
    // `?scene=x&beat=hook&mode=paused` and
    // `?scene=x&mode=paused` (paused alone, no beat).
    const runCalls: SceneTimelineRunInput[] = [];
    const { options } = buildHarness({
      scenes: [{ id: 'scene-a' }],
      manifest: ['scene-a'],
      runTimeline: (input) => {
        runCalls.push(input);
      },
    });
    await resolveComposition({
      ...options,
      headBeat: 'hook',
      onBeatMissing: () => undefined,
      headHold: 'first-frame',
    });
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]?.beat).toBe('hook');
    expect(runCalls[0]?.hold).toBe('first-frame');
    expect(runCalls[0]?.repeat).toBeUndefined();
  });
});

describe('URL scrub-mode runner cue-gate-hint forwarding (PUL-F017)', () => {
  // PUL-F017: in `mode=scrub`, the runtime SHALL display timeline
  // controls allowing the user to scrub forward, backward, and to
  // named beats; audio cues SHALL fire only on monotonic forward
  // playback. ADR-020 places mode dispatch at the loader and the
  // cue-gate semantics at the timeline-runner adapter. The resolver's
  // job is forwarding the URL-derived `headCueGate` hint to the head
  // scene's run input only; subsequent scenes in a composition slice
  // do not receive `cueGate` because under scrub the slice is
  // truncated upstream and the head's interactive timeline never
  // hands off to following entries. The resolver does NOT interpret
  // `headCueGate` itself; honoring "audio cues fire only on monotonic
  // forward playback" is the runner's contract.

  it("forwards `headCueGate` to plan[0]'s run input only — subsequent scenes get no cueGate", async () => {
    const runCalls: SceneTimelineRunInput[] = [];
    const { options } = buildHarness({
      scenes: [{ id: 'scene-a' }, { id: 'scene-b' }],
      manifest: ['scene-a', 'scene-b'],
      runTimeline: (input) => {
        runCalls.push(input);
      },
    });
    await resolveComposition({ ...options, headCueGate: 'monotonic-forward' });
    expect(runCalls).toHaveLength(2);
    expect(runCalls[0]?.scene.id).toBe('scene-a');
    expect(runCalls[0]?.cueGate).toBe('monotonic-forward');
    expect(runCalls[1]?.scene.id).toBe('scene-b');
    expect(runCalls[1]?.cueGate).toBeUndefined();
    // Parallel to `beat` / `repeat` / `hold` / `range` / `behavior`:
    // the key is OMITTED from the input object when absent, not set
    // to `undefined`. The runner can branch on `'cueGate' in input`
    // rather than checking for `undefined`.
    expect('cueGate' in (runCalls[1] as object)).toBe(false);
  });

  it('does not attach `cueGate` when `headCueGate` is absent', async () => {
    const runCalls: SceneTimelineRunInput[] = [];
    const { options } = buildHarness({
      scenes: [{ id: 'scene-a' }],
      manifest: ['scene-a'],
      runTimeline: (input) => {
        runCalls.push(input);
      },
    });
    await resolveComposition(options);
    expect(runCalls).toHaveLength(1);
    expect('cueGate' in (runCalls[0] as object)).toBe(false);
  });

  it('does not interpret `headCueGate` itself — a runner that ignores the hint and returns normally does not error', async () => {
    // Resolver delegates monotonic-forward cue gating to the runner
    // per ADR-020. A runner that receives `cueGate: 'monotonic-forward'`
    // and returns void normally (e.g. the placeholder runner that has
    // no real timeline and no real audio engine to gate cues against)
    // must NOT cause the resolver to throw or skip cleanup.
    const cleanupCalls: string[] = [];
    const { options } = buildHarness({
      scenes: [
        {
          id: 'scene-a',
          cleanup: () => {
            cleanupCalls.push('scene-a');
          },
        },
      ],
      manifest: ['scene-a'],
      runTimeline: () => undefined,
    });
    await expect(
      resolveComposition({
        ...options,
        headCueGate: 'monotonic-forward',
      }),
    ).resolves.toBeUndefined();
    expect(cleanupCalls).toEqual(['scene-a']);
  });

  it('forwards `headCueGate` alongside `headBeat`, `headRepeat`, and `headHold` independently — all four reach plan[0] without coupling', async () => {
    // `headCueGate`, `headBeat`, `headRepeat`, and `headHold` are
    // four independent head-only forwardings. A regression that
    // paired them — e.g. requiring `headBeat` whenever `headCueGate`
    // is set, or dropping `headCueGate` when `headHold` is also
    // supplied — would break valid combinations a programmatic
    // bridge caller (test harness, future export pipeline) can
    // legitimately request. The URL grammar makes the parent modes
    // (`mode=loop`, `mode=paused`, `mode=scrub`) mutually exclusive
    // (mode is a single field), so production callers won't supply
    // more than one of `headRepeat` / `headHold` / `headCueGate`
    // at once; the test exercises a programmatic caller scenario to
    // pin that the resolver does not invent coupling between the
    // four head-only fields. All four must reach plan[0] when all
    // four are supplied — this is also the regression test for
    // URLs like `?scene=x&beat=hook&mode=scrub` (scrub + named
    // beat — exactly what PUL-F017's "to named beats" clause
    // anticipates) which only sets `headBeat` + `headCueGate`.
    const runCalls: SceneTimelineRunInput[] = [];
    const { options } = buildHarness({
      scenes: [{ id: 'scene-a' }],
      manifest: ['scene-a'],
      runTimeline: (input) => {
        runCalls.push(input);
      },
    });
    await resolveComposition({
      ...options,
      headBeat: 'hook',
      onBeatMissing: () => undefined,
      headRepeat: 'until-aborted',
      headHold: 'first-frame',
      headCueGate: 'monotonic-forward',
    });
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]?.beat).toBe('hook');
    expect(runCalls[0]?.repeat).toBe('until-aborted');
    expect(runCalls[0]?.hold).toBe('first-frame');
    expect(runCalls[0]?.cueGate).toBe('monotonic-forward');
  });
});

describe('URL screenshot-mode runner capture-hint forwarding (PUL-F018)', () => {
  // PUL-F018: in `mode=screenshot`, the runtime SHALL render the
  // addressed scene at the addressed beat (or first frame if no beat)
  // with all asset preloads resolved, no animation in progress, all
  // audio suppressed, and any randomness sourced from a deterministic
  // seed. ADR-021 places mode dispatch at the loader and the
  // capture-bundle semantics at the timeline-runner adapter. The
  // resolver's job is forwarding the URL-derived `headScreenshot`
  // hint to the head scene's run input only; subsequent scenes in a
  // composition slice do not receive `screenshot` because under
  // screenshot the slice is truncated upstream and the captured frame
  // belongs to one scene. The resolver does NOT interpret
  // `headScreenshot` itself; honoring "freeze at addressed frame, all
  // audio suppressed, deterministic randomness" is the runner's
  // contract.

  it("forwards `headScreenshot` to plan[0]'s run input only — subsequent scenes get no screenshot", async () => {
    const runCalls: SceneTimelineRunInput[] = [];
    const { options } = buildHarness({
      scenes: [{ id: 'scene-a' }, { id: 'scene-b' }],
      manifest: ['scene-a', 'scene-b'],
      runTimeline: (input) => {
        runCalls.push(input);
      },
    });
    await resolveComposition({ ...options, headScreenshot: 'capture' });
    expect(runCalls).toHaveLength(2);
    expect(runCalls[0]?.scene.id).toBe('scene-a');
    expect(runCalls[0]?.screenshot).toBe('capture');
    expect(runCalls[1]?.scene.id).toBe('scene-b');
    expect(runCalls[1]?.screenshot).toBeUndefined();
    // Parallel to `beat` / `repeat` / `hold` / `cueGate` / `range` /
    // `behavior`: the key is OMITTED from the input object when
    // absent, not set to `undefined`. The runner can branch on
    // `'screenshot' in input` rather than checking for `undefined`.
    expect('screenshot' in (runCalls[1] as object)).toBe(false);
  });

  it('does not attach `screenshot` when `headScreenshot` is absent', async () => {
    const runCalls: SceneTimelineRunInput[] = [];
    const { options } = buildHarness({
      scenes: [{ id: 'scene-a' }],
      manifest: ['scene-a'],
      runTimeline: (input) => {
        runCalls.push(input);
      },
    });
    await resolveComposition(options);
    expect(runCalls).toHaveLength(1);
    expect('screenshot' in (runCalls[0] as object)).toBe(false);
  });

  it('does not interpret `headScreenshot` itself — a runner that ignores the hint and returns normally does not error', async () => {
    // Resolver delegates the screenshot capture bundle (frame freeze,
    // audio suppression, deterministic seed) to the runner per
    // ADR-021. A runner that receives `screenshot: 'capture'` and
    // returns void normally (e.g. the placeholder runner that has no
    // real timeline, no audio engine, and no scene-side randomness)
    // must NOT cause the resolver to throw or skip cleanup.
    const cleanupCalls: string[] = [];
    const { options } = buildHarness({
      scenes: [
        {
          id: 'scene-a',
          cleanup: () => {
            cleanupCalls.push('scene-a');
          },
        },
      ],
      manifest: ['scene-a'],
      runTimeline: () => undefined,
    });
    await expect(
      resolveComposition({
        ...options,
        headScreenshot: 'capture',
      }),
    ).resolves.toBeUndefined();
    expect(cleanupCalls).toEqual(['scene-a']);
  });

  it('forwards `headScreenshot` alongside `headBeat`, `headRepeat`, `headHold`, and `headCueGate` independently — all five reach plan[0] without coupling', async () => {
    // `headScreenshot`, `headBeat`, `headRepeat`, `headHold`, and
    // `headCueGate` are five independent head-only forwardings. A
    // regression that paired them — e.g. dropping `headBeat` when
    // `headScreenshot` is set, or dropping `headScreenshot` when
    // `headHold` is also supplied — would break valid combinations a
    // programmatic bridge caller (test harness, future export
    // pipeline) can legitimately request. The URL grammar makes the
    // parent modes (`mode=loop`, `mode=paused`, `mode=scrub`,
    // `mode=screenshot`) mutually exclusive (mode is a single
    // field), so production callers won't supply more than one of
    // `headRepeat` / `headHold` / `headCueGate` / `headScreenshot`
    // at once; the test exercises a programmatic caller scenario to
    // pin that the resolver does not invent coupling between the
    // five head-only fields. All five must reach plan[0] when all
    // five are supplied — this is also the regression test for URLs
    // like `?scene=x&beat=midpoint&mode=screenshot` (screenshot at
    // a named beat — the natural deterministic-frame-capture
    // anchor PUL-F018 names directly) which only sets `headBeat` +
    // `headScreenshot`.
    const runCalls: SceneTimelineRunInput[] = [];
    const { options } = buildHarness({
      scenes: [{ id: 'scene-a' }],
      manifest: ['scene-a'],
      runTimeline: (input) => {
        runCalls.push(input);
      },
    });
    await resolveComposition({
      ...options,
      headBeat: 'midpoint',
      onBeatMissing: () => undefined,
      headRepeat: 'until-aborted',
      headHold: 'first-frame',
      headCueGate: 'monotonic-forward',
      headScreenshot: 'capture',
    });
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]?.beat).toBe('midpoint');
    expect(runCalls[0]?.repeat).toBe('until-aborted');
    expect(runCalls[0]?.hold).toBe('first-frame');
    expect(runCalls[0]?.cueGate).toBe('monotonic-forward');
    expect(runCalls[0]?.screenshot).toBe('capture');
  });
});
