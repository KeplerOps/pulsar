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
// References:
//  - ADR-002 §Navigation — composition addressability via id.
//  - ADR-008 #1 — kebab-case identity rule shared with scenes,
//    compositions, beats, and assets.
//  - PUL-F003 — composition manifest format validator.
//  - PUL-F008 / ADR-013 — `?composition=X&scene=Y` URL navigation
//    consults this registry to resolve composition existence and
//    membership before any scene lifecycle hook runs.

import { type CompositionManifest, assertCompositionManifest } from './composition';
import { KEBAB_IDENTIFIER_FORM, isKebabIdentifier } from './identifier';

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
export interface CompositionRegistry {
  /** Look up a manifest by id. Throws if no composition is registered with that id. */
  get(id: string): CompositionManifest;
  /** Check whether a composition is registered with the given id. */
  has(id: string): boolean;
  /** Snapshot of registered ids in insertion order. The returned array is detached from the registry. */
  ids(): readonly string[];
  /** Number of registered compositions. */
  readonly size: number;
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
 * The returned registry is frozen and exposes only id-based lookup.
 */
export function createCompositionRegistry(
  entries: Iterable<CompositionRegistryEntry>,
): CompositionRegistry {
  const byId = new Map<string, CompositionManifest>();
  const order: string[] = [];

  for (const entry of entries) {
    if (!isKebabIdentifier(entry.id)) {
      throw new Error(
        `composition registry: id "${entry.id}" must be a non-empty lowercase kebab-case string (${KEBAB_IDENTIFIER_FORM})`,
      );
    }
    if (byId.has(entry.id)) {
      throw new Error(`composition registry: duplicate id "${entry.id}"`);
    }
    assertCompositionManifest(entry.manifest);
    byId.set(entry.id, entry.manifest);
    order.push(entry.id);
  }

  const registry: CompositionRegistry = {
    get(id: string): CompositionManifest {
      const manifest = byId.get(id);
      if (manifest === undefined) {
        throw new Error(`composition registry: no composition registered with id "${id}"`);
      }
      return manifest;
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
