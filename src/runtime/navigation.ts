// URL navigation grammar — PUL-F007.
//
// Boundary adapter from `URLSearchParams` to a plain navigation
// target. Per ADR-013 the parser does NOT resolve scenes, inspect
// composition manifests, run timelines, load assets, or mutate
// browser history — those concerns live in the runtime orchestration
// layer this module hands off to.
//
// The parser accepts only the five grammar keys named by PUL-F007
// (`scene`, `composition`, `index`, `beat`, `mode`). Repeated grammar
// keys are invalid because `URLSearchParams.get()` would otherwise
// make ambiguous input look deterministic. Unknown query keys are
// ignored.
//
// Identifier validation reuses the shared kebab-case predicate in
// `./identifier.ts` per ADR-013 / ADR-008 #1: there is one identifier
// rule for scenes, compositions, beats, and assets.
//
// Mode is validated against the ADR-007 workbench mode set, exported
// here as the frozen tuple {@link NAVIGATION_MODES}.
//
// Index is base-10, zero-based, non-negative, and a JS safe integer
// (`Number.isSafeInteger`). It is composition-scoped — `index`
// without `composition` is invalid; `scene` + `index` is invalid.
//
// Combination shapes (per ADR-013) — exactly five accepted:
//
//   1. no explicit target              + optional mode
//   2. scene                           + optional beat + optional mode
//   3. composition                     + optional mode
//   4. composition + scene             + optional beat + optional mode
//   5. composition + index             + optional beat + optional mode
//
// {@link subscribeNavigation} wires startup parsing + `popstate`
// through the same parser path so error semantics match. Per ADR-013,
// the URL search string is the source of truth on `popstate` —
// `history.state`, localStorage, cookies, and cached runtime state
// must not redefine the target.

import { KEBAB_IDENTIFIER_FORM, isKebabIdentifier } from './identifier';

/**
 * Workbench mode set per ADR-007. The seven modes are the only values
 * accepted for `mode=` URL parameters. Frozen so consumers cannot
 * mutate the public allowlist in place.
 */
export const NAVIGATION_MODES = Object.freeze([
  'present',
  'standalone',
  'loop',
  'paused',
  'scrub',
  'screenshot',
  'prompter',
] as const);

/**
 * One of the seven {@link NAVIGATION_MODES} values.
 */
export type NavigationMode = (typeof NAVIGATION_MODES)[number];

/**
 * The locator portion of a {@link NavigationTarget}. Discriminated by
 * `kind` so callers pattern-match against ADR-013's five accepted
 * target shapes without re-deriving them from optional fields:
 *
 *  - `none`              — no explicit target; bootstrap chooses default.
 *  - `scene`             — single scene by id.
 *  - `composition`       — composition by id, no in-composition jump.
 *  - `composition-scene` — composition + scene id (id-based locator).
 *  - `composition-index` — composition + zero-based index (positional).
 *
 * `composition-scene` and `composition-index` are both id-based at the
 * grammar layer. The composition resolution layer is responsible for
 * existence and uniqueness checks per ADR-013.
 */
export type NavigationLocator =
  | { readonly kind: 'none' }
  | { readonly kind: 'scene'; readonly scene: string }
  | { readonly kind: 'composition'; readonly composition: string }
  | { readonly kind: 'composition-scene'; readonly composition: string; readonly scene: string }
  | {
      readonly kind: 'composition-index';
      readonly composition: string;
      readonly index: number;
    };

/**
 * The result of {@link parseNavigationSearch}. The locator captures
 * the addressed scene/composition/index target (or `none`); `beat` and
 * `mode` are absent when the URL did not specify them. The bootstrap
 * layer is responsible for substituting any defaults (e.g. mapping
 * `mode === undefined` to `'present'`).
 */
export interface NavigationTarget {
  readonly locator: NavigationLocator;
  readonly beat?: string;
  readonly mode?: NavigationMode;
}

const GRAMMAR_KEYS = ['scene', 'composition', 'index', 'beat', 'mode'] as const;

const KEBAB_CONDITION = `must be a non-empty lowercase kebab-case string (${KEBAB_IDENTIFIER_FORM})`;

const INDEX_PATTERN = /^(?:0|[1-9]\d*)$/;

/**
 * The thrown-error grammar matches `assertSceneModule` /
 * `assertCompositionManifest`: a stable `"<noun> is invalid: ..."`
 * prefix so callers can pattern-match on origin without parsing
 * field-specific detail.
 */
function fail(condition: string): never {
  throw new Error(`navigation grammar is invalid: ${condition}`);
}

function toSearchParams(input: URLSearchParams | string): URLSearchParams {
  if (input instanceof URLSearchParams) return input;
  // `new URLSearchParams('?foo=bar')` and `new URLSearchParams('foo=bar')`
  // both yield the same map; the spec strips a leading `?` only when
  // the input is parsed via `new URL(...)`. Strip explicitly so callers
  // can pass `location.search` verbatim.
  return new URLSearchParams(input.startsWith('?') ? input.slice(1) : input);
}

