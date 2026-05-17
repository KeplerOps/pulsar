# PUL-Q009 Asset Failure Surfacing Preflight

PUL-Q009 requires asset preload failures to surface with the scene id
and asset path before the scene mounts. The repository already has the
right ownership split: `scene.assets` is the asset inventory,
`createAssetPreloader()` fetches and aggregates per-asset failures,
`resolveComposition()` awaits preload before `create(ctx)`, and
`createSceneLoader()` owns the browser-visible diagnostic surface.

This requirement should close the diagnostic gap at those seams. It is
not a new asset subsystem, scene lifecycle failure type, validation
schema, logger, retry policy, or workflow.

## Boundary

- `src/runtime/scene.ts` remains the scene metadata contract.
  Implementations must read `SceneModule.assets`; do not add a second
  asset declaration field.
- `src/runtime/asset-preloader.ts` remains the fetch, URL-resolution,
  scheme-validation, redirect-validation, stream-drain, and per-asset
  failure aggregation boundary.
- `src/runtime/composition-resolver.ts` remains the lifecycle
  orchestrator. Preload is still awaited before `create(ctx)`, and a
  preload failure remains composition-wide rather than a PUL-F029
  scene lifecycle failure.
- `src/runtime/scene-loader.ts` remains the browser/workbench
  diagnostic boundary via `onError` and
  `data-pulsar-navigation-error`.
- `src/runtime/error.ts` remains the shared unknown-error rendering
  home. Any cause/AggregateError rendering needed for asset diagnostics
  belongs there or behind a helper exported from there, not as local
  recursive string code in the loader, resolver, or preloader.

## Required Reuse

Implementation must build on these incumbents:

- Scene asset inventory: `SceneModule.assets` and `assertSceneModule()`.
- Asset policy and fetch semantics: `createAssetPreloader()`,
  `resolveAssetUrl()`, `DEFAULT_ALLOWED_SCHEMES`,
  `AssetPreloaderOptions.baseUrl`, `AssetPreloaderOptions.allowedSchemes`,
  `AssetPreloaderOptions.fetch`, and `AssetPreloaderOptions.init`.
- Lifecycle ordering: `AssetPreloader`, `preloadScene()`,
  `resolveComposition()`, `loadSceneNavigationTarget()`, and the
  loader's per-navigation `createPreloader(signal)` seam.
- Error and diagnostic style: `Error`, `AggregateError`, `Error.cause`,
  `describeError()`, loader `onError`, and
  `data-pulsar-navigation-error`.
- Existing test surfaces:
  `tests/runtime/asset-preloader.test.ts`,
  `tests/runtime/composition-resolver.test.ts`,
  `tests/runtime/scene-navigation.test.ts`, and
  `tests/runtime/scene-loader*.test.ts`.

## Cross-Cutting Layers

| Layer | Guardrail |
|-------|-----------|
| Scene schema gate | `assertSceneModule()` already guarantees `assets` is an array of strings. Do not introduce `AssetManifest`, asset DTOs, or duplicate scene validation for PUL-Q009. |
| Asset URL policy | Use `resolveAssetUrl()` and the existing `baseUrl` / `allowedSchemes` behavior. The requirement is about surfacing failures, not widening allowed schemes, adding file access, or probing paths outside the preloader. |
| Fetch boundary | Keep `fetch` injection and `init.signal` forwarding. Abort-driven preload cancellation must keep its current semantics and must not be reported as a stale navigation error after supersession. |
| Redirect and scheme security | Preserve up-front scheme validation and post-redirect re-validation. Do not bypass the preloader with `<link rel=preload>`, `Image()`, Howler, or browser cache heuristics that cannot surface a precise per-asset failure. |
| Credential handling | `init.headers` still flows to every asset URL. Do not add credentials, auth headers, cookies, or token-bearing query construction to satisfy this requirement. If a caller needs credentialed preload, it must stay behind a custom `fetch` or future origin policy. |
| Resolver lifecycle | Preload failures remain composition-wide and must abort before `create(ctx)`. They must not flow through `onSceneFailed`, `data-pulsar-scene-failures`, presenter recovery, or scene cleanup for the not-yet-mounted scene. Already-mounted prior scenes still clean up through the resolver. |
| Error envelope | Public diagnostics must include the scene id and failing declared asset path. They may include the resolved URL when the preloader already has it. Do not dump raw `Response` objects, request headers, cookies, authorization values, full stacks, scene objects, captions, DOM nodes, or serialized causes. |
| Observability | Browser surfacing stays `onError` plus `data-pulsar-navigation-error`. No telemetry stream, persistent error history, localStorage, cookies, or new logging framework. |
| Runtime validation | `validateRuntime()` may continue to catch unresolvable URL shapes through `resolveAssetUrl()`, but PUL-Q009 is runtime preload failure surfacing. Do not reclassify HTTP/network failures as structural validation findings. |
| OS/process exposure | Asset paths and credential-bearing URLs must not be passed through process argv, shell commands, env vars, or generated command lines. Tests should use injected fake fetches in process. |

## Intended Design

The intended design is a narrow diagnostic rendering improvement over
the existing `AggregateError` chain. `createAssetPreloader()` already
throws `AggregateError` with scene id in the top message and
asset-scoped entries in declaration order. `resolveComposition()`
already preserves that object as `Error.cause` while adding scene
context. The browser-facing diagnostic should render enough of that
chain to expose each failing declared asset path alongside the scene
id before any `create(ctx)` call occurs.

Keep the output bounded and deterministic. Multiple failing assets
should remain distinguishable and declaration ordered. A single
failure should keep the same structural path as multiple failures; do
not special-case it into a bare error.

The extensibility seam is a shared diagnostic renderer in
`src/runtime/error.ts`: it can later gain redaction, truncation,
structured-error formatting, or AggregateError-depth limits without
rewriting loader, resolver, asset, audio, and validation code. Keep the
renderer parameterized enough for public surfaces to request bounded
cause/AggregateError detail while internal wrappers can continue to
use concise `describeError()` where appropriate.

## Gotchas And Anti-Patterns

- Do not create `AssetLoadError`, `SceneAssetFailure`, or a parallel
  exception hierarchy. The repo already uses `AggregateError` plus
  `Error.cause` for this path.
- Do not solve surfacing by changing the scene schema or adding asset
  ids. The requirement names the declared asset path.
- Do not swallow `AggregateError.errors` at the loader boundary; that
  is where the failing asset path currently lives.
- Do not classify preload failure as a scene lifecycle failure. ADR-028
  deliberately reserves `onSceneFailed` for `create`, `timeline`, and
  `cleanup`.
- Do not mount a placeholder scene, run `create(ctx)`, or call scene
  cleanup for the scene whose preload failed. The failure must surface
  before mount.
- Do not fetch assets in validation or add a CI/network probe to
  satisfy runtime surfacing.
- Do not add retry, fallback URL, partial-success mount, decode-complete
  image/font/audio handling, or cache warming policy under PUL-Q009.
- Do not include headers, cookies, auth values, stacks, DOM, captions,
  or raw cause serialization in public diagnostics.

## Non-Goals

PUL-Q009 does not add asset retries, fallback assets, host allowlists,
credential policy, offline file access, decode-complete semantics,
validation-network checks, telemetry, persistence, new URL parameters,
new workbench modes, scene recovery UI, presenter commands, or a new
logging system.

It does not change composition manifest shape, scene metadata shape,
registry behavior, navigation grammar, timeline orchestration, audio
source policy, or ADR-028 scene lifecycle failure isolation.
