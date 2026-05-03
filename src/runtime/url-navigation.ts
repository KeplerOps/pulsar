// URL navigation — PUL-F008.
//
// Owns the `scene` URL parameter contract:
//
//  1. Parse `scene` once from `URLSearchParams` at the runtime boundary.
//  2. Validate the identifier shape via the shared `isKebabIdentifier`
//     rule from `./identifier.ts` (ADR-013 forbids a URL-only regex).
//  3. Resolve existence through {@link SceneRegistry.has} / `.get`
//     (ADR-002 §Navigation: the registry is the only addressability
//     mechanism; ADR-013 forbids array scans, dynamic imports, or
//     conditional dispatch).
//  4. Treat malformed or unknown scene ids as navigation errors before
//     any scene lifecycle hook runs.
//  5. Preserve the existing lifecycle contract — the optional
//     {@link loadSceneNavigationTarget} convenience routes the resolved
//     target through {@link resolveComposition} so the URL path inherits
//     PUL-F004's preload → create → timeline → cleanup ordering and
//     PUL-F006's mandatory-cleanup invariant rather than reinventing
//     them.
//  6. URL state is authoritative — this module never reads from
//     localStorage, cookies, or any cached state.
//  7. `scene` is orthogonal to `mode`; this module does not interpret
//     `mode`, `composition`, `index`, or `beat` (those parameters are
//     owned by future requirements). Callers that hand a multi-parameter
//     URL receive a target derived solely from the `scene` value.
//  8. Repeated/conflicting `scene` parameters fail loudly because
//     `URLSearchParams.get()` silently picks one value.
//
// References:
//  - PUL-F008 — when `scene` is present, load the addressed scene as
//    the navigation target.
//  - ADR-013 — `scene` URL parameter is a navigation target selector.
//  - ADR-002 §Navigation — URL grammar.
//  - ADR-007 — workbench URL parameters and modes.
//  - ADR-008 #1 — kebab-case identity rule shared with scenes,
//    compositions, beats, and assets.
//  - ADR-011 — composition resolver as a pure orchestrator with
//    injected adapters; reused by {@link loadSceneNavigationTarget}.

import {
  type AssetPreloader,
  type SceneTimelineRunner,
  resolveComposition,
} from './composition-resolver';
import { KEBAB_IDENTIFIER_FORM, isKebabIdentifier } from './identifier';
import type { SceneRegistry } from './registry';
import type { SceneModule } from './scene';

/**
 * The runtime's resolved view of "which scene the URL addresses".
 *
 * For PUL-F008 the only field is `scene`. Future URL parameters
 * (`composition`, `beat`, `mode`) extend the navigation target shape;
 * the scene resolver owns the `scene` field exclusively.
 */
export interface SceneNavigationTarget {
  /** The registered scene module the URL addresses. */
  readonly scene: SceneModule;
}

/**
 * Inputs the {@link loadSceneNavigationTarget} bridge needs to drive
 * the existing composition resolver lifecycle for one scene. Mirrors
 * the lifecycle-relevant fields of
 * `ResolveCompositionOptions`; the `manifest` field is intentionally
 * absent because the bridge synthesizes a single-entry manifest from
 * the navigation target.
 */
export interface LoadSceneNavigationTargetOptions {
  /** Registry the resolver consults — must contain `target.scene`. */
  readonly registry: SceneRegistry;
  /** Opaque scene context forwarded to every lifecycle hook. */
  readonly ctx: unknown;
  /** Preload adapter — see {@link AssetPreloader}. */
  readonly preloadAssets: AssetPreloader;
  /** Timeline-execution adapter — see {@link SceneTimelineRunner}. */
  readonly runTimeline: SceneTimelineRunner;
  /**
   * Optional cancellation signal forwarded through to
   * {@link resolveComposition}. Honors the same semantics PUL-F006
   * defined for composition-level abort.
   */
  readonly signal?: AbortSignal;
}

/**
 * Inputs accepted by {@link resolveSceneNavigationTarget}. Anything
 * `URLSearchParams` can read is supported so callers can pass a
 * `Location`, a `URL`, a parsed `URLSearchParams`, or a raw search
 * string — the runtime boundary normalizes once and never re-parses.
 *
 * `Location`-like values are typed as `{ search: string }` so the
 * function works in browser bootstrap (`window.location`) and in
 * Node-side tooling without dragging a DOM lib dependency through
 * the type signature.
 */
