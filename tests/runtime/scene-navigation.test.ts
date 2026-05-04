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
        get: () => mutableManifest,
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

describe('loadSceneNavigationTarget (PUL-F008 lifecycle bridge)', () => {
  it('runs preload → create → timeline → cleanup against the addressed scene', async () => {
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
    const scenes = createSceneRegistry([intro]);
    const compositions = createCompositionRegistry([]);
    const target = resolveSceneNavigation(sceneTarget('intro'), {
      scenes,
      compositions,
    }) as SceneNavigationTarget;

    await loadSceneNavigationTarget(target, {
      ctx: {},
      preloadAssets: (scene) => {
        log.push(`preload:${scene.id}`);
      },
      runTimeline: ({ scene, timeline }) => {
        log.push(`runTimeline:${scene.id}:${String(timeline)}`);
      },
    });

    expect(log).toEqual([
      'preload:intro',
      'create',
      'timeline',
      'runTimeline:intro:intro-timeline',
      'cleanup',
    ]);
  });

  it('still calls cleanup when create throws (mandatory-cleanup invariant)', async () => {
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
    const scenes = createSceneRegistry([intro]);
    const compositions = createCompositionRegistry([]);
    const target = resolveSceneNavigation(sceneTarget('intro'), {
      scenes,
      compositions,
    }) as SceneNavigationTarget;

    await expect(
      loadSceneNavigationTarget(target, {
        ctx: {},
        preloadAssets: () => undefined,
        runTimeline: () => undefined,
      }),
    ).rejects.toThrow(/composition resolution failed: scene "intro" create threw/);

    expect(log).toEqual(['create', 'cleanup']);
  });

  it('aborts before create/timeline/cleanup when preload throws', async () => {
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
    const scenes = createSceneRegistry([intro]);
    const compositions = createCompositionRegistry([]);
    const target = resolveSceneNavigation(sceneTarget('intro'), {
      scenes,
      compositions,
    }) as SceneNavigationTarget;

    await expect(
      loadSceneNavigationTarget(target, {
        ctx: {},
        preloadAssets: () => {
          log.push('preload');
          throw new Error('preload failed');
        },
        runTimeline: () => undefined,
      }),
    ).rejects.toThrow(/composition resolution failed: scene "intro" preloadAssets threw/);

    expect(log).toEqual(['preload']);
  });

  it('runs the resolved scene module even when a sibling registry maps the same id elsewhere', async () => {
    // Identity guarantee: passing a different scene registry that maps
    // the same id to a different module must NOT divert the bridge to
    // the wrong module. The bridge synthesizes its own registry from
    // `target.scene`, so the lifecycle always runs the module the
    // dispatcher returned.
    const log: string[] = [];
    const realIntro = buildScene({
      id: 'intro',
      create: () => {
        log.push('real-intro:create');
      },
    });
    const decoyIntro = buildScene({
      id: 'intro',
      create: () => {
        log.push('decoy-intro:create');
      },
    });
    const realScenes = createSceneRegistry([realIntro]);
    const compositions = createCompositionRegistry([]);
    const target = resolveSceneNavigation(sceneTarget('intro'), {
      scenes: realScenes,
      compositions,
    }) as SceneNavigationTarget;
    void createSceneRegistry([decoyIntro]);

    await loadSceneNavigationTarget(target, {
      ctx: {},
      preloadAssets: () => undefined,
      runTimeline: () => undefined,
    });

    expect(log).toEqual(['real-intro:create']);
  });

  it('runs a composition slice end-to-end in order', async () => {
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
    const intro = make('intro');
    const middle = make('middle');
    const outro = make('outro');
    const scenes = createSceneRegistry([intro, middle, outro]);
    const compositions = createCompositionRegistry([
      { id: 'full-talk', manifest: ['intro', 'middle', 'outro'] },
    ]);
    const target = resolveSceneNavigation(compositionSceneTarget('full-talk', 'middle'), {
      scenes,
      compositions,
    }) as SceneNavigationTarget;

    await loadSceneNavigationTarget(target, {
      ctx: {},
      preloadAssets: () => undefined,
      runTimeline: () => undefined,
    });

    // intro is upstream of the addressed scene and is NOT played.
    expect(log).toEqual(['middle:create', 'middle:cleanup', 'outro:create', 'outro:cleanup']);
  });

  it('runs a composition slice with repeated scene ids end-to-end (no duplicate-id registry error)', async () => {
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
    const scenes = createSceneRegistry([intro]);
    const compositions = createCompositionRegistry([
      { id: 'loop-once', manifest: ['intro', 'intro'] },
    ]);
    const target = resolveSceneNavigation(compositionTarget('loop-once'), {
      scenes,
      compositions,
    }) as SceneNavigationTarget;

    await loadSceneNavigationTarget(target, {
      ctx: {},
      preloadAssets: () => undefined,
      runTimeline: () => undefined,
    });

    expect(log).toEqual(['create', 'cleanup', 'create', 'cleanup']);
  });

  it('forwards per-entry overrides (range, behavior) to the runner adapter', async () => {
    const seen: { id: string; range?: unknown; behavior?: unknown }[] = [];
    const intro = buildScene({ id: 'intro', timeline: () => 'intro-tl' });
    const outro = buildScene({ id: 'outro', timeline: () => 'outro-tl' });
    const scenes = createSceneRegistry([intro, outro]);
    const compositions = createCompositionRegistry([
      {
        id: 'mixed',
        manifest: [
          { id: 'intro', range: 'hook' },
          { id: 'outro', behavior: { fade: true } },
        ],
      },
    ]);
    const target = resolveSceneNavigation(compositionTarget('mixed'), {
      scenes,
      compositions,
    }) as SceneNavigationTarget;

    await loadSceneNavigationTarget(target, {
      ctx: {},
      preloadAssets: () => undefined,
      runTimeline: (input) => {
        const captured: { id: string; range?: unknown; behavior?: unknown } = {
          id: input.scene.id,
        };
        if ('range' in input) captured.range = input.range;
        if ('behavior' in input) captured.behavior = input.behavior;
        seen.push(captured);
      },
    });

    expect(seen).toEqual([
      { id: 'intro', range: 'hook' },
      { id: 'outro', behavior: { fade: true } },
    ]);
  });

  it('forwards ctx unchanged to every lifecycle hook', async () => {
    const ctx = { tag: 'workbench-ctx' };
    const seen: unknown[] = [];
    const intro = buildScene({
      id: 'intro',
      create: (received) => {
        seen.push(received);
      },
      timeline: (received) => {
        seen.push(received);
        return 'tl';
      },
      cleanup: (received) => {
        seen.push(received);
      },
    });
    const scenes = createSceneRegistry([intro]);
    const compositions = createCompositionRegistry([]);
    const target = resolveSceneNavigation(sceneTarget('intro'), {
      scenes,
      compositions,
    }) as SceneNavigationTarget;

    await loadSceneNavigationTarget(target, {
      ctx,
      preloadAssets: () => undefined,
      runTimeline: () => undefined,
    });

    expect(seen).toEqual([ctx, ctx, ctx]);
  });

  describe('URL beat forwarding (PUL-F011)', () => {
    // ADR-015: URL beat is timeline-runner state. The bridge's only
    // job is to forward `beat` and `onBeatMissing` from the loader to
    // the resolver as `headBeat` / `onBeatMissing`. Label existence
    // and seeking remain the runner's responsibility.

    it('forwards `beat` to the runner for a single-scene target', async () => {
      const seen: { beat?: string }[] = [];
      const intro = buildScene({ id: 'intro' });
      const scenes = createSceneRegistry([intro]);
      const compositions = createCompositionRegistry([]);
      const target = resolveSceneNavigation(sceneTarget('intro'), {
        scenes,
        compositions,
      }) as SceneNavigationTarget;

      await loadSceneNavigationTarget(target, {
        ctx: {},
        preloadAssets: () => undefined,
        runTimeline: (input) => {
          const captured: { beat?: string } = {};
          if ('beat' in input) captured.beat = input.beat;
          seen.push(captured);
        },
        beat: 'hook',
        onBeatMissing: () => undefined,
      });

      expect(seen).toEqual([{ beat: 'hook' }]);
    });

    it('forwards `beat` to the head scene only of a composition slice', async () => {
      // Composition slice with two entries; the head must receive
      // `beat`, the tail must not. ADR-015: URL beat targets the
      // active head scene only — no search through later scenes.
      // `composition-index` (per ADR-013) is the valid grammar for
      // pairing composition with beat; `kind: 'composition'` alone
      // would be rejected by the parser and the loader's defense-in-
      // depth check.
      const seen: { id: string; beat?: string }[] = [];
      const intro = buildScene({ id: 'intro' });
      const middle = buildScene({ id: 'middle' });
      const scenes = createSceneRegistry([intro, middle]);
      const compositions = createCompositionRegistry([
        { id: 'full-talk', manifest: ['intro', 'middle'] },
      ]);
      const target = resolveSceneNavigation(compositionIndexTarget('full-talk', 0), {
        scenes,
        compositions,
      }) as SceneNavigationTarget;

      await loadSceneNavigationTarget(target, {
        ctx: {},
        preloadAssets: () => undefined,
        runTimeline: (input) => {
          const captured: { id: string; beat?: string } = { id: input.scene.id };
          if ('beat' in input) captured.beat = input.beat;
          seen.push(captured);
        },
        beat: 'hook',
        onBeatMissing: () => undefined,
      });

      expect(seen).toEqual([{ id: 'intro', beat: 'hook' }, { id: 'middle' }]);
    });

    it('forwards `onBeatMissing` to the head scene only', async () => {
      const callbacks: (((() => void) | undefined) | 'absent')[] = [];
      const sentinel = (): void => undefined;
      const intro = buildScene({ id: 'intro' });
      const middle = buildScene({ id: 'middle' });
      const scenes = createSceneRegistry([intro, middle]);
      const compositions = createCompositionRegistry([
        { id: 'full-talk', manifest: ['intro', 'middle'] },
      ]);
      const target = resolveSceneNavigation(compositionIndexTarget('full-talk', 0), {
        scenes,
        compositions,
      }) as SceneNavigationTarget;

      await loadSceneNavigationTarget(target, {
        ctx: {},
        preloadAssets: () => undefined,
        runTimeline: (input) => {
          callbacks.push('onBeatMissing' in input ? input.onBeatMissing : 'absent');
        },
        beat: 'hook',
        onBeatMissing: sentinel,
      });

      expect(callbacks).toEqual([sentinel, 'absent']);
    });

    it('does not forward `onBeatMissing` when `beat` is omitted (paired contract)', async () => {
      // `onBeatMissing` is meaningless without a `beat` to trigger it.
      // The bridge drops the callback when the caller forgot to supply
      // a beat so the resolver / runner never see an impossible state.
      const onBeatMissingPresence: boolean[] = [];
      const intro = buildScene({ id: 'intro' });
      const scenes = createSceneRegistry([intro]);
      const compositions = createCompositionRegistry([]);
      const target = resolveSceneNavigation(sceneTarget('intro'), {
        scenes,
        compositions,
      }) as SceneNavigationTarget;

      await loadSceneNavigationTarget(target, {
        ctx: {},
        preloadAssets: () => undefined,
        runTimeline: (input) => {
          onBeatMissingPresence.push('onBeatMissing' in input);
        },
        onBeatMissing: () => undefined,
      });

      expect(onBeatMissingPresence).toEqual([false]);
    });

    it('throws when `beat` is supplied without `onBeatMissing` (paired-required contract)', async () => {
      // PUL-F011 / ADR-015: a `beat` without an `onBeatMissing` would
      // silently lose the missing-label diagnostic the runner is
      // contracted to surface. The bridge fails fast at the boundary,
      // mirroring the resolver's check.
      const intro = buildScene({ id: 'intro' });
      const scenes = createSceneRegistry([intro]);
      const compositions = createCompositionRegistry([]);
      const target = resolveSceneNavigation(sceneTarget('intro'), {
        scenes,
        compositions,
      }) as SceneNavigationTarget;

      await expect(
        loadSceneNavigationTarget(target, {
          ctx: {},
          preloadAssets: () => undefined,
          runTimeline: () => undefined,
          beat: 'hook',
        }),
      ).rejects.toThrow(
        /^scene navigation failed: "onBeatMissing" is required when "beat" is supplied/,
      );
    });

    it('does not forward `beat` when the option is omitted', async () => {
      const seen: SceneNavigationTarget['scene'][] = [];
      const beatPresence: boolean[] = [];
      const intro = buildScene({ id: 'intro' });
      const scenes = createSceneRegistry([intro]);
      const compositions = createCompositionRegistry([]);
      const target = resolveSceneNavigation(sceneTarget('intro'), {
        scenes,
        compositions,
      }) as SceneNavigationTarget;

      await loadSceneNavigationTarget(target, {
        ctx: {},
        preloadAssets: () => undefined,
        runTimeline: (input) => {
          seen.push(input.scene);
          beatPresence.push('beat' in input);
        },
      });

      expect(seen).toHaveLength(1);
      expect(beatPresence).toEqual([false]);
    });
  });
});
