# Asset URL and credential policy (production)

This is the deployment-facing policy for how Pulsar's asset preloader
should be configured in production. The runtime ships with authoring
defaults that are deliberately permissive; production entrypoints opt
into the hardened profile here.

The canonical preloader decision is
[ADR-012](adrs/012-asset-preloader-fetch-and-drain.md). The
implementation lives in `src/runtime/asset-preloader.ts` and is mirrored
by `src/runtime/validation.ts` for static checks. This document does
not introduce new runtime knobs — it tells deployments how to compose
the existing ones.

## Scope

- Asset preloader (`createAssetPreloader`) — the only runtime fetch
  path for declared scene assets. Workbench bootstrap, exporter, and
  any future deployment entrypoint pass options through it.
- Runtime validation (`validateRuntime`) — receives the same
  `assets: { baseUrl, allowedSchemes }` block so static checks reject
  what the preloader would reject. Authoring/CI gates run identically
  to production gates.
- Audio source policy
  (`src/runtime/audio.ts` → `resolveAssetUrl`) — reuses the same
  scheme allowlist, so tightening at the asset layer flows through.

Out of scope: scene metadata shape, composition manifest shape,
workbench mode grammar, exporter caching strategy, telemetry, and any
new configuration loader. These are explicitly non-goals (see
[issue #101 preflight](design/issue-101-production-asset-policy-preflight.md)).

## The production profile

A hardened public production deployment SHOULD configure both the
preloader and the validation pass like this:

```ts
const ASSET_POLICY = {
  baseUrl: 'https://assets.example.com/',
  allowedSchemes: ['https:'] as const,
};

// Boot/CI validation — same policy, no I/O.
const findings = validateRuntime({
  scenes: WORKBENCH_SCENES,
  compositions: WORKBENCH_COMPOSITIONS,
  assets: ASSET_POLICY,
});
assertNoValidationFindings(findings);

// Runtime preloader — per-navigation, with the abort signal.
const createPreloader = (signal: AbortSignal) =>
  createAssetPreloader({
    ...ASSET_POLICY,
    init: { signal }, // see "Credentialed fetches" below — do NOT
                      // attach Authorization / Cookie here in
                      // production deployments that load any
                      // third-party origin.
  });
```

Today `src/main.ts` runs with authoring defaults — no `baseUrl`,
`DEFAULT_ALLOWED_SCHEMES` (`http:`, `https:`, `data:`, `blob:`), no
custom `fetch`. A deployment that wants the hardened profile passes
the matching policy object to **both** `createAssetPreloader` and
`validateRuntime`. Splitting them is the failure mode this section
exists to prevent.

## Required `baseUrl`

Production MUST set `baseUrl`.

- A configured `baseUrl` makes every declared asset resolve to an
  absolute URL via `URL(asset, baseUrl)`. The preloader then
  scheme-checks the resolved URL up front — before any `fetch` runs
  ([asset-preloader.ts `resolveAssetUrl`](../src/runtime/asset-preloader.ts)).
- Without `baseUrl`, relative paths (`'/foo.png'`, `'images/x.png'`)
  fall through to the browser's `document.baseURI`, whose protocol
  the preloader cannot statically validate. A tightened `allowedSchemes`
  becomes advisory in that path; the production profile MUST NOT rely
  on it. ADR-012 §Negative documents the trade-off; the production
  position is "set `baseUrl`."
- Protocol-relative URLs (`'//host/path'`) without `baseUrl` are
  rejected outright by the preloader — there is no static way to know
  the scheme. With `baseUrl` set, they resolve against it and the
  resolved scheme is re-checked.
- Authoring and the local workbench may omit `baseUrl` for browser
  convenience. The production opt-in is at the deployment entrypoint;
  the runtime does not gate the dev/authoring path.

## Allowed schemes

| Scheme | Production posture | Why |
|--------|-------------------|------|
| `https:` | **Allow.** Default for public production. | Cacheable, inspectable by normal deployment controls, no mixed-content risk, no network-layer tampering. |
| `http:` | **Disallow in public production.** Allow only for explicitly local or private deployments that accept transport risk. | Plaintext, mixed-content-blocked in `https:`-served pages, no integrity. |
| `data:` | **Disallow in hardened public production.** Allow only for a documented trusted-inline profile where scene metadata is fully trusted. | Bypasses CDN/origin allowlisting, deployment scanning, cache policy, and stable URL review. |
| `blob:` | **Disallow in hardened public production.** Allow only when scenes assemble their own bytes locally (rare; not the workbench case today). | Same reasoning as `data:` — opaque to deployment controls. |
| `file:` | **Forbid.** | Local filesystem exposure. |
| `javascript:` | **Forbid.** | Code execution surface; not a fetch URL. |
| `ftp:`, `gopher:` | **Forbid.** | Not how production assets are delivered; legacy and unauthenticated. |
| `ws:`, `wss:` | **Forbid.** | Not byte-warming targets; the preloader's contract is `fetch` + drain. |

The default `DEFAULT_ALLOWED_SCHEMES` constant
(`['http:', 'https:', 'data:', 'blob:']`) is the authoring default and
MUST NOT be mutated to express a production deployment choice — the
constant is shared by validation, audio, and any future surface, and
tightening it globally would break authoring. Entrypoints opt in by
passing an explicit `allowedSchemes` array.

## Credentialed `fetch` and third-party origins

`AssetPreloaderOptions.init` is forwarded to **every** `fetch` call
for the scene. That makes shared `init.headers` and
`credentials: 'include'` a global property of the per-scene preload,
not a per-URL property.

Production rules:

- **DO NOT** attach `Authorization`, `Cookie`, or other
  credential-bearing headers via `init.headers` when **any** asset in
  the deployment can resolve to a third-party origin. Browsers and
  Node will send those credentials to every absolute URL the
  preloader fetches.
- **DO NOT** set `credentials: 'include'` via `init` when third-party
  assets are possible. CORS will block most of these anyway, but the
  intent must be wrong if the deployment relies on the block.
- **DO** bind credentials per destination URL by passing a custom
  `fetch` to `AssetPreloaderOptions.fetch`. The custom function
  inspects the request URL, attaches credentials only for same-origin
  or an explicit allowlist, and refuses (or strips) for everything
  else. The preloader treats the returned `Response` the same as
  default `fetch`'s.

```ts
const ALLOWED_CREDENTIALED_ORIGINS = new Set([
  'https://assets.example.com',
]);

const guardedFetch: typeof fetch = (input, init) => {
  // Pull the request URL out of every shape the Fetch API accepts.
  // `Request.toString()` is "[object Request]" — use `request.url`;
  // `URL.toString()` happens to work, but `URL.href` is the explicit
  // contract.
  const requestUrl =
    input instanceof Request
      ? input.url
      : input instanceof URL
        ? input.href
        : input;
  const url = new URL(requestUrl);
  if (!ALLOWED_CREDENTIALED_ORIGINS.has(url.origin)) {
    return fetch(input, { ...init, credentials: 'omit', headers: undefined });
  }
  return fetch(input, init);
};
```

Production deployments that need credentialed asset delivery pass this
shape (or an equivalent) as `AssetPreloaderOptions.fetch`. The shape
of the policy — origin allowlist plus a custom fetch — is the seam
ADR-012 reserves for credential handling; a future preloader option
(`credentialedOrigins`) would formalize it, but the seam works today.

## Redirect handling

The preloader uses the default `redirect: 'follow'` on every fetch
and re-validates the final URL after redirects:

- If `response.url` differs from the requested URL and its scheme is
  not in `allowedSchemes`, the asset rejects with
  `asset "<url>": redirected to disallowed URL "<final>"`. The
  response body is cancelled before throwing (no connection leak).
- Same-scheme redirects (`https:` → `https:`) pass through.

Production rules:

- **DO NOT** downgrade to `redirect: 'manual'` to dodge the post-
  redirect check. The cost of the check is a single string comparison
  per asset; the value is catching `https://allowed.example` → 302 →
  `file:///etc/passwd`.
- **DO NOT** rely solely on the up-front scheme check. Up-front
  validation and post-redirect validation are independent gates;
  removing either weakens the contract.
- If a future surface adds an origin allowlist
  (`AssetPreloaderOptions.allowedOrigins`), it MUST run the same
  up-front + post-redirect pair. The preloader's seam keeps the two
  checks symmetric.

## SSRF caveat (scheme is not host hardening)

`allowedSchemes: ['https:']` blocks transport-layer downgrades — it
does NOT block loopback (`127.0.0.1`), link-local (`169.254.0.0/16`),
RFC 1918 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), the cloud
metadata endpoint (`169.254.169.254`), or any private host that
happens to serve HTTPS.

Production deployments that process **untrusted scene metadata** (a
hosted workbench accepting third-party scenes, a content surface
that reads scene URLs from user input, etc.) MUST also:

- Restrict egress at the network layer — a firewall, security group,
  or sidecar proxy that blocks RFC 1918 / RFC 6890 ranges and the
  cloud metadata endpoint from the host running the preload.
- OR wait for a future `allowedOrigins` option on the preloader and
  apply it once that exists.

For first-party-only deployments where the scene catalog is
deployment-owned, the egress layer is the only defense the project
ships today. The policy doc and ADR-012 name this explicitly so a
contributor reading "we allow `https:`" does not infer host
hardening.

## Validation parity (boot and CI agree with runtime)

The runtime validation pass (`validateRuntime`, `src/runtime/validation.ts`)
accepts the same `assets: { baseUrl, allowedSchemes }` block as the
preloader and runs the same `resolveAssetUrl` rule. Production rules:

- **DO** pass the production `assets` policy to `validateRuntime` at
  boot (`src/main.ts`) and in the CI gate
  (`tests/runtime/workbench-graph.test.ts`). A misconfigured asset
  fails the validation pass before any lifecycle effect rather than
  surfacing as a per-scene preload rejection at the first navigation.
- **DO NOT** let the validator use authoring defaults while the
  preloader uses hardened settings — that produces "passes
  validation, fails on first navigation" inconsistency.

## Diagnostics envelope (what the policy is allowed to log)

Per ADR-012's error semantics, asset failures aggregate per scene into
a single `AggregateError` whose per-asset messages name the offending
URL (and the resolved URL when different). Production diagnostics:

- **DO** keep the existing message grammar:
  `asset "<url>": ...` or `asset "<url>" → "<resolved>": ...`.
- **DO NOT** include request headers, cookies, Authorization values,
  full response objects, stack traces, environment values, raw scene
  metadata, or DOM nodes in diagnostics. The preloader already
  honors this rule; a custom `fetch` MUST too.
- **DO NOT** pass credential-bearing URLs through process argv, shell
  commands, filenames, CI annotations, or artifacts. Tests use
  injected fake fetches and in-memory policy objects (see
  `tests/runtime/asset-preloader.test.ts`).

## Existing structural gates (what the runtime already enforces)

Each policy rule above is anchored by an executable check the project
already ships. If any of these regress, the policy claim regresses
with them.

| Policy rule | Runtime gate |
|-------------|--------------|
| Scheme allowlist enforced before fetch | `tests/runtime/asset-preloader.test.ts` "scheme allowlist (SSRF defense)" — `file:`, `gopher:`, tightened `['https:']`, baseUrl-resolved scheme re-check (`:548-606`) |
| Post-redirect scheme re-validation | `tests/runtime/asset-preloader.test.ts` "post-redirect URL re-validation" — redirect to `file:` rejected, same-scheme redirect accepted (`:251-291`) |
| Protocol-relative URLs without `baseUrl` rejected | `tests/runtime/asset-preloader.test.ts` "protocol-relative URLs" (`:293-307`) |
| `baseUrl` resolution + resolved-scheme re-check | `tests/runtime/asset-preloader.test.ts` "baseUrl resolution (Node-portable)" (`:499-528`) |
| Validation pass mirrors preloader policy | `tests/runtime/validation.test.ts` asset-resolvable checks share `resolveAssetUrl` and `DEFAULT_ALLOWED_SCHEMES` |
| Audio source policy reuses scheme allowlist | `src/runtime/audio.ts` resolves audio source URLs through `resolveAssetUrl` + `DEFAULT_ALLOWED_SCHEMES` (no copy of the rules) |

## Future extensions (named seams; do not invent parallels)

If a future deployment needs runtime enforcement beyond what
`baseUrl` + `allowedSchemes` + a custom `fetch` cover, extend the
existing `AssetPreloaderOptions` rather than create a parallel asset
configuration system. The named seams ADR-012 reserves:

- `allowedOrigins` — host-level allowlist for first-party and CDN
  origins. The check runs both up front (on `resolveAssetUrl`'s
  output) and post-redirect (on `response.url`) so the gate is
  symmetric with `allowedSchemes`.
- `credentialedOrigins` — explicit destinations allowed to receive
  `Authorization`, cookies, or `credentials: 'include'`. Folds the
  custom-`fetch` pattern documented above into a structural option.
- Shared policy object — `validateRuntime` consumes the same shape
  via `ValidationInput.assets`. Any new field MUST mirror in both
  surfaces so static and runtime gates remain symmetric.

Anti-patterns this doc rules out (per preflight):

- `ProductionAssetPreloader`, `AssetPolicyValidator`, or a parallel
  exception hierarchy.
- A new asset manifest, scene DTO, configuration loader, env-binding
  layer, deployment CLI, or telemetry surface.
- Mutating `DEFAULT_ALLOWED_SCHEMES` to express a deployment choice.
- Banning relative asset strings in `scene.assets` — production
  strictness belongs in `baseUrl` + policy options, not authoring
  metadata.
- Encoding production policy in scene modules (any per-scene
  `assets: { allowedSchemes: ... }` field).
- Treating `data:`/`blob:` as "safe because no network." They bypass
  deployment controls and remain opt-in for trusted profiles.

## Related

- [ADR-012 — asset preloader fetch + drain](adrs/012-asset-preloader-fetch-and-drain.md)
- [Issue #101 preflight](design/issue-101-production-asset-policy-preflight.md)
- [`docs/scene-trust-model.md`](scene-trust-model.md) — scene module
  trust model. Asset URL policy is a URL and credential gate; it is
  not a sandbox for scene code. Untrusted scene-module execution is a
  separate, currently-non-existent surface tracked there.
- `src/runtime/asset-preloader.ts` — `createAssetPreloader`, `resolveAssetUrl`, `DEFAULT_ALLOWED_SCHEMES`.
- `src/runtime/validation.ts` — `validateRuntime`, `ValidationInput.assets`.
