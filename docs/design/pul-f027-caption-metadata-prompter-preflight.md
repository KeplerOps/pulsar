# PUL-F027 Caption Metadata And Prompter Preflight

PUL-F027 widens the caption timestamp grammar: each scene still
declares `captions` in scene metadata, but each caption's `at` value
may be either a non-negative integer millisecond offset or a named
beat label. The runtime prompter view continues to derive from that
same metadata. This is a scene-schema refinement, not a new prompter
data source, timeline cue system, or composition override.

The existing architecture already supplies the right boundaries:
`SceneModule` metadata is canonical (ADR-002 / ADR-008), GSAP labels
are canonical beats (ADR-026), and `buildPrompterScript()` aggregates
scene metadata for `mode=prompter` without mounting scenes (ADR-022).

## Boundary

- `src/runtime/scene.ts` owns the `Caption` type and
  `assertSceneModule()` validation. Widen `Caption.at` at this
  boundary only; downstream consumers must reuse that type.
- `src/runtime/registry.ts` and `src/runtime/scene-loader.ts` must
  continue to rely on the scene-schema gate instead of duplicating a
  caption validator.
- `src/runtime/prompter.ts` remains a pure aggregation seam over an
  already resolved `SceneNavigationTarget`. It must copy captions
  structurally from scene metadata and must not invent a prompter-only
  caption schema.
- `src/runtime/timeline.ts` remains the canonical beat-label boundary.
  Caption beat labels use the same kebab-case rule as timeline labels,
  URL `beat=`, composition `range`, scenes, compositions, and assets.
- `src/runtime/navigation.ts` is out of scope except for preserving
  the existing URL `beat=` semantics. Caption metadata must not add a
  URL query key or alter navigation parsing.
- Composition manifests do not carry caption overrides. Object-form
  entries may expose `range` / `behavior` to the prompter script as
  entry metadata, but caption text and `at` values come from the
  registered scene module.

## Required Reuse

Implementation must build on these incumbents:

- Scene metadata and validation: `Caption`, `SceneModule`,
  `assertSceneModule()`, `isSceneModule()`, `isPlainRecord()`.
- Identifier grammar: `isKebabIdentifier()` and
  `KEBAB_IDENTIFIER_FORM`; do not copy or loosen the regex for
  caption beat labels.
- Registry validation: `createSceneRegistry()` remains the scene
  boundary that calls `assertSceneModule()`.
- Navigation and target resolution: `parseNavigationSearch()`,
  `NavigationTarget.beat`, `effectiveMode()`,
  `resolveSceneNavigation()`, and `SceneNavigationTarget`.
- Prompter aggregation: `PrompterScript`, `PrompterScriptEntry`,
  `buildPrompterScript()`, `PrompterRenderer`, `PrompterDispose`,
  and the loader's `renderPrompter` path.
- Timeline beat validation and lookup: `assertSceneTimeline()`,
  `MasterTimeline`, `MasterBeat`, `sceneTimelineLabel()`,
  `parseSceneTimelineLabel()`, and `createGsapCompositionTimeline()`.
- Error and diagnostics: `describeError()`, the loader `onError`
  sink, and existing stage attrs. Validation errors should identify
  the caption index / field and rule; avoid echoing full caption text.
- Tests and tooling: Vitest boundary tests under `tests/runtime/*`,
  `pnpm test`, `pnpm typecheck`, and `pnpm lint` using the existing
  `vitest.config.ts`, `tsconfig.json`, and `biome.json`.

## Cross-Cutting Layers

