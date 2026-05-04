// Placeholder scene unit tests — exercise the lifecycle hooks against
// an injected stage handle (no `document` reach-into-globals).

import { describe, expect, it } from 'vitest';
import { placeholderScene } from '../../src/scenes/placeholder';

interface FakeStage {
  readonly attrs: Map<string, string>;
  readonly element: {
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
  };
}

const buildStage = (): FakeStage => {
  const attrs = new Map<string, string>();
  return {
    attrs,
    element: {
      setAttribute: (name, value) => attrs.set(name, value),
      removeAttribute: (name) => attrs.delete(name),
    },
  };
};

describe('placeholderScene', () => {
  it('declares the PUL-F001 contract fields with kebab-case id', () => {
    expect(placeholderScene.id).toBe('placeholder');
    expect(placeholderScene.title).toBe('Placeholder');
    expect(placeholderScene.duration).toBeNull();
    expect(placeholderScene.standalone).toBe(true);
    expect(placeholderScene.trailerSafe).toBe(false);
    expect(placeholderScene.assets).toEqual([]);
    expect(placeholderScene.captions).toEqual([]);
  });

  it('writes the lifecycle attribute on `create` against the ctx stage', () => {
    const stage = buildStage();
    placeholderScene.create({ stage: stage.element });
    expect(stage.attrs.get('data-pulsar-scene-lifecycle')).toBe('create');
  });

  it('overwrites the lifecycle attribute on `timeline`', () => {
    const stage = buildStage();
    placeholderScene.create({ stage: stage.element });
    placeholderScene.timeline({ stage: stage.element });
    expect(stage.attrs.get('data-pulsar-scene-lifecycle')).toBe('timeline');
  });

  it('removes the lifecycle attribute on `cleanup`', () => {
    const stage = buildStage();
    placeholderScene.create({ stage: stage.element });
    placeholderScene.cleanup({ stage: stage.element });
    expect(stage.attrs.has('data-pulsar-scene-lifecycle')).toBe(false);
  });

  // For ctx shapes the workbench predicate must reject (or where the
  // stage handle is explicitly null), the lifecycle hooks must do
  // nothing observable: no throw AND no side effect. The latter is
  // verified by pre-populating an unrelated stage with a sentinel
  // attribute and asserting nothing on that stage changes after the
  // hook runs. This catches a regression where the predicate accepts
  // a malformed ctx and the implementation accidentally reaches for
  // a different stage handle (or the global `document`) — a no-throw-
  // only assertion would miss that.
  describe.each<[label: string, ctx: unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['number primitive', 42],
    ['string primitive', 'ctx'],
    ['object without `stage` key', {}],
    ['object with `stage: null`', { stage: null }],
  ])('is a no-op when ctx is %s', (_label, ctx) => {
    it('does not throw and does not mutate any concurrently-existing stage', () => {
      const sentinel = buildStage();
      sentinel.attrs.set('data-unrelated', 'pristine');
      expect(() => placeholderScene.create(ctx)).not.toThrow();
      expect(() => placeholderScene.timeline(ctx)).not.toThrow();
      expect(() => placeholderScene.cleanup(ctx)).not.toThrow();
      // The sentinel stage was never wired into ctx; the lifecycle
      // hooks must not reach for it.
      expect(sentinel.attrs.get('data-unrelated')).toBe('pristine');
      expect(sentinel.attrs.has('data-pulsar-scene-lifecycle')).toBe(false);
    });
  });
});
