// Scene registry — PUL-F002.
//
// The runtime's single source of truth for what scenes exist and how
// they are addressed. Per ADR-002, scenes are addressable by stable id
// and there is no positional dispatch in the runtime core. Per ADR-008,
// registries are manifests over flow control: built once at bootstrap,
// validated up front, immutable thereafter.
//
// The registry delegates scene-shape validation to assertSceneModule
// (PUL-F001) — there is one validator and the registry consumes it
// rather than re-implementing it.

import { type SceneModule, assertSceneModule } from './scene';

/**
 * The runtime's view of every scene that exists. Built by
 * {@link createSceneRegistry}; the surface is intentionally small —
 * lookup by id only — to satisfy PUL-F002's "only mechanism by which
 * scenes are addressable for navigation" clause.
 */
export interface SceneRegistry {
  /** Look up a scene by id. Throws if no scene is registered with that id. */
  get(id: string): SceneModule;
  /** Check whether a scene is registered with the given id. */
  has(id: string): boolean;
  /** Snapshot of registered scene ids in insertion order. The returned array is detached from the registry. */
  ids(): readonly string[];
  /** Number of scenes registered. */
  readonly size: number;
}

/**
 * Build a {@link SceneRegistry} from a collection of scene modules.
 *
 * Validation rules, applied in iteration order:
 *  1. Each module must satisfy {@link assertSceneModule} (PUL-F001).
 *  2. Scene ids must be unique within the registry — registration is by
 *     id, so collisions are unrecoverable here. The first occurrence
 *     wins detection: the duplicating scene raises the error.
 *
 * The returned registry is frozen and exposes only id-based lookup.
 * There is no add/remove/positional API by design (ADR-002 §Navigation,
 * ADR-008 #2 "manifests over flow control").
 */
export function createSceneRegistry(scenes: Iterable<SceneModule>): SceneRegistry {
  const byId = new Map<string, SceneModule>();
  const order: string[] = [];

  for (const scene of scenes) {
    assertSceneModule(scene);
    if (byId.has(scene.id)) {
      throw new Error(`scene registry: duplicate id "${scene.id}"`);
    }
    byId.set(scene.id, scene);
    order.push(scene.id);
  }

  const registry: SceneRegistry = {
    get(id: string): SceneModule {
      const scene = byId.get(id);
      if (scene === undefined) {
        throw new Error(`scene registry: no scene registered with id "${id}"`);
      }
      return scene;
    },
    has(id: string): boolean {
      return byId.has(id);
    },
    ids(): readonly string[] {
      return Object.freeze(order.slice());
    },
    get size(): number {
      return byId.size;
    },
  };

  return Object.freeze(registry);
}
