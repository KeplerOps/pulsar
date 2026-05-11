// Generic id-keyed registry helper.
//
// Both the scene registry (PUL-F002) and the composition registry
// (PUL-F008's companion to PUL-F002) need the same structural plumbing:
// a Map keyed by stable id, an insertion-order array, duplicate-id
// rejection at construction time, lookup that throws on miss, a
// frozen ids() snapshot, and a frozen registry surface.
//
// This module factors that plumbing into one helper so both registries
// stay symmetric and any future bugfix lands once. Per-registry
// concerns (id-shape validation, value-shape validation, defensive
// freeze of the stored value) plug in via the `validate` and
// `transform` hooks, keeping the generic single-purpose.
//
// Per ADR-008 #2 ("manifests over flow control"): registries are
// built once at bootstrap, validated up front, immutable thereafter.
// The generic preserves that contract — there is no add/remove API by
// design.

/** A single registration: an id paired with the value to register. */
export interface IdRegistryEntry<T> {
  readonly id: string;
  readonly value: T;
}

/**
 * Read-only id-keyed registry. The shape is intentionally minimal —
 * lookup by id only, no positional or mutation API. The actual
 * registry types (`SceneRegistry`, `CompositionRegistry`) declare
 * domain-specific method signatures (`get`, `has`) but share the
 * structural shape this interface defines.
 */
export interface IdRegistry<T> {
  /** Look up a value by id. Throws if no value is registered with that id. */
  get(id: string): T;
  /** Check whether a value is registered with the given id. */
  has(id: string): boolean;
  /** Snapshot of registered ids in insertion order. The returned array is frozen. */
  ids(): readonly string[];
  /** Number of registered values. */
  readonly size: number;
}

/**
 * Hooks the per-domain registry uses to specialize the generic.
 *
 *  - `label` — short string included in error messages
 *    (`<label>: id "..." must be ...`, `<label>: duplicate id "..."`,
 *    `<label>: no <subject> registered with id "..."`).
 *  - `subject` — domain noun used in the "no <subject> registered"
 *    miss message; e.g. `'scene'`, `'composition'`. Defaults to
 *    `label` when omitted.
 *  - `validateId` — throws when the id fails the domain's id-shape
 *    rule. Both registries use kebab-case, but the generic stays
 *    agnostic so a future registry can pick a different rule.
 *  - `transform` — applied to each registered value before storage.
 *    Lets the composition registry deep-freeze its manifests without
 *    leaking that concern into the generic.
 *  - `onDuplicate` — optional collector invoked instead of throwing
 *    when an entry's id is already registered. Lets PUL-F028's
 *    runtime validation pass aggregate every duplicate occurrence
 *    rather than stopping at the first, while leaving the runtime
 *    construction path (no callback supplied) fail-fast with the
 *    `<label>: duplicate id "<id>"` envelope. The duplicating entry
 *    is NOT registered; the first occurrence remains canonical.
 */
export interface IdRegistryConfig<T> {
  readonly label: string;
  readonly subject?: string;
  readonly validateId: (id: string) => void;
  readonly transform?: (value: T) => T;
  readonly onDuplicate?: (entry: IdRegistryEntry<T>) => void;
}

/**
 * Build an {@link IdRegistry} from a collection of (id, value) entries.
 *
 * Validation rules, applied in iteration order:
 *  1. `id` is rejected by `config.validateId` (which throws). The
 *     generic itself does not enforce a shape.
 *  2. Ids must be unique within the registry — `<label>: duplicate id
 *     "<id>"`.
 *  3. Each value passes through `config.transform` (when supplied)
 *     before storage so the registry stores a domain-shaped copy.
 *
 * The returned registry object is frozen; the `ids()` snapshot is
 * frozen on every call.
 */
export function createIdRegistry<T>(
  entries: Iterable<IdRegistryEntry<T>>,
  config: IdRegistryConfig<T>,
): IdRegistry<T> {
  const subject = config.subject ?? config.label;
  const byId = new Map<string, T>();
  const order: string[] = [];

  for (const entry of entries) {
    config.validateId(entry.id);
    if (byId.has(entry.id)) {
      // `onDuplicate` lets the PUL-F028 validation pass aggregate every
      // duplicate occurrence (registry stays the single source of truth
      // for uniqueness + error grammar). Default path remains fail-fast:
      // the runtime's boot construction never supplies the callback, so
      // a duplicate at registry construction still throws.
      if (config.onDuplicate !== undefined) {
        config.onDuplicate(entry);
        continue;
      }
      throw new Error(`${config.label}: duplicate id "${entry.id}"`);
    }
    const stored = config.transform === undefined ? entry.value : config.transform(entry.value);
    byId.set(entry.id, stored);
    order.push(entry.id);
  }

  const registry: IdRegistry<T> = {
    get(id: string): T {
      const value = byId.get(id);
      if (value === undefined) {
        throw new Error(`${config.label}: no ${subject} registered with id "${id}"`);
      }
      return value;
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
