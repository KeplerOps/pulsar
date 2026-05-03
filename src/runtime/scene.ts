// Scene module contract — PUL-F001 + PUL-A007.
//
// Single source of truth for the shape every scene module exports.
// Per ADR-002 the scene/composition model treats this object as the
// scene's canonical metadata; per ADR-008 the runtime validates the
// shape before mounting so cleanup leaks, dangling assets, and id
// collisions surface loudly.
//
// Scene id format is enforced here (PUL-A007): kebab-case lowercase
// ASCII (`[a-z0-9]+(-[a-z0-9]+)*`). The regex itself lives in
// ./identifier.ts because ADR-008 #1 makes the same rule binding on
// scenes, compositions, beats, and assets — see `isKebabIdentifier`.
// Id reuse across scenes is enforced by the registry (PUL-F002) —
// the two clauses of PUL-A007 are split across this file (format)
// and ./registry.ts (uniqueness).
//
// Downstream consumers (registry, composition resolver, exporter)
// must call assertSceneModule rather than re-implementing checks.

import { isKebabIdentifier } from './identifier';

/**
 * Caption metadata. ADR-002 specifies `{ at: ms, text }`. The prompter,
 * the live runtime, and the export pipeline all consume this same
 * structure (PUL-A009).
 */
export interface Caption {
  at: number;
  text: string;
}

/**
 * Lifecycle function signature. The `ctx` argument is opaque here and
 * refined by PUL-F002 (registry lifecycle) plus ADR-003 / ADR-004
 * (timeline + audio surface via `ctx.gsap`, `ctx.audio`). Until then,
 * lifecycle implementations should treat the value as opaque and
 * route through whatever helpers the runtime exposes when they land.
 */
export type SceneLifecycleFn = (ctx: unknown) => unknown;

/**
 * The contract every scene module exports per PUL-F001.
 *
 *  - `id`, `title`: stable identity + human-readable label.
 *  - `duration`: non-negative integer milliseconds, or `null` for
 *     open-ended / interrupt-driven scenes.
 *  - `tags`, `assets`, `captions`: metadata consumed by prompter,
 *     preloader, exporter — declared once on the module.
 *  - `defaultNext`: successor scene id, or `null` for "no default".
 *     Sequencing belongs to the composition layer (ADR-002 / PUL-A005);
 *     this field is metadata, not flow control.
 *  - `standalone`: explicit assertion that the scene can run without
 *     surrounding context (ADR-008).
 *  - `trailerSafe`: explicit assertion that the scene can be cut into
 *     a trailer without context.
 *  - `create` / `timeline` / `cleanup`: lifecycle hooks. Cleanup is
 *     mandatory per PUL-P001.
 */
export interface SceneModule {
  id: string;
  title: string;
  duration: number | null;
  tags: readonly string[];
  assets: readonly string[];
  captions: readonly Caption[];
  defaultNext: string | null;
  standalone: boolean;
  trailerSafe: boolean;
  create: SceneLifecycleFn;
  timeline: SceneLifecycleFn;
  cleanup: SceneLifecycleFn;
}

const REQUIRED_FIELDS = [
  'id',
  'title',
  'duration',
  'tags',
  'assets',
  'captions',
  'defaultNext',
  'standalone',
  'trailerSafe',
  'create',
  'timeline',
  'cleanup',
] as const satisfies readonly (keyof SceneModule)[];

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isStringArray = (v: unknown): v is readonly string[] =>
  Array.isArray(v) && v.every((e) => typeof e === 'string');

const isValidDuration = (v: unknown): v is number | null =>
  v === null || (typeof v === 'number' && Number.isInteger(v) && Number.isFinite(v) && v >= 0);

const isCaption = (v: unknown): v is Caption =>
  isPlainObject(v) && typeof v.at === 'number' && typeof v.text === 'string';

const isCaptionArray = (v: unknown): v is readonly Caption[] =>
  Array.isArray(v) && v.every(isCaption);

