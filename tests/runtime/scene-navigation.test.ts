// PUL-F008 — scene navigation dispatch.
//
// The scene navigation dispatcher consumes a `NavigationTarget` from
// PUL-F007's parser and produces a `SceneNavigationTarget` (or null,
// for `kind: 'none'`). The lifecycle bridge then runs that target
// through the composition resolver. Both surfaces live in
// `src/runtime/scene-navigation.ts`.
//
// References:
//  - PUL-F008 — when the URL addresses a scene, load it as the
//    navigation target.
//  - ADR-014 — dispatch decisions: snapshot the slice, fail before
//    lifecycle on missing/empty/out-of-bounds.
//  - ADR-013 — URL grammar boundary; we consume `NavigationTarget`.

import { describe, expect, it } from 'vitest';
import type { CompositionManifest } from '../../src/runtime/composition';
import {
  type CompositionRegistry,
  createCompositionRegistry,
} from '../../src/runtime/composition-registry';
import type { NavigationTarget } from '../../src/runtime/navigation';
import { createPresenterController } from '../../src/runtime/presenter';
import { createSceneRegistry } from '../../src/runtime/registry';
import type { SceneModule } from '../../src/runtime/scene';
import {
  type SceneNavigationTarget,
  loadSceneNavigationTarget,
  resolveSceneNavigation,
} from '../../src/runtime/scene-navigation';

interface BuildSceneOpts {
  readonly id?: string;
  readonly assets?: readonly string[];
  readonly create?: SceneModule['create'];
  readonly timeline?: SceneModule['timeline'];
  readonly cleanup?: SceneModule['cleanup'];
}

const buildScene = (opts: BuildSceneOpts = {}): SceneModule => ({
  id: opts.id ?? 'scene-a',
  title: opts.id ?? 'scene-a',
  duration: 1000,
  tags: [],
  assets: opts.assets ?? [],
  captions: [],
  audio: [],
  defaultNext: null,
  standalone: true,
  trailerSafe: false,
  create: opts.create ?? (() => undefined),
  timeline: opts.timeline ?? (() => undefined),
  cleanup: opts.cleanup ?? (() => undefined),
});

const sceneTarget = (id: string): NavigationTarget => ({
  locator: { kind: 'scene', scene: id },
});
const noneTarget: NavigationTarget = { locator: { kind: 'none' } };
const compositionTarget = (id: string): NavigationTarget => ({
  locator: { kind: 'composition', composition: id },
});
const compositionSceneTarget = (composition: string, scene: string): NavigationTarget => ({
  locator: { kind: 'composition-scene', composition, scene },
});
const compositionIndexTarget = (composition: string, index: number): NavigationTarget => ({
  locator: { kind: 'composition-index', composition, index },
});

