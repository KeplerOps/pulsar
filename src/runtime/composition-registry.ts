// Composition registry — companion to PUL-F002's scene registry.
//
// Compositions need the same addressability path scenes have (ADR-002
// §Navigation: navigation is in terms of (composition, scene, beat,
// mode) tuples). The runtime owns one composition registry, keyed by
// stable kebab-case id, built once at bootstrap, immutable thereafter.
//
// Per ADR-008 #1 / #2: ids are kebab-case and registries are manifests
// over flow control. Manifest-shape validation is delegated to
// `assertCompositionManifest` (PUL-F003); the registry only enforces
// id shape (kebab-case via `isKebabIdentifier`) and uniqueness.
//
// The id-keyed plumbing (Map, frozen snapshot, duplicate-id rejection,
// miss-throws) is shared with the scene registry via `./id-registry.ts`.
//
// References:
//  - ADR-002 §Navigation — composition addressability via id.
//  - ADR-008 #1 — kebab-case identity rule shared with scenes,
//    compositions, beats, and assets.
//  - PUL-F003 — composition manifest format validator.
//  - PUL-F008 / ADR-013 — `?composition=X&scene=Y` URL navigation
//    consults this registry to resolve composition existence and
//    membership before any scene lifecycle hook runs.

import {
  type CompositionEntry,
  type CompositionManifest,
  assertCompositionManifest,
} from './composition';
import { type IdRegistry, createIdRegistry } from './id-registry';
import { KEBAB_IDENTIFIER_FORM, isKebabIdentifier } from './identifier';
import { deepFreeze } from './object';

/** A composition registration: (kebab-case id, validated manifest). */
export interface CompositionRegistryEntry {
  readonly id: string;
  readonly manifest: CompositionManifest;
}

/**
 * Id-keyed registry of composition manifests. Mirrors {@link
 * SceneRegistry}'s shape so URL navigation, presenter controls, and
 * any future composition-aware feature dispatch through the same
 * lookup surface. Built once via {@link createCompositionRegistry};
 * the surface is intentionally small — lookup by id only — and the
 * returned registry is frozen.
 */
export type CompositionRegistry = IdRegistry<CompositionManifest>;

/**
 * Deep-snapshot then deep-freeze the manifest so the stored value
 * cannot be mutated by callers after registration. `structuredClone`
 * gives us a fresh graph (no shared subtrees with the caller's
 * references — defeats the "callers can mutate `behavior.fade.ease`
 * after registration" leak); `deepFreeze` walks the clone and freezes
 * every plain object/array reachable from the manifest (the array,
 * each object-form entry, nested `range` tuples, and the entire
 * `behavior` value graph at every depth). Bare-string entries are
 * immutable already.
 *
 * `structuredClone` is platform-standard since Node 17 / all current
 * browsers; per ADR-008 #1's declarative-data invariant, manifest
 * payloads (including `behavior` records) are structured data only —
 * no functions, classes, or other non-cloneable values.
 *
 * The `unknown` cast is necessary because the source `manifest` is
 * typed `readonly CompositionEntry[]`; the cloned array has the same
 * shape but TypeScript widens the cloned-readonly to `unknown` for
 * `structuredClone`'s untyped output.
 */
function freezeManifest(manifest: CompositionManifest): CompositionManifest {
  return deepFreeze(structuredClone(manifest as CompositionEntry[])) as CompositionManifest;
}

/**
 * Build a {@link CompositionRegistry} from a collection of (id,
 * manifest) entries.
 *
 * Validation rules, applied in iteration order:
 *  1. `id` must satisfy {@link isKebabIdentifier} (ADR-008 #1).
 *  2. `manifest` must satisfy {@link assertCompositionManifest}
 *     (PUL-F003).
 *  3. Ids must be unique within the registry — registration is by id.
 *
 * Stored manifests are deep-frozen so caller-side mutation of the
 * original array (or of nested override objects) cannot leak into the
 * registry. The returned registry is frozen and exposes only id-based
 * lookup.
 */
export function createCompositionRegistry(
  entries: Iterable<CompositionRegistryEntry>,
): CompositionRegistry {
  // `assertCompositionManifest` runs before the generic sees the
  // entry so a malformed manifest raises with the PUL-F003 grammar
  // (`composition manifest is invalid: ...`) rather than a generic
  // registry error. The generic itself handles id-shape rejection
  // (`composition registry: id "<id>" must be ...`) and duplicate-id
  // rejection. Storage uses `freezeManifest` as the transform so the
  // generic is still single-purpose.
  return createIdRegistry(
    (function* mapToEntries() {
      for (const entry of entries) {
        assertCompositionManifest(entry.manifest);
        yield { id: entry.id, value: entry.manifest };
      }
    })(),
    {
      label: 'composition registry',
      subject: 'composition',
      validateId: (id) => {
        if (!isKebabIdentifier(id)) {
          throw new Error(
            `composition registry: id "${id}" must be a non-empty lowercase kebab-case string (${KEBAB_IDENTIFIER_FORM})`,
          );
        }
      },
      transform: freezeManifest,
    },
  );
}
