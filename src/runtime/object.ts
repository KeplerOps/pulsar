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
