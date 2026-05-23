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
in `src/runtime/asset-preloader.ts` uses `fetch` and stream-drains
every successful response body via `response.body.getReader()` so the
network transfer is fully complete before `create(ctx)` runs without
buffering the whole payload into memory. No asset-type discrimination,
no decode pass, no browser-only APIs.

The factory runs validation in two phases:

1. **Up-front**, synchronously: every declared asset URL is resolved
   (against `baseUrl` if configured) and scheme-checked against the
   allowlist. If any URL fails validation, no fetch starts. This way
   an early valid asset cannot race a later disallowed asset into a
   partial network call.
2. **Post-fetch**, per response: the `response.url` (the URL after
   any redirects fetch followed) is re-validated against the same
   scheme allowlist. A scene declared an allowed URL that 302s to a
   disallowed scheme (`https://allowed.example` → `file:///etc/passwd`)
   is rejected before its body is read.

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
- `baseUrl` — base URL used to resolve relative asset paths via the
  `URL` constructor. Required for the Node exporter path because
  Node's `fetch` rejects relative URLs with `TypeError: Invalid URL`.
  Optional in the browser, where relative paths resolve against
  `document.baseURI` automatically. When provided, the resolved URL's
  scheme is re-validated against the allowlist so a scene cannot
  smuggle a disallowed scheme by declaring it absolute.
- `allowedSchemes` — URL scheme allowlist. Defaults to the exported
  `DEFAULT_ALLOWED_SCHEMES` constant: `['http:', 'https:', 'data:',
  'blob:']`. Schemes outside the list (e.g. `file:`, `gopher:`,
  `ws:`) reject before fetch with a clear, asset-scoped message.
  Callers tighten (`['https:']` for production) or extend (add
  `'file:'` for offline-export workflows) as their threat model
  requires. The check is the minimum SSRF defense; host-allowlisting
  for richer attacker models is a deployment concern handled at the
  workbench/exporter layer.

Failures from rejected fetches and from non-2xx responses are
**asset-scoped**: every per-asset error message starts with
`asset "<url>": ...` (or `asset "<declared>" → "<resolved>": ...` when
`baseUrl` was used) so two simultaneously failing fetches stay
distinguishable in `AggregateError.errors`. Rejected fetches preserve
the original error as `Error.cause`. Non-2xx responses cancel the
response body via `body.cancel()` before throwing so connections are
not held open until garbage collection.

### Cross-origin credential caveat

`init.headers` flows to **every** asset URL fetched. If a caller
configures `init.headers` carrying credentials (`Authorization`,
`Cookie`) and a scene declares an asset on a third-party origin,
those credentials are sent to that origin. PUL-F005 does not ship an
origin-allowlist option. Callers wanting credentialed preload have
two options today:

1. Bind credentials to a custom `fetch` that injects headers per
   request based on the destination URL. The custom fetch can refuse
   to send credentials cross-origin or attach origin-specific tokens.
2. Restrict the `allowedSchemes` and/or the scene authoring layer so
   third-party absolute URLs cannot appear in `scene.assets`. For
   first-party-only deployments this is sufficient.

A future requirement may add an explicit `originAllowlist` option to
the preloader if profiling or threat-model evolution motivates it.

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
- The preloader uses generic `fetch` with no parallelism cap, so a
  scene with many large assets briefly opens that many concurrent
  connections. Bounded concurrency is not implemented; if profiling
  motivates it, an `AssetPreloaderOptions.concurrency` option can be
  added without changing the public failure semantics.
- The preloader uses CORS-restricted `fetch` (the default). Cross-
  origin assets without `Access-Control-Allow-Origin` headers cannot
  be preloaded — they reject as `fetch failed: ...` and abort the
  composition. For browser deployments that load assets from a CDN
  or third-party origin, the deployment is responsible for ensuring
  CORS headers are present. A `<link rel="preload">` or `Image()`
  fallback path with weaker semantics (no body verification, no
  failure surfacing) is deliberately not shipped here — it would
  conflict with the "fail loud on missing assets" contract per the
  codex preflight guardrails. A future requirement may add an
  opt-in CORS-bypass path for surfaces that explicitly accept the
  weaker contract.
