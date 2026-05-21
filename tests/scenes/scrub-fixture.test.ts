// PUL-F017 / ADR-020 — scrub verification fixture scene unit tests.
//
// The fixture scene is exercised end-to-end by Playwright in
// `tests-e2e/scrub-mode.spec.ts`, where `mode=scrub` holds the GSAP
// master live for the workbench scrub controls to drive. These unit
// tests cover the PUL-F001 contract shape and the ctx defensiveness —
// the same surface `paused-fixture.test.ts` covers — plus the behaviors
// unique to this fixture: the `timeline(ctx)` tween's `onUpdate`
// callback maps the tween's current value onto the
// `data-pulsar-scrub-progress` attribute, and the timeline carries a
// kebab-case `midpoint` beat label so the scrub controls render one
// named-beat jump button. They do NOT run a real GSAP timeline; that
// responsibility lives in `tests/runtime/timeline.test.ts` and the
// Playwright e2e spec.

import { describe, expect, it } from 'vitest';
import { scrubFixtureScene } from '../../src/scenes/scrub-fixture';

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

// Stage stub mirroring `paused-fixture.test.ts`: `appendChild` records
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

describe('scrubFixtureScene', () => {
  it('declares the PUL-F001 contract fields with kebab-case id', () => {
    expect(scrubFixtureScene.id).toBe('scrub-fixture');
    expect(scrubFixtureScene.title).toBe('Scrub verification fixture');
    expect(scrubFixtureScene.duration).toBeNull();
    expect(scrubFixtureScene.standalone).toBe(true);
    expect(scrubFixtureScene.trailerSafe).toBe(false);
    expect(scrubFixtureScene.assets).toEqual([]);
    expect(scrubFixtureScene.captions).toEqual([]);
    expect(scrubFixtureScene.audio).toEqual([]);
    expect(scrubFixtureScene.tags).toEqual(['fixture', 'scrub']);
    expect(scrubFixtureScene.defaultNext).toBeNull();
  });

  it('appends a fixture element at progress 0 on `create`', () => {
    const stage = buildStage();
    scrubFixtureScene.create({
      stage: stage.element,
      mode: 'scrub',
      gsap: { timeline: () => ({}) } as never,
      audio: {} as never,
    });
    expect(stage.children).toHaveLength(1);
    const attrs = stage.children[0]?.attrs;
    expect(attrs?.get('data-pulsar-scrub-target')).toBe('');
    expect(attrs?.get('data-pulsar-scrub-progress')).toBe('0');
  });

  it('maps the tween value onto `data-pulsar-scrub-progress` and authors a `midpoint` beat', () => {
    // The fixture's `timeline(ctx)` tweens a numeric `progress` object
    // 0 -> 100; its `onUpdate` callback writes the rounded current
    // value onto the DOM attribute. It also adds a kebab-case
    // `midpoint` label so the scrub controls render one beat button.
    // The `.to(...)` / `.addLabel(...)` stub captures the tween target,
    // the `onUpdate` callback, and the label so the test can drive the
    // value GSAP would otherwise interpolate.
    const stage = buildStage();
    let capturedTarget: { value: number } | null = null;
    let capturedOnUpdate: (() => void) | null = null;
    const labels: { name: string; at: number }[] = [];
    const tlStub = {
      to: (target: unknown, vars: Record<string, unknown>) => {
        capturedTarget = target as { value: number };
        capturedOnUpdate = vars.onUpdate as () => void;
        return tlStub;
      },
      addLabel: (name: string, at: number) => {
        labels.push({ name, at });
        return tlStub;
      },
    };
    const gsap = { timeline: () => tlStub } as never;
    scrubFixtureScene.create({ stage: stage.element, mode: 'scrub', gsap, audio: {} as never });

    const result = scrubFixtureScene.timeline({
      stage: stage.element,
      mode: 'scrub',
      gsap,
      audio: {} as never,
    });
    expect(result).toBe(tlStub);
    expect(capturedTarget).not.toBeNull();
    expect(capturedOnUpdate).not.toBeNull();
    // One named beat, kebab-case, at a finite non-negative time.
    expect(labels).toHaveLength(1);
    expect(labels[0]?.name).toBe('midpoint');
    expect(labels[0]?.at).toBeGreaterThan(0);

    const target = capturedTarget as unknown as { value: number };
    const fireUpdate = capturedOnUpdate as unknown as () => void;

    // The tween declares `value: 100` as its end state, so the target
    // starts at 0 — the held first frame.
    expect(target.value).toBe(0);
    fireUpdate();
    expect(stage.children[0]?.attrs.get('data-pulsar-scrub-progress')).toBe('0');

    // A non-integer interpolated value is rounded.
    target.value = 41.6;
    fireUpdate();
    expect(stage.children[0]?.attrs.get('data-pulsar-scrub-progress')).toBe('42');

    target.value = 100;
    fireUpdate();
    expect(stage.children[0]?.attrs.get('data-pulsar-scrub-progress')).toBe('100');
  });

  it('returns null from `timeline(ctx)` when no fixture element is mounted', () => {
    const stage = buildStage();
    const result = scrubFixtureScene.timeline({
      stage: stage.element,
      mode: 'scrub',
      gsap: { timeline: () => ({ to: () => undefined, addLabel: () => undefined }) } as never,
      audio: {} as never,
    });
    expect(result).toBeNull();
  });

  it('removes the fixture element on `cleanup`', () => {
    const stage = buildStage();
    scrubFixtureScene.create({
      stage: stage.element,
      mode: 'scrub',
      gsap: { timeline: () => ({}) } as never,
      audio: {} as never,
    });
    expect(stage.children).toHaveLength(1);
    scrubFixtureScene.cleanup({
      stage: stage.element,
      mode: 'scrub',
      gsap: { timeline: () => ({}) } as never,
      audio: {} as never,
    });
    expect(stage.children).toHaveLength(0);
  });

  it('is a no-op when the stage has no ownerDocument (off-DOM harness)', () => {
    // The scene must NOT reach for the ambient global `document`
    // (ADR-008 #2). Every stage method call is tracked so "no DOM
    // mutation" is asserted structurally.
    const calls: { name: string; args: unknown[] }[] = [];
    const minimalStage = {
      setAttribute: (...args: unknown[]) => {
        calls.push({ name: 'setAttribute', args });
      },
      removeAttribute: (...args: unknown[]) => {
        calls.push({ name: 'removeAttribute', args });
      },
      appendChild: (...args: unknown[]) => {
        calls.push({ name: 'appendChild', args });
        return undefined;
      },
    };
    expect(() =>
      scrubFixtureScene.create({
        stage: minimalStage,
        mode: 'scrub',
        gsap: { timeline: () => ({}) } as never,
        audio: {} as never,
      }),
    ).not.toThrow();
    expect(calls, 'create must not mutate the stage when ownerDocument is absent').toEqual([]);
  });

  describe.each<[label: string, ctx: unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['object without `stage`/`mode`/`gsap`', {}],
    ['object with `stage: null`', { stage: null, mode: 'scrub', gsap: { timeline: () => ({}) } }],
    [
      'object with unknown mode',
      {
        stage: { setAttribute: () => undefined, removeAttribute: () => undefined },
        mode: 'shouty-mode',
        gsap: { timeline: () => ({}) },
      },
    ],
    [
      'object with non-gsap shape',
      {
        stage: { setAttribute: () => undefined, removeAttribute: () => undefined },
        mode: 'scrub',
        gsap: {},
      },
    ],
  ])('is a no-op when ctx is %s', (_label, ctx) => {
    it('does not throw from any lifecycle hook', () => {
      expect(() => scrubFixtureScene.create(ctx)).not.toThrow();
      expect(() => scrubFixtureScene.timeline(ctx)).not.toThrow();
      expect(() => scrubFixtureScene.cleanup(ctx)).not.toThrow();
    });

    it('timeline() returns null for the invalid ctx', () => {
      expect(scrubFixtureScene.timeline(ctx)).toBeNull();
    });
  });
});
