# Issue 99 Repeated Scene Activation Context Preflight

Date: 2026-05-21

Issue 99 removes the resolver's temporary "no repeated scene ids in an
active slice" guard. The change is about activation ownership, not a new
scene schema, composition schema, registry model, URL grammar, audio
engine, timeline engine, or workflow.

No new ADR is needed before implementation. Existing ADRs already decide
the model and the relevant seams: scene/composition identity (ADR-002),
GSAP and master timeline ownership (ADR-003 / ADR-025 / ADR-026),
audio through `ctx.audio` (ADR-004 / ADR-029), workbench URL dispatch
(ADR-007 / ADR-013 / ADR-014), cleanup completeness (ADR-008 /
PUL-Q004), and scene-level failure isolation (ADR-028).

## Boundary

- Composition manifests may already reference the same scene id more
  than once. Keep `CompositionManifest`, `assertCompositionManifest()`,
  and `createCompositionRegistry()` unchanged.
- Scene registry uniqueness remains module identity, not activation
  identity. `createSceneRegistry()` must still reject duplicate scene
  modules with the same `scene.id`.
- A repeated composition entry is a distinct scene occurrence that
  references the same `SceneModule` metadata. Do not clone, rewrite, or
  fork the scene module to manufacture uniqueness.
- Occurrence ownership belongs at the resolver/loader context seam:
  DOM mount root, listener tracking, lifecycle bookkeeping, timeline
  segment identity, audio cleanup, and diagnostics must all agree on
  the same occurrence identity.
- Timeline label disambiguation already exists in `timeline.ts` through
  `sceneSegmentLabel()`, `sceneTimelineLabel()`, `parseSceneTimelineLabel()`,
  `MasterTimeline.labelFor()`, and `MasterTimeline.beats()`. Reuse it.
- `?composition=<id>&scene=<scene-id>` remains ambiguous when a scene id
  appears more than once in that composition. Keep the existing
  `composition+scene` rejection and use `composition+index` for an
  addressed repeated occurrence. Do not change URL grammar for this
  issue.
- Single-occurrence behavior is the compatibility baseline. A slice with
  one occurrence of each scene id should keep the same lifecycle order,
  diagnostics, labels, and audio behavior.

## Required Reuse

- Scene shape and validation: `SceneModule`, `assertSceneModule()`,
  `sceneDeclaresAudio()`, and `createSceneRegistry()`.
- Composition shape and lookup: `CompositionManifest`,
  `assertCompositionManifest()`, `entryId()`, `findUnregisteredEntries()`,
  `createCompositionRegistry()`, and `createIdRegistry()`.
- Navigation snapshots: `resolveSceneNavigation()`,
  `loadSceneNavigationTarget()`, `sliceManifestFromIndex()`,
  `snapshotSceneSlice()`, `truncateToHead()`, and the existing
  composition `startIndex` diagnostic contract.
- Lifecycle and failure handling: `resolveComposition()`, the internal
  plan/mounted cleanup list, `onSceneCleaned`, `onSceneFailed`,
  `SceneFailureEvent`, `Error.cause`, and `AggregateError`.
- Loader context and observability: `createSceneLoader()`, `buildCtx()`,
  per-navigation `AbortController`, `isPureAbort()`, `onError`, and
  stage attributes.
- Timeline: `SceneTimelineSegment`, `composeMasterTimeline()`,
  `createGsapCompositionTimeline()`, `assertSceneTimeline()`, label
  helpers, and `MasterTimeline.kill()`.
- Audio: `createAudioService()`, `AudioService.stopGroup()`,
  `AudioService.stopAll()`, `AudioService.isDisposed()`,
  `AUDIO_OUTPUT_POLICIES`, `resolveAssetUrl()`,
  `DEFAULT_ALLOWED_SCHEMES`, and the existing `AudioError` hierarchy.
- Error rendering: `describeError()`, `describeErrorDetailed()`, and
  `formatSceneContext()`. Extend structured context there if public
  diagnostics need occurrence or entry context.
