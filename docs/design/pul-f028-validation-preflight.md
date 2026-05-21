# PUL-F028 Validation Preflight

PUL-F028 adds a runtime validation pass for structural authoring
breakage: composition entries that reference unregistered scenes,
asset URLs declared in scene metadata that cannot be resolved,
duplicate scene ids, and scene modules that do not export
`cleanup(ctx)`.

This is an orchestration layer over existing contracts. It is not a
second scene schema, second composition schema, registry replacement,
asset preloader clone, CLI-only linter, or workflow controller. The
validator should make the current runtime boundaries inspectable
before lifecycle effects begin.

## Boundary

- `src/runtime/scene.ts` remains the scene module contract. The
  validation pass must reuse `assertSceneModule()` for required
  fields, including `cleanup`.
- `src/runtime/registry.ts`, `src/runtime/composition-registry.ts`,
  and `src/runtime/id-registry.ts` remain the canonical id-keyed
  registry boundaries. Duplicate scene ids are detected by the same
  `createSceneRegistry()` / `createIdRegistry()` behavior, not by a
  parallel map with different error grammar.
- `src/runtime/composition.ts` remains the composition-manifest format
  and reference helper. Use `assertCompositionManifest()`,
  `entryId()`, and `findUnregisteredEntries()` for composition
  reference checks.
- `src/runtime/asset-preloader.ts` remains the asset URL resolution
  and scheme-policy boundary. Asset validation must reuse
  `resolveAssetUrl()` and the same `allowedSchemes` / `baseUrl`
  semantics the preloader and audio service use.
- `src/runtime/composition-resolver.ts`, `src/runtime/scene-navigation.ts`,
  and `src/runtime/scene-loader.ts` remain lifecycle/navigation
  layers. Validation may run before them, but it must not move scene
  mounting, asset fetching, timeline creation, navigation dispatch, or
  cleanup ownership into the validation pass.

## Required Reuse

Implementation must build on these incumbents:

- Scene schema: `SceneModule`, `assertSceneModule()`,
  `isSceneModule()`, `isPlainRecord()`, `isKebabIdentifier()`, and
  `KEBAB_IDENTIFIER_FORM`.
- Registry behavior: `createSceneRegistry()`, `SceneRegistry`,
  `createIdRegistry()`, frozen `ids()` snapshots, and existing
  duplicate-id messages.
- Composition schema and references: `CompositionManifest`,
  `assertCompositionManifest()`, `entryId()`, and
  `findUnregisteredEntries()`.
- Asset policy: `scene.assets`, `resolveAssetUrl()`,
  `DEFAULT_ALLOWED_SCHEMES`, `AssetPreloaderOptions.baseUrl`, and
  `AssetPreloaderOptions.allowedSchemes`.
- Error rendering and diagnostics: `describeError()`, existing
  `Error` / `AggregateError` style, loader `onError`, and
  `data-pulsar-navigation-error` where validation is surfaced through
  the workbench.
- Tests and tooling: Vitest suites under `tests/runtime/*`,
  `pnpm test`, `pnpm typecheck`, and `pnpm lint`.

## Cross-Cutting Layers

