// URL navigation grammar — PUL-F007 (ADR-013).
//
// Boundary adapter from `URLSearchParams` to a plain navigation target;
// it does NOT resolve scenes, run timelines, load assets, or mutate
// history. Accepts only the five grammar keys (`scene`, `composition`,
// `index`, `beat`, `mode`); repeated keys are invalid, unknown keys
// ignored. The URL search string is the source of truth on `popstate`
// (never `history.state` / storage / cookies).
//
// Combination shapes (ADR-013) — exactly five accepted:
//   1. no explicit target          + optional mode
//   2. scene                       + optional beat + optional mode
//   3. composition                 + optional mode
//   4. composition + scene         + optional beat + optional mode
//   5. composition + index         + optional beat + optional mode

import { KEBAB_IDENTIFIER_FORM, isKebabIdentifier } from './identifier';

/** Workbench mode set (ADR-007); the only accepted `mode=` values. Frozen. */
export const NAVIGATION_MODES = Object.freeze([
  'present',
  'standalone',
  'loop',
  'paused',
  'scrub',
  'screenshot',
  'prompter',
  'rehearsal',
] as const);

/** One of the {@link NAVIGATION_MODES} values. */
export type NavigationMode = (typeof NAVIGATION_MODES)[number];

/**
 * The locator portion of a {@link NavigationTarget}, discriminated by
 * `kind` (ADR-013's five target shapes). Existence / uniqueness checks
 * are the resolution layer's, not the grammar's.
 *
 *  - `none`              — no explicit target; bootstrap chooses default.
 *  - `scene`             — single scene by id.
 *  - `composition`       — composition by id, no in-composition jump.
 *  - `composition-scene` — composition + scene id.
 *  - `composition-index` — composition + zero-based index.
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
 * Result of {@link parseNavigationSearch}. `beat` / `mode` are absent
 * when the URL omitted them; the bootstrap layer substitutes defaults
 * (e.g. `mode === undefined` → `'present'`).
 */
export interface NavigationTarget {
  readonly locator: NavigationLocator;
  readonly beat?: string;
  readonly mode?: NavigationMode;
}

const GRAMMAR_KEYS = ['scene', 'composition', 'index', 'beat', 'mode'] as const;

/** Stable prefix every grammar diagnostic carries (see {@link fail}). */
export const NAVIGATION_GRAMMAR_PREFIX = 'navigation grammar is invalid:';

/**
 * The locator kinds a `beat` may pair with (ADR-013): a beat positions
 * a scene timeline, so the target must address a single scene.
 */
function isSceneLikeLocator(locator: NavigationLocator): boolean {
  return (
    locator.kind === 'scene' ||
    locator.kind === 'composition-scene' ||
    locator.kind === 'composition-index'
  );
}

/**
 * Single source of truth for ADR-013's `beat` / `mode` grammar rules,
 * shared by {@link parseNavigationSearch} and the loader's defense-in-depth
 * re-check so rules and diagnostic wording stay identical. The condition
 * strings are the suffix after {@link NAVIGATION_GRAMMAR_PREFIX}.
 */
export const NAVIGATION_GRAMMAR = Object.freeze({
  beatKebab: Object.freeze({
    valid: (beat: string): boolean => isKebabIdentifier(beat),
    condition: `"beat" must be a non-empty lowercase kebab-case string (${KEBAB_IDENTIFIER_FORM})`,
  }),
  beatSceneLike: Object.freeze({
    valid: isSceneLikeLocator,
    condition:
      '"beat" requires a scene-like target ("scene", "composition" + "scene", or "composition" + "index")',
  }),
  mode: Object.freeze({
    valid: (mode: string): boolean => (NAVIGATION_MODES as readonly string[]).includes(mode),
    condition: (mode: string): string =>
      `"mode" unknown mode "${mode}" — allowed: ${NAVIGATION_MODES.join(', ')}`,
  }),
});

