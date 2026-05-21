# PUL-A010 Live And Export Metadata Preflight

PUL-A010 is an architectural constraint: any export pipeline consumes
the same scene metadata and composition manifests as the live runtime.
Export metadata may adapt canonical runtime data for a render target,
but it must not become an authoring source that replaces or shadows
live-runtime metadata.

ADR-006 establishes Remotion as a parallel export path, not the live
runtime. ADR-002 establishes scenes and composition manifests as the
shared model. PUL-A004 already keeps Remotion imports out of runtime
core. This note pins the repo-wide guardrails for the future exporter;
it does not implement export.

## Boundary

- `src/runtime/scene.ts` owns `SceneModule`, `Caption`, `assets`,
  `audio`, `duration`, `tags`, `trailerSafe`, and
  `assertSceneModule()`. Exporters read this contract; they do not
  define `ExportScene`, `RenderScene`, or a parallel metadata schema.
- `src/runtime/composition.ts` owns `CompositionManifest`,
  `CompositionEntry`, `CompositionEntryOverride`, `range`,
  `behavior`, `entryId()`, `findUnregisteredEntries()`, and
  `assertCompositionManifest()`. Export cuts are manifests or
  manifest-derived slices, not exporter-owned sequencing scripts.
- `src/runtime/registry.ts` and
  `src/runtime/composition-registry.ts` own registration,
  uniqueness, id lookup, and frozen snapshots. Export code must build
  from registered scene/composition declarations, not ad hoc maps.
- `src/workbench-graph.ts` is the current application graph: one
  place names the concrete scenes and compositions the browser and CI
  validation consume. A future exporter needs an equivalent composition
  root or workspace entrypoint that imports the same scene modules and
  composition modules, then passes through the same registry and
  validation gates.
- `src/runtime/validation.ts` owns structural graph validation for raw
  scene modules plus composition registrations. Export preflight should
  call it with exporter asset policy options; it must not invent an
  exporter-only validator.
- `src/runtime/asset-preloader.ts` owns URL resolution and scheme
  allowlisting. Export asset handling may provide a different
  `baseUrl`, `allowedSchemes`, or fetch/decode adapter, but it must
  reuse `resolveAssetUrl()` semantics or explicitly extend that seam.
- `src/runtime/composition-resolver.ts` and
  `src/runtime/scene-navigation.ts` own lifecycle orchestration and
  resolved composition slices. Export may reuse their pure manifest
  and adapter seams where lifecycle execution is needed, but export
  must not make those runtime modules import Remotion.

## Required Reuse

Implementation must build on these canonical incumbents:

- Metadata schema: `SceneModule`, `Caption`, `assertSceneModule()`,
  `isSceneModule()`, `sceneDeclaresAudio()`, `isKebabIdentifier()`,
  and `KEBAB_IDENTIFIER_FORM`.
- Composition schema: `CompositionManifest`,
  `CompositionEntryOverride`, `assertCompositionManifest()`,
  `entryId()`, `findUnregisteredEntries()`, and frozen manifest
  snapshots from `createCompositionRegistry()`.
- Registry and graph wiring: `createSceneRegistry()`,
  `createCompositionRegistry()`, `IdRegistry`, and
  `src/workbench-graph.ts` as the current canonical app graph.
- Validation and asset policy: `validateRuntime()`,
  `ValidationCompositionInput`, `resolveAssetUrl()`,
  `DEFAULT_ALLOWED_SCHEMES`, and `AssetPreloaderOptions` policy
  fields.
- Runtime/export boundary policy: ADR-006, ADR-009 workspace
  migration guidance, PUL-A004's source-policy gate in
  `tests/runtime/policy-a004-export-pipeline.test.ts`, and shared
  scanner helpers in `tests/runtime/source-policy.ts`.
- Error and observability: `describeError()`,
  `describeErrorDetailed()`, `formatSceneContext()`, structured
  `Finding` rows, and existing bounded diagnostic conventions.

Do not add a second scene metadata schema, composition DTO,
validation stack, exception hierarchy, logging surface, persistence
layer, workflow controller, or registry abstraction for export.

## Cross-Cutting Layers