| Layer | Guardrail |
|-------|-----------|
| Scene schema gate | `assertSceneModule()` is the only runtime shape-check for captions. `at` accepts finite non-negative integer milliseconds or a kebab-case beat label string. Reject floats, negative numbers, `NaN`, `Infinity`, empty strings, and non-kebab labels. A digit-only label such as `"1000"` is a *valid* beat label because the shared ADR-008 #1 kebab grammar accepts it — caption schema does not invent a stricter sub-grammar (see Gotchas). Per-caption errors must identify the caption index and the failing field (`captions[N].at must be ...`). |
| Registry boundary | Registries continue to validate scene modules once and freeze snapshots. Do not add registry-local caption parsing or a second caption DTO. |
| Timeline / beat boundary | Caption beat labels share the timeline label grammar, but scene-schema validation must not run timelines merely to prove label existence. A future authoring lint may compare caption labels to `MasterTimeline.beats()` through the timeline seam. |
| Prompter data path | `buildPrompterScript()` derives directly from scene `captions` and carries `at` through unchanged. It should not sort, coerce, resolve, drop, or split captions based on whether `at` is numeric or a beat label unless a later requirement defines that view policy. |
| DOM rendering / security | Caption `text` is user-authored content. Any visible prompter renderer must render it as text, not HTML; use `textContent` / framework text binding and never `innerHTML` from caption text. |
| URL / auth surface | PUL-F027 adds no URL grammar, remote input, auth, cookie, localStorage, sessionStorage, or `history.state` surface. URL `beat=` remains navigation state, not caption metadata. |
| Asset / network surface | Captions must not cause asset discovery, dynamic imports, fetches, or audio loads. Asset loading remains only `scene.assets` through `createAssetPreloader()` and audio source allowlists. |
| Error envelope | Caption schema failures should keep the existing `scene "<id>" is invalid:` style and flow through registry / loader diagnostics. Do not introduce a caption exception hierarchy or leak full script content through errors. |
| Config / env / OS exposure | No env vars, config files, process argv flags, shell commands, filesystem reads, or persisted browser state are needed for caption metadata. Do not expose prompter content through process arguments or logs. |
| Observability | Reuse stage diagnostics and `onError`. Do not add per-caption console logging, analytics, or script dumps before the repo has a telemetry/redaction policy. |

## Extensibility

The extension seam is the `Caption.at` type in `src/runtime/scene.ts`
plus any small caption-time classifier needed by multiple consumers.
If more than one module needs to distinguish millisecond offsets from
beat labels, put one helper next to `Caption` and parameterize it by
the consumer's policy rather than letting prompter UI, exporters, and
tests each infer the union differently.

Future caption UI features such as sorting, active-line highlighting,
beat-click seeking, caption export, speaker labels, or localized text
must extend the scene metadata / prompter-script seam without creating
a second caption store. Beat-aware features resolve labels through the
timeline seam after a scene timeline exists; they do not make the URL
parser, registry, or prompter aggregator import GSAP or inspect
timeline internals.

## Gotchas And Anti-Patterns

- Do not coerce a string `Caption.at` into a number. A string `at` is
  always a beat label, never milliseconds — even when its characters
  happen to be all digits (`"1000"` is the label `1000`, not 1000 ms).
  The validator MUST accept any string that satisfies the shared
  ADR-008 #1 kebab identifier rule (`isKebabIdentifier`) — caption
  schema does not invent a stricter sub-grammar than timeline labels,
  URL `beat=`, composition `range`, or asset ids.
- Do not validate caption beat existence in `assertSceneModule()` by
  running `timeline(ctx)`. That would move lifecycle side effects into
  metadata validation.
- Do not add `captions` to composition entries, workbench URLs,
  presenter commands, local storage, or a separate prompter manifest.
- Do not normalize all captions to milliseconds in the prompter path;
  labels are authored metadata and must remain visible to consumers.
- Do not parse namespaced master labels in the prompter. Caption labels
  are scene-local; master namespacing is runtime transport state.
- Do not filter captions by composition `range` until a requirement
  defines label-to-caption filtering semantics. Existing prompter tests
  pin full scene captions with entry `range` / `behavior` carried as
  optional metadata.
- Do not render caption text as HTML, include it in error messages, or
  dump full scripts to logs.
- Do not create `CaptionError`, `CaptionSchema`, `PrompterCaption`, or
  an exporter-only caption DTO unless a real second boundary appears.

## Non-Goals

PUL-F027 does not implement a visible prompter UI, teleprompter
scrolling, caption editing, caption persistence, localization,
speaker attribution, caption export, beat-click navigation, label
existence linting, presenter overlays, audio cues, timeline authoring,
composition caption overrides, new URL parameters, remote protocols,
auth, analytics, or requirement status transition.

It should not add a new registry, repository, workflow controller,
configuration surface, exception hierarchy, validation library, asset
inventory, or persistence format.
