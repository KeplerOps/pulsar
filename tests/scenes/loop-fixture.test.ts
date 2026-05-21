// PUL-F015 / ADR-018 — loop verification fixture scene unit tests.
//
// The fixture scene is exercised end-to-end by Playwright in
// `tests-e2e/loop-mode.spec.ts`, where `mode=loop` drives the GSAP
// master through `repeat(-1)` and the per-iteration counter is
// observed across two cycles. These unit tests cover the PUL-F001
// contract shape and the ctx defensiveness — the same surface
// `browser-support-fixture.test.ts` covers for its fixture — plus the
// one behavior unique to this fixture: the `timeline(ctx)` `.call()`
// callback increments the iteration counter each time it fires, so a
// looping master produces a strictly increasing
// `data-pulsar-loop-iteration` attribute. They do NOT run a real GSAP
// timeline; that responsibility lives in `tests/runtime/timeline.test.ts`
// and in the Playwright e2e spec.

import { describe, expect, it } from 'vitest';
import { loopFixtureScene } from '../../src/scenes/loop-fixture';

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

// Stage stub mirroring `browser-support-fixture.test.ts`: `appendChild`
// records children, `querySelector` looks them up by the attribute
// name in the `[<attr>]` selector, and `ownerDocument.createElement`
// returns a recording stub. The fixture allocates DOM through the
// stage's owner document rather than an ambient `document` global
// (ADR-008 #2), so the stub mirrors that seam.
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

