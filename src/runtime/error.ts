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
 *
 * `describeError` is the **internal wrap** renderer: every resolver /
 * preloader / audio wrapping `Error` uses this to keep the wrapping
 * message terse and stable (so the existing structural tests that
 * pattern-match the wrapping wording keep working). Browser-visible
 * surfaces — `data-pulsar-navigation-error`, the `Error` passed to a
 * workbench `onError` sink — call {@link describeErrorDetailed}
 * instead, which walks `Error.cause` and `AggregateError.errors[]` so
 * the per-asset failure messages buried inside a preload throw
 * (PUL-Q009) reach the operator.
 */
export const describeError = (value: unknown): string =>
  value instanceof Error ? value.message : String(value);

/**
 * Options for {@link describeErrorDetailed}. Both knobs default to
 * values that surface every per-asset failure of a typical scene
 * (multiple-asset compositions) while keeping the rendered string
 * bounded enough for a DOM attribute.
 */
export interface DescribeErrorDetailedOptions {
  /**
   * Maximum walk depth into `Error.cause` and `AggregateError.errors`.
   * `0` collapses to {@link describeError} (no cause, no children).
   * Each cause hop AND each aggregate child consumes one unit of
   * depth. Default `4` covers `loader → resolver → preloader →
   * per-asset` chains without unbounded recursion.
   */
  readonly maxDepth?: number;
  /**
   * Maximum aggregate children rendered before a `…+N more` suffix
   * truncates the rest. Default is unbounded so PUL-Q009 surfaces
   * EVERY failing declared asset path on the public diagnostic
   * surface — a static `scene.assets` list is bounded by the scene
   * schema, so the realistic per-aggregate width is small (a few
   * dozen at most) and truncating by default would silently drop
   * paths beyond the cap. Pass an explicit positive integer when a
   * caller has a separate bound (e.g. a UI that wants a one-line
   * preview); pass `Number.POSITIVE_INFINITY` to be explicit about
   * "render every child."
   */
  readonly maxBranches?: number;
}

const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_BRANCHES = Number.POSITIVE_INFINITY;

/**
 * Public-surface renderer for an unknown error-ish value.
 *
 * Walks `Error.cause` and `AggregateError.errors[]` to a bounded depth
 * and width, producing a single-line summary suitable for a stage
 * attribute or an `onError(err)` handler. Composes existing
 * `.message` strings only — never inspects `stack`, headers, cookies,
 * request init, scene objects, DOM, or response bodies — so the
 * bounded payload is whatever upstream messages chose to surface.
 *
 * Output shape:
 *  - plain `Error` / non-Error value → same as {@link describeError}.
 *  - `Error` with a `cause` → `<message> — cause: <cause-rendered>`.
 *  - `AggregateError` → `<message> [<child1>; <child2>; …]`.
 *  - aggregate with > `maxBranches` children → `…+N more` suffix.
 *  - cyclic cause chains terminate via a per-walk visited set.
 *
 * The renderer is PUL-Q009's diagnostic seam: it surfaces the failing
 * scene id (already in the resolver's wrapping message) AND the
 * per-asset paths (in `cause.errors[].message` from
 * `createAssetPreloader`) at the existing
 * `data-pulsar-navigation-error` / `onError` boundary, without
 * touching the lifecycle ordering invariants in
 * `composition-resolver.ts` or the AggregateError shape in
 * `asset-preloader.ts`.
 */
export function describeErrorDetailed(
  value: unknown,
  options: DescribeErrorDetailedOptions = {},
): string {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxBranches = options.maxBranches ?? DEFAULT_MAX_BRANCHES;
  const visited = new WeakSet<object>();
  return render(value, maxDepth, maxBranches, visited);
}

function render(
  value: unknown,
  depth: number,
  maxBranches: number,
  visited: WeakSet<object>,
): string {
  if (!(value instanceof Error)) return String(value);
  if (visited.has(value)) return value.message;
  visited.add(value);
  let out = value.message;
  if (depth <= 0) return out;
  if (value instanceof AggregateError && value.errors.length > 0) {
    out += ` ${renderBranches(value.errors, depth - 1, maxBranches, visited)}`;
  }
  const cause = (value as Error & { cause?: unknown }).cause;
  if (cause !== undefined && cause !== null) {
    out += ` — cause: ${render(cause, depth - 1, maxBranches, visited)}`;
  }
  return out;
}