// Scene ids share the kebab-case rule with all other Pulsar
// identifiers per ADR-008 #1; the predicate lives in ./identifier.ts
// so composition entries, beat labels, and future asset ids do not
// each carry their own copy of the regex (PUL-A007 clause C1).
const isSceneId = isKebabIdentifier;

const isSceneIdOrNull = (v: unknown): v is string | null => v === null || isSceneId(v);

const fail = (id: string | undefined, field: string, condition: string): never => {
  const idLabel = id === undefined ? '?' : `"${id}"`;
  throw new Error(`scene ${idLabel} is invalid: ${field} ${condition}`);
};

interface FieldGuard {
  readonly field: keyof SceneModule;
  readonly check: (v: Record<string, unknown>) => boolean;
  readonly condition: string;
}

const FIELD_GUARDS: readonly FieldGuard[] = [
  {
    field: 'id',
    check: (v) => isSceneId(v.id),
    condition:
      'must be a non-empty lowercase kebab-case string ([a-z0-9] segments separated by single hyphens)',
  },
  { field: 'title', check: (v) => typeof v.title === 'string', condition: 'must be a string' },
  {
    field: 'duration',
    check: (v) => isValidDuration(v.duration),
    condition: 'must be a non-negative integer (ms) or null',
  },
  { field: 'tags', check: (v) => isStringArray(v.tags), condition: 'must be an array of strings' },
  {
    field: 'assets',
    check: (v) => isStringArray(v.assets),
    condition: 'must be an array of strings',
  },
  {
    field: 'captions',
    check: (v) => isCaptionArray(v.captions),
    condition: 'must be an array of {at: number, text: string}',
  },
  {
    field: 'defaultNext',
    check: (v) => isSceneIdOrNull(v.defaultNext),
    condition:
      'must be a kebab-case scene id ([a-z0-9] segments separated by single hyphens) or null',
  },
  {
    field: 'standalone',
    check: (v) => typeof v.standalone === 'boolean',
    condition: 'must be a boolean',
  },
  {
    field: 'trailerSafe',
    check: (v) => typeof v.trailerSafe === 'boolean',
    condition: 'must be a boolean',
  },
  {
    field: 'create',
    check: (v) => typeof v.create === 'function',
    condition: 'must be a function',
  },
  {
    field: 'timeline',
    check: (v) => typeof v.timeline === 'function',
    condition: 'must be a function',
  },
  {
    field: 'cleanup',
    check: (v) => typeof v.cleanup === 'function',
    condition: 'must be a function',
  },
];

/**
 * Validates that `value` satisfies the {@link SceneModule} contract.
 * Throws `Error` with a message identifying the offending field and
 * condition.
 *
 * Per the codex preflight guardrails, this is the single source of
 * truth for scene shape. Downstream consumers (registry, composition
 * resolver, exporter) call this once at the boundary rather than
 * re-validating piecemeal.
 */
export function assertSceneModule(value: unknown): asserts value is SceneModule {
  if (!isPlainObject(value)) {
    throw new Error('scene ? is invalid: value must be a non-null object');
  }

  // Capture id for error messages when present and a string. If id is
  // missing or wrong-typed, the corresponding guard below raises with
  // `?` as the entity label.
  const id = typeof value.id === 'string' ? value.id : undefined;

  for (const field of REQUIRED_FIELDS) {
    if (!Object.hasOwn(value, field)) {
      fail(id, field, 'must be present');
    }
  }

  for (const guard of FIELD_GUARDS) {
    if (!guard.check(value)) {
      fail(id, guard.field, guard.condition);
    }
  }
}

/**
 * Convenience type predicate. Returns `true` if `value` satisfies the
 * scene module contract; `false` otherwise. Use {@link assertSceneModule}
 * when the failure detail matters to the caller.
 */
export function isSceneModule(value: unknown): value is SceneModule {
  try {
    assertSceneModule(value);
    return true;
  } catch {
    return false;
  }
}
