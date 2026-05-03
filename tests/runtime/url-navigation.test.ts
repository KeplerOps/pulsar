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

  describe('composition+scene combination — explicit rejection (ADR-013)', () => {
    // ADR-013 promises that `?composition=X&scene=Y` selects scene Y
    // *within* composition X. Composition handling lands with a future
    // requirement; for now the resolver rejects the combination so the
    // gap fails loudly rather than producing a single-scene target that
    // ignores the composition context.
    it('throws when both `scene` and `composition` are present', () => {
      const intro = buildScene({ id: 'intro' });
      const registry = createSceneRegistry([intro]);
      expect(() =>
        resolveSceneNavigationTarget('?scene=intro&composition=full-talk', registry),
      ).toThrow(
        /^scene navigation failed: `scene` combined with `composition` is not yet supported/,
      );
    });

    it('throws even when `composition` is empty-valued', () => {
      const intro = buildScene({ id: 'intro' });
      const registry = createSceneRegistry([intro]);
      expect(() => resolveSceneNavigationTarget('?scene=intro&composition=', registry)).toThrow(
        /scene navigation failed: `scene` combined with `composition` is not yet supported/,
      );
    });

    it('rejects regardless of additional `mode` / `index` / `beat` parameters', () => {
      const intro = buildScene({ id: 'intro' });
      const registry = createSceneRegistry([intro]);
      expect(() =>
        resolveSceneNavigationTarget(
          '?scene=intro&composition=full-talk&index=2&beat=hook&mode=loop',
          registry,
        ),
      ).toThrow(
        /scene navigation failed: `scene` combined with `composition` is not yet supported/,
      );
    });

    it('does not look up the registry when `composition` is also present', () => {
      // The combination is rejected at the URL-parse boundary; the
      // registry is never consulted, so even an unknown scene id throws
      // the composition-combination error rather than the registry-miss
      // error.
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
      expect(() =>
        resolveSceneNavigationTarget('?scene=missing&composition=full-talk', sentinel),
      ).toThrow(/composition.*not yet supported/);
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
});