describe('resolveSceneNavigation (PUL-F008)', () => {
  describe('kind: "none"', () => {
    it('returns null — no explicit target, caller falls back', () => {
      const scenes = createSceneRegistry([buildScene({ id: 'intro' })]);
      const compositions = createCompositionRegistry([]);
      expect(resolveSceneNavigation(noneTarget, { scenes, compositions })).toBeNull();
    });
  });

  describe('kind: "scene"', () => {
    it('returns the registered scene module for the addressed id', () => {
      const intro = buildScene({ id: 'intro' });
      const middle = buildScene({ id: 'middle' });
      const scenes = createSceneRegistry([intro, middle]);
      const compositions = createCompositionRegistry([]);

      const target = resolveSceneNavigation(sceneTarget('middle'), { scenes, compositions });

      expect(target?.scene).toBe(middle);
      expect(target?.composition).toBeUndefined();
    });

    it('throws when the scene is not registered', () => {
      const scenes = createSceneRegistry([buildScene({ id: 'intro' })]);
      const compositions = createCompositionRegistry([]);
      expect(() =>
        resolveSceneNavigation(sceneTarget('missing'), { scenes, compositions }),
      ).toThrow(/^scene navigation failed: scene "missing" is not registered$/);
    });
  });

  describe('kind: "composition"', () => {
    it('snapshots the full manifest from index 0 with matching scene modules', () => {
      const intro = buildScene({ id: 'intro' });
      const middle = buildScene({ id: 'middle' });
      const scenes = createSceneRegistry([intro, middle]);
      const compositions = createCompositionRegistry([
        { id: 'full-talk', manifest: ['intro', 'middle'] },
      ]);

      const target = resolveSceneNavigation(compositionTarget('full-talk'), {
        scenes,
        compositions,
      });

      expect(target?.scene).toBe(intro);
      expect(target?.composition?.id).toBe('full-talk');
      expect(target?.composition?.manifestSlice).toEqual(['intro', 'middle']);
      expect(target?.composition?.sceneSlice).toEqual([intro, middle]);
    });

    it('throws when the composition is not registered', () => {
      const scenes = createSceneRegistry([buildScene({ id: 'intro' })]);
      const compositions = createCompositionRegistry([]);
      expect(() =>
        resolveSceneNavigation(compositionTarget('missing'), { scenes, compositions }),
      ).toThrow(/^scene navigation failed: composition "missing" is not registered$/);
    });

    it('throws when the composition is empty', () => {
      const scenes = createSceneRegistry([buildScene({ id: 'intro' })]);
      const compositions = createCompositionRegistry([{ id: 'empty', manifest: [] }]);
      expect(() =>
        resolveSceneNavigation(compositionTarget('empty'), { scenes, compositions }),
      ).toThrow(/^scene navigation failed: composition "empty" is empty/);
    });

    it('reports missing scene ids using ABSOLUTE composition indices, not slice-relative ones', () => {
      // For composition-scene / composition-index targets, the slice
      // starts mid-manifest. Diagnostic indices must reference the
      // ORIGINAL composition's entry positions so the operator can
      // navigate to the broken entry directly. Reporting slice-
      // relative indices lies about which composition entry is gone.
      const intro = buildScene({ id: 'intro' });
      const middle = buildScene({ id: 'middle' });
      const scenes = createSceneRegistry([intro, middle]);
      const compositions = createCompositionRegistry([
        { id: 'broken', manifest: ['intro', 'middle', 'gone-a', 'gone-b'] },
      ]);
      // Slice from index 2 — the missing entries are at composition
      // entries [2] and [3], NOT slice-relative [0] and [1].
      expect(() =>
        resolveSceneNavigation(compositionIndexTarget('broken', 2), { scenes, compositions }),
      ).toThrow(
        /scene\(s\) not in the scene registry: "gone-a" \(entry \[2\]\), "gone-b" \(entry \[3\]\)/,
      );
    });

    it('aggregates every missing scene id when the composition references unregistered scenes', () => {
      const intro = buildScene({ id: 'intro' });
      const scenes = createSceneRegistry([intro]);
      const compositions = createCompositionRegistry([
        { id: 'broken', manifest: ['intro', 'gone-a', 'gone-b'] },
      ]);
      expect(() =>
        resolveSceneNavigation(compositionTarget('broken'), { scenes, compositions }),
      ).toThrow(
        /^scene navigation failed: composition "broken" references scene\(s\) not in the scene registry: "gone-a" \(entry \[1\]\), "gone-b" \(entry \[2\]\)$/,
      );
    });
  });

  describe('kind: "composition-scene"', () => {
    it('slices the manifest from the addressed scene onwards', () => {
      const intro = buildScene({ id: 'intro' });
      const middle = buildScene({ id: 'middle' });
      const outro = buildScene({ id: 'outro' });
      const scenes = createSceneRegistry([intro, middle, outro]);
      const compositions = createCompositionRegistry([
        { id: 'full-talk', manifest: ['intro', 'middle', 'outro'] },
      ]);

      const target = resolveSceneNavigation(compositionSceneTarget('full-talk', 'middle'), {
        scenes,
        compositions,
      });

      expect(target?.scene).toBe(middle);
      expect(target?.composition?.manifestSlice).toEqual(['middle', 'outro']);
      expect(target?.composition?.sceneSlice).toEqual([middle, outro]);
    });

    it('preserves per-entry overrides in the slice', () => {
      const intro = buildScene({ id: 'intro' });
      const middle = buildScene({ id: 'middle' });
      const outro = buildScene({ id: 'outro' });
      const scenes = createSceneRegistry([intro, middle, outro]);
      const compositions = createCompositionRegistry([
        {
          id: 'trailer',
          manifest: [
            { id: 'intro', range: 'hook' },
            'middle',
            { id: 'outro', behavior: { fade: true } },
          ],
        },
      ]);

      const target = resolveSceneNavigation(compositionSceneTarget('trailer', 'middle'), {
        scenes,
        compositions,
      });

      expect(target?.composition?.manifestSlice).toEqual([
        'middle',
        { id: 'outro', behavior: { fade: true } },
      ]);
    });

    it('throws when the addressed scene id appears more than once in the composition (ambiguous; use composition+index)', () => {
      // ADR-013: repeated scene ids in `composition+scene` are
      // ambiguous and the URL must use `composition+index` to
      // disambiguate. Without this check, `findIndex` silently picks
      // the first occurrence and the user can load the wrong slice
      // (especially when later occurrences carry different overrides).
      const intro = buildScene({ id: 'intro' });
      const scenes = createSceneRegistry([intro]);
      const compositions = createCompositionRegistry([
        {
          id: 'looped',
          manifest: ['intro', 'intro', { id: 'intro', behavior: { fade: true } }],
        },
      ]);
      expect(() =>
        resolveSceneNavigation(compositionSceneTarget('looped', 'intro'), {
          scenes,
          compositions,
        }),
      ).toThrow(
        /^scene navigation failed: scene "intro" appears 3 times in composition "looped" — use composition\+index/,
      );
    });

    it('throws when the addressed scene is not a member of the composition', () => {
      const intro = buildScene({ id: 'intro' });
      const middle = buildScene({ id: 'middle' });
      const scenes = createSceneRegistry([intro, middle]);
      const compositions = createCompositionRegistry([{ id: 'full-talk', manifest: ['intro'] }]);
      expect(() =>
        resolveSceneNavigation(compositionSceneTarget('full-talk', 'middle'), {
          scenes,
          compositions,
        }),
      ).toThrow(
        /^scene navigation failed: scene "middle" is not a member of composition "full-talk"$/,
      );
    });

    it('throws when the composition is not registered (composition error wins over scene check)', () => {
      const scenes = createSceneRegistry([buildScene({ id: 'intro' })]);
      const compositions = createCompositionRegistry([]);
      expect(() =>
        resolveSceneNavigation(compositionSceneTarget('missing', 'intro'), {
          scenes,
          compositions,
        }),
      ).toThrow(/^scene navigation failed: composition "missing" is not registered$/);
    });
  });

  describe('kind: "composition-index"', () => {
    it('slices the manifest from the addressed index onwards', () => {
      const intro = buildScene({ id: 'intro' });
      const middle = buildScene({ id: 'middle' });
      const outro = buildScene({ id: 'outro' });
      const scenes = createSceneRegistry([intro, middle, outro]);
      const compositions = createCompositionRegistry([
        { id: 'full-talk', manifest: ['intro', 'middle', 'outro'] },
      ]);

      const target = resolveSceneNavigation(compositionIndexTarget('full-talk', 1), {
        scenes,
        compositions,
      });

      expect(target?.scene).toBe(middle);
      expect(target?.composition?.manifestSlice).toEqual(['middle', 'outro']);
    });

    it('handles index 0 (full manifest)', () => {
      const intro = buildScene({ id: 'intro' });
      const middle = buildScene({ id: 'middle' });
      const scenes = createSceneRegistry([intro, middle]);
      const compositions = createCompositionRegistry([
        { id: 'full-talk', manifest: ['intro', 'middle'] },
      ]);

      const target = resolveSceneNavigation(compositionIndexTarget('full-talk', 0), {
        scenes,
        compositions,
      });

      expect(target?.scene).toBe(intro);
      expect(target?.composition?.manifestSlice).toEqual(['intro', 'middle']);
    });

    it('throws on a negative index (defense in depth — parser already rejects, but the dispatcher re-validates)', () => {
      const intro = buildScene({ id: 'intro' });
      const scenes = createSceneRegistry([intro]);
      const compositions = createCompositionRegistry([{ id: 'full-talk', manifest: ['intro'] }]);
      // PUL-F007's parser already rejects negative indexes, but
      // `NavigationTarget` is an exported type and consumers can
      // construct one directly (event-detail unmarshaling, tests,
      // future callers). The dispatcher re-validates so the
      // `manifest.slice(-1)` interpretation cannot leak through.
      expect(() =>
        resolveSceneNavigation(compositionIndexTarget('full-talk', -1), {
          scenes,
          compositions,
        }),
      ).toThrow(
        /^scene navigation failed: index -1 is out of range for composition "full-talk" \(size 1\)$/,
      );
    });

    it('throws on a non-integer index', () => {
      const intro = buildScene({ id: 'intro' });
      const scenes = createSceneRegistry([intro]);
      const compositions = createCompositionRegistry([{ id: 'full-talk', manifest: ['intro'] }]);
      expect(() =>
        resolveSceneNavigation(compositionIndexTarget('full-talk', 0.5), {
          scenes,
          compositions,
        }),
      ).toThrow(
        /^scene navigation failed: index 0\.5 is out of range for composition "full-talk" \(size 1\)$/,
      );
    });

    it('throws when the index is out of range', () => {
      const intro = buildScene({ id: 'intro' });
      const scenes = createSceneRegistry([intro]);
      const compositions = createCompositionRegistry([{ id: 'full-talk', manifest: ['intro'] }]);
      expect(() =>
        resolveSceneNavigation(compositionIndexTarget('full-talk', 5), {
          scenes,
          compositions,
        }),
      ).toThrow(
        /^scene navigation failed: index 5 is out of range for composition "full-talk" \(size 1\)$/,
      );
    });

    it('throws when the composition is empty (any index is out of range)', () => {
      const scenes = createSceneRegistry([buildScene({ id: 'intro' })]);
      const compositions = createCompositionRegistry([{ id: 'empty', manifest: [] }]);
      expect(() =>
        resolveSceneNavigation(compositionIndexTarget('empty', 0), { scenes, compositions }),
      ).toThrow(/^scene navigation failed: index 0 is out of range for composition "empty"/);
    });
  });

  describe('snapshot immutability', () => {
    it('deep-freezes the slice itself even when the composition registry returns mutable manifests', () => {
      // The dispatcher accepts the `CompositionRegistry` interface,
      // not a specific implementation. To prove the dispatcher does
      // its OWN deep-freeze (rather than relying on
      // `createCompositionRegistry` happening to deep-freeze), inject
      // a hand-built registry that returns mutable nested objects.
      // If the dispatcher reverted to a shallow `Object.freeze`,
      // `slice[0].behavior.fade.duration` would remain mutable and
      // the assertions below would fail.
      const middle = buildScene({ id: 'middle' });
      const outro = buildScene({ id: 'outro' });
      const scenes = createSceneRegistry([middle, outro]);
      const mutableManifest: CompositionManifest = [
        { id: 'middle', range: ['intro', 'hook'] },
        { id: 'outro', behavior: { fade: { duration: 200, ease: ['cubic'] }, flags: ['a'] } },
      ];
      // Hand-rolled CompositionRegistry that returns the mutable
      // manifest as-is — no deep-freeze on its side.
      const mutableCompositions: CompositionRegistry = {
        get: () => ({ manifest: mutableManifest }),
        has: () => true,
        ids: () => ['mixed'],
        get size() {
          return 1;
        },
      };

      const target = resolveSceneNavigation(compositionTarget('mixed'), {
        scenes,
        compositions: mutableCompositions,
      }) as SceneNavigationTarget;

      const slice = target.composition?.manifestSlice as unknown as readonly unknown[];
      expect(Object.isFrozen(slice)).toBe(true);
      // Object-form entries are frozen.
      expect(Object.isFrozen(slice[0])).toBe(true);
      expect(Object.isFrozen(slice[1])).toBe(true);
      // And nested objects/arrays inside `range` and `behavior` are
      // frozen too — this is what the registry-not-freezing branch
      // would miss with a shallow freeze.
      const entry1 = slice[1] as { behavior: { fade: { ease: string[] }; flags: string[] } };
      expect(Object.isFrozen(entry1.behavior)).toBe(true);
      expect(Object.isFrozen(entry1.behavior.fade)).toBe(true);
      expect(Object.isFrozen(entry1.behavior.fade.ease)).toBe(true);
      expect(Object.isFrozen(entry1.behavior.flags)).toBe(true);
    });

    it('manifestSlice and sceneSlice are frozen', () => {
      const intro = buildScene({ id: 'intro' });
      const middle = buildScene({ id: 'middle' });
      const scenes = createSceneRegistry([intro, middle]);
      const compositions = createCompositionRegistry([
        { id: 'full-talk', manifest: ['intro', 'middle'] },
      ]);
      const target = resolveSceneNavigation(compositionTarget('full-talk'), {
        scenes,
        compositions,
      }) as SceneNavigationTarget;

      expect(Object.isFrozen(target.composition?.manifestSlice)).toBe(true);
      expect(Object.isFrozen(target.composition?.sceneSlice)).toBe(true);
    });
  });

  describe('lifecycle is not touched on any error path', () => {
    it.each<[label: string, target: NavigationTarget]>([
      ['scene unknown', sceneTarget('missing')],
      ['composition unknown', compositionTarget('missing')],
      ['composition-scene composition unknown', compositionSceneTarget('missing', 'intro')],
      ['composition-scene non-member', compositionSceneTarget('full-talk', 'gone')],
      ['composition-index out of range', compositionIndexTarget('full-talk', 5)],
    ])('does not invoke create/timeline/cleanup on %s', (_label, target) => {
      const calls: string[] = [];
      const intro = buildScene({
        id: 'intro',
        create: () => {
          calls.push('create');
        },
        timeline: () => {
          calls.push('timeline');
        },
        cleanup: () => {
          calls.push('cleanup');
        },
      });
      const scenes = createSceneRegistry([intro]);
      const compositions = createCompositionRegistry([{ id: 'full-talk', manifest: ['intro'] }]);
      expect(() => resolveSceneNavigation(target, { scenes, compositions })).toThrow();
      expect(calls).toEqual([]);
    });
  });
});

