// Scene module contract — PUL-F001.
//
// Single source of truth for the shape every scene module exports.
// Per ADR-002 the scene/composition model treats this object as the
// scene's canonical metadata; per ADR-008 the runtime validates the
// shape before mounting so cleanup leaks, dangling assets, and id
// collisions surface loudly.
//
// Downstream consumers (registry, composition resolver, exporter)
// must call assertSceneModule rather than re-implementing checks.

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
 * Scene context passed to the lifecycle functions. Refined by PUL-F002
 * (registry lifecycle) and ADR-003 / ADR-004 (timeline + audio surface
 * via `ctx.gsap`, `ctx.audio`). Until then, lifecycle implementations
 * should treat the value as opaque.
 */
export type SceneContext = unknown;

export type SceneLifecycleFn = (ctx: SceneContext) => unknown;

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

const fail = (id: string | undefined, field: string, condition: string): never => {
  const idLabel = id === undefined ? '?' : `"${id}"`;
  throw new Error(`scene ${idLabel} is invalid: ${field} ${condition}`);
};

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

  // Capture id for error messages when it is present and a string.
  // If id is missing or wrong-typed, the relevant check below raises
  // with `?` as the entity label.
  const id = typeof value.id === 'string' ? value.id : undefined;

  for (const field of REQUIRED_FIELDS) {
    if (!Object.hasOwn(value, field)) {
      fail(id, field, 'must be present');
    }
  }

  if (typeof value.id !== 'string') fail(id, 'id', 'must be a string');
  if (typeof value.title !== 'string') fail(id, 'title', 'must be a string');

  if (!isValidDuration(value.duration)) {
    fail(id, 'duration', 'must be a non-negative integer (ms) or null');
  }

  if (!isStringArray(value.tags)) fail(id, 'tags', 'must be an array of strings');
  if (!isStringArray(value.assets)) fail(id, 'assets', 'must be an array of strings');
  if (!isCaptionArray(value.captions)) {
    fail(id, 'captions', 'must be an array of {at: number, text: string}');
  }

  if (value.defaultNext !== null && typeof value.defaultNext !== 'string') {
    fail(id, 'defaultNext', 'must be a string or null');
  }

  if (typeof value.standalone !== 'boolean') fail(id, 'standalone', 'must be a boolean');
  if (typeof value.trailerSafe !== 'boolean') fail(id, 'trailerSafe', 'must be a boolean');

  if (typeof value.create !== 'function') fail(id, 'create', 'must be a function');
  if (typeof value.timeline !== 'function') fail(id, 'timeline', 'must be a function');
  if (typeof value.cleanup !== 'function') fail(id, 'cleanup', 'must be a function');
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