function rejectRepeats(params: URLSearchParams): void {
  for (const key of GRAMMAR_KEYS) {
    if (params.getAll(key).length > 1) {
      fail(`repeated query parameter "${key}"`);
    }
  }
}

function validateKebab(field: string, value: string): void {
  if (!isKebabIdentifier(value)) {
    fail(`"${field}" ${KEBAB_CONDITION}`);
  }
}

function parseIndex(raw: string): number {
  if (!INDEX_PATTERN.test(raw)) {
    fail('"index" must be a base-10 non-negative integer (e.g. 0, 1, 12)');
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('"index" must be a non-negative safe integer');
  }
  return value;
}

function parseMode(raw: string): NavigationMode {
  // The membership check is correct as written; the type assertion
  // documents that callers receive a typed mode, not a bare string.
  if ((NAVIGATION_MODES as readonly string[]).includes(raw)) {
    return raw as NavigationMode;
  }
  fail(`"mode" unknown mode "${raw}" — allowed: ${NAVIGATION_MODES.join(', ')}`);
}

function buildLocator(
  scene: string | undefined,
  composition: string | undefined,
  index: number | undefined,
): NavigationLocator {
  if (index !== undefined) {
    // Order matters: "scene + index" is the more semantically
    // informative violation, so it wins over the "index requires
    // composition" message when both are technically true (e.g.
    // `?scene=x&index=0`).
    if (scene !== undefined) {
      fail('"scene" and "index" cannot be used together — use one locator');
    }
    if (composition === undefined) {
      fail('"index" requires "composition"');
    }
    return Object.freeze({ kind: 'composition-index', composition, index });
  }
  if (composition !== undefined && scene !== undefined) {
    return Object.freeze({ kind: 'composition-scene', composition, scene });
  }
  if (composition !== undefined) {
    return Object.freeze({ kind: 'composition', composition });
  }
  if (scene !== undefined) {
    return Object.freeze({ kind: 'scene', scene });
  }
  return Object.freeze({ kind: 'none' });
}

function ensureBeatHasSceneLikeTarget(beat: string | undefined, locator: NavigationLocator): void {
  if (beat === undefined) return;
  if (
    locator.kind === 'scene' ||
    locator.kind === 'composition-scene' ||
    locator.kind === 'composition-index'
  ) {
    return;
  }
  fail(
    '"beat" requires a scene-like target ("scene", "composition" + "scene", or "composition" + "index")',
  );
}

/**
 * Parse a URL search string (or `URLSearchParams` instance) into a
 * {@link NavigationTarget} per PUL-F007 / ADR-013.
 *
 * Accepts:
 *  - the empty string and `'?'` (no explicit target).
 *  - either `'?key=value'` or `'key=value'` form.
 *  - a `URLSearchParams` instance (passed through unchanged).
 *
 * Throws an `Error` with the prefix `"navigation grammar is invalid: "`
 * on:
 *  - any repeated grammar key (`scene`, `composition`, `index`, `beat`,
 *    `mode`).
 *  - a malformed identifier (non-kebab-case `scene` / `composition` /
 *    `beat`).
 *  - a malformed `index` (not base-10, leading zero, negative,
 *    decimal, exponent, hex, etc.).
 *  - an unknown `mode`.
 *  - any of the four invalid combination shapes ADR-013 names.
 *
 * Unknown query keys are ignored — the parser is a grammar boundary,
 * not a filter.
 */
export function parseNavigationSearch(input: URLSearchParams | string): NavigationTarget {
  const params = toSearchParams(input);
  rejectRepeats(params);

  const sceneRaw = params.get('scene');
  const compositionRaw = params.get('composition');
  const indexRaw = params.get('index');
  const beatRaw = params.get('beat');
  const modeRaw = params.get('mode');

  if (sceneRaw !== null) validateKebab('scene', sceneRaw);
  if (compositionRaw !== null) validateKebab('composition', compositionRaw);
  if (beatRaw !== null) validateKebab('beat', beatRaw);
  const index = indexRaw === null ? undefined : parseIndex(indexRaw);
  const mode = modeRaw === null ? undefined : parseMode(modeRaw);

  const locator = buildLocator(sceneRaw ?? undefined, compositionRaw ?? undefined, index);
  const beat = beatRaw ?? undefined;
  ensureBeatHasSceneLikeTarget(beat, locator);

  const target: { -readonly [K in keyof NavigationTarget]: NavigationTarget[K] } = { locator };
  if (beat !== undefined) target.beat = beat;
  if (mode !== undefined) target.mode = mode;
  return Object.freeze(target);
}

