// PUL-Q008 / ADR-005 — accessibility fixture scene unit tests.
//
// The fixture is exercised end-to-end by Playwright in
// `tests-e2e/dom-css-accessibility.spec.ts`. These unit tests cover
// the PUL-F001 contract shape and the ctx defensiveness — the same
// surface `browser-support-fixture.test.ts` covers for the
// browser-support fixture scene. They also pin the
// accessibility-relevant DOM the fixture authors so a regression that
// dropped an ARIA attribute, broke the focus-order seam, or removed
// the selectable text container would surface here before reaching
// the browser gate.

import { describe, expect, it } from 'vitest';
import {
  SELECTABLE_PHRASE,
  domCssAccessibilityFixtureScene,
} from '../../src/scenes/dom-css-accessibility-fixture';

interface FakeChild {
  readonly tag: string;
  readonly attrs: Map<string, string>;
  readonly children: FakeChild[];
  textContent: string;
}

interface FakeStage {
  readonly children: FakeChild[];
  readonly element: {
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
    appendChild(node: unknown): unknown;
    querySelector(selector: string): { remove(): void } | null;
    ownerDocument: {
      createElement(tag: string): FakeChild;
    };
  };
}

const makeChild = (tag: string): FakeChild => ({
  tag,
  attrs: new Map<string, string>(),
  children: [],
  textContent: '',
});

// Stage stub mirrors the browser-support fixture's shape but supports
// arbitrary-depth `appendChild` recording so we can inspect the
// accessibility tree the fixture authors. `querySelector` finds the
// scene root by attribute selector (`[data-pulsar-q008-root]`), the
// shape `findFixtureElement` in the fixture uses.
const buildStage = (): FakeStage => {
  const children: FakeChild[] = [];
  return {
    children,
    element: {
      setAttribute: () => undefined,
      removeAttribute: () => undefined,
      appendChild: (node) => {
        children.push(node as FakeChild);
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
              remove: () => {
                children.splice(i, 1);
              },
            };
          }
        }
        return null;
      },
      ownerDocument: {
        createElement: (tag: string) => {
          const child = makeChild(tag);
          // Extend the recorded child to implement the minimal
          // element surface the fixture writes against: `setAttribute`
          // mutates `attrs`, `appendChild` records into `children`.
          // The fixture authors via these two methods plus
          // `textContent` (a plain field on FakeChild).
          (
            child as unknown as { setAttribute: (name: string, value: string) => void }
          ).setAttribute = (name: string, value: string) => {
            child.attrs.set(name, value);
          };
          (child as unknown as { appendChild: (n: unknown) => unknown }).appendChild = (
            n: unknown,
          ) => {
            child.children.push(n as FakeChild);
            return n;
          };
          return child;
        },
      },
    },
  };
};

const buildCtx = (stage: FakeStage['element'] | null): unknown => ({
  stage,
  mode: 'paused' as const,
  gsap: { timeline: () => ({}) } as never,
  audio: {} as never,
});

const findDescendant = (
  root: FakeChild,
  predicate: (c: FakeChild) => boolean,
): FakeChild | null => {
  if (predicate(root)) return root;
  for (const child of root.children) {
    const hit = findDescendant(child, predicate);
    if (hit !== null) return hit;
  }
  return null;
};

