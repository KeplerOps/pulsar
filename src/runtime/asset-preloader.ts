// Asset preloader — PUL-F005.
//
// Builds a per-scene asset preloader that warms every URL declared in
// `scene.assets` before the scene's `create(ctx)` runs. The preloader
// satisfies the PUL-F004 resolver's `AssetPreloader` adapter contract
// (a function `(scene: SceneModule) => void | Promise<void>` whose
// rejection aborts the composition before mount) — when both
// requirements have shipped, the workbench bootstrap passes
// `createAssetPreloader()` straight to `resolveComposition({ preloadAssets })`.
//
// Strategy:
//  1. Validate (scheme allowlist) and resolve (against `baseUrl`) every
//     declared asset URL up front in a synchronous pass. Network requests
//     do not start until validation has accepted every URL — an early
//     valid asset cannot race a later disallowed scheme into a partial
//     fetch.
//  2. Fetch every resolved URL in parallel via `Promise.allSettled` and
//     stream-drain each successful response body via
//     `body.getReader()`. Streaming (rather than `arrayBuffer()`) keeps
//     transient memory bounded for large assets.
//  3. After fetch completes, re-validate the response's final URL
//     (post-redirect) against the scheme allowlist so a 3xx to a
//     disallowed scheme cannot bypass the up-front check.
//
// Failure handling: any non-2xx response, rejected fetch, scheme
// rejection, or invalid URL surfaces as a single `AggregateError` whose
// `errors` array carries every failure in declaration order. Single-
// failure cases use the same shape as multi-failure cases for consumer
// consistency. Each per-asset failure message names the offending URL
// (and the resolved URL when different) so multi-asset failures stay
// distinguishable. Failures from non-2xx responses cancel the response
// body via `body.cancel()` before throwing so connections are not
// leaked. Failures are never swallowed; the resolver wraps the
// AggregateError as
// `composition resolution failed: scene "<id>" preloadAssets threw: ...`.
//
// Decode-complete semantics (image decode, font load, audio decode)
// are explicitly out of scope here — see ADR-012. A future requirement
// can layer a decode pass on top of (or compose with) this preloader
// without changing its contract.
//
// Cross-origin credential leak: if the caller passes
// `init.headers` carrying credentials (Authorization, Cookie) and a
// scene declares an asset on a third-party origin, those credentials
// are sent to that origin. Per ADR-012, callers wanting credentialed
// preload MUST either bind credentials to a custom `fetch` (per-origin)
// or restrict scenes to first-party assets via `allowedSchemes` plus
// deployment-level network policy. An origin-allowlist option may be
// added in a future requirement; PUL-F005 documents the constraint.
//
// References:
//  - ADR-002 §Resolution — runtime preloads assets per scene before mount.
//  - ADR-008 #5 — scene asset inventories are statically inspectable
//    (no runtime discovery; the only source is `scene.assets`).
//  - ADR-011 — orchestrator-with-injected-adapters; this module is the
//    asset adapter the resolver consumes.
//  - ADR-012 — fetch + drain semantics; decode-complete deferred;
//    SSRF and credential-leak posture.

import { describeError } from './error';
import type { SceneModule } from './scene';

/**
 * URL schemes accepted by default. Scene assets that resolve to any
 * other scheme (e.g. `file:`, `gopher:`, `ws:`) are rejected before
 * the preloader calls `fetch`. Callers wanting a tighter or looser
 * allowlist pass `AssetPreloaderOptions.allowedSchemes`.
 */
export const DEFAULT_ALLOWED_SCHEMES: readonly string[] = Object.freeze([
  'http:',
  'https:',
  'data:',
  'blob:',
]);

/**
 * Options for {@link createAssetPreloader}. All fields are optional;
 * the defaults pull from `globalThis.fetch`, no extra request init,
 * no base URL, and the {@link DEFAULT_ALLOWED_SCHEMES} allowlist.
 */
