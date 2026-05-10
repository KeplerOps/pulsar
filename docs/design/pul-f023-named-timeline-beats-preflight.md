# PUL-F023 Named Timeline Beats Preflight

PUL-F023 names the shared time grammar: scene timelines support named
labels (beats) referenceable by URL, presenter input, and other runtime
subsystems. Existing ADRs already decide the core boundary: GSAP labels
are the canonical beat source (ADR-003, ADR-008), URL `beat=` is
timeline-runner state (ADR-015), and the GSAP adapter owns the master
timeline label surface (ADR-025).

## Boundary

Implementation must keep beats on the existing navigation / lifecycle /
timeline path:

- `src/runtime/navigation.ts` owns URL grammar shape. It validates
  `beat=` as a kebab identifier and valid parameter combination only.
  It must not inspect scene modules, GSAP timelines, registries, or
  master labels.
- `src/runtime/scene-loader.ts` owns defensive grammar checks for
  hand-built `NavigationTarget` values, stage diagnostics, `onError`,
  per-navigation abort, and mode dispatch. Missing URL beats remain
  non-fatal positioning diagnostics.
- `src/runtime/scene-navigation.ts` owns scene/composition target
  resolution and snapshotting. It forwards beat input without label
  lookup.
- `src/runtime/composition-resolver.ts` owns lifecycle ordering,
  cleanup, and error envelopes. It forwards `headBeat` /
  `onBeatMissing` to the timeline adapter; resolver rejection remains
  reserved for lifecycle or adapter failures.
- `src/runtime/timeline.ts` is the canonical beat-resolution boundary.
  Scene-local GSAP labels are copied to the master under deterministic
  namespaced labels with `sceneTimelineLabel()` / `labelFor()`. Runtime
  subsystems consume the `MasterTimeline.labels` snapshot, `hasLabel()`,
  `seek()`, and `labelFor()` rather than reaching into GSAP directly.
- `src/runtime/presenter.ts` owns presenter command shape validation.
  Presenter commands that need an explicit beat target must extend the
  existing `PresenterCommand` discriminator and validate any beat
  payload at this same boundary; do not add a second presenter event
  schema.

## Required Reuse

Use the canonical incumbents:

- Identifier rule: `isKebabIdentifier()` and `KEBAB_IDENTIFIER_FORM`.
- URL grammar: `parseNavigationSearch()`, `NavigationTarget.beat`,
  loader-side `validateBeatGrammar`, `NAVIGATION_MODES`,
  `effectiveMode()`.
- Scene schema: `SceneModule`, `assertSceneModule()`,
  `createSceneRegistry()`. Do not add scene metadata solely to list
  beats.
- Composition schema: `SubRange`, `assertCompositionManifest()`,
  `entryId()`, `findUnregisteredEntries()`,
  `createCompositionRegistry()`. `range` stays label-shaped metadata;
  label existence is adapter/runtime state, not manifest validation.
- Timeline adapter: `createTimelineEngine()`, `assertSceneTimeline()`,
  `composeMasterTimeline()`, `MasterTimeline`, `sceneSegmentLabel()`,
  `sceneTimelineLabel()`, `createGsapCompositionTimeline()`.
- Presenter seam: `PRESENTER_COMMAND_KINDS`,
  `isPresenterCommand()`, `createPresenterController()`,
  loader-scoped `presenterCommands`.
- Error and observability: `describeError()`, existing stage attrs
  (`data-pulsar-scene-target`, `data-pulsar-composition-target`,
  `data-pulsar-navigation-error`), and the loader `onError` sink.
- Tests: Vitest seam tests under `tests/runtime/*`, split by boundary
  when coverage grows. Keep URL/loader/bridge/resolver/timeline tests
  distinct.

## Cross-Cutting Layers

