// PUL-F008 — URL parameter `scene` selects the runtime navigation target.
//
// The spec covers:
//  - parsing/extraction (which URL/URLSearchParams shapes are accepted),
//  - identifier-shape validation via the shared `isKebabIdentifier`,
//  - existence resolution via the SceneRegistry,
//  - explicit handling of repeated/conflicting `scene` parameters,
//  - the lifecycle bridge (`loadSceneNavigationTarget`) that routes
//    a navigation target through the existing composition resolver so
//    the URL path inherits PUL-F004's preload → create → timeline →
//    cleanup contract and PUL-F006's mandatory-cleanup invariant.
//
// References:
//  - PUL-F008 statement: when `scene` is present the runtime SHALL
//    load the addressed scene as the navigation target.
//  - ADR-013 — boundary decisions for the scene URL parameter.
//  - ADR-002 §Navigation — the URL grammar.
//  - ADR-007 — workbench URL parameters; `mode` is orthogonal to
//    scene resolution.

import { describe, expect, it } from 'vitest';
import { createCompositionRegistry } from '../../src/runtime/composition-registry';
import { createSceneRegistry } from '../../src/runtime/registry';
import type { SceneModule } from '../../src/runtime/scene';
import {
  type SceneNavigationTarget,
  loadSceneNavigationTarget,
  resolveSceneNavigationTarget,
} from '../../src/runtime/url-navigation';

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