describe('domCssAccessibilityFixtureScene', () => {
  it('declares the PUL-F001 contract fields with kebab-case id', () => {
    expect(domCssAccessibilityFixtureScene.id).toBe('dom-css-accessibility-fixture');
    expect(domCssAccessibilityFixtureScene.title).toBe('DOM/CSS accessibility fixture');
    expect(domCssAccessibilityFixtureScene.duration).toBeNull();
    expect(domCssAccessibilityFixtureScene.standalone).toBe(true);
    expect(domCssAccessibilityFixtureScene.trailerSafe).toBe(false);
    expect(domCssAccessibilityFixtureScene.assets).toEqual([]);
    expect(domCssAccessibilityFixtureScene.captions).toEqual([]);
    expect(domCssAccessibilityFixtureScene.audio).toEqual([]);
    expect(domCssAccessibilityFixtureScene.tags).toEqual(['fixture', 'accessibility']);
    expect(domCssAccessibilityFixtureScene.defaultNext).toBeNull();
  });

  it('appends a scene-root element with the canonical marker on `create`', () => {
    const stage = buildStage();
    domCssAccessibilityFixtureScene.create(buildCtx(stage.element));
    expect(stage.children).toHaveLength(1);
    const root = stage.children[0];
    if (!root) throw new Error('expected scene root');
    expect(root.attrs.get('data-pulsar-q008-root')).toBe('');
  });

  it('authors a selectable-text paragraph (clause C1)', () => {
    const stage = buildStage();
    domCssAccessibilityFixtureScene.create(buildCtx(stage.element));
    const root = stage.children[0];
    if (!root) throw new Error('expected scene root');
    const para = findDescendant(root, (c) => c.attrs.has('data-pulsar-q008-text'));
    expect(para, 'fixture must mount a [data-pulsar-q008-text] element').not.toBeNull();
    expect(para?.tag).toBe('p');
    // Assert the EXACT phrase shared with the Playwright spec (which
    // compares the selection round-trip byte-for-byte). A non-empty
    // check would let the phrase drift silently — the unit test must
    // share the same source of truth so a regression in the fixture
    // string surfaces here, not at the browser layer (test-quality
    // review, cycle 1).
    expect(para?.textContent).toBe(SELECTABLE_PHRASE);
  });

  it('authors a focus sentinel then two focusable buttons in DOM order (clause C2)', () => {
    const stage = buildStage();
    domCssAccessibilityFixtureScene.create(buildCtx(stage.element));
    const root = stage.children[0];
    if (!root) throw new Error('expected scene root');
    const buttons: FakeChild[] = [];
    const walk = (n: FakeChild): void => {
      if (n.tag === 'button') buttons.push(n);
      for (const child of n.children) walk(child);
    };
    walk(root);
    // The fixture authors three `<button>` elements: the focus
    // sentinel (first in DOM order so the C2 browser gate can anchor
    // a Tab sequence), then alpha, then beta.
    expect(buttons).toHaveLength(3);
    expect(buttons[0]?.attrs.has('data-pulsar-q008-sentinel')).toBe(true);
    expect(buttons[1]?.attrs.get('data-pulsar-q008-button')).toBe('alpha');
    expect(buttons[2]?.attrs.get('data-pulsar-q008-button')).toBe('beta');
  });

  it('preserves authored ARIA attributes on the fixture DOM (clause C3)', () => {
    const stage = buildStage();
    domCssAccessibilityFixtureScene.create(buildCtx(stage.element));
    const root = stage.children[0];
    if (!root) throw new Error('expected scene root');

    const alpha = findDescendant(root, (c) => c.attrs.get('data-pulsar-q008-button') === 'alpha');
    expect(alpha?.attrs.get('aria-label')).toBe('alpha button');

    const beta = findDescendant(root, (c) => c.attrs.get('data-pulsar-q008-button') === 'beta');
    expect(beta?.attrs.get('aria-describedby')).toBe('pul-q008-desc');
    // beta's accessible name comes from `aria-labelledby` → the
    // betaLabel span. Pin both attribute and target span at the
    // unit layer so a regression that dropped either surfaces here
    // before the browser gate runs (test-quality review, cycle 1).
    expect(beta?.attrs.get('aria-labelledby')).toBe('pul-q008-beta-label');

    const betaLabel = findDescendant(root, (c) => c.attrs.get('id') === 'pul-q008-beta-label');
    expect(betaLabel, 'aria-labelledby target span must be present').not.toBeNull();
    expect(betaLabel?.textContent.length).toBeGreaterThan(0);

    const desc = findDescendant(root, (c) => c.attrs.get('id') === 'pul-q008-desc');
    expect(desc?.attrs.get('role')).toBe('note');
    expect(desc?.textContent.length).toBeGreaterThan(0);

    const region = findDescendant(root, (c) => c.attrs.get('role') === 'region');
    expect(region?.attrs.get('aria-label')).toBe('accessibility fixture surface');
  });

  it('does NOT author any positive tabindex, aria-hidden="true", or inert attribute', () => {
    const stage = buildStage();
    domCssAccessibilityFixtureScene.create(buildCtx(stage.element));
    const root = stage.children[0];
    if (!root) throw new Error('expected scene root');

    const offending: string[] = [];
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: accessibility-attribute scan walks a synthetic DOM checking three independent attribute predicates per node; complexity is intrinsic to the multi-predicate audit.
    const walk = (n: FakeChild): void => {
      for (const [name, value] of n.attrs.entries()) {
        if (name === 'tabindex' && /^[1-9]\d*$/.test(value)) {
          offending.push(`${n.tag}[tabindex="${value}"]`);
        }
        if (name === 'aria-hidden' && value === 'true') {
          offending.push(`${n.tag}[aria-hidden="true"]`);
        }
        if (name === 'inert') {
          offending.push(`${n.tag}[inert]`);
        }
      }
      for (const child of n.children) walk(child);
    };
    walk(root);
    expect(offending).toEqual([]);
  });

  it('returns no timeline contribution from `timeline(ctx)` (the fixture has no animation)', () => {
    const stage = buildStage();
    // Valid ctx: timeline returns undefined (no animation) after
    // tagging the stage with the lifecycle marker. The
    // master-timeline composer treats null and undefined identically,
    // so the structural difference between valid (undefined) and
    // invalid (null) keeps the function honest under SonarCloud's
    // invariant-return rule without changing observable behaviour.
    expect(domCssAccessibilityFixtureScene.timeline(buildCtx(stage.element))).toBeUndefined();
    // And the lifecycle marker was written to the (off-DOM) stage.
    // The buildStage stub's `setAttribute` is a no-op, but the
    // dedicated tracked-stub test below verifies the side effect.
  });

  it('writes a lifecycle marker on the stage from `timeline(ctx)`', () => {
    const calls: { name: string; value: string }[] = [];
    const trackedStage = {
      setAttribute: (name: string, value: string) => {
        calls.push({ name, value });
      },
      removeAttribute: () => undefined,
      appendChild: () => undefined,
      querySelector: () => null,
    };
    domCssAccessibilityFixtureScene.timeline({
      stage: trackedStage,
      mode: 'paused',
      gsap: { timeline: () => ({}) } as never,
      audio: {} as never,
    });
    expect(calls).toEqual([{ name: 'data-pulsar-q008-lifecycle', value: 'timeline' }]);
  });

  it('removes the scene root on `cleanup`', () => {
    const stage = buildStage();
    domCssAccessibilityFixtureScene.create(buildCtx(stage.element));
    expect(stage.children).toHaveLength(1);
    domCssAccessibilityFixtureScene.cleanup(buildCtx(stage.element));
    expect(stage.children).toHaveLength(0);
  });

  it('is a no-op on `cleanup` when no scene root was mounted (valid ctx, no prior create)', () => {
    const stage = buildStage();
    expect(stage.children).toHaveLength(0);
    expect(() => domCssAccessibilityFixtureScene.cleanup(buildCtx(stage.element))).not.toThrow();
    expect(stage.children).toHaveLength(0);
  });

  it('is a no-op when the stage has no ownerDocument (off-DOM harness)', () => {
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
      domCssAccessibilityFixtureScene.create({
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
    ['object without `stage`/`mode`', {}],
    ['object with `stage: null`', { stage: null, mode: 'paused' }],
  ])('is a no-op when ctx is %s', (_label, ctx) => {
    it('does not throw from any lifecycle hook', () => {
      expect(() => domCssAccessibilityFixtureScene.create(ctx)).not.toThrow();
      expect(() => domCssAccessibilityFixtureScene.timeline(ctx)).not.toThrow();
      expect(() => domCssAccessibilityFixtureScene.cleanup(ctx)).not.toThrow();
    });

    it('timeline() returns no timeline contribution for this ctx', () => {
      // The master-timeline composer at `src/runtime/timeline.ts`
      // treats null and undefined identically as "no timeline
      // contribution." The fixture's timeline returns null for
      // invalid-ctx shapes and falls through to undefined on the
      // valid-but-stage-null path; both shapes are accepted by the
      // composer. The assertion uses the `== null` loose check that
      // catches both shapes.
      const result = domCssAccessibilityFixtureScene.timeline(ctx);
      expect(result == null, `expected null or undefined, got ${JSON.stringify(result)}`).toBe(
        true,
      );
    });
  });

  describe('is a no-op when ctx has an unknown mode', () => {
    // Build a tracked stage stub so the assertion is "no stage
    // mutation occurred," not "no exception was thrown." Without
    // the tracking, the create/cleanup hooks' inner early-exit on
    // missing `appendChild` / `querySelector` would silently absorb
    // a regression in `isFixtureCtx`'s mode validation and the
    // .not.toThrow() check would pass anyway (test-quality review,
    // cycle 1). The other four ctx variants above provoke a real
    // TypeError if their guards were removed, so .not.toThrow() is
    // a meaningful gate there; the 'unknown mode' case needs an
    // observable side-effect to be a meaningful gate.
    const buildTracked = (): {
      readonly stage: {
        setAttribute(name: string, value: string): void;
        removeAttribute(name: string): void;
        appendChild(node: unknown): unknown;
        querySelector(selector: string): { remove(): void } | null;
        ownerDocument: { createElement(tag: string): FakeChild };
      };
      readonly calls: string[];
    } => {
      const calls: string[] = [];
      return {
        calls,
        stage: {
          setAttribute: () => {
            calls.push('setAttribute');
          },
          removeAttribute: () => {
            calls.push('removeAttribute');
          },
          appendChild: () => {
            calls.push('appendChild');
            return undefined;
          },
          querySelector: () => {
            calls.push('querySelector');
            return null;
          },
          ownerDocument: {
            createElement: (tag: string) => {
              calls.push(`createElement:${tag}`);
              return makeChild(tag);
            },
          },
        },
      };
    };

    const ctx = (stage: ReturnType<typeof buildTracked>['stage']): unknown => ({
      stage,
      mode: 'shouty-mode',
      gsap: { timeline: () => ({}) } as never,
      audio: {} as never,
    });

    it('create() never touches the stage', () => {
      const { stage, calls } = buildTracked();
      expect(() => domCssAccessibilityFixtureScene.create(ctx(stage))).not.toThrow();
      expect(calls, 'mode-validation regression would let create touch the stage').toEqual([]);
    });

    it('timeline() returns null without touching the stage', () => {
      const { stage, calls } = buildTracked();
      expect(domCssAccessibilityFixtureScene.timeline(ctx(stage))).toBeNull();
      expect(calls).toEqual([]);
    });

    it('cleanup() never touches the stage', () => {
      const { stage, calls } = buildTracked();
      expect(() => domCssAccessibilityFixtureScene.cleanup(ctx(stage))).not.toThrow();
      expect(calls, 'mode-validation regression would let cleanup touch the stage').toEqual([]);
    });
  });
});