- Relative-path assets (e.g. `'/foo.png'`) without a configured
  `baseUrl` bypass scheme validation entirely — the browser resolves
  them against `document.baseURI` whose protocol the preloader
  cannot statically check. Production callers wanting strict scheme
  enforcement (e.g. `allowedSchemes: ['https:']`) MUST also set
  `baseUrl` so every asset resolves to an absolute URL the preloader
  can scheme-check up front. Without `baseUrl`, the allowlist only
  covers assets that declare an explicit scheme (or `//host/...`
  which is rejected outright). This trade-off is intentional: the
  browser's same-origin default makes relative paths safe in normal
  usage, and forcing a `baseUrl` everywhere would harm the local
  dev / workbench UX.

### Risks

| Risk | Mitigation |
|------|-----------|
| Future contributor "improves" the preloader by adding decode-complete logic and breaks the Node test environment (no `Image`, no `document.fonts`). | This ADR makes the boundary explicit. The decode layer must land as a separate, opt-in module that composes with this preloader rather than mutating it. PR review enforces. |
| Screenshot mode lands and depends on decode-complete, but the team forgets the boundary. | When PUL-F005's customer requirement hits, the implementer reads this ADR (linked from the resolver and the preloader module comments), notices the gap, and ships the decode layer as part of that work. The link from `src/runtime/asset-preloader.ts` to ADR-012 is the breadcrumb. |
| Two scenes share an asset URL; the same URL is fetched twice across consecutive scenes. | The HTTP cache (browser or `undici`) handles cross-scene dedup transparently for cacheable URLs. The preloader does not maintain a separate dedup map; if profiling shows this matters for non-cacheable URLs, a future change can add an in-memory dedup keyed by URL string. |
| `init.signal` cancellation arrives mid-drain and the preloader propagates a partial failure. | The current behavior surfaces the cancellation as one entry in `AggregateError.errors`. Callers driving cancellation from outside (e.g. the workbench during scene navigation) are responsible for treating cancellation as a non-fatal abort separate from genuine asset failures. |
| SSRF via `scene.assets` declaring loopback / link-local IPs (e.g. `http://127.0.0.1:...`, `http://169.254.169.254/`). | The scheme allowlist alone does not block these; `http:` and `https:` allow any host. Production deployments wanting host-level defense need to either restrict at the network layer (egress firewall blocking RFC 1918 / RFC 6890 ranges) or wait for a future `originAllowlist` option on the preloader. Surfaces processing untrusted scene metadata MUST adopt one of these defenses. |

## Production profile

The preloader's defaults are authoring defaults
(`DEFAULT_ALLOWED_SCHEMES = ['http:', 'https:', 'data:', 'blob:']`,
no `baseUrl`, no custom `fetch`). Deployments opt into the hardened
production profile at the entrypoint by passing
`{ baseUrl, allowedSchemes: ['https:'], fetch?: <per-origin-credential-guard> }`
to **both** `createAssetPreloader` and `validateRuntime`.

The canonical deployment-facing policy doc is
[`docs/asset-url-policy.md`](../asset-url-policy.md). It covers:

- when `baseUrl` is required (every production entrypoint);
- which schemes are allowed in public production (`https:` only) and
  why each forbidden scheme is forbidden;
- how credentialed `fetch` options must be bound per destination URL
  rather than via shared `init.headers`;
- post-redirect scheme re-validation as a non-negotiable gate;
- the SSRF caveat — scheme allowlisting is not host hardening, and
  deployments processing untrusted scene metadata still need network
  egress controls;
- the named future seams (`allowedOrigins`, `credentialedOrigins`)
  for any runtime tightening beyond the current behavior.

Future changes to accepted production policy SHOULD update both the
policy doc and this ADR; the policy doc is the operational source of
truth, the ADR is the decision record.

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

## Related docs

- [`docs/asset-url-policy.md`](../asset-url-policy.md) — production
  policy for `baseUrl`, schemes, credentials, redirects, and SSRF
  posture.
