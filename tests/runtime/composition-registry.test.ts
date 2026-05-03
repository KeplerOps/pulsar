// CompositionRegistry — id-keyed lookup over composition manifests.
//
// The registry is the single addressability path for compositions, in
// the same shape SceneRegistry has for scenes (PUL-F002): immutable
// after construction, kebab-case ids, no positional dispatch, and
// validation delegated to `assertCompositionManifest` (PUL-F003).

import { describe, expect, it } from 'vitest';
import type { CompositionManifest } from '../../src/runtime/composition';
import {
  type CompositionRegistryEntry,
  createCompositionRegistry,
} from '../../src/runtime/composition-registry';

const fullTalk: CompositionManifest = ['scene-a', 'scene-b'];
const trailer: CompositionManifest = [{ id: 'scene-a', range: 'hook' }];

describe('createCompositionRegistry', () => {
  describe('happy paths', () => {
    it('builds an empty registry from an empty iterable', () => {
      const registry = createCompositionRegistry([]);
      expect(registry.size).toBe(0);
      expect(registry.ids()).toEqual([]);
    });

    it('registers a single composition and returns it by id', () => {
      const registry = createCompositionRegistry([{ id: 'full-talk', manifest: fullTalk }]);
      expect(registry.size).toBe(1);
      expect(registry.has('full-talk')).toBe(true);
      expect(registry.get('full-talk')).toBe(fullTalk);
    });

    it('registers multiple compositions and exposes each by id', () => {
      const registry = createCompositionRegistry([
        { id: 'full-talk', manifest: fullTalk },
        { id: 'trailer', manifest: trailer },
      ]);
      expect(registry.size).toBe(2);
      expect(registry.get('full-talk')).toBe(fullTalk);
      expect(registry.get('trailer')).toBe(trailer);
      expect(registry.ids()).toEqual(['full-talk', 'trailer']);
    });

    it('accepts a generator as input', () => {
      function* entries(): Generator<CompositionRegistryEntry> {
        yield { id: 'a', manifest: ['scene-a'] };
        yield { id: 'b', manifest: ['scene-a', 'scene-b'] };
      }
      const registry = createCompositionRegistry(entries());
      expect(registry.size).toBe(2);
      expect(registry.ids()).toEqual(['a', 'b']);
    });
  });

  describe('validation', () => {
    it('rejects a non-kebab id', () => {
      expect(() => createCompositionRegistry([{ id: 'Full-Talk', manifest: fullTalk }])).toThrow(
        /composition registry: id "Full-Talk" must be a non-empty lowercase kebab-case/,
      );
    });

    it('rejects an empty id', () => {
      expect(() => createCompositionRegistry([{ id: '', manifest: fullTalk }])).toThrow(
        /composition registry: id "" must be/,
      );
    });

    it('rejects an id with whitespace', () => {
      expect(() => createCompositionRegistry([{ id: 'full talk', manifest: fullTalk }])).toThrow(
        /composition registry: id "full talk"/,
      );
    });

    it('delegates manifest-shape validation to assertCompositionManifest', () => {
      expect(() =>
        createCompositionRegistry([
          { id: 'broken', manifest: 'not-an-array' as unknown as CompositionManifest },
        ]),
      ).toThrow(/composition manifest is invalid:/);
    });

    it('rejects duplicate ids on construction', () => {
      expect(() =>
        createCompositionRegistry([
          { id: 'dup', manifest: fullTalk },
          { id: 'dup', manifest: trailer },
        ]),
      ).toThrow(/composition registry: duplicate id "dup"/);
    });
  });

  describe('lookup', () => {
    it('throws on get() for an unregistered id', () => {
      const registry = createCompositionRegistry([{ id: 'a', manifest: fullTalk }]);
      expect(() => registry.get('missing')).toThrow(
        /composition registry: no composition registered with id "missing"/,
      );
    });

    it('has() returns false for an unregistered id', () => {
      const registry = createCompositionRegistry([{ id: 'a', manifest: fullTalk }]);
      expect(registry.has('missing')).toBe(false);
    });

    it('ids() returns a frozen snapshot — caller cannot mutate to corrupt the registry', () => {
      const registry = createCompositionRegistry([
        { id: 'a', manifest: fullTalk },
        { id: 'b', manifest: trailer },
      ]);
      const snapshot = registry.ids();
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(() => (snapshot as string[]).push('c')).toThrow();
      expect(registry.ids()).toEqual(['a', 'b']);
    });

    it('the registry object is frozen — no add/remove API', () => {
      const registry = createCompositionRegistry([{ id: 'a', manifest: fullTalk }]);
      expect(Object.isFrozen(registry)).toBe(true);
    });
  });
});