// ADR-013 `index`: base-10 digits only (leading zeros allowed); signs,
// decimals, exponents, and non-decimal notations rejected.
const INDEX_PATTERN = /^\d+$/;

/**
 * The thrown-error grammar matches `assertSceneModule` /
 * `assertCompositionManifest`: a stable `"<noun> is invalid: ..."`
 * prefix so callers can pattern-match on origin without parsing
 * field-specific detail.
 */
function fail(condition: string): never {
  throw new Error(`${NAVIGATION_GRAMMAR_PREFIX} ${condition}`);
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
    fail(`"${field}" must be a non-empty lowercase kebab-case string (${KEBAB_IDENTIFIER_FORM})`);
  }
}

function parseIndex(raw: string): number {
  if (!INDEX_PATTERN.test(raw)) {
    fail('"index" must be a base-10 non-negative integer (e.g. 0, 1, 12)');
  }
  // The regex already excludes negatives/decimals; only the safe-integer
  // bound needs a runtime check (long digit strings can overflow).
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value)) {
    fail('"index" must be a non-negative safe integer');
  }
  return value;
}

function parseMode(raw: string): NavigationMode {
  if (NAVIGATION_GRAMMAR.mode.valid(raw)) {
    return raw as NavigationMode;
  }
  fail(NAVIGATION_GRAMMAR.mode.condition(raw));
}

function buildLocator(
  scene: string | undefined,
  composition: string | undefined,
  index: number | undefined,
): NavigationLocator {
  if (index !== undefined) {
    // "scene + index" wins over "index requires composition" when both
    // hold (e.g. `?scene=x&index=0`) — the more informative violation.
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
  if (NAVIGATION_GRAMMAR.beatSceneLike.valid(locator)) return;
  fail(NAVIGATION_GRAMMAR.beatSceneLike.condition);
}

/**
 * Parse a URL search string or `URLSearchParams` into a
 * {@link NavigationTarget} (PUL-F007 / ADR-013). Accepts the empty
 * string / `'?'`, `'?k=v'` or `'k=v'` form, or a params instance.
 * Throws (prefix `"navigation grammar is invalid: "`) on repeated keys,
 * malformed identifiers/index, unknown mode, or an invalid combination
 * shape. Unknown query keys are ignored.
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
 * Build a grammar `Error` (prefixed with {@link NAVIGATION_GRAMMAR_PREFIX})
 * from a condition string, so the loader's defense-in-depth re-check
 * produces byte-identical diagnostics to {@link parseNavigationSearch}.
 */
function grammarError(condition: string): Error {
  return new Error(`${NAVIGATION_GRAMMAR_PREFIX} ${condition}`);
}

/**
 * Defense-in-depth for ADR-013's `beat` grammar (PUL-F011): re-check a
 * directly-constructed `NavigationTarget` at the loader boundary so a
 * hand-built invalid `beat` never reaches the runner. Returns an `Error`
 * with the parser's exact message, or `null`.
 */
export function validateBeatGrammar(target: NavigationTarget): Error | null {
  if (target.beat === undefined) return null;
  if (!NAVIGATION_GRAMMAR.beatKebab.valid(target.beat)) {
    return grammarError(NAVIGATION_GRAMMAR.beatKebab.condition);
  }
  if (!NAVIGATION_GRAMMAR.beatSceneLike.valid(target.locator)) {
    return grammarError(NAVIGATION_GRAMMAR.beatSceneLike.condition);
  }
  return null;
}

/**
 * Defense-in-depth for ADR-007's mode allowlist (PUL-F012), symmetric to
 * {@link validateBeatGrammar}: re-check a directly-built `target.mode`
 * before it reaches {@link effectiveMode}. Returns an `Error` or `null`.
 */
export function validateModeGrammar(target: NavigationTarget): Error | null {
  if (target.mode === undefined) return null;
  if (!NAVIGATION_GRAMMAR.mode.valid(target.mode)) {
    return grammarError(NAVIGATION_GRAMMAR.mode.condition(target.mode));
  }
  return null;
}

/**
 * Effective workbench mode for the dispatch boundary (PUL-F012):
 * `target.mode` or `'present'`. Pure — the URL is the ONLY source of
 * mode (ADR-007); never reads storage / cookies / `history.state`.
 */
export function effectiveMode(target?: NavigationTarget | undefined): NavigationMode {
  return target?.mode ?? 'present';
}

/**
 * Minimal `Window`-like surface for {@link subscribeNavigation}; a narrow
 * shape so tests inject a fake without jsdom. The listener takes an
 * `Event` so the browser `window` is structurally assignable.
 */
export interface NavigationWindowLike {
  readonly addEventListener: (event: 'popstate', listener: (evt: Event) => void) => void;
  readonly removeEventListener: (event: 'popstate', listener: (evt: Event) => void) => void;
  readonly location: { readonly search: string };
}

/**
 * Inputs for {@link subscribeNavigation}. Exactly one callback fires per
 * parse: `onNavigate` on success, `onError` on grammar failure (failures
 * never throw out to the caller).
 */
export interface NavigationSubscriptionOptions {
  readonly window: NavigationWindowLike;
  readonly onNavigate: (target: NavigationTarget) => void;
  readonly onError: (error: Error) => void;
  /**
   * Defer the startup parse to a microtask so subscribers registered
   * after {@link subscribeNavigation} returns see the first event. The
   * popstate listener registers synchronously regardless. Default `false`.
   */
  readonly deferStartup?: boolean;
}

/**
 * Subscribe to URL navigation events: parse at startup and on each
 * `popstate` (reading the current `location.search`), both via
 * {@link parseNavigationSearch}. Returns an idempotent disposer that
 * removes the `popstate` listener.
 */
export function subscribeNavigation(options: NavigationSubscriptionOptions): () => void {
  const { window: win, onNavigate, onError, deferStartup = false } = options;

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
  // `disposed` lets a caller that disposes before the deferred startup
  // runs suppress a stale initial event (e.g. Vite HMR swapping the entry).
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    win.removeEventListener('popstate', handle);
  };

  // If a startup callback throws, remove the popstate listener before the
  // exception escapes so it does not leak (grammar failures route through
  // `onError` and never reach this catch).
  const startup = (): void => {
    if (disposed) return;
    try {
      handle();
    } catch (err) {
      dispose();
      throw err;
    }
  };
  if (deferStartup) {
    queueMicrotask(startup);
  } else {
    startup();
  }
  return dispose;
}

