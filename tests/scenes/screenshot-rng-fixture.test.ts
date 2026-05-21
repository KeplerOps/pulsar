// PUL-F018 / ADR-021 — screenshot RNG verification fixture unit tests.
//
// The fixture scene is exercised end-to-end by Playwright in
// `tests-e2e/screenshot-mode.spec.ts`, where two loads of the same
// `?scene=screenshot-rng-fixture&mode=screenshot` URL must project an
// identical `data-pulsar-screenshot-rng` attribute. These unit tests
// cover the PUL-F001 contract shape, the ctx defensiveness, and the
// behavior unique to this fixture: `create(ctx)` draws a fixed number
// of values from `ctx.rng` and projects them onto the fixture
// element's `data-pulsar-screenshot-rng` attribute, so the same seeded
// generator yields the same attribute and a different generator does
// not.

import { describe, expect, it } from 'vitest';
import { createSeededRng } from '../../src/runtime/rng';
import { screenshotRngFixtureScene } from '../../src/scenes/screenshot-rng-fixture';

interface FakeStage {
  readonly children: { attrs: Map<string, string> }[];
  readonly element: {
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
    appendChild(node: unknown): unknown;
    querySelector(selector: string): {
      setAttribute(name: string, value: string): void;
      remove(): void;
    } | null;
    ownerDocument: {
      createElement(tag: string): { setAttribute(name: string, value: string): void };
    };
  };
}

// Stage stub mirroring `scrub-fixture.test.ts`: `appendChild` records
// children, `querySelector` looks them up by the attribute name in the
// `[<attr>]` selector, and `ownerDocument.createElement` returns a
// recording stub. The fixture allocates DOM through the stage's owner
// document rather than an ambient `document` global (ADR-008 #2).
const buildStage = (): FakeStage => {
  const children: { attrs: Map<string, string> }[] = [];
  return {
    children,
    element: {
      setAttribute: () => undefined,
      removeAttribute: () => undefined,
      appendChild: (node: unknown) => {
        children.push(node as { attrs: Map<string, string> });
        return node;
      },
      querySelector: (selector: string) => {
        const attr = selector.replace(/^\[|\]$/g, '').split('=')[0];
        if (attr === undefined) return null;
        for (let i = 0; i < children.length; i += 1) {
          const child = children[i];
          if (child === undefined) continue;
          if (child.attrs.has(attr)) {
            return {
              setAttribute: (name: string, value: string) => child.attrs.set(name, value),
              remove: () => {
                children.splice(i, 1);
              },
            };
          }
        }
        return null;
      },
      ownerDocument: {
        createElement: () => {
          const attrs = new Map<string, string>();
          return {
            attrs,
            setAttribute: (name: string, value: string) => attrs.set(name, value),
          };
        },
      },
    },
  };
};

const RNG_ATTR = 'data-pulsar-screenshot-rng';
const TARGET_ATTR = 'data-pulsar-screenshot-rng-target';

// Build a `create`-ready ctx with a seeded `ctx.rng` (PUL-F018).
const ctxWithSeed = (stage: FakeStage, seed: string): Record<string, unknown> => ({
  stage: stage.element,
  mode: 'screenshot',
  gsap: { timeline: () => ({}) } as never,
  audio: {} as never,
  rng: createSeededRng(seed),
});

describe('screenshotRngFixtureScene', () => {
  it('declares the PUL-F001 contract fields with kebab-case id', () => {
    expect(screenshotRngFixtureScene.id).toBe('screenshot-rng-fixture');
    expect(screenshotRngFixtureScene.title).toBe('Screenshot RNG verification fixture');
    expect(screenshotRngFixtureScene.duration).toBeNull();
    expect(screenshotRngFixtureScene.standalone).toBe(true);
    expect(screenshotRngFixtureScene.trailerSafe).toBe(false);
    expect(screenshotRngFixtureScene.assets).toEqual([]);
    expect(screenshotRngFixtureScene.captions).toEqual([]);
    expect(screenshotRngFixtureScene.audio).toEqual([]);
    expect(screenshotRngFixtureScene.tags).toEqual(['fixture', 'screenshot']);
    expect(screenshotRngFixtureScene.defaultNext).toBeNull();
  });

  it('projects a non-empty comma-separated draw list onto the fixture element on `create`', () => {
    const stage = buildStage();
    screenshotRngFixtureScene.create(ctxWithSeed(stage, 'seed-a'));
    expect(stage.children).toHaveLength(1);
    const attrs = stage.children[0]?.attrs;
    expect(attrs?.get(TARGET_ATTR)).toBe('');
    const draws = (attrs?.get(RNG_ATTR) ?? '').split(',');
    expect(draws.length).toBeGreaterThan(1);
    // Every projected value is a parseable float in [0, 1).
    for (const d of draws) {
      const n = Number.parseFloat(d);
      expect(Number.isNaN(n)).toBe(false);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(1);
    }
  });

  it('projects an identical attribute for two ctx with the same seed', () => {
    const a = buildStage();
    const b = buildStage();
    screenshotRngFixtureScene.create(ctxWithSeed(a, 'shared-seed'));
    screenshotRngFixtureScene.create(ctxWithSeed(b, 'shared-seed'));
    expect(a.children[0]?.attrs.get(RNG_ATTR)).toBe(b.children[0]?.attrs.get(RNG_ATTR));
  });

  it('projects a different attribute for a different seed', () => {
    const a = buildStage();
    const b = buildStage();
    screenshotRngFixtureScene.create(ctxWithSeed(a, 'seed-a'));
    screenshotRngFixtureScene.create(ctxWithSeed(b, 'seed-b'));
    expect(a.children[0]?.attrs.get(RNG_ATTR)).not.toBe(b.children[0]?.attrs.get(RNG_ATTR));
  });

  it('returns null from `timeline(ctx)` — the fixture declares no animation', () => {
    const stage = buildStage();
    expect(screenshotRngFixtureScene.timeline(ctxWithSeed(stage, 'seed-a'))).toBeNull();
  });

  it('mounts a defined (possibly empty) attribute when ctx carries no rng', () => {
    // Defensive: an off-contract ctx without `rng` must not throw.
    const stage = buildStage();
    screenshotRngFixtureScene.create({
      stage: stage.element,
      mode: 'screenshot',
      gsap: { timeline: () => ({}) } as never,
      audio: {} as never,
    });
    expect(stage.children).toHaveLength(1);
    expect(typeof stage.children[0]?.attrs.get(RNG_ATTR)).toBe('string');
  });

  it('removes the fixture element on `cleanup`', () => {
    const stage = buildStage();
    screenshotRngFixtureScene.create(ctxWithSeed(stage, 'seed-a'));
    expect(stage.children).toHaveLength(1);
    screenshotRngFixtureScene.cleanup(ctxWithSeed(stage, 'seed-a'));
    expect(stage.children).toHaveLength(0);
  });

  it('is a no-op when the stage has no ownerDocument (off-DOM harness)', () => {
    const calls: string[] = [];
    const bareStage = {
      setAttribute: (n: string) => calls.push(`set:${n}`),
      removeAttribute: (n: string) => calls.push(`remove:${n}`),
    };
    expect(() =>
      screenshotRngFixtureScene.create({
        stage: bareStage,
        mode: 'screenshot',
        gsap: { timeline: () => ({}) } as never,
        audio: {} as never,
        rng: createSeededRng('seed-a'),
      }),
    ).not.toThrow();
    expect(calls).toEqual([]);
  });
});
