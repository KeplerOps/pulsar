// Scene module contract — PUL-F001 + PUL-A007 (ADR-002 / ADR-008).
//
// Single source of truth for the shape every scene module exports;
// validated before mount so leaks, dangling assets, and id collisions
// surface loudly. Scene id format (PUL-A007 clause C1) is the shared
// kebab-case rule in ./identifier.ts (ADR-008 #1); id uniqueness is the
// registry's (PUL-F002). Downstream consumers call assertSceneModule.

import { KEBAB_IDENTIFIER_FORM, isKebabIdentifier } from './identifier';
import { isPlainRecord } from './object';

/**
 * Caption metadata (PUL-F027 / PUL-A009): `{ at, text }` where `at` is a
 * finite non-negative integer ms offset OR a scene-local kebab-case beat
 * label (ADR-008 #1, ADR-026 named beats). The validator does not walk the
 * timeline to verify the label exists. Shared by prompter, runtime, export.
 */
export interface Caption {
  at: number | string;
  text: string;
}

/** Lifecycle function signature; `ctx` is opaque here, refined by the loader. */
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
  /**
   * Static audio-declaration list (PUL-F030 / ADR-029): the subset of
   * `assets` that are audio sources. IS the runtime audio-source allowlist
   * for `ctx.audio.load()` and drives the {@link sceneDeclaresAudio}
   * unlock-gate predicate — every entry MUST be a member of `assets`.
   */
  audio: readonly string[];
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
  'audio',
  'defaultNext',
  'standalone',
  'trailerSafe',
  'create',
  'timeline',
  'cleanup',
] as const satisfies readonly (keyof SceneModule)[];

const isStringArray = (v: unknown): v is readonly string[] =>
  Array.isArray(v) && v.every((e) => typeof e === 'string');

const isValidDuration = (v: unknown): v is number | null =>
  v === null || (typeof v === 'number' && Number.isInteger(v) && Number.isFinite(v) && v >= 0);

/**
 * PUL-F027: a caption `at` is a finite non-negative integer ms offset OR a
 * kebab-case beat label (ADR-008 #1). A purely-digit label like `"1000"`
 * is valid; caption labels do not invent a stricter sub-grammar.
 */
const isCaptionAt = (v: unknown): v is number | string => {
  if (typeof v === 'number') {
    return Number.isInteger(v) && Number.isFinite(v) && v >= 0;
  }
  return isKebabIdentifier(v);
};

/**
 * Describe why a caption is malformed, indexed by position; `null` when
 * well-formed. Caption text is NEVER echoed (avoid leaking content).
 */
const describeCaptionFault = (cap: unknown, index: number): string | null => {
  if (!isPlainRecord(cap)) {
    return `captions[${index}] must be a {at, text} object`;
  }
  if (!isCaptionAt(cap.at)) {
    return `captions[${index}].at must be a non-negative integer (ms) or a kebab-case beat label (${KEBAB_IDENTIFIER_FORM})`;
  }
  if (typeof cap.text !== 'string') {
    return `captions[${index}].text must be a string`;
  }
  return null;
};

// Scene ids share the kebab-case rule (ADR-008 #1; PUL-A007 clause C1).
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
    condition: `must be a non-empty lowercase kebab-case string (${KEBAB_IDENTIFIER_FORM})`,
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
    check: (v) => Array.isArray(v.captions),
    condition: 'must be an array',
  },
  {
    field: 'audio',
    check: (v) => isStringArray(v.audio),
    condition: 'must be an array of strings',
  },
  {
    field: 'defaultNext',
    check: (v) => isSceneIdOrNull(v.defaultNext),
    condition: `must be a kebab-case scene id (${KEBAB_IDENTIFIER_FORM}) or null`,
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
 * Validate that `value` satisfies the {@link SceneModule} contract,
 * throwing with the offending field + condition. Single source of truth
 * for scene shape — downstream consumers call this at the boundary.
 */
export function assertSceneModule(value: unknown): asserts value is SceneModule {
  if (!isPlainRecord(value)) {
    throw new Error('scene ? is invalid: value must be a non-null object');
  }

  // Id for error messages; the id guard below raises with `?` if absent.
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

  // Per-element caption validation (FIELD_GUARDS only checks array-ness),
  // surfacing the index + failing field; caption text is never echoed.
  const idLabel = id === undefined ? '?' : `"${id}"`;
  for (let i = 0; i < (value.captions as readonly unknown[]).length; i++) {
    const fault = describeCaptionFault((value.captions as readonly unknown[])[i], i);
    if (fault !== null) {
      throw new Error(`scene ${idLabel} is invalid: ${fault}`);
    }
  }

  // PUL-F030 / ADR-029 cross-field invariant: every `audio` entry must be
  // a member of `assets` so the preloader warms it (ADR-008 #5).
  const assetsSet = new Set(value.assets as readonly string[]);
  const audioList = value.audio as readonly string[];
  for (let i = 0; i < audioList.length; i++) {
    const entry = audioList[i] as string;
    if (!assetsSet.has(entry)) {
      throw new Error(
        `scene ${idLabel} is invalid: audio[${i}] "${entry}" must be a member of scene.assets (PUL-F030 / ADR-029)`,
      );
    }
  }
}

/**
 * Author-facing scene input: only `id`, `title`, `create`, `timeline`
 * are required; every other field defaults via {@link defineScene}.
 */
export interface SceneInput {
  id: string;
  title: string;
  duration?: number | null | undefined;
  tags?: readonly string[] | undefined;
  assets?: readonly string[] | undefined;
  captions?: readonly Caption[] | undefined;
  audio?: readonly string[] | undefined;
  defaultNext?: string | null | undefined;
  standalone?: boolean | undefined;
  trailerSafe?: boolean | undefined;
  create: SceneLifecycleFn;
  timeline: SceneLifecycleFn;
  /** Defaults to a no-op. Mandatory cleanup (PUL-P001) is satisfied trivially when a scene mounts nothing of its own. */
  cleanup?: SceneLifecycleFn | undefined;
}

const NOOP_CLEANUP: SceneLifecycleFn = () => {};

/**
 * Single source of scene defaulting: fill optional fields, then assert
 * the {@link SceneModule} contract so malformed input fails at authoring.
 */
export function defineScene(input: SceneInput): SceneModule {
  const scene: SceneModule = {
    id: input.id,
    title: input.title,
    duration: input.duration ?? null,
    tags: input.tags ?? [],
    assets: input.assets ?? [],
    captions: input.captions ?? [],
    audio: input.audio ?? [],
    defaultNext: input.defaultNext ?? null,
    standalone: input.standalone ?? false,
    trailerSafe: input.trailerSafe ?? false,
    create: input.create,
    timeline: input.timeline,
    cleanup: input.cleanup ?? NOOP_CLEANUP,
  };
  assertSceneModule(scene);
  return scene;
}

/**
 * PUL-F030 / ADR-029: single source of truth for "this scene declares
 * audio" — true when the static {@link SceneModule.audio} list is non-empty.
 */
export function sceneDeclaresAudio(scene: SceneModule): boolean {
  return scene.audio.length > 0;
}

/**
 * Type predicate for the scene module contract; use {@link assertSceneModule}
 * when the failure detail matters.
 */
export function isSceneModule(value: unknown): value is SceneModule {
  try {
    assertSceneModule(value);
    return true;
  } catch {
    return false;
  }
}
