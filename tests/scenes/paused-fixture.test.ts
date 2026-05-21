// PUL-F016 / ADR-019 — paused verification fixture scene unit tests.
//
// The fixture scene is exercised end-to-end by Playwright in
// `tests-e2e/paused-mode.spec.ts`, where `mode=paused` drives the GSAP
// master through `seek(0)` + `pause()` and the progress attribute is
// observed to stay pinned at its first-frame value. These unit tests
// cover the PUL-F001 contract shape and the ctx defensiveness — the
// same surface `loop-fixture.test.ts` covers for its fixture — plus the
// one behavior unique to this fixture: the `timeline(ctx)` tween's
// `onUpdate` callback maps the tween's current value onto the
// `data-pulsar-paused-progress` attribute, so a held master (value
// pinned at 0) leaves the attribute at `"0"`. They do NOT run a real
// GSAP timeline; that responsibility lives in
// `tests/runtime/timeline.test.ts` and in the Playwright e2e spec.

import { describe, expect, it } from 'vitest';
import { pausedFixtureScene } from '../../src/scenes/paused-fixture';

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

// Stage stub mirroring `loop-fixture.test.ts`: `appendChild` records
// children, `querySelector` looks them up by the attribute name in the
// `[<attr>]` selector, and `ownerDocument.createElement` returns a
// recording stub. The fixture allocates DOM through the stage's owner
// document rather than an ambient `document` global (ADR-008 #2), so
// the stub mirrors that seam.
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