describe('loadSceneNavigationTarget (PUL-F008 lifecycle bridge — ADR-025)', () => {
  // Records every `timeline.run(segments, opts)` call (one per
  // navigation) and resolves immediately, or parks until the navigation
  // aborts when `park` is set. The GSAP adapter has its own tests in
  // `timeline.test.ts`; here we only pin what the bridge hands it.
  const recordingTimeline = (
    park = false,
  ): {
    adapter: import('../../src/runtime/composition-resolver').CompositionTimelineAdapter;
    calls: {
      segments: readonly import('../../src/runtime/composition-resolver').SceneTimelineSegment[];
      opts: import('../../src/runtime/composition-resolver').CompositionTimelineRunOptions;
    }[];
  } => {
    const calls: {
      segments: readonly import('../../src/runtime/composition-resolver').SceneTimelineSegment[];
      opts: import('../../src/runtime/composition-resolver').CompositionTimelineRunOptions;
    }[] = [];
    return {
      calls,
      adapter: {
        run(segments, opts) {
          calls.push({ segments, opts });
          if (!park) return Promise.resolve();
          return new Promise<void>((resolve) => {
            const sig = opts.signal;
            if (sig === undefined || sig.aborted) {
              resolve();
              return;
            }
            sig.addEventListener('abort', () => resolve(), { once: true });
          });
        },
      },
    };
  };
  const segmentIds = (
    segments: readonly import('../../src/runtime/composition-resolver').SceneTimelineSegment[],
  ): string[] => segments.map((s) => s.id);

  it('mounts the addressed scene then composes its timeline then tears it down', async () => {
    const log: string[] = [];
    const intro = buildScene({
      id: 'intro',
      create: () => {
        log.push('create');
      },
      timeline: () => {
        log.push('timeline');
        return 'intro-timeline';
      },
      cleanup: () => {
        log.push('cleanup');
      },
    });
    const target = resolveSceneNavigation(sceneTarget('intro'), {
      scenes: createSceneRegistry([intro]),
      compositions: createCompositionRegistry([]),
    }) as SceneNavigationTarget;
    const tl = recordingTimeline();

    await loadSceneNavigationTarget(target, {
      ctx: () => ({}),
      preloadAssets: (scene) => {
        log.push(`preload:${scene.id}`);
      },
      timeline: tl.adapter,
    });

    expect(log).toEqual(['preload:intro', 'create', 'timeline', 'cleanup']);
    expect(tl.calls).toHaveLength(1);
    expect(tl.calls[0]?.segments).toEqual([{ id: 'intro', timeline: 'intro-timeline' }]);
  });

  it('runs a composition slice in mount-all → compose → run → cleanup-all order', async () => {
    const log: string[] = [];
    const make = (id: string): SceneModule =>
      buildScene({
        id,
        create: () => {
          log.push(`${id}:create`);
        },
        timeline: () => {
          log.push(`${id}:timeline`);
          return `${id}-tl`;
        },
        cleanup: () => {
          log.push(`${id}:cleanup`);
        },
      });
    const target = resolveSceneNavigation(compositionSceneTarget('full-talk', 'middle'), {
      scenes: createSceneRegistry([make('intro'), make('middle'), make('outro')]),
      compositions: createCompositionRegistry([
        { id: 'full-talk', manifest: ['intro', 'middle', 'outro'] },
      ]),
    }) as SceneNavigationTarget;
    const tl = recordingTimeline();

    await loadSceneNavigationTarget(target, {
      ctx: () => ({}),
      preloadAssets: () => undefined,
      timeline: tl.adapter,
    });

    // `intro` is upstream of the addressed scene and is not part of the slice.
    expect(log).toEqual([
      'middle:create',
      'outro:create',
      'middle:timeline',
      'outro:timeline',
      'outro:cleanup',
      'middle:cleanup',
    ]);
    expect(segmentIds(tl.calls[0]?.segments ?? [])).toEqual(['middle', 'outro']);
  });

  it('runs a composition slice that repeats a scene id, mounting each occurrence (issue #99)', async () => {
    const log: string[] = [];
    const intro = buildScene({
      id: 'intro',
      create: () => log.push('create'),
      timeline: () => {
        log.push('timeline');
        return undefined;
      },
      cleanup: () => log.push('cleanup'),
    });
    // The dispatcher resolves `?composition=loop-once`; the bridge
    // de-duplicates the synthesized scene registry by id and the
    // resolver mounts each `intro` occurrence as a distinct activation
    // (issue #99 — repeated scene ids are supported).
    const target = resolveSceneNavigation(compositionTarget('loop-once'), {
      scenes: createSceneRegistry([intro]),
      compositions: createCompositionRegistry([{ id: 'loop-once', manifest: ['intro', 'intro'] }]),
    }) as SceneNavigationTarget;
    const tl = recordingTimeline();

    await expect(
      loadSceneNavigationTarget(target, {
        ctx: () => ({}),
        preloadAssets: () => undefined,
        timeline: tl.adapter,
      }),
    ).resolves.toBeUndefined();

    // Each occurrence is mounted, composed, and torn down once.
    expect(log).toEqual(['create', 'create', 'timeline', 'timeline', 'cleanup', 'cleanup']);
    expect(segmentIds(tl.calls[0]?.segments ?? [])).toEqual(['intro', 'intro']);
  });

  it('still calls cleanup when create throws (mandatory-cleanup invariant)', async () => {
    // PUL-F029 / ADR-028: a thrown `create(ctx)` is a per-scene
    // failure, isolated by the resolver. The mandatory-cleanup
    // invariant survives: the failing scene's `cleanup(ctx)` runs
    // eagerly. When no `onSceneFailed` is wired (direct bridge
    // callers, this test) the resolver still aggregates the scene
    // failure into an AggregateError at the end so the caller never
    // loses the signal — the individual wrapper inside `.errors[]`
    // carries the legacy `scene "intro" create threw` envelope.
    const log: string[] = [];
    const intro = buildScene({
      id: 'intro',
      create: () => {
        log.push('create');
        throw new Error('create failed');
      },
      cleanup: () => {
        log.push('cleanup');
      },
    });
    const target = resolveSceneNavigation(sceneTarget('intro'), {
      scenes: createSceneRegistry([intro]),
      compositions: createCompositionRegistry([]),
    }) as SceneNavigationTarget;

    let caught: unknown;
    await loadSceneNavigationTarget(target, {
      ctx: () => ({}),
      preloadAssets: () => undefined,
      timeline: recordingTimeline().adapter,
    }).catch((err: unknown) => {
      caught = err;
    });
    expect(caught).toBeInstanceOf(AggregateError);
    const messages = (caught as AggregateError).errors.map((e) => (e as Error).message);
    expect(messages).toContain(
      'composition resolution failed: scene "intro" create threw: create failed',
    );
    expect(log).toEqual(['create', 'cleanup']);
  });

  it('aborts before activation when preload throws', async () => {
    const log: string[] = [];
    const intro = buildScene({
      id: 'intro',
      create: () => log.push('create'),
      cleanup: () => log.push('cleanup'),
    });
    const target = resolveSceneNavigation(sceneTarget('intro'), {
      scenes: createSceneRegistry([intro]),
      compositions: createCompositionRegistry([]),
    }) as SceneNavigationTarget;

    await expect(
      loadSceneNavigationTarget(target, {
        ctx: () => ({}),
        preloadAssets: () => {
          log.push('preload');
          throw new Error('preload failed');
        },
        timeline: recordingTimeline().adapter,
      }),
    ).rejects.toThrow(/composition resolution failed: scene "intro" preloadAssets threw/);
    expect(log).toEqual(['preload']);
  });

  it('runs the resolved scene module even when a sibling registry maps the same id elsewhere', async () => {
    const log: string[] = [];
    const realIntro = buildScene({ id: 'intro', create: () => log.push('real-intro:create') });
    const decoyIntro = buildScene({ id: 'intro', create: () => log.push('decoy-intro:create') });
    const target = resolveSceneNavigation(sceneTarget('intro'), {
      scenes: createSceneRegistry([realIntro]),
      compositions: createCompositionRegistry([]),
    }) as SceneNavigationTarget;
    void createSceneRegistry([decoyIntro]);

    await loadSceneNavigationTarget(target, {
      ctx: () => ({}),
      preloadAssets: () => undefined,
      timeline: recordingTimeline().adapter,
    });
    expect(log).toEqual(['real-intro:create']);
  });

  it('carries per-entry overrides (range, behavior) into the segments handed to the adapter', async () => {
    const intro = buildScene({ id: 'intro', timeline: () => 'intro-tl' });
    const outro = buildScene({ id: 'outro', timeline: () => 'outro-tl' });
    const target = resolveSceneNavigation(compositionTarget('mixed'), {
      scenes: createSceneRegistry([intro, outro]),
      compositions: createCompositionRegistry([
        {
          id: 'mixed',
          manifest: [
            { id: 'intro', range: 'hook' },
            { id: 'outro', behavior: { fade: true } },
          ],
        },
      ]),
    }) as SceneNavigationTarget;
    const tl = recordingTimeline();

    await loadSceneNavigationTarget(target, {
      ctx: () => ({}),
      preloadAssets: () => undefined,
      timeline: tl.adapter,
    });
    expect(tl.calls[0]?.segments).toEqual([
      { id: 'intro', timeline: 'intro-tl', range: 'hook' },
      { id: 'outro', timeline: 'outro-tl', behavior: { fade: true } },
    ]);
  });

  it('builds ctx per occurrence and forwards it unchanged to that occurrence lifecycle hooks', async () => {
    const activations: Array<{ sceneId: string; entryIndex: number; occurrence: number }> = [];
    const seen: unknown[] = [];
    const intro = buildScene({
      id: 'intro',
      create: (received) => seen.push(received),
      timeline: (received) => {
        seen.push(received);
        return 'tl';
      },
      cleanup: (received) => seen.push(received),
    });
    const target = resolveSceneNavigation(sceneTarget('intro'), {
      scenes: createSceneRegistry([intro]),
      compositions: createCompositionRegistry([]),
    }) as SceneNavigationTarget;

    await loadSceneNavigationTarget(target, {
      ctx: (activation) => {
        activations.push(activation);
        return { tag: 'workbench-ctx', activation };
      },
      preloadAssets: () => undefined,
      timeline: recordingTimeline().adapter,
    });
    // One occurrence → the factory is called once, with that
    // occurrence's activation; its single ctx reaches all three hooks.
    expect(activations).toEqual([{ sceneId: 'intro', entryIndex: 0, occurrence: 0 }]);
    const expectedCtx = {
      tag: 'workbench-ctx',
      activation: { sceneId: 'intro', entryIndex: 0, occurrence: 0 },
    };
    expect(seen).toEqual([expectedCtx, expectedCtx, expectedCtx]);
  });

  // ----- head-hint forwarding -------------------------------------------

  /** Build a target + load it with the given bridge options; return the adapter's recorded call. */
  const loadWith = async (
    target: NavigationTarget,
    scenes: SceneModule[],
    compositions: { id: string; manifest: CompositionManifest }[],
    options: Partial<{
      beat: string;
      onBeatMissing: () => void;
      repeat: 'until-aborted';
      hold: 'first-frame';
      cueGate: 'monotonic-forward';
      screenshot: 'capture';
      presenter: ReturnType<typeof createPresenterController>;
      onPresenterError: (err: unknown) => void;
    }>,
  ): Promise<{
    calls: {
      segments: readonly import('../../src/runtime/composition-resolver').SceneTimelineSegment[];
      opts: import('../../src/runtime/composition-resolver').CompositionTimelineRunOptions;
    }[];
  }> => {
    const resolved = resolveSceneNavigation(target, {
      scenes: createSceneRegistry(scenes),
      compositions: createCompositionRegistry(compositions),
    }) as SceneNavigationTarget;
    const tl = recordingTimeline();
    await loadSceneNavigationTarget(resolved, {
      ctx: () => ({}),
      preloadAssets: () => undefined,
      timeline: tl.adapter,
      ...options,
    });
    return { calls: tl.calls };
  };

  describe('URL beat forwarding (PUL-F011)', () => {
    const beatTarget = (id: string, beat: string): NavigationTarget => ({
      ...sceneTarget(id),
      beat,
    });

    it('forwards beat + onBeatMissing as headBeat + onBeatMissing', async () => {
      const onBeatMissing = (): void => undefined;
      const { calls } = await loadWith(
        beatTarget('intro', 'hook'),
        [buildScene({ id: 'intro' })],
        [],
        {
          beat: 'hook',
          onBeatMissing,
        },
      );
      expect(calls[0]?.opts.headBeat).toBe('hook');
      expect(calls[0]?.opts.onBeatMissing).toBe(onBeatMissing);
    });

    it('does not forward onBeatMissing when beat is omitted (paired contract)', async () => {
      const { calls } = await loadWith(sceneTarget('intro'), [buildScene({ id: 'intro' })], [], {
        onBeatMissing: () => undefined,
      });
      expect('headBeat' in (calls[0]?.opts ?? {})).toBe(false);
      expect('onBeatMissing' in (calls[0]?.opts ?? {})).toBe(false);
    });

    it('throws when beat is supplied without onBeatMissing (paired-required contract)', async () => {
      const resolved = resolveSceneNavigation(beatTarget('intro', 'hook'), {
        scenes: createSceneRegistry([buildScene({ id: 'intro' })]),
        compositions: createCompositionRegistry([]),
      }) as SceneNavigationTarget;
      await expect(
        loadSceneNavigationTarget(resolved, {
          ctx: () => ({}),
          preloadAssets: () => undefined,
          timeline: recordingTimeline().adapter,
          beat: 'hook',
        }),
      ).rejects.toThrow(/"onBeatMissing" is required when "beat" is supplied/);
    });

    it('does not forward beat when omitted', async () => {
      const { calls } = await loadWith(sceneTarget('intro'), [buildScene({ id: 'intro' })], [], {});
      expect('headBeat' in (calls[0]?.opts ?? {})).toBe(false);
    });
  });

  // The four single-scene-execution modes (loop / paused / scrub /
  // screenshot) share the same bridge behavior: forward the hint as the
  // `head*` run option, and truncate a composition slice to the head so
  // "no following entries run" is structural — independent of the
  // adapter honoring the hint. `present` (presenter) is the odd one out:
  // it runs the FULL slice and forwards the controller once.
  const headHintCases = [
    { name: 'loop (PUL-F015)', option: 'repeat', value: 'until-aborted', runKey: 'headRepeat' },
    { name: 'paused (PUL-F016)', option: 'hold', value: 'first-frame', runKey: 'headHold' },
    {
      name: 'scrub (PUL-F017)',
      option: 'cueGate',
      value: 'monotonic-forward',
      runKey: 'headCueGate',
    },
    {
      name: 'screenshot (PUL-F018)',
      option: 'screenshot',
      value: 'capture',
      runKey: 'headScreenshot',
    },
  ] as const;

  for (const { name, option, value, runKey } of headHintCases) {
    describe(`URL ${name} forwarding`, () => {
      it(`forwards ${option} as ${runKey} for a single-scene target`, async () => {
        const { calls } = await loadWith(sceneTarget('intro'), [buildScene({ id: 'intro' })], [], {
          [option]: value,
        });
        expect((calls[0]?.opts as Record<string, unknown>)[runKey]).toBe(value);
        expect(segmentIds(calls[0]?.segments ?? [])).toEqual(['intro']);
      });

      it(`truncates a composition slice to the addressed head when ${option} is supplied`, async () => {
        const { calls } = await loadWith(
          compositionTarget('full-talk'),
          [buildScene({ id: 'a' }), buildScene({ id: 'b' }), buildScene({ id: 'c' })],
          [{ id: 'full-talk', manifest: ['a', 'b', 'c'] }],
          { [option]: value },
        );
        expect((calls[0]?.opts as Record<string, unknown>)[runKey]).toBe(value);
        expect(segmentIds(calls[0]?.segments ?? [])).toEqual(['a']);
      });

      it(`does not truncate a composition slice when ${option} is absent`, async () => {
        const { calls } = await loadWith(
          compositionTarget('full-talk'),
          [buildScene({ id: 'a' }), buildScene({ id: 'b' }), buildScene({ id: 'c' })],
          [{ id: 'full-talk', manifest: ['a', 'b', 'c'] }],
          {},
        );
        expect(segmentIds(calls[0]?.segments ?? [])).toEqual(['a', 'b', 'c']);
      });

      it(`does not forward ${runKey} when ${option} is omitted`, async () => {
        const { calls } = await loadWith(
          sceneTarget('intro'),
          [buildScene({ id: 'intro' })],
          [],
          {},
        );
        expect(runKey in (calls[0]?.opts ?? {})).toBe(false);
      });
    });
  }

  describe('URL present-mode presenter forwarding (PUL-F020)', () => {
    const makePresenter = (): ReturnType<typeof createPresenterController> => {
      const controller = new AbortController();
      return createPresenterController({ subscribe: () => () => undefined }, controller.signal);
    };

    it('forwards the presenter controller once into the run options', async () => {
      const presenter = makePresenter();
      const { calls } = await loadWith(sceneTarget('intro'), [buildScene({ id: 'intro' })], [], {
        presenter,
      });
      expect(calls[0]?.opts.presenter).toBe(presenter);
    });

    it('does not truncate the slice when presenter is supplied — present-mode runs the full composition', async () => {
      const presenter = makePresenter();
      const { calls } = await loadWith(
        compositionTarget('full-talk'),
        [buildScene({ id: 'a' }), buildScene({ id: 'b' }), buildScene({ id: 'c' })],
        [{ id: 'full-talk', manifest: ['a', 'b', 'c'] }],
        { presenter },
      );
      expect(segmentIds(calls[0]?.segments ?? [])).toEqual(['a', 'b', 'c']);
      expect(calls[0]?.opts.presenter).toBe(presenter);
    });

    it('forwards onPresenterError paired with presenter', async () => {
      const presenter = makePresenter();
      const onPresenterError = (): void => undefined;
      const { calls } = await loadWith(sceneTarget('intro'), [buildScene({ id: 'intro' })], [], {
        presenter,
        onPresenterError,
      });
      expect(calls[0]?.opts.onPresenterError).toBe(onPresenterError);
    });

    it('does not forward presenter when omitted', async () => {
      const { calls } = await loadWith(sceneTarget('intro'), [buildScene({ id: 'intro' })], [], {});
      expect('presenter' in (calls[0]?.opts ?? {})).toBe(false);
    });
  });
});

