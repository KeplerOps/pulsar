// Kebab-case identifier predicate — ADR-008 #1.
//
// Scenes, compositions, beats, and assets all share a single
// identifier shape per ADR-008 #1 ("Stable, declarative identity.
// Scenes, compositions, beats, and assets have stable, kebab-case
// ids."). PUL-A007 formalizes the rule for scene ids and clause C1
// of that requirement is enforced in `./scene.ts`.
//
// Multiple call sites (scene shape validation, composition manifest
// validation, future beat / asset validators) need the same
// predicate. This module is the single source of truth so the regex
// is defined once and each caller can name the concept it is
// validating without duplicating the rule.

/**
 * Strict kebab-case identifier pattern: non-empty lowercase ASCII
 * alphanumeric segments separated by single hyphens. Rejects empty
 * strings, leading/trailing hyphens, consecutive hyphens, uppercase,
 * underscores, whitespace, punctuation, and non-ASCII.
 */
export const KEBAB_IDENTIFIER_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Returns `true` when `value` is a string matching
 * {@link KEBAB_IDENTIFIER_PATTERN}.
 */
export const isKebabIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && KEBAB_IDENTIFIER_PATTERN.test(value);
