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
// rather than re-implementing it. The id-keyed plumbing (Map, frozen
// snapshot, duplicate-id rejection, miss-throws) is shared with the
// composition registry via `./id-registry.ts`.

import { type IdRegistry, createIdRegistry } from './id-registry';
import { type SceneModule, assertSceneModule } from './scene';

/**
 * The runtime's view of every scene that exists. Built by
 * {@link createSceneRegistry}; the surface is intentionally small —
 * lookup by id only — to satisfy PUL-F002's "only mechanism by which
 * scenes are addressable for navigation" clause.
 */
export type SceneRegistry = IdRegistry<SceneModule>;

/**
 * Build a {@link SceneRegistry} from a collection of scene modules.
 *
 * Validation rules, applied in iteration order:
 *  1. Each module must satisfy {@link assertSceneModule} (PUL-F001).
 *     The shape validator also enforces the kebab-case `scene.id`
 *     rule (PUL-A007) before the registry sees it.
 *  2. Scene ids must be unique within the registry — registration is by
 *     id, so collisions are unrecoverable here. The first occurrence
 *     wins detection: the duplicating scene raises the error.
 *
 * The returned registry is frozen and exposes only id-based lookup.
 * There is no add/remove/positional API by design (ADR-002 §Navigation,
 * ADR-008 #2 "manifests over flow control").
 */
export function createSceneRegistry(scenes: Iterable<SceneModule>): SceneRegistry {
  // `assertSceneModule` runs before the generic sees the entry so a
  // bad module raises with the PUL-F001 grammar (`scene "<id>" is
  // invalid: ...`) rather than a generic registry error. The
  // generic's own validators handle id-shape rejection (delegated
  // back to `assertSceneModule` via the `validate` block) and
  // duplicate-id rejection.
  return createIdRegistry(
    (function* mapToEntries() {
      for (const scene of scenes) {
        assertSceneModule(scene);
        yield { id: scene.id, value: scene };
      }
    })(),
    {
      label: 'scene registry',
      subject: 'scene',
      // `assertSceneModule` already validated the id shape; the
      // generic's id check is a no-op for scenes.
      validateId: () => undefined,
    },
  );
}
