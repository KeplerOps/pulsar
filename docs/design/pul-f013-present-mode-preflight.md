# PUL-F013 Present Mode Preflight

PUL-F013 specifies the default workbench behavior for `mode=present`:
full chrome, audio, inter-scene transitions, and presenter input. It is
an integration requirement across existing runtime seams, not a new
runtime model. None of the four facets has a rendering / input surface
in this repo yet (see ADR-016): chrome and audio surfaces have not
landed, inter-scene transition rendering is reserved by ADR-003's GSAP
runner, and presenter input is PUL-F020 / PUL-F021 / PUL-F025.
PUL-F013 ACTIVE requires every facet to land. This preflight defines
the boundary and required reuse for that future work.

## Boundary

`present` mode must be selected only through the existing navigation
boundary:

- `src/runtime/navigation.ts` owns the `mode` URL grammar and the
  `NAVIGATION_MODES` allowlist.
- `effectiveMode()` owns the absent-mode default to `present`.
- `src/runtime/scene-loader.ts` owns per-navigation mode dispatch and
  `ctx.mode` construction.
- `src/runtime/scene-navigation.ts` owns scene/composition target
  resolution.
- `src/runtime/composition-resolver.ts` owns lifecycle ordering,
  abort propagation, and cleanup.

Do not add a parallel `present` flag, route, controller, enum, or
manifest field. `mode=present` and omitted `mode` converge only at the
runtime dispatch seam; parsing must continue to preserve whether the
URL explicitly supplied `mode`.

## Required Reuse

Implementation must reuse these cross-cutting concerns:

- Identifier validation: `src/runtime/identifier.ts`.
- URL validation and mode parsing: `parseNavigationSearch()` and
  `NAVIGATION_MODES`.
- Effective mode derivation: `effectiveMode()`.
- Scene/composition schemas and validators:
  `assertSceneModule()`, `createSceneRegistry()`,
  `assertCompositionManifest()`, and `createCompositionRegistry()`.
- Lifecycle orchestration: `loadSceneNavigationTarget()` and
  `resolveComposition()`.
- Asset handling: `createAssetPreloader()` with the existing scheme and
  redirect validation rules.
- Error rendering: `describeError()` plus existing stage diagnostics
  (`data-pulsar-navigation-error`).
- Abort and cleanup: one per-navigation `AbortController`, forwarded to
  preload and timeline adapters; cleanup remains resolver-owned and
  exactly-once per activated scene.

Chrome, audio, transition, and presenter-control adapters should be
injected through the workbench context or the timeline runner seam
already reserved by ADR-003, ADR-004, and ADR-011. The resolver must
remain opaque to DOM, GSAP, Howler, and presenter UI details.

## Guardrails

- Chrome is workbench-owned persistent UI, not scene metadata and not a
  lifecycle hook. Scenes may render their content into `ctx.stage`;
  they must not own global chrome state.
- Audio is exposed through `ctx.audio` per ADR-004. Scenes must not
  create raw `<audio>` elements or import Howler directly unless a
  documented scene-specific exception also registers cleanup with the
  runtime.
- Inter-scene transitions belong in the timeline-runner / workbench
  integration layer. Do not encode transitions as fake scenes or mutate
  composition manifests to insert transition entries.
- Presenter input owns cancellation and timeline operations. It should
  drive the existing `AbortSignal` and runner controls rather than
  adding a second skip/cleanup path.
- Missing beats and navigation errors use the existing non-fatal or
  fatal surfaces. Do not throw from a missing-beat callback or unmount
  the scene to report a positioning diagnostic.
- `present` must not read mode, target, mute, or navigation state from
  localStorage, sessionStorage, cookies, `history.state`, or prior
  in-memory navigation state.

## Non-Goals

PUL-F013 should not implement alternate workbench modes (`standalone`,
`loop`, `paused`, `scrub`, `screenshot`, `prompter`), export behavior,
decode-complete asset semantics, new scene schema fields, persistence,
or authoring UI. It may add the minimum shared adapter surface needed
for full present-mode playback, but only where the existing ADRs have
already reserved that boundary.

## Anti-Patterns

- Duplicating `NAVIGATION_MODES` or re-validating mode strings with a
  local enum.
- Adding per-scene mode detection from `window.location`.
- Building presenter controls that call scene `cleanup()` directly.
- Creating a second exception hierarchy for presentation errors.
- Swallowing `AggregateError.errors` from resolver or preloader
  failures.
- Treating `present` as a special-case route that bypasses
  `SceneLoader`.
- Persisting the last selected mode or composition target.
