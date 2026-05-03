import { describe, expect, it } from 'vitest';
import { createSceneRegistry } from '../../src/runtime/registry';
import type { SceneRegistry } from '../../src/runtime/registry';
import type { SceneModule } from '../../src/runtime/scene';

const buildScene = (overrides: Partial<SceneModule> = {}): SceneModule => ({
  id: 'scene-a',
  title: 'Scene A',
  duration: 5000,
  tags: [],
  assets: [],
  captions: [],
  defaultNext: null,
  standalone: true,
  trailerSafe: false,
  create: () => undefined,
  timeline: () => undefined,
  cleanup: () => undefined,
  ...overrides,
});

describe('SceneRegistry contract (PUL-F002)', () => {
  describe('createSceneRegistry — happy paths (clause C1)', () => {
    it('builds an empty registry from an empty iterable', () => {
      const registry = createSceneRegistry([]);
      expect(registry.size).toBe(0);
      expect(registry.ids()).toEqual([]);
    });

    it('registers a single scene and returns it by id', () => {
      const scene = buildScene({ id: 'intro' });
      const registry = createSceneRegistry([scene]);
      expect(registry.size).toBe(1);
      expect(registry.get('intro')).toBe(scene);
    });

    it('registers multiple scenes and exposes each by id', () => {
      const intro = buildScene({ id: 'intro' });
      const middle = buildScene({ id: 'middle' });
      const outro = buildScene({ id: 'outro' });
      const registry = createSceneRegistry([intro, middle, outro]);
      expect(registry.size).toBe(3);
      expect(registry.get('intro')).toBe(intro);
      expect(registry.get('middle')).toBe(middle);
      expect(registry.get('outro')).toBe(outro);
    });

    it('accepts a generator as input', () => {
      const intro = buildScene({ id: 'intro' });
      const outro = buildScene({ id: 'outro' });
      function* scenes(): Generator<SceneModule> {
        yield intro;
        yield outro;
      }
      const registry = createSceneRegistry(scenes());
      expect(registry.size).toBe(2);
      expect(registry.get('intro')).toBe(intro);
      expect(registry.get('outro')).toBe(outro);
    });

    it('accepts a Set as input', () => {
      const intro = buildScene({ id: 'intro' });
      const registry = createSceneRegistry(new Set([intro]));
      expect(registry.size).toBe(1);
      expect(registry.get('intro')).toBe(intro);
    });
  });

  describe('createSceneRegistry — module validation delegated to PUL-F001', () => {
    it('rejects a scene module missing a required field with the PUL-F001 error', () => {
      const broken: Record<string, unknown> = { ...buildScene({ id: 'broken' }) };
      const missingField = 'cleanup';
      delete broken[missingField];
      expect(() => createSceneRegistry([broken as unknown as SceneModule])).toThrow(/cleanup/);
    });

    it.each<[string, unknown]>([
      ['null', null],
      ['undefined', undefined],
      ['a string', 'scene-a'],
      ['a number', 42],
      ['a boolean', true],
      ['an array', []],
    ])('rejects %s as a registry element', (_label, value) => {
      expect(() => createSceneRegistry([value as SceneModule])).toThrow(/object/i);
    });
  });

  describe('createSceneRegistry — duplicate ids (clause C1)', () => {
    it('rejects two scenes that share an id', () => {
      const a = buildScene({ id: 'shared' });
      const b = buildScene({ id: 'shared', title: 'Different title' });
      expect(() => createSceneRegistry([a, b])).toThrow(/duplicate id "shared"/);
    });

    it('rejects when the third scene duplicates the first', () => {
      const a = buildScene({ id: 'intro' });
      const b = buildScene({ id: 'middle' });
      const c = buildScene({ id: 'intro' });
      expect(() => createSceneRegistry([a, b, c])).toThrow(/duplicate id "intro"/);
    });

    it('error message is prefixed with "scene registry"', () => {
      const a = buildScene({ id: 'shared' });
      const b = buildScene({ id: 'shared' });
      expect(() => createSceneRegistry([a, b])).toThrow(/^scene registry:/);
    });
  });

  describe('get(id) — clause C1', () => {
    it('returns the exact module reference registered', () => {
      const scene = buildScene({ id: 'intro' });
      const registry = createSceneRegistry([scene]);
      expect(registry.get('intro')).toBe(scene);
    });

    it('throws a descriptive error when the id is not registered', () => {
      const registry = createSceneRegistry([buildScene({ id: 'intro' })]);
      expect(() => registry.get('missing')).toThrow(
        /scene registry: no scene registered with id "missing"/,
      );
    });

    it('throws when the lookup id is the empty string', () => {
      const registry = createSceneRegistry([buildScene({ id: 'intro' })]);
      expect(() => registry.get('')).toThrow(/scene registry: no scene registered with id ""/);
    });
  });

  describe('has(id) — clause C2 helper', () => {
    it('returns true for registered ids', () => {
      const registry = createSceneRegistry([buildScene({ id: 'intro' })]);
      expect(registry.has('intro')).toBe(true);
    });

    it('returns false for unregistered ids', () => {
      const registry = createSceneRegistry([buildScene({ id: 'intro' })]);
      expect(registry.has('missing')).toBe(false);
    });

    it('returns false for the empty string', () => {
      const registry = createSceneRegistry([buildScene({ id: 'intro' })]);
      expect(registry.has('')).toBe(false);
    });

    it('returns false on an empty registry', () => {
      const registry = createSceneRegistry([]);
      expect(registry.has('anything')).toBe(false);
    });
  });

  describe('ids() — listing', () => {
    it('returns ids in insertion order', () => {
      const scenes = [
        buildScene({ id: 'intro' }),
        buildScene({ id: 'middle' }),
        buildScene({ id: 'outro' }),
      ];
      const registry = createSceneRegistry(scenes);
      expect(registry.ids()).toEqual(['intro', 'middle', 'outro']);
    });

    it('returns a copy that callers cannot use to mutate the registry', () => {
      const registry = createSceneRegistry([buildScene({ id: 'intro' })]);
      const ids = registry.ids() as string[];
      // Either the array is frozen (push throws) or it is a defensive copy.
      try {
        ids.push('extra');
      } catch {
        // Frozen array — perfectly acceptable.
      }
      expect(registry.ids()).toEqual(['intro']);
      expect(registry.size).toBe(1);
      expect(registry.has('extra')).toBe(false);
    });
  });

  describe('immutability — ADR-008 "manifests over flow control"', () => {
    it('returns a frozen registry object', () => {
      const registry = createSceneRegistry([buildScene({ id: 'intro' })]);
      expect(Object.isFrozen(registry)).toBe(true);
    });

    const FORBIDDEN_METHODS = [
      'add',
      'register',
      'remove',
      'set',
      'delete',
      'clear',
      'getByIndex',
      'getNext',
      'at',
    ] as const;

    it.each(FORBIDDEN_METHODS)(
      'does not expose %s — registry surface is id-lookup-only (clause C2)',
      (name) => {
        const registry = createSceneRegistry([buildScene({ id: 'intro' })]) as unknown as Record<
          string,
          unknown
        >;
        expect(registry[name]).toBeUndefined();
      },
    );

    it('exposes exactly the documented public surface', () => {
      const registry: SceneRegistry = createSceneRegistry([buildScene({ id: 'intro' })]);
      const keys = Object.keys(registry).sort();
      expect(keys).toEqual(['get', 'has', 'ids', 'size']);
    });
  });
});