describe('resolveSceneNavigation — composition audio bed (PUL-F014)', () => {
  // The resolver snapshots the registered composition's audio bed onto
  // the navigation context but makes NO suppression decision — that is
  // the loader's mode-dispatch job. These tests pin the snapshot for
  // every composition locator kind.
  const bed = { src: '/audio/bed.webm', volume: 0.7 };

  it('threads a declared audio bed into the composition context (kind: composition)', () => {
    const scenes = createSceneRegistry([buildScene({ id: 'intro' })]);
    const compositions = createCompositionRegistry([
      { id: 'talk', manifest: ['intro'], audioBed: bed },
    ]);
    const target = resolveSceneNavigation(compositionTarget('talk'), { scenes, compositions });
    expect(target?.composition?.audioBed).toEqual(bed);
  });

  it('threads the bed for a composition-scene locator', () => {
    const scenes = createSceneRegistry([buildScene({ id: 'intro' }), buildScene({ id: 'middle' })]);
    const compositions = createCompositionRegistry([
      { id: 'talk', manifest: ['intro', 'middle'], audioBed: bed },
    ]);
    const target = resolveSceneNavigation(compositionSceneTarget('talk', 'middle'), {
      scenes,
      compositions,
    });
    expect(target?.composition?.audioBed).toEqual(bed);
  });

  it('threads the bed for a composition-index locator', () => {
    const scenes = createSceneRegistry([buildScene({ id: 'intro' }), buildScene({ id: 'middle' })]);
    const compositions = createCompositionRegistry([
      { id: 'talk', manifest: ['intro', 'middle'], audioBed: bed },
    ]);
    const target = resolveSceneNavigation(compositionIndexTarget('talk', 1), {
      scenes,
      compositions,
    });
    expect(target?.composition?.audioBed).toEqual(bed);
  });

  it('leaves audioBed undefined when the composition declared no bed', () => {
    const scenes = createSceneRegistry([buildScene({ id: 'intro' })]);
    const compositions = createCompositionRegistry([{ id: 'talk', manifest: ['intro'] }]);
    const target = resolveSceneNavigation(compositionTarget('talk'), { scenes, compositions });
    expect(target?.composition).not.toBeUndefined();
    expect(target?.composition?.audioBed).toBeUndefined();
  });

  it('carries no composition context — and so no bed — for a bare scene target', () => {
    const scenes = createSceneRegistry([buildScene({ id: 'intro' })]);
    const compositions = createCompositionRegistry([]);
    const target = resolveSceneNavigation(sceneTarget('intro'), { scenes, compositions });
    expect(target?.composition).toBeUndefined();
  });
});
