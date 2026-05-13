// PUL-Q002 / ADR-030 — fixture scene unit tests.
//
// The fixture scene is exercised end-to-end by Playwright in
// `tests-e2e/browser-support.spec.ts`. These unit tests cover the
// PUL-F001 contract shape and the ctx defensiveness — the same
// surface `placeholder.test.ts` covers for the placeholder scene.
// They do NOT attempt to run a real GSAP timeline; that responsibility
// lives in `tests/runtime/timeline.test.ts` and in the Playwright
// e2e spec.

import { describe, expect, it } from 'vitest';
import { browserSupportFixtureScene } from '../../src/scenes/browser-support-fixture';

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

// Constructs a stage stub whose `appendChild` records children, whose
// `querySelector` looks them up by attribute name (matching the CSS
// attribute-selector shape the scene uses: `[<attr>]`), and whose
// `ownerDocument.createElement` returns a recording stub. The fixture
// allocates DOM through the stage's owner document rather than an
// ambient `document` global (codex pre-push review, cycle 2), so the
// stub mirrors that seam.
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

describe('browserSupportFixtureScene', () => {
  it('declares the PUL-F001 contract fields with kebab-case id', () => {
    expect(browserSupportFixtureScene.id).toBe('browser-support-fixture');
    expect(browserSupportFixtureScene.title).toBe('Browser support fixture');
    expect(browserSupportFixtureScene.duration).toBeNull();
    expect(browserSupportFixtureScene.standalone).toBe(true);
    expect(browserSupportFixtureScene.trailerSafe).toBe(false);
    expect(browserSupportFixtureScene.assets).toEqual([]);
    expect(browserSupportFixtureScene.captions).toEqual([]);
    expect(browserSupportFixtureScene.audio).toEqual([]);
    // PUL-F001 / scene.ts `REQUIRED_FIELDS` also includes `tags` and
    // `defaultNext`. Both carry behavioral meaning: `defaultNext`
    // drives composition sequencing (a regression to a sibling
    // scene id would silently change the workbench graph),
    // `tags` drives prompter/exporter filtering. Asserting both
    // here pins the fixture's intended values (test-quality
    // review, cycle 1).
    expect(browserSupportFixtureScene.tags).toEqual(['fixture', 'browser-support']);
    expect(browserSupportFixtureScene.defaultNext).toBeNull();
  });

  it('appends a fixture element under the stage on `create`', () => {
    const stage = buildStage();
    browserSupportFixtureScene.create({
      stage: stage.element,
      mode: 'present',
      gsap: { timeline: () => ({}) } as never,
      audio: {} as never,
    });
    expect(stage.children).toHaveLength(1);
    const attrs = stage.children[0]?.attrs;
    expect(attrs?.get('data-pulsar-fixture-target')).toBe('');
    expect(attrs?.get('data-pulsar-fixture-state')).toBe('mounted');
  });

  it('returns a GSAP timeline whose final `call` advances the fixture state to "ran"', () => {
    // The stub for `tl.call(fn)` must INVOKE the callback the
    // fixture supplies — otherwise the test would assert only that
    // a callback was registered, not that the callback does its
    // job (the state advancement `el.setAttribute('data-pulsar-
    // fixture-state', 'ran')` is the observable datum the
    // Playwright e2e gate relies on). A discarded-callback stub
    // would pass even if the fixture's callback body were deleted
    // (test-quality review, cycle 1).
    const stage = buildStage();
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
        fn();
        return tlStub;
      },
    };
    const gsap = { timeline: () => tlStub } as never;
    browserSupportFixtureScene.create({
      stage: stage.element,
      mode: 'present',
      gsap,
      audio: {} as never,
    });
    // Pre-condition: after `create`, the fixture element exists at
    // state `"mounted"`. A regression in `create` would surface
    // here before the `timeline` callback's side-effect is
    // measured.
    expect(stage.children[0]?.attrs.get('data-pulsar-fixture-state')).toBe('mounted');

    const result = browserSupportFixtureScene.timeline({
      stage: stage.element,
      mode: 'present',
      gsap,
      audio: {} as never,
    });
    expect(result).toBe(tlStub);
    expect(tlCalls).toEqual(['set', 'to', 'call']);
    // Post-condition: the `tl.call(...)` callback (now actually
    // invoked by the stub) ran the fixture's state-advance
    // setAttribute. Deleting or changing the callback body in the
    // fixture would fail this assertion.
    expect(stage.children[0]?.attrs.get('data-pulsar-fixture-state')).toBe('ran');
  });

  it('returns null from `timeline(ctx)` when no fixture element is mounted', () => {
    const stage = buildStage();
    const result = browserSupportFixtureScene.timeline({
      stage: stage.element,
      mode: 'present',
      gsap: { timeline: () => ({}) } as never,
      audio: {} as never,
    });
    expect(result).toBeNull();
  });

  it('removes the fixture element on `cleanup`', () => {
    const stage = buildStage();
    browserSupportFixtureScene.create({
      stage: stage.element,
      mode: 'present',
      gsap: { timeline: () => ({}) } as never,
      audio: {} as never,
    });
    expect(stage.children).toHaveLength(1);
    browserSupportFixtureScene.cleanup({
      stage: stage.element,
      mode: 'present',
      gsap: { timeline: () => ({}) } as never,
      audio: {} as never,
    });
    expect(stage.children).toHaveLength(0);
  });

  it('is a no-op when the stage has no ownerDocument (off-DOM harness)', () => {
    // The scene must NOT reach for the ambient global `document`.
    // A stage stub without `ownerDocument` must produce no DOM
    // mutation; the create hook silently no-ops. This pins the
    // codex-cycle-2 fix: routing DOM allocation through
    // `stage.ownerDocument` rather than the ambient `document`
    // global. We track every method call on the stage stub so
    // "no DOM mutation" is asserted structurally (`.not.toThrow()`
    // alone would let a regression that called
    // `stage.appendChild(somethingFromDocument)` pass — the
    // appendChild stub would silently swallow it; test-quality
    // review, cycle 1).
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
      browserSupportFixtureScene.create({
        stage: minimalStage,
        mode: 'present',
        gsap: { timeline: () => ({}) } as never,
        audio: {} as never,
      }),
    ).not.toThrow();
    expect(
      calls,
      'create must not mutate the stage when ownerDocument is absent',
    ).toEqual([]);
  });

  describe.each<[label: string, ctx: unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['object without `stage`/`mode`/`gsap`', {}],
    ['object with `stage: null`', { stage: null, mode: 'present', gsap: { timeline: () => ({}) } }],
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
        mode: 'present',
        gsap: {},
      },
    ],
  ])('is a no-op when ctx is %s', (_label, ctx) => {
    it('does not throw from any lifecycle hook', () => {
      expect(() => browserSupportFixtureScene.create(ctx)).not.toThrow();
      expect(() => browserSupportFixtureScene.timeline(ctx)).not.toThrow();
      expect(() => browserSupportFixtureScene.cleanup(ctx)).not.toThrow();
    });

    // The fixture's `timeline(ctx)` contract for an invalid ctx is
    // explicit: return `null`. A regression that returned
    // `undefined`, `{}`, or a stub timeline object would pass the
    // `.not.toThrow()` assertion above but still violate the
    // contract — the master-timeline composer's `null`-handling
    // path expects exactly `null` (test-quality review, cycle 1).
    it('timeline() returns null for the invalid ctx', () => {
      expect(browserSupportFixtureScene.timeline(ctx)).toBeNull();
    });
  });
});
