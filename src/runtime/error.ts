// Shared error-rendering helpers.
//
// Multiple subsystems (`composition-resolver`, `asset-preloader`,
// `workbench-navigator`) need to fold an unknown thrown value into a
// human-readable string for diagnostic messages. Centralizing the
// "Error → message, otherwise stringify" predicate prevents drift
// between subsystems and gives any future error-rendering rule
// (truncation, redaction, structured-cause unwrapping) a single home.

/**
 * Return a human-readable summary of an unknown error-ish value.
 *
 * Native `Error` instances surface `.message` so the diagnostic line
 * reads naturally; anything else (string, number, plain object,
 * `null`, `undefined`) is coerced via `String(...)` so the message
 * is still well-defined for non-Error throws (`throw 'boom'`,
 * `Promise.reject(undefined)`, etc.).
 */
export const describeError = (value: unknown): string =>
  value instanceof Error ? value.message : String(value);