| Layer | Guardrail |
|-------|-----------|
| Scene schema gate | Exporter inputs pass through `assertSceneModule()` by building a `SceneRegistry` from the same scene modules the live runtime uses. Export adapters may project fields, but they cannot accept fields that are invalid for live runtime. |
| Composition schema gate | Exporter compositions pass through `assertCompositionManifest()` and `createCompositionRegistry()`. Trailer/social cuts may be separate manifests, but their entries still reference canonical scene ids and object-form `range` / `behavior`; no `ExportComposition` grammar. |
| Registry boundary | Registries remain id-keyed and frozen. Export code must not hold mutable scene maps, normalize scenes into an editable cache, or resolve ids by filesystem path, import order, or array position. |
| Runtime validation | Export preflight should call `validateRuntime()` against the actual export graph before render. It stays pure: no scene lifecycle hooks, DOM, network fetch, Remotion render, browser storage, env, or argv reads. |
| URL / navigation | Export target selection is not URL grammar. If an export needs a composition slice, derive it from the manifest and `entryId()` / registry checks; do not add export-only URL parameters, localStorage fallbacks, or history state. |
| Lifecycle orchestration | Live presentation owns `create` / `timeline` / `cleanup` execution through `scene-loader`, `scene-navigation`, and `composition-resolver`. Remotion render components are export adapters; they must not replace live lifecycle hooks or force Remotion into runtime core. |
| Asset / network | Export asset resolution must reuse `resolveAssetUrl()` policy. Headless/Node export must pass an explicit `baseUrl`; surfaces processing untrusted metadata need deployment-level egress controls or a future origin allowlist, because scheme allowlisting alone does not block private-network hosts. |
| Audio | Audio source truth remains `scene.audio` as a subset of `scene.assets` plus the existing audio policy. Export may render/mix audio differently, but it must not maintain an exporter-only audio inventory. |
| Auth / secrets / env / config | PUL-A010 itself needs no auth, cookies, browser storage, tokens, secret files, or new env vars. If a future render service needs credentials, bind them at the exporter adapter/config boundary and keep them out of scene metadata, manifests, public diagnostics, and runtime core. |
| OS-level exposure | Do not pass full scene metadata, captions, manifests, credentials, or render payloads through process argv, filenames, CI annotations, or shell commands. Use in-memory module imports or bounded config references; argv may carry ids or paths only when a future exporter defines that CLI contract. |
| Error envelope | Diagnostics may name scene ids, composition ids, entry indexes, field names, asset URLs, and rule names. They must not dump raw scene objects, full captions, manifest JSON blobs, DOM nodes, stacks, headers, cookies, env, auth values, or render-service payloads. |
| Observability | Reuse structured validation findings and existing diagnostic renderers. Do not add per-scene metadata dumps, exporter-only log schemas, analytics, telemetry, or a second workbench event stream. |
| Source policy / CI | Keep PUL-A004 active: runtime core does not import `remotion`, `@remotion/*`, or video rendering libraries. A future exporter belongs in a separate workspace/package or sibling codebase and should add source-policy coverage for any new boundary it creates. |

## Extensibility

The required seam is a read-only metadata adapter over the canonical
scene/composition graph:

- Export target variation belongs on the adapter input, e.g.
  `compositionId`, optional manifest slice, output profile, FPS,
  dimensions, asset `baseUrl`, and allowed schemes.
- New metadata fields that both live runtime and export need belong on
  `SceneModule` or `CompositionEntryOverride`, with validation in
  `assertSceneModule()` / `assertCompositionManifest()`.
- Export-only render options belong in exporter adapter config or
  Remotion component props derived from canonical data, not on scene
  modules or composition manifests unless the live runtime also needs
  the field.
- If multiple consumers need the same projection (for example an
  export-safe scene descriptor), put one pure helper next to the
  canonical runtime type it projects from. Do not let exporter,
  prompter, validation, and tests each infer the projection
  independently.

This leaves room for multiple output profiles, trailer-specific
composition manifests, asset base URL differences, render-service
credentials, and Remotion workspaces without re-editing the canonical
scene or composition contracts for each artifact.

## Gotchas And Anti-Patterns

- Do not add `exportMetadata`, `remotionMetadata`, `renderManifest`,
  `exportCaptions`, `exportAssets`, `videoDuration`, or
  `exportAudio` fields that duplicate existing scene metadata.
- Do not copy scene metadata into a generated JSON file, Remotion
  module, browser storage value, CI artifact, or render-service
  payload that authors edit directly.
- Do not create `ExportScene`, `RenderScene`, `SceneDTO`,
  `ExportComposition`, `RenderManifest`, zod/AJV schemas, or
  exporter-specific errors parallel to the runtime validators.
- Do not make runtime core import Remotion or video rendering
  libraries. PUL-A004's import ban is the guardrail.
- Do not let export-specific rendering needs mutate live composition
  manifests, reorder manifests imperatively, or encode exporter
  branches in composition modules.
- Do not bypass `scene.audio` / `scene.assets` by sniffing file
  extensions, DOM state, Howler state, Remotion component props, or
  network responses.
- Do not serialize captions or full manifests into process argv,
  filenames, logs, CI annotations, or public error messages.
- Do not treat `trailerSafe` as an export manifest. It is metadata a
  selector may consult; it does not replace explicit composition
  membership.

## Non-Goals

PUL-A010 does not implement Remotion, video rendering, workspace
migration, render-service integration, export CLI commands, asset
uploading, decode-complete checks, audio mixing, frame-accurate live
timeline capture, persistence, auth, telemetry, new URL grammar,
caption export, composition authoring UI, or requirement status
transition.

It should not change scene metadata shape, composition manifest shape,
live runtime lifecycle ordering, workbench modes, existing source
policy gates, CI workflow topology, error envelopes, logging,
persistence, or the Ground Control workflow unless a future export
requirement explicitly changes those contracts.
