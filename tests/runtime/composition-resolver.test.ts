import { describe, expect, it, vi } from 'vitest';
import type { CompositionManifest } from '../../src/runtime/composition';
import {
  type AssetPreloader,
  type ResolveCompositionOptions,
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
    ((scene, timelineValue) => {
      log.push({ hook: 'runTimeline', sceneId: scene.id, value: timelineValue });
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
      // microtask flush: preload should have started but not yet finished
      await Promise.resolve();
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
        runTimeline: (scene, value) => {
          runCalls.push({ sceneId: scene.id, value });
        },
      });
      await resolveComposition(options);
      expect(runCalls).toEqual([{ sceneId: 'scene-a', value: sentinel }]);
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
        runTimeline: async (scene) => {
          log.push(`runTimeline-${scene.id}-start`);
          await runGate;
          log.push(`runTimeline-${scene.id}-end`);
        },
      });
      const resolverPromise = resolveComposition(options);
      await Promise.resolve();
      await Promise.resolve();
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
        runTimeline: (scene) => {
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

    it('chains the cleanup error as Error.cause when both timeline and cleanup fail (timeline error wins as the message)', async () => {
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
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(
          /^composition resolution failed: scene "scene-a" timeline threw: runner failed \(cleanup also failed: and so did cleanup\)$/,
        );
        // Cause chain: top-level Error.cause is the timeline error; its
        // .cause is the cleanup error so neither is silently dropped.
        const top = err as Error & { cause?: unknown };
        expect(top.cause).toBe(timelineErr);
        expect((timelineErr as Error & { cause?: unknown }).cause).toBe(cleanupErr);
      }
    });

    it('chains the cleanup error as Error.cause when both create and cleanup fail', async () => {
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
        const top = err as Error & { cause?: unknown };
        expect(top.message).toMatch(
          /^composition resolution failed: scene "scene-a" create threw: mount blew up \(cleanup also failed: cleanup also blew up\)$/,
        );
        expect(top.cause).toBe(createErr);
        expect((createErr as Error & { cause?: unknown }).cause).toBe(cleanupErr);
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
        runTimeline: (_scene, value) => {
          log.push(`runTimeline-received-${String(value)}`);
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

    it('drives the ADR-002 trailer fixture (mixed bare-string + object entries) end-to-end in order', async () => {
      const { log, options } = buildHarness({
        scenes: [{ id: 'scene-a' }, { id: 'scene-c' }],
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
  });

  describe('contract surfaces', () => {
    it('exports resolveComposition as an async function', () => {
      // ResolveCompositionOptions / AssetPreloader / SceneTimelineRunner
      // type imports above pin the public surface — if they are removed
      // or renamed this test file fails to type-check.
      expect(typeof resolveComposition).toBe('function');
      // Calling with no arg blows up at runtime — deliberately not
      // testing that path (TypeScript catches it at compile time and
      // we don't add runtime guards beyond assertCompositionManifest's
      // boundary check).
    });
  });
});

// Silence unused-import warnings for vi (kept available for future fakes
// that need vi.useFakeTimers or vi.spyOn).
void vi;