function renderBranches(
  errors: readonly unknown[],
  depth: number,
  maxBranches: number,
  visited: WeakSet<object>,
): string {
  const shown = errors
    .slice(0, maxBranches)
    .map((child) => render(child, depth, maxBranches, visited));
  const remaining = errors.length - shown.length;
  if (remaining > 0) shown.push(`…+${remaining} more`);
  return `[${shown.join('; ')}]`;
}

/**
 * Lifecycle phase keywords PUL-Q006 names in its statement: the three
 * `create` / `timeline` / `cleanup` hooks the scene contract owns
 * (`SceneFailurePhase` in `composition-resolver.ts` is the structured
 * source). Re-declared as a string-literal union here so this module
 * stays free of a `composition-resolver` import — `error.ts` is
 * upstream of the resolver in the dependency graph, and a runtime
 * `Error` formatter has no business depending on lifecycle plumbing.
 */
export type ScenePhase = 'create' | 'timeline' | 'cleanup';

/**
 * Structured context for {@link formatSceneContext} — the PUL-Q006
 * "scene id and (where applicable) the beat label or the timeline
 * phase" surface contract, lifted out of bespoke message templates so
 * future fields (composition entry, occurrence index, mode) get added
 * here once instead of grepped back out of `Error.message`.
 */
export interface SceneErrorContext {
  /** The scene id the diagnostic belongs to (PUL-Q006 mandatory clause). */
  readonly sceneId: string;
  /**
   * The lifecycle phase whose throw produced the diagnostic, when one
   * applies. Preload / abort / manifest / registry errors have no
   * phase; lifecycle failures (`create` / `timeline` / `cleanup`) do.
   */
  readonly phase?: ScenePhase;
  /**
   * The beat label the diagnostic concerns, when one applies. The URL
   * `beat=` value for a missing-label diagnostic, or the offending
   * authored label for a {@link import('./timeline').SceneTimelineLabelError}.
   */
  readonly beat?: string;
  /**
   * The 0-based per-scene-id occurrence ordinal, when the diagnostic
   * concerns one occurrence of a composition that repeats a scene id
   * (issue #99 — see `SceneActivation` in `composition-resolver.ts`).
   * Occurrence `0` (the first / only use) renders bare, so a
   * single-occurrence diagnostic is byte-identical to one with no
   * `occurrence` supplied; only a later occurrence shows the ordinal.
   */
  readonly occurrence?: number;
}

/**
 * Render the canonical PUL-Q006 scene-error context prefix.
 *
 * Used by every public-surface error template that scopes to a scene,
 * so a future regression that drops the scene id, phase, or beat at
 * any one seam shows up as a behavioral diff at this single helper
 * rather than as one bespoke message-template per surface. Existing
 * resolver / timeline wording (e.g. `composition resolution failed:
 * scene "X" create threw: ...`) keeps its prose and continues to
 * satisfy the requirement on its own; this helper is the seam for
 * surfaces that compose the prefix programmatically (the loader's
 * `buildOnSceneFailed`) and for future fields per the PUL-Q006
 * preflight.
 *
 * Output shapes:
 *  - `{ sceneId: 'X' }`                                       → `scene "X"`
 *  - `{ sceneId: 'X', phase: 'create' }`                      → `scene "X" failed during create`
 *  - `{ sceneId: 'X', beat: 'b' }`                            → `scene "X" at beat "b"`
 *  - `{ sceneId: 'X', phase: 'timeline', beat: 'b' }`         → `scene "X" failed during timeline at beat "b"`
 *  - `{ sceneId: 'X', occurrence: 0 }`                        → `scene "X"`
 *  - `{ sceneId: 'X', phase: 'create', occurrence: 2 }`       → `scene "X" (occurrence 2) failed during create`
 */
export function formatSceneContext(context: SceneErrorContext): string {
  let out = `scene "${context.sceneId}"`;
  // Occurrence 0 (first / only use) renders bare so a single-occurrence
  // diagnostic is unchanged; a later occurrence of a repeated scene id
  // carries the ordinal (issue #99).
  if (context.occurrence !== undefined && context.occurrence > 0) {
    out += ` (occurrence ${context.occurrence})`;
  }
  if (context.phase !== undefined) out += ` failed during ${context.phase}`;
  if (context.beat !== undefined) out += ` at beat "${context.beat}"`;
  return out;
}
