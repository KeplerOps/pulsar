// Shared property-based fuzz for the runtime shape validators
// (`assertSceneModule`, `assertCompositionManifest`,
// `assertAudioBedDeclaration`).
//
// These validators exist to reject author-fallible plain-JS data, so
// the regression oracle that matters is "every malformed-input class is
// rejected and the offending field is named" — not an enumerated row
// per concrete bad value. A hand-rolled deterministic generator emits
// inputs across the malformed-input space the validators guard
// (omission, wrong type, out-of-range number, non-kebab id) and the
// driver asserts each is rejected with the offending field named. Far
// fewer brittle `.each` lines, same-or-better coverage.
//
// Determinism: the generator draws from `createSeededRng` (the runtime
// mulberry32 PRNG, ADR-021) rather than `Math.random`, so a failing
// case reproduces from its seed. `Math.random` is banned in `src/`; we
// hold tests to the same reproducibility bar by choice.

import { expect } from 'vitest';
import { createSeededRng } from '../../src/runtime/rng';

/**
 * The expected type of a fuzzable field. The generator corrupts the
 * field with values drawn ONLY from outside this type, so every draw is
 * guaranteed-invalid — covering the wrong-type / out-of-range / non-
 * kebab-id malformed classes per field kind.
 *
 *  - `string`       — a plain string field (corrupt with non-strings).
 *  - `kebab-id`     — a kebab-case identifier (corrupt with non-kebab
 *    strings AND non-strings).
 *  - `string-array` — an array of strings (corrupt with non-arrays and
 *    arrays carrying a non-string element).
 *  - `boolean`      — a boolean (corrupt with non-booleans).
 *  - `function`     — a function (corrupt with non-functions).
 *  - `gain`         — a finite number in `[0, 1]` (corrupt with non-
 *    numbers and out-of-range numbers).
 *  - `kebab-id-or-null` — a kebab id OR `null` (corrupt with non-kebab
 *    strings and wrong types, but NEVER `null`/`undefined`, which are
 *    accepted).
 *  - `nonneg-int-or-null` — a non-negative integer OR `null` (corrupt
 *    with negatives, fractionals, non-finite numbers, and wrong types,
 *    but NEVER `null`, which is accepted).
 *  - `string-or-array` — a string OR any array (the shallow audio-bed
 *    `src` shape; corrupt with values that are neither).
 *  - `number` — a number (corrupt with non-numbers, but NEVER
 *    `undefined`, which means "field omitted" for an optional field).
 */
export type FieldKind =
  | 'string'
  | 'kebab-id'
  | 'kebab-id-or-null'
  | 'string-array'
  | 'boolean'
  | 'function'
  | 'gain'
  | 'nonneg-int-or-null'
  | 'string-or-array'
  | 'number';

const NON_KEBAB_STRINGS = [
  '',
  'Upper',
  'two words',
  'snake_case',
  '-leading',
  'trailing-',
  'double--hyphen',
  'dot.sep',
  'slash/sep',
  'séance',
] as const;

const NON_STRINGS = [42, true, null, undefined, { not: 'string' }, ['arr'], Symbol.for('fuzz')];
// Wrong types for a `string | null` field, EXCLUDING null/undefined.
const NON_STRING_NON_NULL = [42, true, { not: 'string' }, ['arr'], Symbol.for('fuzz')];
const NON_BOOLEANS = [42, 'yes', null, undefined, {}, [], 0, 1];
const NON_FUNCTIONS = [42, 'fn', null, undefined, {}, [], true];
const NON_STRING_ARRAYS = [42, 'not-array', true, null, undefined, {}, [42], ['ok', 99]];
const BAD_GAINS = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  'loud',
  null,
  {},
];
// Invalid for a `non-negative integer | null` field, EXCLUDING null.
const BAD_NONNEG_INTS = [
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  '5000',
  true,
  {},
];

// Neither a string nor an array — invalid for the shallow `src` shape.
const NEITHER_STRING_NOR_ARRAY = [42, true, null, { not: 'src' }, Symbol.for('fuzz')];
// Non-numbers, EXCLUDING undefined (which means "optional field omitted").
const NON_NUMBERS = ['loud', true, null, { not: 'number' }, ['arr'], Symbol.for('fuzz')];

