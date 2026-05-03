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
// Failure handling: any non-2xx response or rejected fetch surfaces as
// a single `AggregateError` whose `errors` array carries every failure
// in declaration order. Single-failure cases use the same shape as
// multi-failure cases for consumer consistency. Failures are never
// swallowed; the resolver wraps the AggregateError as
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
 * Options for {@link createAssetPreloader}. All fields are optional;
 * the defaults pull from `globalThis.fetch` with no extra request init.
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
}

/**
 * Build a per-scene asset preloader.
 *
 * The returned function:
 *  - resolves immediately when `scene.assets` is empty (no fetch calls);
 *  - otherwise issues one parallel `fetch` per asset URL, drains each
 *    successful response body, and resolves with `undefined` once every
 *    asset is fully downloaded;
 *  - throws an `AggregateError` when one or more assets fail (HTTP
 *    non-2xx OR rejected fetch). The wrapping message is
 *    `composition asset preload failed: scene "<id>"`; per-asset
 *    failure messages live in `AggregateError.errors`. The order of
 *    `errors` matches the declaration order in `scene.assets`, not
 *    completion order.
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
  return async (scene) => {
    if (scene.assets.length === 0) return;
    const results = await Promise.allSettled(
      scene.assets.map((asset) => preloadAsset(asset, fetchImpl, init)),
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
 * Fetch one asset URL and drain its body. Throws the underlying error
 * for the caller's `Promise.allSettled` to collect; this function does
 * not aggregate.
 */
async function preloadAsset(
  url: string,
  fetchImpl: typeof globalThis.fetch,
  init: RequestInit | undefined,
): Promise<void> {
  const response = init === undefined ? await fetchImpl(url) : await fetchImpl(url, init);
  if (!response.ok) {
    throw new Error(`asset "${url}": ${response.status} ${response.statusText}`);
  }
  // Drain the body so the network transfer fully completes before the
  // caller's `create(ctx)` runs. Without this, `fetch` resolves on
  // headers and the bytes may still be in flight, defeating the
  // "preload" contract.
  await response.arrayBuffer();
}
