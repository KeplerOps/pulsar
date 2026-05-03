# ADR-012: Asset Preloader — Warm Bytes via Fetch + Drain; Decode-Complete is Future Work

## Status

Accepted

## Date

2026-05-03

## Context

PUL-F005 ships the asset preloader the runtime composition resolver
(PUL-F004 / [ADR-011](011-composition-resolver-orchestration.md)) calls
before each scene's `create(ctx)`. ADR-002 §Resolution and ADR-008 #5
("asset inventories") set the contract: scenes declare assets in
metadata; the runtime preloads them so behavior is predictable for both
human reviewers and coding agents and so screenshot rendering is
deterministic. PUL-F005's statement is "the runtime SHALL preload
declared assets for the active composition before the scene mounts."

"Preload" can mean two materially different things:

1. **Bytes-on-disk** — the asset file is fully downloaded into the HTTP
   cache (or in-memory equivalent), so subsequent reads inside
   `create(ctx)` resolve immediately without a network round trip.
   Implementable in both Node and the browser with native `fetch`
   alone.
2. **Decode-complete** — the asset is not just downloaded but
   format-decoded into the form the runtime will use:
   `Image.decode()` for images so the first paint shows pixels rather
   than a blank rect; `document.fonts.load(font)` for web fonts so
   text doesn't reflow on first paint; `audioContext.decodeAudioData`
   for audio buffers ready for playback. Browser-only APIs;
   per-asset-type handling required.

Decode-complete matters most for `mode=screenshot`
([ADR-007](007-browser-workbench.md)) where a single deterministic
frame is rendered and any post-load layout or paint shift breaks the
guarantee. It matters less for live presentation where a brief
post-load flicker is tolerable.

The Pulsar runtime targets both Node 22 (for the test runner and
exporter pipeline) and the browser (for the live workbench), and the
codebase has no logger, no asset-format-aware loader, no fetch wrapper
to extend.

## Decision

PUL-F005 ships the **byte-warming** preloader. `createAssetPreloader`
in `src/runtime/asset-preloader.ts` uses `fetch` and drains every
successful response body via `response.arrayBuffer()` so the network
transfer is fully complete before `create(ctx)` runs. No asset-type
discrimination, no decode pass, no browser-only APIs.

Failure handling matches the
[ADR-011](011-composition-resolver-orchestration.md) convention: any
non-2xx response or rejected fetch surfaces as a single
`AggregateError` whose `errors` array carries every failure in the
order assets were declared on the scene. Single-failure cases use the
same `AggregateError` shape as multi-failure cases — consistency over
ergonomic difference. The wrapping message is
`composition asset preload failed: scene "<id>"`; per-asset detail
(URL + HTTP status, or original network error) lives in
`errors[i].message`. The PUL-F004 resolver wraps this further as
`composition resolution failed: scene "<id>" preloadAssets threw: ...`
without losing detail.

The factory is configurable via `AssetPreloaderOptions`:

- `fetch` — override `globalThis.fetch`. Required for tests (avoids
  global mutation) and useful in the bootstrap if a custom fetch
  (e.g. an `undici` Agent with custom keep-alive, a service-worker
  shim) is needed.
- `init` — `RequestInit` forwarded to every fetch call. Headers,
  `cache` mode, and `signal` (for cooperative cancellation) flow
  through this slot.

Decode-complete semantics are explicitly **out of scope** for PUL-F005.
A future requirement that needs decode-complete (e.g. when screenshot
mode hardens its determinism guarantees, or when an image-heavy scene
shows a flicker) will layer a decode pass on top of — or compose
with — `createAssetPreloader`. The decode layer can wrap each scene's
declared assets, branch on extension or content-type, and call the
appropriate browser API. The byte-warming preloader's contract does
not need to change for that layer to land.

## Consequences

### Positive

- Works in both Node 22 (tests, exporter) and the browser (workbench)
  with no environment branching and no new dependency.
- Single, small surface: one factory, one options interface, one
  exported function. Structurally legible per
  [ADR-008](008-agent-native-authoring.md) — an agent can read the
  module front-to-back in under two minutes.
- Failure semantics are explicit and testable. Per-asset failures
  aggregate; the resolver's wrap preserves both the wrapping context
  and the per-asset detail.
- Plugs straight into the PUL-F004 `AssetPreloader` adapter slot
  without a wrapper because the function signature
  `(scene: SceneModule) => Promise<void>` is structurally compatible.

### Negative

- Image / font / audio scenes that depend on first-frame correctness
  will see a brief post-load shift between `create(ctx)` and "fully
  decoded." Acceptable for live presentation; not acceptable for
  deterministic screenshots once that surface lands.
- HTTP cache behavior depends on the response's `Cache-Control`
  headers. Callers wanting strong "always reload" semantics pass
  `init: { cache: 'no-store' }`; callers wanting strong "always
  serve from cache" semantics pass `init: { cache: 'force-cache' }`.
  The preloader does not impose a default — the bootstrap and the
  exporter each have different needs.
- Reading `response.arrayBuffer()` allocates the full asset bytes in
  memory transiently before they're GC'd. For very large assets
  (multi-megabyte audio or video) this is wasteful compared to a
  streaming drain. If profiling motivates it, a future change can
  swap to a `body.getReader()` loop without changing the public API.

### Risks

| Risk | Mitigation |
|------|-----------|
| Future contributor "improves" the preloader by adding decode-complete logic and breaks the Node test environment (no `Image`, no `document.fonts`). | This ADR makes the boundary explicit. The decode layer must land as a separate, opt-in module that composes with this preloader rather than mutating it. PR review enforces. |
| Screenshot mode lands and depends on decode-complete, but the team forgets the boundary. | When PUL-F005's customer requirement hits, the implementer reads this ADR (linked from the resolver and the preloader module comments), notices the gap, and ships the decode layer as part of that work. The link from `src/runtime/asset-preloader.ts` to ADR-012 is the breadcrumb. |
| Two scenes share an asset URL; the same URL is fetched twice across consecutive scenes. | The HTTP cache (browser or `undici`) handles cross-scene dedup transparently for cacheable URLs. The preloader does not maintain a separate dedup map; if profiling shows this matters for non-cacheable URLs, a future change can add an in-memory dedup keyed by URL string. |
| `init.signal` cancellation arrives mid-drain and the preloader propagates a partial failure. | The current behavior surfaces the cancellation as one entry in `AggregateError.errors`. Callers driving cancellation from outside (e.g. the workbench during scene navigation) are responsible for treating cancellation as a non-fatal abort separate from genuine asset failures. |

## Related ADRs

- [ADR-002](002-scene-registry-and-compositions.md) §Resolution —
  defines the runtime lifecycle this preloader fits into.
- [ADR-008](008-agent-native-authoring.md) #5 — asset inventories as
  agent-legible structure; the preloader reads them, doesn't discover
  them.
- [ADR-011](011-composition-resolver-orchestration.md) — the resolver
  whose `AssetPreloader` adapter slot this preloader fills.
- [ADR-007](007-browser-workbench.md) — the workbench whose
  `mode=screenshot` is the future customer of decode-complete.
