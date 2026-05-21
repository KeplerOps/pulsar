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

import { KEBAB_IDENTIFIER_FORM, isKebabIdentifier } from './identifier';
import { isPlainRecord } from './object';

/**
 * Caption metadata. ADR-002 / ADR-008 / PUL-F027: `{ at, text }` where
 * `at` is EITHER a finite non-negative integer (millisecond offset
 * from scene start) OR a kebab-case beat label sharing the same
 * identifier grammar as scene ids, composition ids, timeline labels,
 * and asset ids (ADR-008 #1 — `isKebabIdentifier`). The prompter, the
 * live runtime, and the export pipeline all consume this same
 * structure (PUL-A009 / PUL-F019).
 *
 * Beat-label `at` values are scene-local — they refer to a label
 * registered on the scene's own timeline (ADR-026 named beats). The
 * scene-schema validator does NOT walk the timeline to verify the
 * label exists; lifecycle side effects do not belong in metadata
 * validation. A future authoring lint MAY cross-check caption beat
 * labels against `MasterTimeline.beats()`.
 */
export interface Caption {
  at: number | string;
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
  /**
   * Static audio-declaration list (PUL-F030 / ADR-029). Names the
   * subset of `assets` that are audio sources. An empty array means
   * "this scene declares no audio" — the loader/workbench unlock
   * gate, the validation pass (PUL-F028), and future authoring lints
   * all consult the same {@link sceneDeclaresAudio} predicate built
   * over this field, so "declares audio" never depends on file
   * extension sniffing, MIME guesses, asset URL substrings, or
   * runtime observation of `ctx.audio.load()`.
   *
   * Every entry MUST be a member of `assets` so the preloader
   * (PUL-F005) warms it. `scene.audio` itself IS the runtime
   * audio-source allowlist for `ctx.audio.load()` — a scene cannot
   * register audio it did not declare here. ADR-008 #5 keeps
   * `scene.assets` as the canonical asset inventory; PUL-F030 /
   * ADR-029 narrows audio to this `scene.audio` subset so the
   * present-mode unlock-gate predicate and the runtime allowlist
   * agree on one source of truth.
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
 * PUL-F027: a caption's `at` field is either a millisecond offset
 * (finite non-negative integer) OR a beat label string sharing the
 * one identifier grammar ADR-008 #1 reserves for scenes, compositions,
 * beats, and assets — `isKebabIdentifier`. Floats, negatives, NaN,
 * ±Infinity, empty strings, and non-kebab labels are rejected at
 * this boundary. A purely-digit label like `"1000"` IS valid (the
 * shared kebab regex accepts it), the same as it is for a timeline
 * label, a URL `beat=` parameter, and a composition `range` endpoint
 * — caption labels do not invent a stricter sub-grammar (codex
 * review, cycle 1).
 *
 * Hoisted to module scope (pure, no closure captures) so the same
 * predicate covers `describeCaptionFault` and any future
 * caption-time classifier the preflight reserves.
 */
const isCaptionAt = (v: unknown): v is number | string => {
  if (typeof v === 'number') {
    return Number.isInteger(v) && Number.isFinite(v) && v >= 0;
  }
  return isKebabIdentifier(v);
};

/**
 * Describe why a caption is malformed, indexed by position so the
 * scene author can find the offending entry directly (codex review,
 * cycle 1 — adjacent composition-manifest validator does the same).
 * Returns the message the scene-schema error envelope will report,
 * or `null` when the caption is well-formed. Caption text is NEVER
 * echoed in the message (preflight: avoid leaking full caption
 * content through diagnostics).
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
  if (!isPlainRecord(value)) {
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

  // Indexed caption validation (codex review, cycle 1): the
  // FIELD_GUARDS pass above only verifies `captions` is an array.
  // Per-element validation runs here so a bad caption in a
  // multi-caption scene surfaces with its index and the failing
  // field, matching the adjacent composition-manifest validator's
  // `composition entry [N] is invalid: ...` envelope. Caption text
  // is never echoed in the message (preflight: avoid leaking full
  // caption content).
  const idLabel = id === undefined ? '?' : `"${id}"`;
  for (let i = 0; i < (value.captions as readonly unknown[]).length; i++) {
    const fault = describeCaptionFault((value.captions as readonly unknown[])[i], i);
    if (fault !== null) {
      throw new Error(`scene ${idLabel} is invalid: ${fault}`);
    }
  }

  // PUL-F030 / ADR-029 cross-field invariant: every `audio` entry must
  // be a member of `assets`. The shape guard above accepts an
  // arbitrary string array; this loop enforces the "audio sources
  // reference scene.assets" rule the preflight names, so the
  // preloader (PUL-F005) warms every declared audio URL and the audio
  // service's allowlist accepts it (ADR-008 #5). Reported by index so
  // a multi-entry scene's bad declaration is locatable, mirroring the
  // caption validator's `captions[N]` envelope.
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
 * PUL-F030 / ADR-029: predicate the loader/workbench unlock gate, the
 * validation pass, and future authoring lints all consult so "this
 * scene declares audio" has one source of truth. True when the
 * scene's static {@link SceneModule.audio} list has at least one
 * entry. The shape and membership invariants of `audio` are
 * established by {@link assertSceneModule} — this predicate only
 * reads the field length, so it is safe to call on any
 * already-validated scene module.
 */
export function sceneDeclaresAudio(scene: SceneModule): boolean {
  return scene.audio.length > 0;
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