export interface AssetPreloaderOptions {
  /**
   * Override the fetch implementation. Production callers default to
   * `globalThis.fetch`; tests inject a fake to record calls and shape
   * responses. Injection (rather than module-level global mutation)
   * keeps tests isolated and matches the orchestrator-with-adapters
   * pattern PUL-F004 uses.
   */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * `RequestInit` forwarded to every fetch call (e.g. headers, signal,
   * cache mode). Forwarded by reference so callers can attach a single
   * `AbortSignal` to all per-scene fetches. NB: credentials in
   * `init.headers` flow to every asset URL — see ADR-012's
   * cross-origin caveat before attaching `Authorization` or `Cookie`.
   */
  readonly init?: RequestInit;
  /**
   * Base URL used to resolve relative asset paths. Required when the
   * runtime is preloading on Node — Node's `fetch` rejects relative
   * URLs with `TypeError: Invalid URL`. Optional in the browser, where
   * relative paths resolve against `document.baseURI` automatically.
   * When provided, every resolved URL is re-validated against the
   * scheme allowlist (so a scene cannot smuggle a `file:` URL by
   * declaring it absolute). When NOT provided, protocol-relative
   * (`//host/path`) assets are rejected since their final scheme
   * cannot be statically validated.
   */
  readonly baseUrl?: string;
  /**
   * URL schemes accepted by the preloader. Defaults to
   * {@link DEFAULT_ALLOWED_SCHEMES}. Pass an explicit list to tighten
   * (e.g. `['https:']` for production) or extend (e.g. add `'file:'`
   * for offline-export workflows). Schemes outside the list reject
   * before fetch with `asset "<url>": scheme "<scheme>" not allowed`.
   * The allowlist is also re-checked against the response's final URL
   * after fetch (defense against allowed-URL → disallowed-scheme
   * redirects).
   *
   * Caveat: relative-path assets (e.g. `'/foo.png'`, `'images/x.png'`)
   * with no `baseUrl` configured bypass scheme validation entirely,
   * because the final scheme depends on the browser's
   * `document.baseURI` and cannot be checked statically. Production
   * callers wanting strict scheme enforcement MUST also set `baseUrl`
   * so every asset resolves to an absolute URL the preloader can
   * scheme-check up front. Without `baseUrl`, the allowlist only
   * applies to assets that declare an explicit scheme (or `//host/...`
   * which is rejected outright).
   */
  readonly allowedSchemes?: readonly string[];
}

/**
 * Build a per-scene asset preloader.
 *
 * The returned function:
 *  - resolves immediately when `scene.assets` is empty (no fetch calls);
 *  - validates every asset URL against the scheme allowlist BEFORE any
 *    network request (default allowlist is {@link DEFAULT_ALLOWED_SCHEMES});
 *  - if `baseUrl` is provided, resolves each asset against it via the
 *    `URL` constructor and validates the resolved scheme;
 *  - otherwise issues one parallel `fetch` per asset URL,
 *    stream-drains each successful response body via
 *    `response.body.getReader()`, and resolves with `undefined` once
 *    every asset is fully downloaded;
 *  - re-validates the post-redirect URL of every successful response
 *    against the scheme allowlist (defense against
 *    allowed → disallowed redirects);
 *  - throws an `AggregateError` when one or more assets fail (HTTP
 *    non-2xx, rejected fetch, scheme rejection, or invalid URL). The
 *    wrapping message is `composition asset preload failed: scene "<id>"`;
 *    per-asset failure messages live in `AggregateError.errors` and
 *    always name the offending asset URL (and the resolved URL when
 *    different) so multi-asset failures stay distinguishable. The
 *    order of `errors` matches the declaration order in `scene.assets`,
 *    not completion order.
 *
 * The returned function is the `AssetPreloader` adapter the PUL-F004
 * resolver expects (`(scene: SceneModule) => Promise<void>`). When
 * both requirements have landed, callers wire it via
 * `resolveComposition({ preloadAssets: createAssetPreloader(), ... })`.
 */
export function createAssetPreloader(
  options: AssetPreloaderOptions = {},
): (scene: SceneModule) => Promise<void> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const init = options.init;
  const baseUrl = options.baseUrl;
  const allowedSchemes = options.allowedSchemes ?? DEFAULT_ALLOWED_SCHEMES;
  return async (scene) => {
    if (scene.assets.length === 0) return;

    // Phase 1: resolve and scheme-validate every asset URL up front.
    // Network requests do not start until validation accepts every
    // URL — an early valid asset cannot race a later disallowed
    // scheme into a partial fetch.
    const resolved: string[] = [];
    const validationErrors: unknown[] = [];
    for (const asset of scene.assets) {
      try {
        resolved.push(resolveAssetUrl(asset, baseUrl, allowedSchemes));
      } catch (cause) {
        validationErrors.push(cause);
      }
    }
    if (validationErrors.length > 0) {
      throw new AggregateError(
        validationErrors,
        `composition asset preload failed: scene "${scene.id}"`,
      );
    }

    // Phase 2: fetch + stream-drain in parallel. Declaration order is
    // preserved because we map through the original `scene.assets`
    // array; `Promise.allSettled` collects every failure for the
    // aggregate error.
    const fetchResults = await Promise.allSettled(
      scene.assets.map((asset, index) =>
        fetchAndDrain(asset, resolved[index] as string, fetchImpl, init, allowedSchemes),
      ),
    );
    const fetchErrors: unknown[] = [];
    for (const result of fetchResults) {
      if (result.status === 'rejected') fetchErrors.push(result.reason);
    }
    if (fetchErrors.length > 0) {
      throw new AggregateError(
        fetchErrors,
        `composition asset preload failed: scene "${scene.id}"`,
      );
    }
  };
}

