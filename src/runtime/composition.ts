// Composition manifest format — PUL-F003.
//
// A composition manifest is a declarative ordered list of scene id
// references. Each entry is either a bare scene id string or an
// object carrying a scene id plus per-entry overrides. This module
// owns the *format* — the data shape and the validator that rejects
// malformed values. Resolution against a SceneRegistry (existence
// checks, beat-label existence inside a scene's timeline, asset
// preloading) belongs to a later requirement and is out of scope
// here.
//
// References:
//  - ADR-002 §Composition manifests — informal shape + canonical examples.
//  - ADR-003 §Labels — sub-range labels addressed by name.
//  - ADR-008 #1 — kebab-case ids for scenes, compositions, beats, assets.
//  - PUL-A007 — scene id format (kebab-case).
//
// Per the codex architecture preflight (PUL-F003): the format is a
// declarative data shape only. Override fields must not redefine,
// inline, fork, or mutate the scene; unknown override keys are
// rejected so typos surface immediately rather than silently
// changing intent.

import { KEBAB_IDENTIFIER_FORM, isKebabIdentifier } from './identifier';
import { isPlainRecord } from './object';

/**
 * A sub-range override referencing one or more beat labels inside the
 * referenced scene's timeline (ADR-003 §Labels).
 *
 *  - `string` — a single beat label.
 *  - `readonly [string, string]` — a `[start, end]` label pair.
 *
 * Beat labels share the kebab-case rule with scene ids per ADR-008 #1.
 * Existence of the labels inside the referenced scene's timeline is
 * NOT validated here — that is a resolution concern and requires the
 * scene timeline to be inspected.
 */
export type SubRange = string | readonly [string, string];

/**
 * Per-entry behavior override blob. The format reserves this slot for
 * runtime-defined behavior keys; this module does not constrain keys
 * or values beyond "must be a plain object". Resolution layers that
 * consume specific behavior keys validate them.
 */
export type BehaviorOverride = Readonly<Record<string, unknown>>;

/**
 * Object form of a composition entry: a scene id reference plus
 * optional per-entry overrides for sub-range or behavior. Unknown
 * keys are rejected by the validator — see module comment.
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

function failManifest(condition: string): never {
  throw new Error(`composition manifest is invalid: ${condition}`);
}

function failEntry(index: number, field: string, condition: string): never {
  throw new Error(`composition entry [${index}] is invalid: ${field} ${condition}`);
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
 * Validates that `value` is a well-formed {@link CompositionManifest}
 * per PUL-F003. Throws `Error` with a message identifying the offending
 * entry index and field/condition (matches the
 * `assertSceneModule` error grammar with an entry index prefix).
 *
 * Iterates entries in order and stops at the first failure. Existence
 * of referenced scene ids in the registry, and existence of referenced
 * beat labels inside a scene's timeline, are NOT checked here; they
 * belong to the resolution layer.
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
 * Convenience type predicate. Returns `true` if `value` satisfies the
 * composition manifest contract; `false` otherwise. Use
 * {@link assertCompositionManifest} when the failure detail matters
 * to the caller.
 */
export function isCompositionManifest(value: unknown): value is CompositionManifest {
  try {
    assertCompositionManifest(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract the scene id from a composition entry. Bare string entries
 * are the scene id verbatim; object entries carry the id under `id`.
 * Centralized so resolver, URL navigation, and any future consumer
 * read entry identity through one helper.
 */
export const entryId = (entry: CompositionEntry): string =>
  typeof entry === 'string' ? entry : entry.id;

/**
 * One missing entry recorded by {@link findUnregisteredEntries}: the
 * entry's index in the manifest plus its scene id. Callers format
 * their own error messages from these tuples so subsystem-specific
 * grammar (composition resolver vs URL navigation) stays at the call
 * site.
 */
export interface MissingEntry {
  readonly index: number;
  readonly id: string;
}

/**
 * Walk a composition manifest and aggregate every entry whose scene
 * id is not satisfied by `isPresent`. Returns the missing entries in
 * iteration order.
 *
 * Centralized so composition-resolver's preflight pass and URL
 * navigation's slice snapshot share the same "report every gap, not
 * just the first" behavior — a manifest author or composition
 * registrar fixes every typo in one pass rather than chasing a
 * sequence of "first miss" errors.
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