describe('pausedFixtureScene', () => {
  it('declares the PUL-F001 contract fields with kebab-case id', () => {
    expect(pausedFixtureScene.id).toBe('paused-fixture');
    expect(pausedFixtureScene.title).toBe('Paused verification fixture');
    expect(pausedFixtureScene.duration).toBeNull();
    expect(pausedFixtureScene.standalone).toBe(true);
    expect(pausedFixtureScene.trailerSafe).toBe(false);
    expect(pausedFixtureScene.assets).toEqual([]);
    expect(pausedFixtureScene.captions).toEqual([]);
    expect(pausedFixtureScene.audio).toEqual([]);
    expect(pausedFixtureScene.tags).toEqual(['fixture', 'paused']);
    expect(pausedFixtureScene.defaultNext).toBeNull();
  });

  it('appends a fixture element at progress 0 on `create`', () => {
    const stage = buildStage();
    pausedFixtureScene.create({
      stage: stage.element,
      mode: 'paused',
      gsap: { timeline: () => ({}) } as never,
      audio: {} as never,
    });
    expect(stage.children).toHaveLength(1);
    const attrs = stage.children[0]?.attrs;
    expect(attrs?.get('data-pulsar-paused-target')).toBe('');
    // The progress attribute starts at 0 — "mounted, timeline rendered
    // at its first frame" — so a Playwright poll can distinguish a held
    // first frame from a timeline that advanced.
    expect(attrs?.get('data-pulsar-paused-progress')).toBe('0');
  });

  it('maps the tween value onto `data-pulsar-paused-progress` via `onUpdate`', () => {
    // PUL-F016 acceptance criterion 2: paused mode must be observable as
    // an animation that does NOT progress. The fixture's `timeline(ctx)`
    // tweens a numeric `progress` object 0 -> 100; its `onUpdate`
    // callback writes the rounded current value onto the DOM attribute.
    // Under a held master (`seek(0)` + `pause()`) the tween value stays
    // at 0, so the attribute stays `"0"`; under a playing master it
    // climbs. The `.to(target, vars)` stub captures both the tween
    // target object and the `onUpdate` callback, so the test can drive
    // the target value GSAP would otherwise interpolate and assert the
    // callback's mapping directly.
    const stage = buildStage();
    let capturedTarget: { value: number } | null = null;
    let capturedOnUpdate: (() => void) | null = null;
    const tlCalls: string[] = [];
    const tlStub = {
      to: (target: unknown, vars: Record<string, unknown>) => {
        tlCalls.push('to');
        capturedTarget = target as { value: number };
        capturedOnUpdate = vars.onUpdate as () => void;
        return tlStub;
      },
    };
    const gsap = { timeline: () => tlStub } as never;
    pausedFixtureScene.create({ stage: stage.element, mode: 'paused', gsap, audio: {} as never });
    expect(stage.children[0]?.attrs.get('data-pulsar-paused-progress')).toBe('0');

    const result = pausedFixtureScene.timeline({
      stage: stage.element,
      mode: 'paused',
      gsap,
      audio: {} as never,
    });
    expect(result).toBe(tlStub);
    expect(tlCalls).toEqual(['to']);
    expect(capturedTarget).not.toBeNull();
    expect(capturedOnUpdate).not.toBeNull();

    const target = capturedTarget as unknown as { value: number };
    const fireUpdate = capturedOnUpdate as unknown as () => void;

    // The tween declares `value: 100` as its end state, so the target
    // starts at 0 — the held first frame.
    expect(target.value).toBe(0);

    // Frame 0: a held master leaves the value at 0; the callback writes
    // `"0"`.
    fireUpdate();
    expect(stage.children[0]?.attrs.get('data-pulsar-paused-progress')).toBe('0');

    // A non-integer interpolated value is rounded.
    target.value = 41.6;
    fireUpdate();
    expect(stage.children[0]?.attrs.get('data-pulsar-paused-progress')).toBe('42');

    // The tween's terminal value.
    target.value = 100;
    fireUpdate();
    expect(stage.children[0]?.attrs.get('data-pulsar-paused-progress')).toBe('100');
  });

  it('returns null from `timeline(ctx)` when no fixture element is mounted', () => {
    const stage = buildStage();
    const result = pausedFixtureScene.timeline({
      stage: stage.element,
      mode: 'paused',
      gsap: { timeline: () => ({}) } as never,
      audio: {} as never,
    });
    expect(result).toBeNull();
  });

  it('removes the fixture element on `cleanup`', () => {
    const stage = buildStage();
    pausedFixtureScene.create({
      stage: stage.element,
      mode: 'paused',
      gsap: { timeline: () => ({}) } as never,
      audio: {} as never,
    });
    expect(stage.children).toHaveLength(1);
    pausedFixtureScene.cleanup({
      stage: stage.element,
      mode: 'paused',
      gsap: { timeline: () => ({}) } as never,
      audio: {} as never,
    });
    expect(stage.children).toHaveLength(0);
  });

  it('is a no-op on `cleanup` when no fixture element was mounted (valid ctx, no prior create)', () => {
    const stage = buildStage();
    expect(stage.children).toHaveLength(0);
    expect(() =>
      pausedFixtureScene.cleanup({
        stage: stage.element,
        mode: 'paused',
        gsap: { timeline: () => ({}) } as never,
        audio: {} as never,
      }),
    ).not.toThrow();
    expect(stage.children).toHaveLength(0);
  });

  it('is a no-op when the stage has no ownerDocument (off-DOM harness)', () => {
    // The scene must NOT reach for the ambient global `document`. A
    // stage stub without `ownerDocument` must produce no DOM mutation
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
      pausedFixtureScene.create({
        stage: minimalStage,
        mode: 'paused',
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
    ['object with `stage: null`', { stage: null, mode: 'paused', gsap: { timeline: () => ({}) } }],
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
        mode: 'paused',
        gsap: {},
      },
    ],
  ])('is a no-op when ctx is %s', (_label, ctx) => {
    it('does not throw from any lifecycle hook', () => {
      expect(() => pausedFixtureScene.create(ctx)).not.toThrow();
      expect(() => pausedFixtureScene.timeline(ctx)).not.toThrow();
      expect(() => pausedFixtureScene.cleanup(ctx)).not.toThrow();
    });

    it('timeline() returns null for the invalid ctx', () => {
      expect(pausedFixtureScene.timeline(ctx)).toBeNull();
    });
  });
});