/**
 * Minimal `Window`-like surface required by {@link subscribeNavigation}.
 * Defined as a narrow shape — rather than `Pick<Window, ...>` — so the
 * tests can inject a fake without standing up jsdom or pulling in DOM
 * lib types just for `popstate` wiring.
 *
 * The listener is typed as `(evt: Event) => void` so the actual browser
 * `window` is structurally assignable to this interface — DOM
 * `addEventListener` requires the listener to handle an `Event` arg.
 * The internal handler ignores the arg.
 */
export interface NavigationWindowLike {
  readonly addEventListener: (event: 'popstate', listener: (evt: Event) => void) => void;
  readonly removeEventListener: (event: 'popstate', listener: (evt: Event) => void) => void;
  readonly location: { readonly search: string };
}

/**
 * Inputs for {@link subscribeNavigation}. Both callbacks are required:
 * exactly one fires per parse — `onNavigate` on success, `onError` on
 * grammar failure. The subscriber never throws out to the caller.
 */
export interface NavigationSubscriptionOptions {
  readonly window: NavigationWindowLike;
  readonly onNavigate: (target: NavigationTarget) => void;
  readonly onError: (error: Error) => void;
}

/**
 * Subscribe to URL navigation events.
 *
 * Wires the boundary parser to the two parsing triggers PUL-F007
 * names: `at startup` (one synchronous parse before this function
 * returns) and `on popstate` (one parse per `popstate` event,
 * reading the current `location.search` each time). Both go through
 * {@link parseNavigationSearch} so error semantics are identical.
 *
 * Returns a disposer that removes the `popstate` listener. The
 * disposer is idempotent at the wiring level — calling it more than
 * once is a no-op the underlying `removeEventListener` already
 * handles.
 */
export function subscribeNavigation(options: NavigationSubscriptionOptions): () => void {
  const { window: win, onNavigate, onError } = options;

  const handle = (_evt?: Event): void => {
    let target: NavigationTarget;
    try {
      target = parseNavigationSearch(win.location.search);
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    onNavigate(target);
  };

  win.addEventListener('popstate', handle);
  const dispose = (): void => {
    win.removeEventListener('popstate', handle);
  };
  // If `onNavigate` / `onError` itself throws during the startup parse,
  // remove the popstate listener before the exception escapes. Without
  // this, the disposer never returns and the listener leaks across the
  // entire window lifetime. Grammar failures during startup never reach
  // this catch — those route through `onError` and return normally.
  try {
    handle();
  } catch (err) {
    dispose();
    throw err;
  }
  return dispose;
}

/**
 * Event dispatched on a successful navigation parse. Future workbench
 * bootstrap layers subscribe to `'pulsar:navigate'` to receive parsed
 * targets without coupling to the runtime entry point.
 *
 * Subclasses `Event` (rather than using `CustomEvent`) so the helper
 * works on Node 18, where `CustomEvent` is not yet a global.
 */
export class PulsarNavigationEvent extends Event {
  readonly navigationTarget: NavigationTarget;
  constructor(target: NavigationTarget) {
    super(PulsarNavigationEvent.TYPE);
    this.navigationTarget = target;
  }
  static readonly TYPE = 'pulsar:navigate';
}

/**
 * Event dispatched when URL grammar parsing fails. Future workbench
 * bootstrap layers subscribe to `'pulsar:navigate-error'` to surface
 * malformed URLs to the operator.
 */
export class PulsarNavigationErrorEvent extends Event {
  readonly navigationError: Error;
  constructor(error: Error) {
    super(PulsarNavigationErrorEvent.TYPE);
    this.navigationError = error;
  }
  static readonly TYPE = 'pulsar:navigate-error';
}

/**
 * Browser-target shape required by {@link bootstrapNavigation}: every
 * member of {@link NavigationWindowLike} plus a DOM-shaped
 * `dispatchEvent` so the helper can publish parsed targets and parse
 * errors as events on the same target.
 */
export interface NavigationEventTarget extends NavigationWindowLike {
  dispatchEvent(event: Event): boolean;
}

/**
 * Bootstrap navigation parsing for the runtime entry point.
 *
 * Subscribes the URL grammar parser to the supplied target's
 * `popstate` and runs it once at startup (PUL-F007 clause 2). Every
 * successful parse fires a {@link PulsarNavigationEvent}; every parse
 * failure fires a {@link PulsarNavigationErrorEvent}. Returns a
 * disposer that removes the listener.
 *
 * The future workbench bootstrap (scene catalog, mode dispatch,
 * composition orchestration) subscribes to these events on `window`
 * to receive parsed targets without coupling to the entry script.
 */
export function bootstrapNavigation(target: NavigationEventTarget): () => void {
  return subscribeNavigation({
    window: target,
    onNavigate: (parsed) => {
      target.dispatchEvent(new PulsarNavigationEvent(parsed));
    },
    onError: (error) => {
      target.dispatchEvent(new PulsarNavigationErrorEvent(error));
    },
  });
}