/**
 * Resolve and scheme-validate one asset URL.
 *
 *  - `baseUrl` provided: resolve via `URL` constructor; validate
 *    resolved protocol; return the absolute URL string. Absolute
 *    asset URLs ignore the base (URL constructor behavior).
 *  - `baseUrl` not provided, asset starts with `//`: reject. The
 *    browser's `fetch` would resolve a protocol-relative URL against
 *    `document.baseURI` to a host we cannot statically scheme-check,
 *    so a tightened `allowedSchemes` would be silently bypassed.
 *  - `baseUrl` not provided, asset is parseable as absolute URL:
 *    validate protocol; return the asset string unchanged so fetch
 *    sees it verbatim.
 *  - `baseUrl` not provided, asset is a relative path: pass through.
 *    The browser resolves against `document.baseURI` (same-origin by
 *    default).
 */
function resolveAssetUrl(
  asset: string,
  baseUrl: string | undefined,
  allowedSchemes: readonly string[],
): string {
  if (baseUrl !== undefined) {
    let resolved: URL;
    try {
      resolved = new URL(asset, baseUrl);
    } catch (cause) {
      throw new Error(`asset "${asset}": invalid URL relative to baseUrl`, { cause });
    }
    rejectDisallowedScheme(asset, resolved.protocol, allowedSchemes);
    return resolved.toString();
  }
  if (asset.startsWith('//')) {
    throw new Error(
      `asset "${asset}": protocol-relative URL requires AssetPreloaderOptions.baseUrl for scheme validation`,
    );
  }
  let absolute: URL | null;
  try {
    absolute = new URL(asset);
  } catch {
    return asset;
  }
  rejectDisallowedScheme(asset, absolute.protocol, allowedSchemes);
  return asset;
}

function rejectDisallowedScheme(
  asset: string,
  protocol: string,
  allowedSchemes: readonly string[],
): void {
  if (allowedSchemes.includes(protocol)) return;
  throw new Error(
    `asset "${asset}": scheme "${protocol}" not in allowed list (${allowedSchemes.join(', ')})`,
  );
}

/**
 * Fetch one resolved asset URL, re-validate the post-redirect URL,
 * and stream-drain the body. All errors thrown here carry the asset
 * URL (and the resolved URL when different) in their message.
 */
async function fetchAndDrain(
  asset: string,
  resolvedUrl: string,
  fetchImpl: typeof globalThis.fetch,
  init: RequestInit | undefined,
  allowedSchemes: readonly string[],
): Promise<void> {
  const label = describeAsset(asset, resolvedUrl);
  let response: Response;
  try {
    response =
      init === undefined ? await fetchImpl(resolvedUrl) : await fetchImpl(resolvedUrl, init);
  } catch (cause) {
    throw new Error(`${label}: ${describeError(cause)}`, { cause });
  }
  // Re-validate the final URL after redirects. `response.url` is the
  // URL after any redirects fetch followed. A scene declared an
  // allowed URL that 302s to a disallowed scheme MUST reject.
  if (response.url !== '' && response.url !== resolvedUrl) {
    let finalProtocol: string | null = null;
    try {
      finalProtocol = new URL(response.url).protocol;
    } catch {
      finalProtocol = null;
    }
    if (finalProtocol === null || !allowedSchemes.includes(finalProtocol)) {
      await cancelBodyQuietly(response);
      throw new Error(`${label}: redirected to disallowed URL "${response.url}"`);
    }
  }
  if (!response.ok) {
    // Cancel the body before throwing so connections are not held
    // open until GC.
    await cancelBodyQuietly(response);
    throw new Error(`${label}: ${response.status} ${response.statusText}`);
  }
  try {
    await streamDrain(response);
  } catch (cause) {
    throw new Error(`${label}: body drain failed: ${describeError(cause)}`, { cause });
  }
}

/**
 * Drain the response body without buffering the whole payload into
 * memory. Reads chunks and discards them. Compared to
 * `response.arrayBuffer()`, this avoids transient allocation
 * proportional to asset size — relevant for video / large audio
 * scenes (see ADR-012 §Negative).
 */
async function streamDrain(response: Response): Promise<void> {
  const body = response.body;
  if (body === null) return;
  const reader = body.getReader();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

const describeAsset = (asset: string, resolved: string): string =>
  asset === resolved ? `asset "${asset}"` : `asset "${asset}" → "${resolved}"`;

async function cancelBodyQuietly(response: Response): Promise<void> {
  if (response.body === null) return;
  try {
    await response.body.cancel();
  } catch {
    // Ignore: the body may already be consumed or released.
  }
}
