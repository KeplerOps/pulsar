// Composition manifest format — PUL-F003 (ADR-002 / ADR-003 / ADR-008 #1).
//
// A declarative ordered list of scene-id references: each entry is a bare
// kebab-case scene id or an object with the id plus per-entry overrides.
// This module owns the FORMAT only — shape + validator; resolution against
// a SceneRegistry is the resolver's. Unknown override keys are rejected so
// typos surface immediately.

import { KEBAB_IDENTIFIER_FORM, isKebabIdentifier } from './identifier';
import { isPlainRecord } from './object';

/**
 * A sub-range override (ADR-003 §Labels): a single kebab-case beat label
 * or a `[start, end]` pair. Label existence is a resolution concern, not
 * validated here.
 */
export type SubRange = string | readonly [string, string];

/**
 * Per-entry behavior override blob — a plain object whose keys are the
 * consuming resolution layer's contract; not constrained here.
 */
export type BehaviorOverride = Readonly<Record<string, unknown>>;

/**
 * Object form of a composition entry: a scene id plus optional `range` /
 * `behavior` overrides. Unknown keys are rejected by the validator.
 */
export interface CompositionEntryOverride {
  readonly id: string;
  readonly range?: SubRange;
  readonly behavior?: BehaviorOverride;
}

/** A single composition entry: bare scene-id string OR override object. */
export type CompositionEntry = string | CompositionEntryOverride;

/** A composition manifest: an ordered list of entries (PUL-F003 C1). */
export type CompositionManifest = readonly CompositionEntry[];

const ALLOWED_OBJECT_KEYS = new Set<keyof CompositionEntryOverride>(['id', 'range', 'behavior']);

const KEBAB_CONDITION = `must be a non-empty lowercase kebab-case string (${KEBAB_IDENTIFIER_FORM})`;

const RANGE_CONDITION =
  'must be a kebab-case beat label or a [start, end] tuple of kebab-case beat labels';

const isValidSubRange = (v: unknown): v is SubRange => {
  if (isKebabIdentifier(v)) return true;
  if (!Array.isArray(v)) return false;
  if (v.length !== 2) return false;
  return isKebabIdentifier(v[0]) && isKebabIdentifier(v[1]);
};

/**
 * Error thrown by {@link assertCompositionManifest}. Carries `entryIndex`
 * as a structured field (per-entry failures set it; shape failures leave
 * it `undefined`) so PUL-Q005 / PUL-F028 validation can read it via
 * `instanceof` without parsing the message string.
 */
export class CompositionManifestError extends Error {
  readonly entryIndex?: number;

  constructor(message: string, entryIndex?: number) {
    super(message);
    this.name = 'CompositionManifestError';
    if (entryIndex !== undefined) this.entryIndex = entryIndex;
  }
}

function failManifest(condition: string): never {
  throw new CompositionManifestError(`composition manifest is invalid: ${condition}`);
}

function failEntry(index: number, field: string, condition: string): never {
  throw new CompositionManifestError(
    `composition entry [${index}] is invalid: ${field} ${condition}`,
    index,
  );
}

const validateBareString = (index: number, entry: string): void => {
  if (!isKebabIdentifier(entry)) {
    failEntry(index, 'id', KEBAB_CONDITION);
  }
};

const validateObjectEntry = (index: number, entry: Record<string, unknown>): void => {
  if (!Object.hasOwn(entry, 'id')) {
    failEntry(index, 'id', 'must be present');
  }

  if (!isKebabIdentifier(entry.id)) {
    failEntry(index, 'id', KEBAB_CONDITION);
  }

  if (Object.hasOwn(entry, 'range') && !isValidSubRange(entry.range)) {
    failEntry(index, 'range', RANGE_CONDITION);
  }

  if (Object.hasOwn(entry, 'behavior') && !isPlainRecord(entry.behavior)) {
    failEntry(index, 'behavior', 'must be a plain object');
  }

  for (const key of Object.keys(entry)) {
    if (!ALLOWED_OBJECT_KEYS.has(key as keyof CompositionEntryOverride)) {
      failEntry(index, `unknown key "${key}"`, '— allowed: id, range, behavior');
    }
  }
};

/**
 * Validate a well-formed {@link CompositionManifest} (PUL-F003), throwing
 * with the offending entry index + field/condition and stopping at the
 * first failure. Scene-id / beat-label existence is the resolution layer's.
 */
export function assertCompositionManifest(value: unknown): asserts value is CompositionManifest {
  if (!Array.isArray(value)) {
    failManifest('must be an array');
  }

  for (let index = 0; index < value.length; index += 1) {
    const entry: unknown = value[index];

    if (typeof entry === 'string') {
      validateBareString(index, entry);
      continue;
    }

    if (!isPlainRecord(entry)) {
      failEntry(
        index,
        'entry',
        'must be a kebab-case scene id string or a { id, range?, behavior? } object',
      );
    }

    validateObjectEntry(index, entry);
  }
}

/**
 * Type predicate for the composition manifest contract; use
 * {@link assertCompositionManifest} when the failure detail matters.
 */
export function isCompositionManifest(value: unknown): value is CompositionManifest {
  try {
    assertCompositionManifest(value);
    return true;
  } catch {
    return false;
  }
}

/** Extract the scene id from a composition entry (bare string, or `.id`). */
export const entryId = (entry: CompositionEntry): string =>
  typeof entry === 'string' ? entry : entry.id;

/** One missing entry from {@link findUnregisteredEntries}: index + scene id. */
export interface MissingEntry {
  readonly index: number;
  readonly id: string;
}

/**
 * Aggregate every entry whose scene id is not satisfied by `isPresent`,
 * in iteration order — so callers report every gap in one pass.
 */
export function findUnregisteredEntries(
  manifest: CompositionManifest,
  isPresent: (id: string) => boolean,
): readonly MissingEntry[] {
  const missing: MissingEntry[] = [];
  for (const [index, entry] of manifest.entries()) {
    const id = entryId(entry);
    if (!isPresent(id)) {
      missing.push({ index, id });
    }
  }
  return missing;
}