- Tests and gates: focused Vitest runtime suites under
  `tests/runtime/*`, policy source scans, `pnpm test`, `pnpm typecheck`,
  and `pnpm lint`.

## Cross-Cutting Layers

| Layer | Guardrail |
|-------|-----------|
| Scene schema gate | Do not add `RepeatedScene`, `SceneOccurrenceModule`, a second lifecycle hook, or an occurrence field to scene metadata. `SceneModule.id` remains the module id. |
| Composition schema gate | Repeated entries are valid manifest data. Occurrence identity is resolved from manifest position at activation time, not stored as a manifest override or new DTO. |
| Registry / snapshot gate | Registries stay id-keyed and immutable. A navigation slice may contain repeated entries, but the synthesized scene registry must still contain one module per id. |
| URL grammar | Keep `parseNavigationSearch()` grammar unchanged. `composition+scene` is still rejected for ambiguous repeated members; `composition+index` is the existing precise locator. |
| Mode dispatch | `present` may run the full repeated slice. `standalone`, `loop`, `paused`, `scrub`, and `screenshot` keep truncating to the head entry and should remain unaffected by later repeats. |
| Lifecycle / cancellation | One navigation `AbortSignal` still drives preloader, resolver, timeline adapter, audio service, presenter controller, and prompter cleanup. Occurrence identity must not create a second cancellation workflow. |
| DOM ownership | Scenes should receive or derive an occurrence-owned mount surface from the runtime context. Cleanup must remove only that occurrence's DOM and listeners, never clear the whole stage or sibling occurrence roots. |
| Timeline labels | Use the canonical label helpers. Do not parse `:` / `#` names locally, and do not substitute absolute composition indexes into master label names unless a future ADR changes the label contract. |
| Audio cleanup | Scene-id-only groups are unsafe for repeated active occurrences. Per-occurrence cleanup must either use an occurrence-scoped audio facade/group or explicitly document a scene-scoped group as shared and not cleaned per occurrence. |
| Asset security | Asset and audio source strings still flow through declared `scene.assets` / `scene.audio`, `createAssetPreloader()`, `resolveAssetUrl()`, and the audio service allowlist. Occurrence identity must not permit arbitrary URLs or duplicate fetch policy. |
| Error envelope | Public diagnostics may include scene id, phase, composition id, entry index, occurrence identity, mode, and bounded messages. Never serialize raw scene objects, DOM nodes, listeners, GSAP objects, Howler handles, captions, headers, cookies, env, auth values, stacks, or raw `cause`. |
| Validation pass | `validateRuntime()` should continue to report duplicate scene modules as invalid, while allowing repeated composition references. Do not add a second validator for composition occurrence identity. |
| Source-policy security | Existing bans still apply: no scene GSAP imports, Howler imports, `Audio()` construction, dynamic remote imports, `eval`, parallel caption stores, or imperative composition flow control. |
| Config / env / OS | This design needs no auth surface, secrets, `.env`, `import.meta.env`, `process.env`, `process.argv`, shell flags, temp files, cookies, localStorage, sessionStorage, or history-state fallback. Occurrence ownership is in-memory runtime state. |
| Observability | Use existing `onError`, stage attributes, and tests. Do not add telemetry, persistent logs, resource dumps, or high-cardinality per-frame diagnostics. |

## Extensibility

The required seam is a deterministic scene activation identity. It
should be derived from the active manifest slice, not from randomness,
global counters, storage, process state, or scene-authored data.

The identity needs enough structure for future consumers to ask two
different questions without parsing strings:

- Which scene module is this? `sceneId`.
- Which activation owns this resource? entry position plus per-scene
  occurrence ordinal within the active slice.

The stable parameter belongs on the resolver plan and the scene
activation context/facade the loader builds. The same identity should
feed lifecycle bookkeeping, DOM ownership, audio group/facade scoping,
failure diagnostics, and any future resource owner. Timeline labels may
continue using the existing slice-local occurrence ordinal; diagnostics
can carry absolute composition `entryIndex` when the loader knows it.

