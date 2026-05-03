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
// Strategy: fetch every asset URL in parallel via `Promise.allSettled`
// and drain each successful response body via `arrayBuffer()` so the
// network stream is fully consumed before the function resolves —
// without the drain, `fetch` resolves on headers and the cache may
// not yet hold the bytes when `create(ctx)` runs.
//
// Failure handling: any non-2xx response, rejected fetch, or scheme
// rejection surfaces as a single `AggregateError` whose `errors` array
// carries every failure in declaration order. Each failure's message
// names the asset URL so a multi-asset failure does not collapse into
// indistinguishable network errors. Failures from non-2xx responses
// drain/cancel the response body before throwing so connections are
// not leaked. Failures are never swallowed; the resolver wraps the
// AggregateError as
// `composition resolution failed: scene "<id>" preloadAssets threw: ...`.
//
// Decode-complete semantics (image decode, font load, audio decode)
// are explicitly out of scope here — see ADR-012. A future requirement
// can layer a decode pass on top of (or compose with) this preloader
// without changing its contract.
//
// References:
//  - ADR-002 §Resolution — runtime preloads assets per scene before mount.
//  - ADR-008 #5 — scene asset inventories are statically inspectable
//    (no runtime discovery; the only source is `scene.assets`).
//  - ADR-011 — orchestrator-with-injected-adapters; this module is the
//    asset adapter the resolver consumes.
//  - ADR-012 — fetch + drain semantics; decode-complete deferred.

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
   * `AbortSignal` to all per-scene fetches.
   */
  readonly init?: RequestInit;
  /**
   * Base URL used to resolve relative asset paths. Required when the
   * runtime is preloading on Node — Node's `fetch` rejects relative
   * URLs with `TypeError: Invalid URL`. Optional in the browser, where
   * relative paths resolve against `document.baseURI` automatically.
   * When provided, every resolved URL is re-validated against the
   * scheme allowlist (so a scene cannot smuggle a `file:` URL by
   * declaring it absolute).
   */
  readonly baseUrl?: string;
  /**
   * URL schemes accepted by the preloader. Defaults to
   * {@link DEFAULT_ALLOWED_SCHEMES}. Pass an explicit list to tighten
   * (e.g. `['https:']` for production) or extend (e.g. add `'file:'`
   * for offline-export workflows). Schemes outside the list reject
   * before fetch with `asset "<url>": scheme "<scheme>" not allowed`.
   */
  readonly allowedSchemes?: readonly string[];
}

/**
 * Build a per-scene asset preloader.
 *
 * The returned function:
 *  - resolves immediately when `scene.assets` is empty (no fetch calls);
 *  - validates every asset URL against the scheme allowlist before any
 *    network request (default allowlist is {@link DEFAULT_ALLOWED_SCHEMES});
 *  - if `baseUrl` is provided, resolves each asset against it via the
 *    `URL` constructor and re-validates the resolved scheme;
 *  - otherwise issues one parallel `fetch` per asset URL, drains each
 *    successful response body, and resolves with `undefined` once every
 *    asset is fully downloaded;
 *  - throws an `AggregateError` when one or more assets fail (HTTP
 *    non-2xx, rejected fetch, scheme rejection, or invalid URL). The
 *    wrapping message is `composition asset preload failed: scene "<id>"`;
 *    per-asset failure messages live in `AggregateError.errors` and
 *    always name the offending asset URL so multi-asset failures stay
 *    distinguishable. The order of `errors` matches the declaration
 *    order in `scene.assets`, not completion order.
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
    const results = await Promise.allSettled(
      scene.assets.map((asset) => preloadAsset(asset, fetchImpl, init, baseUrl, allowedSchemes)),
    );
    const errors: unknown[] = [];
    for (const result of results) {
      if (result.status === 'rejected') errors.push(result.reason);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `composition asset preload failed: scene "${scene.id}"`);
    }
  };
}

/**
 * Resolve and scheme-validate one asset URL. Throws an asset-scoped
 * Error on rejection; the caller's `Promise.allSettled` collects.
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
  // No baseUrl: try parsing as an absolute URL. If parsing succeeds,
  // the asset declared an explicit scheme — validate it. If parsing
  // throws, the asset is a relative path; pass it through and let the
  // browser's `fetch` resolve it against `document.baseURI`.
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
 * Fetch one resolved asset URL and drain its body. All errors thrown
 * here carry the asset URL in their message so multi-asset failures
 * stay distinguishable.
 */
async function preloadAsset(
  asset: string,
  fetchImpl: typeof globalThis.fetch,
  init: RequestInit | undefined,
  baseUrl: string | undefined,
  allowedSchemes: readonly string[],
): Promise<void> {
  const resolvedUrl = resolveAssetUrl(asset, baseUrl, allowedSchemes);
  let response: Response;
  try {
    response =
      init === undefined ? await fetchImpl(resolvedUrl) : await fetchImpl(resolvedUrl, init);
  } catch (cause) {
    throw new Error(`asset "${asset}": ${describeFailure(cause)}`, { cause });
  }
  if (!response.ok) {
    // Drain/cancel the body before throwing so connections are not
    // tied up waiting for GC. `cancel()` is a no-op if the body is
    // already consumed or null; failures here are irrelevant — the
    // HTTP error is the failure we want to surface.
    await cancelBodyQuietly(response);
    throw new Error(`asset "${asset}": ${response.status} ${response.statusText}`);
  }
  // Drain the body so the network transfer fully completes before the
  // caller's `create(ctx)` runs. Without this, `fetch` resolves on
  // headers and the bytes may still be in flight, defeating the
  // "preload" contract.
  try {
    await response.arrayBuffer();
  } catch (cause) {
    throw new Error(`asset "${asset}": body drain failed: ${describeFailure(cause)}`, { cause });
  }
}

const describeFailure = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

async function cancelBodyQuietly(response: Response): Promise<void> {
  if (response.body === null) return;
  try {
    await response.body.cancel();
  } catch {
    // Ignore: the body may already be consumed or released.
  }
}
