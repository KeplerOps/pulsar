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

import { type AudioBedDeclaration, assertAudioBedDeclaration } from './audio';
import { type CompositionManifest, assertCompositionManifest } from './composition';
import { type IdRegistry, createIdRegistry } from './id-registry';
import { KEBAB_IDENTIFIER_FORM, isKebabIdentifier } from './identifier';
import { deepFreeze } from './object';

/**
 * A composition registration: a kebab-case id, a validated manifest,
 * and an optional composition-level audio bed (PUL-F014 / ADR-004).
 * The `audioBed`, when present, is the surrounding ambient / musical
 * loop the runtime plays underneath the slice — and suppresses under
 * `mode=standalone`.
 */
export interface CompositionRegistryEntry {
  readonly id: string;
  readonly manifest: CompositionManifest;
  readonly audioBed?: AudioBedDeclaration;
}

/**
 * The value the {@link CompositionRegistry} stores per id: the
 * validated, deep-frozen manifest plus the optional composition audio
 * bed declaration (PUL-F014). Extending the registration boundary
 * here — rather than hiding the bed in a per-entry `behavior` blob —
 * keeps the bed a composition-level fact, validated once at
 * registration.
 */
export interface RegisteredComposition {
  readonly manifest: CompositionManifest;
  readonly audioBed?: AudioBedDeclaration;
}

/**
 * Id-keyed registry of compositions. Mirrors {@link SceneRegistry}'s
 * shape so URL navigation, presenter controls, and any future
 * composition-aware feature dispatch through the same lookup surface.
 * Built once via {@link createCompositionRegistry}; the surface is
 * intentionally small — lookup by id only — and the returned registry
 * is frozen. Each stored value is a {@link RegisteredComposition}
 * (manifest + optional audio bed).
 */
export type CompositionRegistry = IdRegistry<RegisteredComposition>;

/**
 * Deep-snapshot then deep-freeze the registered composition so the
 * stored value cannot be mutated by callers after registration.
 * `structuredClone` gives us a fresh graph (no shared subtrees with
 * the caller's references — defeats the "callers can mutate
 * `behavior.fade.ease` (or `audioBed.src`) after registration" leak);
 * `deepFreeze` walks the clone and freezes every plain object/array
 * reachable from it (the manifest array, each object-form entry,
 * nested `range` tuples, the entire `behavior` value graph, and the
 * `audioBed` declaration). Bare-string entries are immutable already.
 *
 * `structuredClone` is platform-standard since Node 17 / all current
 * browsers; per ADR-008 #1's declarative-data invariant, manifest and
 * bed payloads are structured data only — no functions, classes, or
 * other non-cloneable values.
 */
function freezeComposition(composition: RegisteredComposition): RegisteredComposition {
  return deepFreeze(structuredClone(composition)) as RegisteredComposition;
}

/**
 * Build a {@link CompositionRegistry} from a collection of (id,
 * manifest, audioBed?) entries.
 *
 * Validation rules, applied in iteration order:
 *  1. `id` must satisfy {@link isKebabIdentifier} (ADR-008 #1).
 *  2. `manifest` must satisfy {@link assertCompositionManifest}
 *     (PUL-F003).
 *  3. `audioBed` (when present) must satisfy
 *     {@link assertAudioBedDeclaration} (PUL-F014).
 *  4. Ids must be unique within the registry — registration is by id.
 *
 * Stored compositions are deep-frozen so caller-side mutation of the
 * original array (or of nested override / bed objects) cannot leak
 * into the registry. The returned registry is frozen and exposes only
 * id-based lookup.
 */
export function createCompositionRegistry(
  entries: Iterable<CompositionRegistryEntry>,
): CompositionRegistry {
  // `assertCompositionManifest` / `assertAudioBedDeclaration` run
  // before the generic sees the entry so a malformed manifest raises
  // with the PUL-F003 grammar (`composition manifest is invalid: ...`)
  // and a malformed bed with the PUL-F014 grammar (`audio bed ...`),
  // rather than a generic registry error. The generic itself handles
  // id-shape rejection (`composition registry: id "<id>" must be ...`)
  // and duplicate-id rejection. Storage uses `freezeComposition` as
  // the transform so the generic is still single-purpose.
  return createIdRegistry(
    (function* mapToEntries() {
      for (const entry of entries) {
        assertCompositionManifest(entry.manifest);
        if (entry.audioBed !== undefined) assertAudioBedDeclaration(entry.audioBed);
        const value: RegisteredComposition = {
          manifest: entry.manifest,
          ...(entry.audioBed ? { audioBed: entry.audioBed } : {}),
        };
        yield { id: entry.id, value };
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
      transform: freezeComposition,
    },
  );
}
