# Issue 101 Production Asset URL And Credential Policy Preflight

Date: 2026-05-23

Issue 101 asks for a production-facing policy over the existing asset
preloader: URL schemes, `baseUrl`, relative assets, `data:` / `blob:`,
redirects, credentialed fetches, and cross-origin behavior.

The runtime already has the right policy boundary. This issue should
document the production profile and, only if the documented profile is
claimed as runtime-enforced, extend the existing preloader and
validation policy hooks. It is not a new asset subsystem, scene schema,
configuration system, fetch wrapper, error hierarchy, logger, or
deployment workflow.

## Boundary

- `src/runtime/scene.ts` owns the asset inventory through
  `SceneModule.assets`; production policy must not add a second asset
  manifest or per-deployment scene DTO.
- `src/runtime/asset-preloader.ts` owns URL resolution, scheme
  allowlisting, fetch/drain, redirect re-validation, and request-init
  forwarding. Production enforcement belongs here when it is runtime
  behavior.
- `src/runtime/validation.ts` mirrors the preloader's `baseUrl` and
  `allowedSchemes` policy in `ValidationInput.assets`. Any new static
  URL policy check that can run without network I/O must be mirrored
  here so boot/CI validation and runtime preload agree.
- `src/main.ts` and future deployment/export entrypoints own the
  deployment profile: they choose `baseUrl`, scheme allowlist, fetch,
  and request init. Do not encode production policy in scene modules.
- ADR-012 remains the canonical asset-preloader decision. If the issue
  changes accepted preloader semantics, update ADR-012 rather than
  leaving the policy only in issue prose.

## Required Reuse

Implementation must build on these incumbents:

- Asset inventory and schema: `SceneModule.assets`,
  `SceneModule.audio`, `assertSceneModule()`, and the `scene.audio`
  subset rule.
- Asset URL policy: `resolveAssetUrl()`,
  `DEFAULT_ALLOWED_SCHEMES`, `AssetPreloaderOptions.baseUrl`,
  `AssetPreloaderOptions.allowedSchemes`,
  `AssetPreloaderOptions.fetch`, and `AssetPreloaderOptions.init`.
- Structural validation: `validateRuntime()`,
  `ValidationInput.assets`, `Finding`, and
  `assertNoValidationFindings()`.
- Lifecycle and cancellation: `createSceneLoader()`'s
  `createPreloader(signal)` seam, `AssetPreloader`,
  `resolveComposition()`, and the per-navigation `AbortSignal`.
- Error and diagnostics: `Error`, `AggregateError`, `Error.cause`,
  `describeError()`, loader `onError`,
  `data-pulsar-navigation-error`, and validation findings.
- Workflow and tests: `pnpm test`, `pnpm typecheck`, `pnpm lint`,
  `tests/runtime/asset-preloader.test.ts`,
  `tests/runtime/validation.test.ts`,
  `tests/runtime/workbench-graph.test.ts`, and existing source-policy
  tests.

## Production Policy

Recommended hardened production profile:

- Require an explicit `baseUrl` at every production entrypoint that
  preloads assets. This is what makes relative assets and
  root-relative assets resolve to an absolute URL that the same scheme
  policy can validate before fetch. Authoring/dev may omit `baseUrl`
  for browser convenience; production should not.
- Use `allowedSchemes: ['https:']` for public production. `https:` is
  cacheable, inspectable by normal deployment controls, and avoids
  mixed-content and network-tampering risks.
- Treat `http:` as non-production except explicitly local or private
  deployments that accept transport risk. Do not leave `http:` enabled
  in the public production profile.
- Treat `data:` and `blob:` as authoring defaults, not hardened
  production defaults. They bypass origin/CDN allowlisting,
  deployment scanning, cache policy, and stable URL review. Allow them
  only for a documented trusted-inline profile where scene metadata is
  fully trusted and no credentialed fetch policy depends on origin.
- Never allow `file:`, `javascript:`, `ftp:`, `gopher:`, `ws:`, or
  `wss:` in production asset preload. They either expose local host
  resources, execute or imply code, bypass normal asset delivery, or
  do not fit the byte-warming `fetch` contract.
- Reject protocol-relative URLs without `baseUrl`; the current
  `resolveAssetUrl()` behavior already does this. With `baseUrl`,
  validate the resolved absolute URL exactly like any other asset.
- Keep post-redirect validation mandatory. A declared allowed URL that
  redirects to a disallowed scheme must fail after fetch and before
  body drain. If origin allowlisting is added, re-check the final
  redirected origin too.
- For third-party or CDN origins, prefer uncredentialed public assets.
  Do not pass global `Authorization`, `Cookie`, token-bearing headers,
  or `credentials: 'include'` to all asset URLs when any asset can
  resolve to a third-party origin.
- Credentialed asset fetches are allowed only when credentials are
  bound per destination URL. Use a custom `fetch` or a future
  preloader policy seam that attaches credentials only for
  same-origin or explicitly allowlisted origins and refuses every
  other destination.

This policy is stricter than the authoring default
`DEFAULT_ALLOWED_SCHEMES` (`http:`, `https:`, `data:`, `blob:`). Do
not change that default just to express a production deployment choice;
entrypoints must opt into the production profile.

## Cross-Cutting Layers