/** Successful-parse event, a `CustomEvent<NavigationTarget>` on `window`. */
export const PULSAR_NAVIGATE_EVENT_TYPE = 'pulsar:navigate';

/** Parse-failure event, a `CustomEvent<Error>` on `window`. */
export const PULSAR_NAVIGATE_ERROR_EVENT_TYPE = 'pulsar:navigate-error';

/**
 * Browser-target shape for {@link bootstrapNavigation}: {@link NavigationWindowLike}
 * plus a `dispatchEvent` so the helper can publish events on it.
 */
export interface NavigationEventTarget extends NavigationWindowLike {
  dispatchEvent(event: Event): boolean;
}

/**
 * Bootstrap navigation parsing for the runtime entry (PUL-F007 clause 2):
 * subscribe the parser to `popstate`, defer the startup parse to a
 * microtask, and dispatch `pulsar:navigate` / `pulsar:navigate-error`
 * `CustomEvent`s. Returns a disposer that removes the listener.
 */
export function bootstrapNavigation(target: NavigationEventTarget): () => void {
  return subscribeNavigation({
    window: target,
    onNavigate: (parsed) => {
      target.dispatchEvent(
        new CustomEvent<NavigationTarget>(PULSAR_NAVIGATE_EVENT_TYPE, { detail: parsed }),
      );
    },
    onError: (error) => {
      target.dispatchEvent(
        new CustomEvent<Error>(PULSAR_NAVIGATE_ERROR_EVENT_TYPE, { detail: error }),
      );
    },
    deferStartup: true,
  });
}