const POOLS: Record<FieldKind, readonly unknown[]> = {
  string: NON_STRINGS,
  'kebab-id': [...NON_KEBAB_STRINGS, ...NON_STRINGS],
  'kebab-id-or-null': [...NON_KEBAB_STRINGS, ...NON_STRING_NON_NULL],
  'string-array': NON_STRING_ARRAYS,
  boolean: NON_BOOLEANS,
  function: NON_FUNCTIONS,
  gain: BAD_GAINS,
  'nonneg-int-or-null': BAD_NONNEG_INTS,
  'string-or-array': NEITHER_STRING_NOR_ARRAY,
  number: NON_NUMBERS,
};

/** Draw a deterministic element of `pool` from the seeded generator. */
const pick = <T>(rng: () => number, pool: readonly T[]): T => {
  const index = Math.floor(rng() * pool.length) % pool.length;
  return pool[index] as T;
};

/**
 * One fuzzable field: its name, its expected kind (which fixes the
 * guaranteed-invalid corruption pool), and whether omitting it is also
 * a rejection the validator must catch.
 */
export interface FuzzField {
  /** Field name; also the substring the rejection message must name. */
  readonly name: string;
  /** Expected type — fixes the malformed-value pool. */
  readonly kind: FieldKind;
  /** When true, also fuzz the omission case (delete the field). */
  readonly omittable?: boolean;
  /**
   * Substring the rejection message must contain, when it differs from
   * `name` (e.g. an indexed `audio[0]` envelope).
   */
  readonly messageField?: string;
}

/**
 * Run the seeded fuzz over `fields` against `assert`.
 *
 * For each field, build a value that is valid except for that one
 * corrupted field, then assert `assert` throws an error whose message
 * names the field. `iterations` draws are made per field so each pool
 * is exercised without an enumerated row per value. `valid()` must
 * return a fresh, valid base each call so corruption never leaks
 * between draws.
 *
 * `wrap` adapts a corrupted record into the shape `assert` accepts (a
 * scene / bed validator takes the record directly; the composition
 * validator takes `[entry]`).
 */
export function runValidatorFuzz<T>(opts: {
  readonly seed: string;
  readonly iterations?: number;
  readonly valid: () => Record<string, unknown>;
  readonly fields: readonly FuzzField[];
  readonly wrap?: (record: Record<string, unknown>) => T;
  readonly assert: (value: T) => void;
}): void {
  const { seed, valid, fields, assert } = opts;
  const iterations = opts.iterations ?? 24;
  const wrap = opts.wrap ?? ((record) => record as unknown as T);
  const rng = createSeededRng(seed);

  const expectRejected = (record: Record<string, unknown>, field: string, detail: string): void => {
    let message: string | null = null;
    try {
      assert(wrap(record));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message, `expected rejection for ${detail}`).not.toBeNull();
    if (message === null) return;
    // The validator must name the offending field as a DISTINCT token, not
    // merely contain its letters: a bare substring check for a short field
    // like "id" is satisfied by "invalid"/"identifier", so a regression to a
    // generic "... is invalid" message with no field name would pass. Require
    // the field bounded by non-identifier characters (or string ends).
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const namedToken = new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}([^\\p{L}\\p{N}_]|$)`, 'u');
    expect(message, `rejection for ${detail} must name "${field}" as a distinct token`).toMatch(
      namedToken,
    );
  };

  for (const field of fields) {
    const named = field.messageField ?? field.name;
    if (field.omittable === true) {
      const record = valid();
      delete record[field.name];
      expectRejected(record, named, `omitted "${field.name}"`);
    }
    for (let i = 0; i < iterations; i += 1) {
      const record = valid();
      const corrupt = pick(rng, POOLS[field.kind]);
      record[field.name] = corrupt;
      expectRejected(record, named, `"${field.name}" = ${String(corrupt)} (${field.kind})`);
    }
  }
}