| Layer | Guardrail |
|-------|-----------|
| Scene schema gate | `assertSceneModule()` already guarantees `assets` is an array of strings and `audio` entries are members of `assets`. Do not add `ProductionAsset`, asset ids, or a second schema. |
| Workbench graph validation | Browser boot and CI validation should pass the same production asset policy to `validateRuntime()` when running a production profile. Do not let validation use authoring defaults while preload uses hardened settings. |
| URL parser / policy gate | Reuse `resolveAssetUrl()` for `baseUrl`, protocol-relative URLs, absolute URLs, and scheme allowlists. Do not copy URL parsing into `main.ts`, tests, scene modules, or docs examples. |
| Fetch boundary | `createAssetPreloader()` remains the only runtime fetch/drain path for declared scene assets. Keep `fetch` injection and `init.signal` forwarding; do not bypass it with `<link rel=preload>`, `Image()`, Howler, or scene-local fetches. |
| Redirect security | Preserve up-front scheme validation and post-redirect scheme validation. If origin checks are added, they must run both before fetch and against `response.url` after redirects. |
| Credential handling | `RequestInit.headers` and `credentials` apply to every fetch call unless a custom `fetch` gates them per URL. Production policy must not rely on authors remembering which absolute URLs receive shared credentials. |
| Cross-origin / CORS | Scheme allowlisting is not origin allowlisting. Third-party assets need valid CORS headers for `fetch` preload and must be treated as public unless an explicit credentialed-origin policy exists. |
| SSRF / private network | `https:` still permits loopback, link-local, RFC 1918, and metadata-service hosts. If production processes untrusted scene metadata, use deployment egress controls now or add a canonical origin/private-network policy seam; scheme checks alone are insufficient. |
| Audio source policy | Audio source validation also reuses `resolveAssetUrl()` and `DEFAULT_ALLOWED_SCHEMES`. Do not create a looser audio URL policy than the production asset policy; a future shared policy parameter should feed audio too. |
| Lifecycle / cancellation | Asset policy failures remain preload failures before `create(ctx)`. Abort-driven supersession remains an `AbortSignal` concern, not a policy error or scene lifecycle failure. |
| Error envelope | Diagnostics may name scene id, declared asset string, resolved URL when needed, scheme, origin, and rule. Do not dump request headers, cookies, authorization values, full response objects, stacks, env values, raw scene objects, DOM nodes, or serialized causes. |
| Config / env binding | Production profile values are non-secret configuration: base URL, allowed schemes, and optional origins. Secrets and credentials must stay out of scene metadata, URL query params, validation findings, docs examples, and committed config. |
| OS-level exposure | Do not pass credential-bearing asset URLs, headers, cookies, or tokens through process argv, shell commands, filenames, CI annotations, or artifacts. Tests should use injected fake fetches and in-memory policy objects. |
| Observability | Keep observability on existing surfaces: validation findings, `onError`, DOM diagnostic attributes, and bounded console errors. Do not add telemetry, localStorage/sessionStorage logs, or a parallel production logger. |
| Workflow | Source changes need a Towncrier fragment; this preflight doc and README entry do not. Ground Control has no requirement UID for this issue-driven run, so no requirement status transition or traceability link is available. |

## Extensibility

The required seam is the existing asset policy object shared by
preload and validation. Keep it parameterized at the entrypoint:
`baseUrl`, `allowedSchemes`, `fetch`, and `init` today.

If production policy needs runtime enforcement beyond the current
behavior, extend this seam narrowly instead of creating a new
configuration layer. The obvious future parameters are:

- `allowedOrigins` for first-party/CDN host control and private-network
  defense that cannot be expressed by schemes.
- `credentialedOrigins` or an equivalent credential policy for the
  destinations allowed to receive `Authorization`, cookies, or
  `credentials: 'include'`.

Any static part of those checks should be mirrored in
`ValidationInput.assets`; any fetch-time part must live in
`createAssetPreloader()` and must be re-applied after redirects. The
audio service should eventually consume the same policy rather than
keeping a separate default-only source check.

## Gotchas And Anti-Patterns

- Do not document `allowedSchemes: ['https:']` as sufficient SSRF
  protection. It is scheme hardening, not host or network hardening.
- Do not require absolute asset strings in `scene.assets`. Production
  strictness belongs in `baseUrl` plus policy options, not authoring
  metadata.
- Do not silently rely on the browser's `document.baseURI` in
  production; that prevents static scheme and origin validation of
  relative assets.
- Do not send shared headers or cookies through `init` when third-party
  assets are permitted. Use custom fetch or a canonical credential
  policy.
- Do not put credential-bearing URLs in diagnostics, tests, examples,
  shell commands, or CI config.
- Do not add validation that fetches assets or probes the network.
  Structural validation stays side-effect-free.
- Do not special-case `data:` / `blob:` as "safe because no network."
  They bypass deployment controls and should remain opt-in for trusted
  profiles.
- Do not create `ProductionAssetPreloader`, `AssetPolicyValidator`,
  `AssetLoadError`, or a parallel exception hierarchy when the
  existing preloader, validator, and `AggregateError` path cover the
  behavior.
- Do not weaken redirect validation or set `redirect: 'manual'` just
  to avoid final-URL policy checks. If redirects are followed, the
  final URL must satisfy the same policy.

## Non-Goals

Issue 101 does not require asset retries, fallback URLs, decode-complete
image/font/audio loading, CDN health checks, network existence checks,
service-worker preloading, cache warming policy, new workbench modes,
new URL parameters, scene recovery UI, telemetry, persistence, a new
logging system, or a deployment CLI.

It should not change scene metadata shape, composition manifest shape,
registry behavior, navigation grammar, timeline orchestration, scene
cleanup semantics, ADR-028 scene failure isolation, or the byte-warming
scope of ADR-012 unless a separate decision explicitly changes those
contracts.