export type SceneUrlInput = URL | URLSearchParams | string | { readonly search: string };

const NAV_FAIL_PREFIX = 'scene navigation failed:';

const fail = (detail: string): never => {
  throw new Error(`${NAV_FAIL_PREFIX} ${detail}`);
};

/**
 * Normalize the parser input to a {@link URLSearchParams}. The
 * runtime parses URL state exactly once at this boundary so downstream
 * code (lifecycle, future composition/mode/beat resolvers) operates on
 * a structured surface rather than re-parsing strings.
 */
function toSearchParams(input: SceneUrlInput): URLSearchParams {
  if (input instanceof URLSearchParams) return input;
  if (input instanceof URL) return input.searchParams;
  if (typeof input === 'string') {
    // A bare `?` or empty string both yield an empty search.
    if (input === '' || input === '?') return new URLSearchParams();
    // Detect a fully-qualified URL string vs. a bare query string.
    // `URL` accepts both `https://...` and `protocol:...` shapes; the
    // cheaper guard is "starts with `?`" or "has no `:` before `?`".
    if (input.startsWith('?')) return new URLSearchParams(input);
    // A full URL parses; otherwise treat as a bare search string.
    try {
      return new URL(input).searchParams;
    } catch {
      return new URLSearchParams(input);
    }
  }
  return new URLSearchParams(input.search);
}

/**
 * Resolves the `scene` URL parameter against the registry and returns a
 * {@link SceneNavigationTarget}. Returns `null` when the parameter is
 * absent — the caller decides whether to fall through to other URL
 * routing logic (composition, default home, etc.).
 *
 * Throws an `Error` whose message starts with `scene navigation failed:`
 * when the parameter is repeated, malformed, or names a scene that is
 * not in the registry. No lifecycle hook is invoked on any error path.
 */
export function resolveSceneNavigationTarget(
  input: SceneUrlInput,
  registry: SceneRegistry,
): SceneNavigationTarget | null {
  const params = toSearchParams(input);
  const values = params.getAll('scene');

  if (values.length === 0) return null;

  if (values.length > 1) {
    // Render every observed value verbatim so the error names the
    // exact strings the caller submitted (helps diagnose proxies that
    // append duplicates and tooling that produces multi-valued URLs).
    const rendered = values.map((v) => `"${v}"`).join(', ');
    fail(
      `\`scene\` URL parameter appears ${values.length} times (${rendered}); expected exactly one`,
    );
  }

  const id = values[0] as string;

  if (!isKebabIdentifier(id)) {
    fail(`scene id "${id}" is not a valid kebab-case identifier (${KEBAB_IDENTIFIER_FORM})`);
  }

  if (!registry.has(id)) {
    fail(`scene "${id}" is not registered`);
  }

  return { scene: registry.get(id) };
}

/**
 * Drives the addressed scene through the existing composition resolver
 * lifecycle so the URL navigation path inherits PUL-F004's preload →
 * create → timeline → cleanup ordering and PUL-F006's mandatory-cleanup
 * invariant.
 *
 * Constructs a single-entry composition manifest from
 * `target.scene.id` and delegates to {@link resolveComposition}. ADR-013
 * mandates that a scene URL not bypass the resolver lifecycle; the
 * synthesized manifest is the smallest path that satisfies that
 * invariant without inventing a parallel single-scene runner.
 *
 * Resolves when the lifecycle has run end-to-end; rejects with the
 * resolver's own wrapping error (`composition resolution failed: ...`)
 * when any phase throws. Cleanup runs whenever the scene was touched,
 * matching the resolver's own invariants.
 */
export async function loadSceneNavigationTarget(
  target: SceneNavigationTarget,
  options: LoadSceneNavigationTargetOptions,
): Promise<void> {
  const manifest = [target.scene.id] as const;
  await resolveComposition({
    registry: options.registry,
    manifest,
    ctx: options.ctx,
    preloadAssets: options.preloadAssets,
    runTimeline: options.runTimeline,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}