describe('loopFixtureScene', () => {
  it('declares the PUL-F001 contract fields with kebab-case id', () => {
    expect(loopFixtureScene.id).toBe('loop-fixture');
    expect(loopFixtureScene.title).toBe('Loop verification fixture');
    expect(loopFixtureScene.duration).toBeNull();
    expect(loopFixtureScene.standalone).toBe(true);
    expect(loopFixtureScene.trailerSafe).toBe(false);
    expect(loopFixtureScene.assets).toEqual([]);
    expect(loopFixtureScene.captions).toEqual([]);
    expect(loopFixtureScene.audio).toEqual([]);
    expect(loopFixtureScene.tags).toEqual(['fixture', 'loop']);
    expect(loopFixtureScene.defaultNext).toBeNull();
  });

  it('appends a fixture element at iteration 0 on `create`', () => {
    const stage = buildStage();
    loopFixtureScene.create({
      stage: stage.element,
      mode: 'loop',
      gsap: { timeline: () => ({}) } as never,
      audio: {} as never,
    });
    expect(stage.children).toHaveLength(1);
    const attrs = stage.children[0]?.attrs;
    expect(attrs?.get('data-pulsar-loop-target')).toBe('');
    // The counter starts at 0 so a Playwright poll can distinguish
    // "fixture mounted, not yet run" from "ran at least once".
    expect(attrs?.get('data-pulsar-loop-iteration')).toBe('0');
  });

  it('increments `data-pulsar-loop-iteration` each time the timeline `.call()` fires', () => {
    // PUL-F015 acceptance criterion 2: loop must be observable as
    // *distinct iterations*, not a sticky terminal state. Under a
    // looping master the nested scene timeline replays each cycle and
    // its end `.call()` re-fires; the fixture's callback must produce
    // a strictly increasing counter so the e2e spec can poll for two
    // distinct values. The `.call(fn)` stub captures the callback and
    // the test invokes it repeatedly to simulate the per-cycle
    // re-fire a `repeat(-1)` master produces.
    const stage = buildStage();
    let captured: (() => void) | null = null;
    const tlCalls: string[] = [];
    const tlStub = {
      set: (_target: unknown, _vars: unknown) => {
        tlCalls.push('set');
        return tlStub;
      },
      to: (_target: unknown, _vars: unknown) => {
        tlCalls.push('to');
        return tlStub;
      },
      call: (fn: () => void) => {
        tlCalls.push('call');
        captured = fn;
        return tlStub;
      },
    };
    const gsap = { timeline: () => tlStub } as never;
    loopFixtureScene.create({ stage: stage.element, mode: 'loop', gsap, audio: {} as never });
    expect(stage.children[0]?.attrs.get('data-pulsar-loop-iteration')).toBe('0');

    const result = loopFixtureScene.timeline({
      stage: stage.element,
      mode: 'loop',
      gsap,
      audio: {} as never,
    });
    expect(result).toBe(tlStub);
    expect(tlCalls).toEqual(['set', 'to', 'call']);

    // `timeline(ctx)` only registers the callback; the counter has
    // not advanced yet.
    expect(stage.children[0]?.attrs.get('data-pulsar-loop-iteration')).toBe('0');
    expect(captured).not.toBeNull();
    const fire = captured as unknown as () => void;

    // Each `.call()` fire — one per loop cycle — advances the counter.
    fire();
    expect(stage.children[0]?.attrs.get('data-pulsar-loop-iteration')).toBe('1');
    fire();
    expect(stage.children[0]?.attrs.get('data-pulsar-loop-iteration')).toBe('2');
    fire();
    expect(stage.children[0]?.attrs.get('data-pulsar-loop-iteration')).toBe('3');
  });

  it('gives each navigation a fresh counter (the closure does not leak across `timeline` calls)', () => {
    // Loop must restart the *timeline*, not the scene lifecycle: the
    // resolver calls `timeline(ctx)` once per navigation, and the
    // master's `repeat(-1)` replays that one timeline. A second
    // navigation builds a new timeline whose counter must start from
    // zero — otherwise a stale module-level counter would make the
    // e2e poll pass without a genuine restart.
    const stageA = buildStage();
    const fires: (() => void)[] = [];
    const makeStub = () => {
      const stub: Record<string, unknown> = {};
      stub.set = () => stub;
      stub.to = () => stub;
      stub.call = (fn: () => void) => {
        fires.push(fn);
        return stub;
      };
      return stub;
    };
    const gsapA = { timeline: makeStub } as never;
    loopFixtureScene.create({
      stage: stageA.element,
      mode: 'loop',
      gsap: gsapA,
      audio: {} as never,
    });
    loopFixtureScene.timeline({
      stage: stageA.element,
      mode: 'loop',
      gsap: gsapA,
      audio: {} as never,
    });
    fires[0]?.();
    fires[0]?.();
    expect(stageA.children[0]?.attrs.get('data-pulsar-loop-iteration')).toBe('2');

    const stageB = buildStage();
    const gsapB = { timeline: makeStub } as never;
    loopFixtureScene.create({
      stage: stageB.element,
      mode: 'loop',
      gsap: gsapB,
      audio: {} as never,
    });
    loopFixtureScene.timeline({
      stage: stageB.element,
      mode: 'loop',
      gsap: gsapB,
      audio: {} as never,
    });
    fires[1]?.();
    expect(stageB.children[0]?.attrs.get('data-pulsar-loop-iteration')).toBe('1');
  });

  it('returns null from `timeline(ctx)` when no fixture element is mounted', () => {
    const stage = buildStage();
    const result = loopFixtureScene.timeline({
      stage: stage.element,
      mode: 'loop',
      gsap: { timeline: () => ({}) } as never,
      audio: {} as never,
    });
    expect(result).toBeNull();
  });

  it('removes the fixture element on `cleanup`', () => {
    const stage = buildStage();
    loopFixtureScene.create({
      stage: stage.element,
      mode: 'loop',
      gsap: { timeline: () => ({}) } as never,
      audio: {} as never,
    });
    expect(stage.children).toHaveLength(1);
    loopFixtureScene.cleanup({
      stage: stage.element,
      mode: 'loop',
      gsap: { timeline: () => ({}) } as never,
      audio: {} as never,
    });
    expect(stage.children).toHaveLength(0);
  });

  it('is a no-op on `cleanup` when no fixture element was mounted (valid ctx, no prior create)', () => {
    const stage = buildStage();
    expect(stage.children).toHaveLength(0);
    expect(() =>
      loopFixtureScene.cleanup({
        stage: stage.element,
        mode: 'loop',
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
      loopFixtureScene.create({
        stage: minimalStage,
        mode: 'loop',
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
    ['object with `stage: null`', { stage: null, mode: 'loop', gsap: { timeline: () => ({}) } }],
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
        mode: 'loop',
        gsap: {},
      },
    ],
  ])('is a no-op when ctx is %s', (_label, ctx) => {
    it('does not throw from any lifecycle hook', () => {
      expect(() => loopFixtureScene.create(ctx)).not.toThrow();
      expect(() => loopFixtureScene.timeline(ctx)).not.toThrow();
      expect(() => loopFixtureScene.cleanup(ctx)).not.toThrow();
    });

    it('timeline() returns null for the invalid ctx', () => {
      expect(loopFixtureScene.timeline(ctx)).toBeNull();
    });
  });
});