Future changes such as windowed mounting, cross-scene seek, transition
ownership, occurrence-aware presenter HUDs, or stricter resource
tracking should extend this activation identity. They should not add
parallel registries, parallel scene schemas, or URL state.

## Gotchas

- Module-level mutable state in a scene module is shared by repeated
  occurrences. Scene-local mutable state must live in the activation
  context or in data structures keyed by activation identity, not by
  `scene.id` alone.
- `onSceneCleaned(sceneId)` and `audio.stopGroup(sceneId)` are the
  current unsafe point for repeated active occurrences. A cleanup hook
  keyed only by scene id can stop the sibling occurrence's audio.
- `data-pulsar-scene-failures` currently records `<sceneId>:<phase>`.
  That collapses two occurrences of the same scene that fail in the
  same phase. Repeated-occurrence diagnostics need occurrence or entry
  context at this surface.
- Eager cleanup after `create` or `timeline` failure must clean exactly
  the failed occurrence, remove it from the mounted list exactly once,
  and leave sibling occurrences mounted.
- Final cleanup still runs in reverse mount order by occurrence, not by
  unique scene id. A Set keyed by scene id would drop work.
- Timeline labels are already unambiguous only if segments remain in
  manifest order and the occurrence counter is computed from the same
  segment list the master composes.
- `headBeat` targets the head segment of the active slice. If navigation
  starts at the second occurrence by `composition+index`, that head is
  still occurrence 0 within the sliced master.
- A throwing diagnostic hook remains a workbench hook failure, not a
  scene failure. Keep ADR-028 aggregation semantics.
- Per-occurrence DOM cleanup must not delete workbench chrome,
  transition overlays, prompter UI, or sibling scene DOM.

## Anti-Patterns

- Rewriting scene ids in manifests or registries to make them unique.
- Cloning `SceneModule` objects or registering synthetic duplicate
  modules.
- Using global counters, random ids, timestamps, localStorage,
  `history.state`, env vars, process argv, or URL tokens as activation
  identity.
- Keying cleanup, listeners, DOM roots, audio groups, or diagnostics by
  scene id alone after repeated active occurrences are allowed.
- Parsing timeline label strings in loader, resolver, presenter, or
  tests instead of using `timeline.ts` helpers.
- Adding a duplicate validation pass, exception hierarchy, audio
  service, registry, presenter command schema, or workflow state
  machine for this issue.
- Treating audio groups as timeline labels, composition flow control,
  or scene identity. Groups are audio cleanup scopes.
- Silencing failures to preserve playback. Scene-level failures should
  isolate through ADR-028 surfaces; composition-wide failures keep their
  existing envelopes.

## Tests

Coverage should sit at runtime boundaries:

- Resolver tests for repeated manifest entries, stable occurrence data,
  failure isolation, eager cleanup, final cleanup order, and
  no-double-cleanup behavior.
- Timeline tests should continue to pin occurrence label namespacing
  through the existing helpers.
- Navigation and loader tests for repeated composition slices, ambiguous
  `composition+scene` rejection, precise `composition+index` addressing,
  stage diagnostics, and single-occurrence compatibility.
- Audio tests for occurrence-safe cleanup, including create/timeline
  failure paths and reverse-order final cleanup.

Do not add browser storage, new test-only public APIs, or a second test
runner. Source changes should add a Towncrier fragment; this preflight
note alone does not require one.

## Non-Goals

Issue 99 does not require a new URL grammar, new workbench mode, scene
metadata change, composition manifest change, registry change, asset
policy change, timeline engine replacement, audio engine replacement,
presenter command change, prompter change, telemetry, persistence, or
export semantics.

It also does not require windowed/lazy mounting, cross-scene reverse
seek, transition redesign, automatic repair of scene module global
state, raw Web Audio support, or requirement/ADR status transitions.