| Layer | Guardrail |
|-------|-----------|
| URL input | `beat=` is an identifier, not a path, module name, resource URL, or script. Repeated grammar keys and invalid combinations stay rejected before lifecycle side effects. |
| Presenter input | Workbench or remote presenter code emits through `PresenterCommandSource`; the controller shape-checks before the runner sees commands. If a future command carries a beat, validate it with `isKebabIdentifier()` in `presenter.ts`. Remote auth/policy belongs before the source. |
| Scene validation | `assertSceneModule()` remains the only scene-shape gate. Beats live in the returned GSAP timeline labels, not a duplicate `beats` field. |
| Composition validation | `assertCompositionManifest()` validates `range` shape only. It must not build timelines or prove label existence. |
| Timeline validation | `assertSceneTimeline()` rejects non-GSAP returns; `MasterTimeline.seek()` rejects unknown labels/non-finite times; missing URL beats use `onBeatMissing`, not adapter rejection. |
| Asset/security | Beats must not trigger undeclared fetches, dynamic imports, or asset discovery. Asset loading remains `scene.assets` through `createAssetPreloader()` with scheme and redirect checks. |
| Error envelopes | Navigation errors keep `scene navigation failed:` / grammar prefixes. Lifecycle failures keep `composition resolution failed:` with causes. Missing URL beat diagnostics stay non-fatal and use the stage error attr plus `onError`. |
| Config/env/OS | No env vars, config files, process argv flags, browser storage, cookies, or history state are needed for beat state. Do not persist current beat or presenter target outside the active runtime unless a future requirement says so. |
| Observability | Use stage diagnostics and `onError`; do not add per-frame or per-command label logging without a telemetry policy. |

## Guardrails

- Treat authored beats as scene-local GSAP labels. Master labels are
  runtime namespaced labels; use helper functions instead of string
  concatenation.
- Keep URL `beat` head-scoped per ADR-015. It does not search later
  composition entries and does not rewrite the composition slice.
- Do not expose automatic segment-start labels (`scene-a`,
  `scene-a#1`) as authored beats unless a future requirement
  explicitly asks for scene-entry anchors. They are transport anchors.
- If a subsystem needs an ordered or filtered beat list, derive it in
  `src/runtime/timeline.ts` from the master labels and namespace
  helpers. Do not make every subsystem parse label strings locally.
- Presenter advance / hold / skip / pause / resume remain transport
  commands. Translation to `MasterTimeline.play()`, `pause()`,
  `seek()`, or GSAP `tweenTo()` belongs in the timeline adapter /
  runner, not in the controller, loader, scene, or URL parser.
- Missing URL beat: surface one non-fatal diagnostic, stay at frame 0,
  keep the scene mounted until normal completion or abort.
- Invalid command payload or malformed beat from a presenter source:
  drop at the controller boundary and report through `onError`; do not
  unmount the scene to report input validation.
- Repeated scene ids require occurrence-aware labels
  (`sceneTimelineLabel(scene, beat, occurrence)`). Do not assume the
  first occurrence if future repeated-entry activation support lands.

## Extensibility

The extension seam is `MasterTimeline` plus the optional `onMaster`
observer in `createGsapCompositionTimeline()`. Future scrub controls,
presenter HUDs, beat pickers, or automation should consume a
runtime-derived beat view from that seam. If the runtime needs a
first-class beat-list helper, it belongs in `src/runtime/timeline.ts`
and should be parameterized by scene id / occurrence so repeated
entries and head-scoped URL beats stay unambiguous.

Future presenter commands that target a specific beat extend
`PresenterCommand` as a discriminated union in `src/runtime/presenter.ts`
and validate the beat payload there. The runner resolves the validated
payload against the active `MasterTimeline`; the loader only decides
whether presenter input is present for the navigation.

## Non-Goals

- No new URL query key beyond existing `beat=`.
- No `beats`, `labels`, cue, or marker list on `SceneModule`.
- No new registry, manifest schema, persistence format, or authoring UI.
- No label-existence validation in URL parsing, scene registries, or
  composition manifest validation.
- No new exception hierarchy for beats.
- No remote-presenter protocol, auth model, analytics, or telemetry.
- No requirement status transition or traceability changes during this
  preflight.

## Anti-Patterns

- Duplicating the kebab-case regex or beat validators.
- Importing `gsap` directly from scenes or presenter/workbench UI.
- Treating `range`, URL `beat`, presenter `skip`, scrub selection, and
  segment-start labels as interchangeable concepts.
- Throwing through `resolveComposition()` for a missing URL beat.
- Persisting current beat in localStorage/sessionStorage/cookies or
  recovering it from `history.state`.
- Building a scene-side keyboard listener or command pump for beats.
- Letting each subsystem parse namespaced label strings differently.