| Layer | Guardrail |
|-------|-----------|
| Scene schema gate | `assertSceneModule()` is the only shape-check for scene modules. A missing or non-function `cleanup` keeps the existing `scene "<id>" is invalid: cleanup ...` grammar. Do not add `CleanupError` or a second required-field table. |
| Scene id registry | Duplicate scene ids must use the id-registry construction path so uniqueness, insertion order, `ids()` snapshots, and frozen surfaces stay identical to normal runtime boot. |
| Composition schema gate | Validate manifest shape with `assertCompositionManifest()` before checking references. Do not let a malformed object-form entry reach registry lookup and produce a misleading "missing scene" error. |
| Composition reference check | Use `findUnregisteredEntries()` to aggregate every dangling scene id in declaration order. Error text should name the composition id, scene id, and entry index. |
| Asset URL policy | Asset resolvability means resolving each `scene.assets` value through `resolveAssetUrl(asset, baseUrl, allowedSchemes)`. Honor the same protocol-relative, relative-without-`baseUrl`, invalid-URL, and scheme-allowlist semantics as the preloader. Do not copy the URL parser. |
| Network / filesystem security | Core validation must not fetch, stream-drain, import, read arbitrary files, or probe the network just to validate metadata. If a future local-file or CDN existence check is required, add it as an injected resolver with explicit policy. |
| Audio source policy | Audio already reuses `scene.assets` and `resolveAssetUrl()` through `audio.ts`. Do not add an `audioAssets` field or a separate audio validation inventory. |
| Timeline / lifecycle | Validation must not call `scene.create(ctx)`, `scene.timeline(ctx)`, or `scene.cleanup(ctx)`. Timeline beat validation remains `assertSceneTimeline()` when the lifecycle creates a timeline; PUL-F028 is structural metadata validation. |
| URL / mode / auth surface | No new URL key, workbench mode, presenter command, auth gate, cookie, localStorage, sessionStorage, or history-state rule is needed. Validation is not navigation parsing. |
| Config and env binding | The only asset-policy parameters should mirror the existing preloader shape: `baseUrl` and `allowedSchemes`. Do not add env vars, process argv flags, hidden config files, or persistent browser state for this requirement. |
| OS-level exposure | Asset paths, source URLs, captions, headers, tokens, and registry objects must not be passed through process argv or shell commands. Browser/runtime validation should stay in memory; any future CLI wrapper must pass options through typed config, not argv secrets. |
| Error envelope and leakage | Diagnostics should be actionable and bounded: ids, composition ids, entry indexes, asset string, resolved URL when relevant, and rule violated. Do not dump raw scene objects, request headers, cookies, authorization values, or full captions. |
| Observability | Surface validation failures through the same workbench error sink and stage diagnostic path when invoked from the browser. Avoid scattered `console.log` output or a new logging framework. |

## Validation Contract

The pass should inspect the same declarative inputs the runtime uses:
the scene module collection, composition registry entries/manifests,
and an optional asset URL policy. It should report structural problems
before preload, mount, timeline composition, presenter input, audio
playback, or cleanup side effects.

The pass may choose a throwing or diagnostic-list API, but it must keep
one canonical normalization path. If it reports multiple failures, use
the repo's existing aggregate-error style or a small diagnostic value
owned by the validation module; do not expose subsystem-specific
private objects or introduce parallel exception hierarchies.

## Extensibility

The required seam is the asset resolver policy. Keep it parameterized
with the same knobs the preloader already has: `baseUrl` and
`allowedSchemes`. A future offline-export validator can add an
injected existence resolver at that seam without changing scene
metadata, composition manifests, registries, or the browser loader.

If multiple callers need validation output in different shapes
(browser error, CI summary, JSON report), keep collection separate
from rendering. The canonical validation pass should produce stable
findings; adapters format them for the workbench or CI.

## Gotchas And Anti-Patterns

- Do not implement validation by running the scene lifecycle. That
  turns a structural check into rendering, network, audio, and cleanup
  behavior.
- Do not build new scene/composition DTOs. The runtime already has the
  contracts and validators.
- Do not copy the kebab-case regex, manifest entry parsing, duplicate
  id map, or asset scheme logic.
- Do not validate only the active URL target. PUL-F028 is about the
  registered runtime graph, not the currently navigated scene.
- Do not flatten object-form composition entries or drop `range` /
  `behavior` while checking references; use `entryId()`.
- Do not silently accept malformed composition manifests and then
  report missing scenes from bad shapes.
- Do not fetch assets in the core validator. Fetching belongs to the
  preloader; validation should be deterministic and cheap.
- Do not add an asset inventory separate from `scene.assets`.
- Do not mark missing `cleanup` as a warning. `cleanup` is mandatory
  scene schema and lifecycle policy.
- Do not create a new logging, exception, config, auth, persistence, or
  workflow subsystem for this pass.

## Non-Goals

PUL-F028 does not implement a CLI UX, CI workflow, requirement status
transition, GitHub automation, asset downloading, file existence
probing, CDN health checks, image/audio decode checks, timeline beat
existence linting, screenshot regression, scene rendering, presenter
controls, auth, persistence, telemetry, or a new validation library.

It should not change scene metadata, composition manifest shape,
navigation URL grammar, workbench modes, timeline transport, audio
service behavior, registry mutability, or lifecycle ordering.