describe('resolveSceneNavigationTarget (PUL-F008)', () => {
  describe('happy paths — scene present, valid, in registry', () => {
    it('returns a navigation target whose `scene` is the registry module for the addressed id', () => {
      const intro = buildScene({ id: 'intro' });
      const middle = buildScene({ id: 'middle' });
      const registry = createSceneRegistry([intro, middle]);

      const target = resolveSceneNavigationTarget(new URLSearchParams('scene=middle'), registry);

      expect(target).not.toBeNull();
      expect(target?.scene).toBe(middle);
    });

    it('accepts a URL object', () => {
      const intro = buildScene({ id: 'intro' });
      const registry = createSceneRegistry([intro]);

      const target = resolveSceneNavigationTarget(
        new URL('https://workbench.test/?scene=intro'),
        registry,
      );

      expect(target?.scene).toBe(intro);
    });

    it('accepts a full URL string', () => {
      const intro = buildScene({ id: 'intro' });
      const registry = createSceneRegistry([intro]);

      const target = resolveSceneNavigationTarget('https://workbench.test/?scene=intro', registry);

      expect(target?.scene).toBe(intro);
    });

    it('accepts a bare search string', () => {
      const intro = buildScene({ id: 'intro' });
      const registry = createSceneRegistry([intro]);

      const target = resolveSceneNavigationTarget('?scene=intro', registry);

      expect(target?.scene).toBe(intro);
    });

    it('accepts a search string without the leading "?"', () => {
      const intro = buildScene({ id: 'intro' });
      const registry = createSceneRegistry([intro]);

      const target = resolveSceneNavigationTarget('scene=intro', registry);

      expect(target?.scene).toBe(intro);
    });

    it('accepts a Location-like object (`{ search }` shape)', () => {
      // Pin the `{ search: string }` branch of `SceneUrlInput`. The
      // browser bootstrap calls this with `window.location`, which is a
      // `Location` not a `URL` / `URLSearchParams`; using a plain
      // `{ search }` literal guarantees the parser handles that branch
      // independently of any DOM lib types.
      const intro = buildScene({ id: 'intro' });
      const registry = createSceneRegistry([intro]);

      const target = resolveSceneNavigationTarget({ search: '?scene=intro' }, registry);

      expect(target?.scene).toBe(intro);
    });

    it('accepts a Location-like object whose `search` is empty', () => {
      const intro = buildScene({ id: 'intro' });
      const registry = createSceneRegistry([intro]);
      expect(resolveSceneNavigationTarget({ search: '' }, registry)).toBeNull();
    });
  });

  describe('scene parameter absent — returns null', () => {
    it('returns null for an empty URLSearchParams', () => {
      const registry = createSceneRegistry([buildScene({ id: 'intro' })]);
      expect(resolveSceneNavigationTarget(new URLSearchParams(), registry)).toBeNull();
    });

    it('returns null for an empty URL search string', () => {
      const registry = createSceneRegistry([buildScene({ id: 'intro' })]);
      expect(resolveSceneNavigationTarget('', registry)).toBeNull();
    });

    it('returns null for a URL with only unrelated parameters', () => {
      const registry = createSceneRegistry([buildScene({ id: 'intro' })]);
      const target = resolveSceneNavigationTarget(
        'https://workbench.test/?mode=screenshot&beat=hook',
        registry,
      );
      expect(target).toBeNull();
    });

    it('returns null for a URL object whose searchParams is empty', () => {
      const registry = createSceneRegistry([buildScene({ id: 'intro' })]);
      expect(resolveSceneNavigationTarget(new URL('https://workbench.test/'), registry)).toBeNull();
    });
  });

  describe('repeated scene parameter — explicit rejection (ADR-013)', () => {
    it('throws when `scene` appears twice with different values', () => {
      const registry = createSceneRegistry([
        buildScene({ id: 'intro' }),
        buildScene({ id: 'middle' }),
      ]);
      expect(() => resolveSceneNavigationTarget('?scene=intro&scene=middle', registry)).toThrow(
        /^scene navigation failed: `scene` URL parameter appears 2 times \("intro", "middle"\); expected exactly one$/,
      );
    });

    it('throws when `scene` appears three times', () => {
      const registry = createSceneRegistry([buildScene({ id: 'intro' })]);
      expect(() => resolveSceneNavigationTarget('?scene=a&scene=b&scene=c', registry)).toThrow(
        /^scene navigation failed: `scene` URL parameter appears 3 times/,
      );
    });

    it('throws even when both scene parameters carry the same value', () => {
      const registry = createSceneRegistry([buildScene({ id: 'intro' })]);
      expect(() => resolveSceneNavigationTarget('?scene=intro&scene=intro', registry)).toThrow(
        /^scene navigation failed: `scene` URL parameter appears 2 times/,
      );
    });

    it('does not call registry.has or registry.get when the parameter is repeated', () => {
      const intro = buildScene({ id: 'intro' });
      const registry = createSceneRegistry([intro]);
      const calls: string[] = [];
      const sentinel = {
        has: (id: string) => {
          calls.push(`has(${id})`);
          return registry.has(id);
        },
        get: (id: string) => {
          calls.push(`get(${id})`);
          return registry.get(id);
        },
        ids: () => registry.ids(),
        get size() {
          return registry.size;
        },
      };
      expect(() => resolveSceneNavigationTarget('?scene=intro&scene=intro', sentinel)).toThrow();
      expect(calls).toEqual([]);
    });
  });

  describe('malformed identifier shape — reuses isKebabIdentifier (ADR-013)', () => {
    it.each<[label: string, raw: string]>([
      ['empty string', ''],
      ['uppercase', 'Scene-A'],
      ['screaming kebab', 'SCENE-A'],
      ['underscore', 'scene_a'],
      ['leading hyphen', '-scene-a'],
      ['trailing hyphen', 'scene-a-'],
      ['consecutive hyphens', 'scene--a'],
      ['whitespace inside', 'scene a'],
      ['leading whitespace', ' scene-a'],
      ['punctuation', 'scene!'],
      ['non-ASCII', 'scéne-a'],
      ['slash', 'scene/a'],
      ['dot', 'scene.a'],
    ])('throws on %s (%j)', (_label, raw) => {
      const registry = createSceneRegistry([buildScene({ id: 'intro' })]);
      const params = new URLSearchParams();
      params.set('scene', raw);
      expect(() => resolveSceneNavigationTarget(params, registry)).toThrow(
        /^scene navigation failed: scene id ".*" is not a valid kebab-case identifier/,
      );
    });

    it('does not call the registry on a malformed scene id', () => {
      const calls: string[] = [];
      const blockingRegistry = {
        has: (id: string) => {
          calls.push(`has(${id})`);
          return false;
        },
        get: (id: string) => {
          calls.push(`get(${id})`);
          throw new Error('unreachable');
        },
        ids: () => [],
        size: 0,
      } as const;
      expect(() => resolveSceneNavigationTarget('?scene=Scene-A', blockingRegistry)).toThrow(
        /scene navigation failed: scene id "Scene-A"/,
      );
      expect(calls).toEqual([]);
    });
  });

  describe('unknown scene id — registry miss is a navigation error', () => {
    it('throws when the id is well-formed but not registered', () => {
      const registry = createSceneRegistry([buildScene({ id: 'intro' })]);
      expect(() => resolveSceneNavigationTarget('?scene=unknown-scene', registry)).toThrow(
        /^scene navigation failed: scene "unknown-scene" is not registered$/,
      );
    });

    it('does not call registry.get when registry.has returns false', () => {
      const calls: string[] = [];
      const sentinel = {
        has: (id: string) => {
          calls.push(`has(${id})`);
          return false;
        },
        get: (id: string) => {
          calls.push(`get(${id})`);
          throw new Error('unreachable');
        },
        ids: () => [],
        size: 0,
      } as const;
      expect(() => resolveSceneNavigationTarget('?scene=intro', sentinel)).toThrow();
      expect(calls).toEqual(['has(intro)']);
    });
  });

  describe('lifecycle is not touched on the failure paths (ADR-013)', () => {
    it('does not invoke create / timeline / cleanup when the id is malformed', () => {
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
      const registry = createSceneRegistry([intro]);
      expect(() => resolveSceneNavigationTarget('?scene=NOT-KEBAB', registry)).toThrow();
      expect(calls).toEqual([]);
    });

    it('does not invoke create / timeline / cleanup when the id is unknown', () => {
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
      const registry = createSceneRegistry([intro]);
      expect(() => resolveSceneNavigationTarget('?scene=unknown', registry)).toThrow();
      expect(calls).toEqual([]);
    });
  });

  describe('orthogonality — `mode`, `index`, `beat` do not affect scene resolution', () => {
    it.each<[label: string, query: string]>([
      ['mode=screenshot', '?scene=intro&mode=screenshot'],
      ['mode=loop', '?scene=intro&mode=loop'],
      ['beat=hook', '?scene=intro&beat=hook'],
      ['index=2', '?scene=intro&index=2'],
      ['index+beat+mode', '?scene=intro&index=2&beat=hook&mode=loop'],
    ])('returns the same navigation target with %s alongside scene', (_label, query) => {
      const intro = buildScene({ id: 'intro' });
      const registry = createSceneRegistry([intro]);
      const target = resolveSceneNavigationTarget(query, registry);
      expect(target?.scene).toBe(intro);
    });

    it('does not let `index` become identity when `scene` is supplied', () => {
      // Two scenes; index 0 is `intro`, index 1 is `middle`. The URL
      // names `?scene=middle&index=0`. Per ADR-013 `index` must NOT
      // override `scene` — the resolved target is `middle`.
      const intro = buildScene({ id: 'intro' });
      const middle = buildScene({ id: 'middle' });
      const registry = createSceneRegistry([intro, middle]);
      const target = resolveSceneNavigationTarget('?scene=middle&index=0', registry);
      expect(target?.scene).toBe(middle);
    });
  });

  describe('composition+scene combination (ADR-002 §Navigation)', () => {
    // ADR-013 + ADR-002: `?composition=X&scene=Y` selects scene Y as
    // the navigation target *within* composition X. The resolver
    // resolves composition X via the composition registry, validates
    // scene Y is a member, and snapshots the manifest slice from Y
    // onwards plus the matching scene modules so the bridge can run
    // the slice through `resolveComposition` without re-resolving by
    // id (which would let a different registry substitute scenes).

    it('resolves the addressed scene within the composition and snapshots the slice from that scene onwards', () => {
      const intro = buildScene({ id: 'intro' });
      const middle = buildScene({ id: 'middle' });
      const outro = buildScene({ id: 'outro' });
      const sceneRegistry = createSceneRegistry([intro, middle, outro]);
      const compositionRegistry = createCompositionRegistry([
        { id: 'full-talk', manifest: ['intro', 'middle', 'outro'] },
      ]);

      const target = resolveSceneNavigationTarget(
        '?composition=full-talk&scene=middle',
        sceneRegistry,
        compositionRegistry,
      );

      expect(target?.scene).toBe(middle);
      expect(target?.composition?.id).toBe('full-talk');
      expect(target?.composition?.manifestSlice).toEqual(['middle', 'outro']);
      expect(target?.composition?.sceneSlice).toEqual([middle, outro]);
    });

    it('preserves per-entry override objects in the slice', () => {
      // Entry overrides (range, behavior) on object-form composition
      // entries must survive slicing so the runner adapter still
      // receives sub-range and behavior overrides for entries inside
      // the slice. Bare-string entries stay bare strings.
      const intro = buildScene({ id: 'intro' });
      const middle = buildScene({ id: 'middle' });
      const outro = buildScene({ id: 'outro' });
      const sceneRegistry = createSceneRegistry([intro, middle, outro]);
      const compositionRegistry = createCompositionRegistry([
        {
          id: 'trailer',
          manifest: [
            { id: 'intro', range: 'hook' },
            'middle',
            { id: 'outro', behavior: { fade: true } },
          ],
        },
      ]);

      const target = resolveSceneNavigationTarget(
        '?composition=trailer&scene=middle',
        sceneRegistry,
        compositionRegistry,
      );

      expect(target?.composition?.manifestSlice).toEqual([
        'middle',
        { id: 'outro', behavior: { fade: true } },
      ]);
    });

    it('returns the full manifest as the slice when the addressed scene is the first entry', () => {
      const intro = buildScene({ id: 'intro' });
      const middle = buildScene({ id: 'middle' });
      const sceneRegistry = createSceneRegistry([intro, middle]);
      const compositionRegistry = createCompositionRegistry([
        { id: 'full-talk', manifest: ['intro', 'middle'] },
      ]);

      const target = resolveSceneNavigationTarget(
        '?composition=full-talk&scene=intro',
        sceneRegistry,
        compositionRegistry,
      );

      expect(target?.composition?.manifestSlice).toEqual(['intro', 'middle']);
      expect(target?.composition?.sceneSlice).toEqual([intro, middle]);
    });

    it('returns a single-entry slice when the addressed scene is the last entry', () => {
      const intro = buildScene({ id: 'intro' });
      const outro = buildScene({ id: 'outro' });
      const sceneRegistry = createSceneRegistry([intro, outro]);
      const compositionRegistry = createCompositionRegistry([
        { id: 'full-talk', manifest: ['intro', 'outro'] },
      ]);

      const target = resolveSceneNavigationTarget(
        '?composition=full-talk&scene=outro',
        sceneRegistry,
        compositionRegistry,
      );

      expect(target?.composition?.manifestSlice).toEqual(['outro']);
      expect(target?.composition?.sceneSlice).toEqual([outro]);
    });

    it('throws when `composition` is repeated', () => {
      const intro = buildScene({ id: 'intro' });
      const sceneRegistry = createSceneRegistry([intro]);
      const compositionRegistry = createCompositionRegistry([
        { id: 'full-talk', manifest: ['intro'] },
      ]);
      expect(() =>
        resolveSceneNavigationTarget(
          '?composition=full-talk&composition=trailer&scene=intro',
          sceneRegistry,
          compositionRegistry,
        ),
      ).toThrow(/^scene navigation failed: `composition` URL parameter appears 2 times/);
    });

    it('throws when the composition id is malformed', () => {
      const intro = buildScene({ id: 'intro' });
      const sceneRegistry = createSceneRegistry([intro]);
      const compositionRegistry = createCompositionRegistry([
        { id: 'full-talk', manifest: ['intro'] },
      ]);
      expect(() =>
        resolveSceneNavigationTarget(
          '?composition=Full-Talk&scene=intro',
          sceneRegistry,
          compositionRegistry,
        ),
      ).toThrow(/^scene navigation failed: composition id "Full-Talk" is not a valid kebab-case/);
    });

    it('throws when the composition value is empty', () => {
      const intro = buildScene({ id: 'intro' });
      const sceneRegistry = createSceneRegistry([intro]);
      const compositionRegistry = createCompositionRegistry([
        { id: 'full-talk', manifest: ['intro'] },
      ]);
      expect(() =>
        resolveSceneNavigationTarget(
          '?composition=&scene=intro',
          sceneRegistry,
          compositionRegistry,
        ),
      ).toThrow(/^scene navigation failed: composition id "" is not a valid kebab-case/);
    });

    it('throws when the composition is not registered', () => {
      const intro = buildScene({ id: 'intro' });
      const sceneRegistry = createSceneRegistry([intro]);
      const compositionRegistry = createCompositionRegistry([]);
      expect(() =>
        resolveSceneNavigationTarget(
          '?composition=missing-talk&scene=intro',
          sceneRegistry,
          compositionRegistry,
        ),
      ).toThrow(/^scene navigation failed: composition "missing-talk" is not registered$/);
    });

    it('throws when the addressed scene is not a member of the composition', () => {
      const intro = buildScene({ id: 'intro' });
      const middle = buildScene({ id: 'middle' });
      const sceneRegistry = createSceneRegistry([intro, middle]);
      const compositionRegistry = createCompositionRegistry([
        { id: 'full-talk', manifest: ['intro'] },
      ]);
      expect(() =>
        resolveSceneNavigationTarget(
          '?composition=full-talk&scene=middle',
          sceneRegistry,
          compositionRegistry,
        ),
      ).toThrow(
        /^scene navigation failed: scene "middle" is not a member of composition "full-talk"$/,
      );
    });

    it('throws when `composition` is supplied but no composition registry was passed', () => {
      const intro = buildScene({ id: 'intro' });
      const sceneRegistry = createSceneRegistry([intro]);
      expect(() =>
        resolveSceneNavigationTarget('?composition=full-talk&scene=intro', sceneRegistry),
      ).toThrow(
        /^scene navigation failed: composition registry was not provided to the navigation resolver/,
      );
    });

    it('does not invoke any lifecycle hook on any composition-error path', () => {
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
      const sceneRegistry = createSceneRegistry([intro]);
      const compositionRegistry = createCompositionRegistry([]);

      // Each error path that involves composition handling.
      expect(() =>
        resolveSceneNavigationTarget(
          '?composition=Bad-Id&scene=intro',
          sceneRegistry,
          compositionRegistry,
        ),
      ).toThrow();
      expect(() =>
        resolveSceneNavigationTarget(
          '?composition=missing&scene=intro',
          sceneRegistry,
          compositionRegistry,
        ),
      ).toThrow();
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
    const registry = createSceneRegistry([intro]);
    const target = resolveSceneNavigationTarget('?scene=intro', registry) as SceneNavigationTarget;

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
    const registry = createSceneRegistry([intro]);
    const target = resolveSceneNavigationTarget('?scene=intro', registry) as SceneNavigationTarget;

    await expect(
      loadSceneNavigationTarget(target, {
        ctx: {},
        preloadAssets: (scene) => {
          log.push(`preload:${scene.id}`);
        },
        runTimeline: () => {
          log.push('runTimeline-should-not-fire');
        },
      }),
    ).rejects.toThrow(/composition resolution failed: scene "intro" create threw/);

    expect(log).toEqual(['preload:intro', 'create', 'cleanup']);
  });

  it('aborts before create/timeline/cleanup when preload throws', async () => {
    const log: string[] = [];
    const intro = buildScene({
      id: 'intro',
      create: () => {
        log.push('create');
      },
      timeline: () => {
        log.push('timeline');
      },
      cleanup: () => {
        log.push('cleanup');
      },
    });
    const registry = createSceneRegistry([intro]);
    const target = resolveSceneNavigationTarget('?scene=intro', registry) as SceneNavigationTarget;

    await expect(
      loadSceneNavigationTarget(target, {
        ctx: {},
        preloadAssets: () => {
          log.push('preload');
          throw new Error('preload failed');
        },
        runTimeline: () => {
          log.push('runTimeline');
        },
      }),
    ).rejects.toThrow(/composition resolution failed: scene "intro" preloadAssets threw/);

    expect(log).toEqual(['preload']);
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
    const registry = createSceneRegistry([intro]);
    const target = resolveSceneNavigationTarget('?scene=intro', registry) as SceneNavigationTarget;

    await loadSceneNavigationTarget(target, {
      ctx,
      preloadAssets: () => undefined,
      runTimeline: () => undefined,
    });

    expect(seen).toEqual([ctx, ctx, ctx]);
  });

  it('runs the resolved scene module even when a sibling registry maps the same id elsewhere', async () => {
    // Identity guarantee: passing a different registry that maps the
    // same id to a different scene module must not divert the bridge to
    // the wrong module. The bridge synthesizes its own registry from
    // `target.scene`, so the module the lifecycle runs is always the
    // module the navigation resolver returned. This pins codex's review
    // finding that the original implementation re-resolved by id and
    // could run a different module.
    const log: string[] = [];
    const resolvedIntro = buildScene({
      id: 'intro',
      create: () => {
        log.push('resolved-create');
      },
    });
    const decoyIntro = buildScene({
      id: 'intro',
      create: () => {
        log.push('decoy-create');
      },
    });
    // Resolve through a registry containing the real `intro`.
    const realRegistry = createSceneRegistry([resolvedIntro]);
    const target = resolveSceneNavigationTarget(
      '?scene=intro',
      realRegistry,
    ) as SceneNavigationTarget;
    expect(target.scene).toBe(resolvedIntro);
    // Show that even if the caller has a different registry mapping the
    // same id, the bridge runs the resolved scene module.
    void createSceneRegistry([decoyIntro]);

    await loadSceneNavigationTarget(target, {
      ctx: {},
      preloadAssets: () => undefined,
      runTimeline: () => undefined,
    });

    expect(log).toEqual(['resolved-create']);
  });

  describe('composition+scene execution', () => {
    it('runs the manifest slice from the addressed scene through the lifecycle, in order', async () => {
      const log: string[] = [];
      const make = (id: string): SceneModule =>
        buildScene({
          id,
          create: () => {
            log.push(`${id}:create`);
          },
          timeline: () => {
            log.push(`${id}:timeline`);
            return `${id}-timeline`;
          },
          cleanup: () => {
            log.push(`${id}:cleanup`);
          },
        });
      const intro = make('intro');
      const middle = make('middle');
      const outro = make('outro');
      const sceneRegistry = createSceneRegistry([intro, middle, outro]);
      const compositionRegistry = createCompositionRegistry([
        { id: 'full-talk', manifest: ['intro', 'middle', 'outro'] },
      ]);
      const target = resolveSceneNavigationTarget(
        '?composition=full-talk&scene=middle',
        sceneRegistry,
        compositionRegistry,
      ) as SceneNavigationTarget;

      await loadSceneNavigationTarget(target, {
        ctx: {},
        preloadAssets: (scene) => {
          log.push(`${scene.id}:preload`);
        },
        runTimeline: ({ scene, timeline }) => {
          log.push(`${scene.id}:runTimeline:${String(timeline)}`);
        },
      });

      // intro is upstream of the addressed scene and is NOT played.
      expect(log).toEqual([
        'middle:preload',
        'middle:create',
        'middle:timeline',
        'middle:runTimeline:middle-timeline',
        'middle:cleanup',
        'outro:preload',
        'outro:create',
        'outro:timeline',
        'outro:runTimeline:outro-timeline',
        'outro:cleanup',
      ]);
    });

    it('runs the resolved scene modules even when a sibling registry maps the same ids elsewhere', async () => {
      // Identity guarantee for the composition path: the bridge runs
      // the snapshot the resolver captured, not the modules `options`
      // might point at.
      const log: string[] = [];
      const realIntro = buildScene({
        id: 'intro',
        create: () => {
          log.push('real-intro:create');
        },
      });
      const realOutro = buildScene({
        id: 'outro',
        create: () => {
          log.push('real-outro:create');
        },
      });
      const realScenes = createSceneRegistry([realIntro, realOutro]);
      const compositions = createCompositionRegistry([
        { id: 'full-talk', manifest: ['intro', 'outro'] },
      ]);
      const target = resolveSceneNavigationTarget(
        '?composition=full-talk&scene=intro',
        realScenes,
        compositions,
      ) as SceneNavigationTarget;
      // A separate registry with the same ids would resolve different
      // modules; the bridge must NOT consult it.
      void createSceneRegistry([
        buildScene({
          id: 'intro',
          create: () => {
            log.push('decoy-intro:create');
          },
        }),
        buildScene({
          id: 'outro',
          create: () => {
            log.push('decoy-outro:create');
          },
        }),
      ]);

      await loadSceneNavigationTarget(target, {
        ctx: {},
        preloadAssets: () => undefined,
        runTimeline: () => undefined,
      });

      expect(log).toEqual(['real-intro:create', 'real-outro:create']);
    });

    it('forwards per-entry overrides (range, behavior) to the runner adapter', async () => {
      const seenInputs: { id: string; range?: unknown; behavior?: unknown }[] = [];
      const intro = buildScene({ id: 'intro', timeline: () => 'intro-tl' });
      const outro = buildScene({ id: 'outro', timeline: () => 'outro-tl' });
      const sceneRegistry = createSceneRegistry([intro, outro]);
      const compositionRegistry = createCompositionRegistry([
        {
          id: 'mixed',
          manifest: [
            { id: 'intro', range: 'hook' },
            { id: 'outro', behavior: { fade: true } },
          ],
        },
      ]);
      const target = resolveSceneNavigationTarget(
        '?composition=mixed&scene=intro',
        sceneRegistry,
        compositionRegistry,
      ) as SceneNavigationTarget;

      await loadSceneNavigationTarget(target, {
        ctx: {},
        preloadAssets: () => undefined,
        runTimeline: (input) => {
          const captured: { id: string; range?: unknown; behavior?: unknown } = {
            id: input.scene.id,
          };
          if ('range' in input) captured.range = input.range;
          if ('behavior' in input) captured.behavior = input.behavior;
          seenInputs.push(captured);
        },
      });

      expect(seenInputs).toEqual([
        { id: 'intro', range: 'hook' },
        { id: 'outro', behavior: { fade: true } },
      ]);
    });
  });
});
