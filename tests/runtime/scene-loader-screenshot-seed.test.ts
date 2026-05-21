import { describe, expect, it } from 'vitest';
import type { NavigationTarget } from '../../src/runtime/navigation';
import { deriveNavigationSeed } from '../../src/runtime/scene-loader';
import { PULSAR_RUNTIME_VERSION } from '../../src/runtime/version';
import {
  type WorkbenchSceneCtx,
  buildScene,
  buildStage,
  createCompositionRegistry,
  createSceneLoader,
  createSceneRegistry,
  noopTimeline,
  stubCtx,
} from './scene-loader.helpers';

// PUL-F018 / ADR-021 — deterministic seeded RNG on the scene context.
//
// PUL-F018 statement: in `mode=screenshot` the runtime SHALL render the
// addressed scene "with ... any randomness sourced from a deterministic
// seed." ADR-021 routes that clause through a seed surface on `ctx`: the
// loader derives a per-navigation seed from bounded, deterministic URL
// inputs and exposes a scene-consumable RNG on `WorkbenchSceneCtx.rng`.
//
// These suites pin (1) the seed-derivation helper — pure, bounded, and
// distinct per addressed target — and (2) the loader threading the RNG
// into every scene occurrence's `ctx` so two navigations of the same
// screenshot URL replay an identical random sequence.

describe('deriveNavigationSeed (PUL-F018 / ADR-021)', () => {
  it('is pure — structurally equal targets yield the same seed', () => {
    const a: NavigationTarget = { locator: { kind: 'scene', scene: 'scene-a' }, beat: 'intro' };
    const b: NavigationTarget = { locator: { kind: 'scene', scene: 'scene-a' }, beat: 'intro' };
    expect(deriveNavigationSeed(a)).toBe(deriveNavigationSeed(b));
  });

  it('embeds the runtime revision so a bundle bump changes the seed', () => {
    // The derived seed must include PULSAR_RUNTIME_VERSION (ADR-021:
    // "a bundle/runtime revision literal") — pin it by substring so a
    // regression that drops the revision input is caught.
    expect(deriveNavigationSeed({ locator: { kind: 'scene', scene: 'scene-a' } })).toContain(
      PULSAR_RUNTIME_VERSION,
    );
  });

  it('separates distinct addressed locators', () => {
    const seeds = [
      deriveNavigationSeed({ locator: { kind: 'none' } }),
      deriveNavigationSeed({ locator: { kind: 'scene', scene: 'scene-a' } }),
      deriveNavigationSeed({ locator: { kind: 'scene', scene: 'scene-b' } }),
      deriveNavigationSeed({ locator: { kind: 'composition', composition: 'talk' } }),
      deriveNavigationSeed({
        locator: { kind: 'composition-scene', composition: 'talk', scene: 'scene-a' },
      }),
      deriveNavigationSeed({
        locator: { kind: 'composition-index', composition: 'talk', index: 0 },
      }),
      deriveNavigationSeed({
        locator: { kind: 'composition-index', composition: 'talk', index: 1 },
      }),
    ];
    expect(new Set(seeds).size).toBe(seeds.length);
  });

  it('separates a present beat from an absent beat and from a different beat', () => {
    const noBeat = deriveNavigationSeed({ locator: { kind: 'scene', scene: 'scene-a' } });
    const intro = deriveNavigationSeed({
      locator: { kind: 'scene', scene: 'scene-a' },
      beat: 'intro',
    });
    const outro = deriveNavigationSeed({
      locator: { kind: 'scene', scene: 'scene-a' },
      beat: 'outro',
    });
    expect(new Set([noBeat, intro, outro]).size).toBe(3);
  });

  it('does not depend on mode — the addressed frame is mode-independent', () => {
    // ADR-021 lists the seed inputs as the normalized locator, the
    // addressed beat, and the runtime revision — not the workbench
    // mode. `?scene=x&beat=y` addresses the same frame whether it is
    // captured (`screenshot`) or played (`present`).
    const base: NavigationTarget = { locator: { kind: 'scene', scene: 'scene-a' }, beat: 'intro' };
    expect(deriveNavigationSeed({ ...base, mode: 'screenshot' })).toBe(
      deriveNavigationSeed({ ...base, mode: 'present' }),
    );
    expect(deriveNavigationSeed({ ...base, mode: 'screenshot' })).toBe(deriveNavigationSeed(base));
  });
});

describe('createSceneLoader — deterministic ctx.rng (PUL-F018 / ADR-021)', () => {
  // Drive one navigation; return the random draws each scene occurrence
  // pulled from `ctx.rng` during `create(ctx)`, keyed by occurrence.
  const drawsForNavigation = async (
    target: NavigationTarget,
    scenes: readonly string[],
    composition?: { id: string; manifest: string[] },
  ): Promise<Map<number, number[]>> => {
    const byOccurrence = new Map<number, number[]>();
    const sceneModules = scenes.map((id) =>
      buildScene({
        id,
        create: (ctx: unknown): void => {
          const c = ctx as WorkbenchSceneCtx;
          byOccurrence.set(c.activation.occurrence, [c.rng(), c.rng(), c.rng(), c.rng(), c.rng()]);
        },
      }),
    );
    const loader = createSceneLoader({
      scenes: createSceneRegistry(sceneModules),
      compositions: createCompositionRegistry(composition === undefined ? [] : [composition]),
      stage: buildStage().element,
      buildCtx: stubCtx,
      createPreloader: () => () => undefined,
      timeline: noopTimeline,
    });
    await loader.handle(target);
    return byOccurrence;
  };

  it('exposes a callable `ctx.rng` on every navigation, including non-screenshot modes', async () => {
    const draws = await drawsForNavigation({ locator: { kind: 'scene', scene: 'scene-a' } }, [
      'scene-a',
    ]);
    expect(draws.get(0)).toHaveLength(5);
    for (const v of draws.get(0) ?? []) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('replays an identical random sequence across two navigations of the same screenshot URL', async () => {
    const target: NavigationTarget = {
      locator: { kind: 'scene', scene: 'scene-a' },
      beat: 'intro',
      mode: 'screenshot',
    };
    const first = await drawsForNavigation(target, ['scene-a']);
    const second = await drawsForNavigation(target, ['scene-a']);
    expect(first.get(0)).toEqual(second.get(0));
  });

  it('produces a different random sequence for a different addressed beat', async () => {
    const intro = await drawsForNavigation(
      { locator: { kind: 'scene', scene: 'scene-a' }, beat: 'intro', mode: 'screenshot' },
      ['scene-a'],
    );
    const outro = await drawsForNavigation(
      { locator: { kind: 'scene', scene: 'scene-a' }, beat: 'outro', mode: 'screenshot' },
      ['scene-a'],
    );
    expect(intro.get(0)).not.toEqual(outro.get(0));
  });

  it('gives each occurrence of a repeated scene id an independent RNG stream', async () => {
    // issue #99: a composition slice may reference the same scene id
    // more than once. ADR-021's seed/RNG guardrail requires the RNG be
    // scoped per activation, not a shared singleton — so one
    // occurrence's draws cannot perturb a sibling occurrence's stream.
    const draws = await drawsForNavigation(
      { locator: { kind: 'composition', composition: 'twice' } },
      ['dup'],
      { id: 'twice', manifest: ['dup', 'dup'] },
    );
    expect(draws.size).toBe(2);
    expect(draws.get(0)).not.toEqual(draws.get(1));
  });
});
