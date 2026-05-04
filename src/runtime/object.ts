// Plain-record predicate for runtime validation.
//
// Pulsar's declarative-data invariant (ADR-008 #1, "manifests are
// declarative data only") rules out class instances such as `Date`,
// `Map`, `Set`, `RegExp`, `Error`, and user classes for any value
// the runtime treats as an object payload — they cannot be safely
// serialized, diffed, or treated as a record of keyed fields.
//
// Both the scene-shape validator (`./scene.ts`) and the composition
// manifest validator (`./composition.ts`) need this check. The
// predicate lives here so they share one definition, eliminating the
// drift the original duplication produced.

/**
 * Returns `true` only when `value` is a plain object literal —
 * `{ ... }` or `Object.create(null)`. Rejects `null`, arrays,
 * primitives, and class instances (including built-ins like `Date`,
 * `Map`, `Set`, `RegExp`, `Error`).
 */
export const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * Recursively freeze plain objects and arrays. Walks the value graph,
 * freezing each plain object and array reachable from `value`, and
 * returns the input unchanged when it is a primitive or already
 * frozen.
 *
 * Used wherever the runtime needs to defend a stored or returned
 * value against post-validation mutation: composition registry
 * manifests, behavior overrides, etc. Lives next to
 * {@link isPlainRecord} because the two predicates share the same
 * "what counts as a plain structure" boundary.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  // Already frozen — skip to avoid re-walking shared subtrees.
  if (Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const element of value) deepFreeze(element);
    return Object.freeze(value);
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}
