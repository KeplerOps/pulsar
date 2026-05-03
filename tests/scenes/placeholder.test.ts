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

  it('is a no-op when ctx has no stage handle', () => {
    expect(() => placeholderScene.create(null)).not.toThrow();
    expect(() => placeholderScene.create({})).not.toThrow();
    expect(() => placeholderScene.create({ stage: null })).not.toThrow();
    expect(() => placeholderScene.timeline(undefined)).not.toThrow();
    expect(() => placeholderScene.cleanup(42)).not.toThrow();
  });
});
