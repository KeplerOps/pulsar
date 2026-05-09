# PUL-F014 Standalone Mode Preflight

PUL-F014 specifies `mode=standalone`: render one scene as an isolated
authoring / inspection target, with surrounding chrome,
inter-scene transitions, and the audio bed suppressed. The scene still
runs through the runtime lifecycle and sees the effective mode through
`ctx.mode`.

This is a mode-dispatch requirement across existing runtime seams. It
is not a new scene model, router, composition schema, or lifecycle.

## Boundary

`standalone` selection must reuse the existing navigation path:

- `src/runtime/navigation.ts` owns the `mode` URL grammar and the
  `NAVIGATION_MODES` allowlist.
- `effectiveMode()` owns effective mode derivation.
- `src/runtime/scene-loader.ts` owns per-navigation mode dispatch,
  `ctx.mode` construction, cancellation, stage diagnostics, and error
  surfacing.
- `src/runtime/scene-navigation.ts` owns target resolution and
  composition slicing.
- `src/runtime/composition-resolver.ts` owns preload -> create ->
  timeline -> cleanup ordering, abort propagation, and exactly-once
  cleanup.

Do not add a second route, mode enum, `standalone` boolean, scene schema
field, manifest flag, or local URL parser. URL input remains the only
source of mode selection; `standalone` must not be recovered from
localStorage, sessionStorage, cookies, `history.state`, or prior
in-memory navigation state.

## Required Reuse

Implementation must reuse these cross-cutting concerns:

- Identifier validation: `src/runtime/identifier.ts`.
- URL and mode validation: `parseNavigationSearch()` and
  `NAVIGATION_MODES`.
- Effective mode derivation: `effectiveMode()`.
- Scene and composition validation:
  `assertSceneModule()`, `createSceneRegistry()`,
  `assertCompositionManifest()`, and `createCompositionRegistry()`.
- Navigation resolution: `resolveSceneNavigation()` and
  `loadSceneNavigationTarget()`.
- Lifecycle orchestration: `resolveComposition()` with injected
  `createPreloader()` and `runTimeline()` adapters.
- Asset handling: `createAssetPreloader()` with the existing scheme,
  redirect, `baseUrl`, and `AbortSignal` rules.
- Error rendering: `describeError()` plus the existing
  `data-pulsar-navigation-error` stage diagnostic and `onError` sink.
- Cancellation and cleanup: one per-navigation `AbortController`,
  forwarded to preload and timeline adapters; cleanup remains
  resolver-owned.

If implementation needs a shared suppression representation, it must
live at the workbench / adapter boundary that owns chrome, audio, and
timeline execution. The resolver must remain mode-opaque and must not
learn about chrome, Howler, GSAP, presenter controls, or DOM
suppression attributes.

## Standalone Contract

`standalone` is single-scene execution:

- A direct `scene` target runs only that scene.
- A `composition` / `composition+scene` / `composition+index` target
  may use composition context to find the addressed head scene, but
  must not continue into following composition entries.
- `beat` remains scoped to the addressed head scene per ADR-015.
- Scene lifecycle remains unchanged: declared assets preload, `create`
  runs, the scene timeline is handed to the runner, and `cleanup` runs
  on exit / abort / error.

The suppressed surfaces are external to the scene lifecycle:

- Chrome suppression is workbench-shell behavior. Do not make scenes own
  global chrome state.
- Audio-bed suppression is audio-service behavior per ADR-004. It must
  not suppress scene-owned sound effects unless a later requirement says
  standalone is silent.
- Inter-scene transition rendering, when ADR-003's runner lands, is
  workbench/runner adapter behavior — a future runner reading
  `ctx.mode` from its seam, not loader logic. Do not encode
  transition suppression by mutating manifest entry CONTENTS (e.g.,
  swapping a scene id, editing a `range` value, rewriting a
  `behavior` blob, inserting a sentinel entry). Truncating the
  resolved slice at the loader to a one-entry slice that preserves
  the addressed head entry verbatim is the chosen mechanism for
  single-scene execution under `mode=standalone` and is recorded in
  ADR-017 — that is selection, not rewriting.

## Guardrails

- Treat `standalone` as mode behavior over an addressed head scene, not
  as a separate composition type.
- Preserve composition member / index validation before lifecycle
  effects when the URL uses composition context. Invalid composition
  targets must still fail as navigation errors, not silently degrade to
  direct scene lookup.
- Do not bypass `SceneLoader` to get "just one scene." The loader owns
  the serialized navigation queue, stage attributes, abort handling,
  and `ctx.mode`.
- Do not call scene `cleanup()` from chrome, audio, or presenter
  adapters. Drive cancellation through the existing per-navigation
  `AbortSignal`.
- Do not add duplicate exception hierarchies. Navigation failures keep
  the `scene navigation failed:` surface; lifecycle failures keep the
  `composition resolution failed:` surface; preload failures preserve
  `AggregateError.errors`.
- Do not mutate registered composition manifests to produce a
  standalone slice. Snapshot or derive per-navigation execution input
  at the dispatch boundary. ADR-017 truncates the *resolved*
  `SceneNavigationCompositionContext` (already a per-navigation
  snapshot deep-frozen in `scene-navigation.ts`); registry contents
  are untouched.
- Do not hide missing beats, unknown scenes, ambiguous
  `composition+scene` locators, out-of-range indexes, empty
  compositions, or preload failures because standalone is an inspection
  mode.

## Non-Goals

PUL-F014 should not implement `present`, `loop`, `paused`, `scrub`,
`screenshot`, or `prompter`; presenter controls; export behavior;
decode-complete asset semantics; authoring UI; new scene metadata;
persistence; or a generic mode-policy framework unless the concrete
chrome / audio / timeline adapters need one now.

## Anti-Patterns

- Duplicating `NAVIGATION_MODES` or validating mode strings with a
  local enum.
- Reading `window.location` from a scene to detect standalone mode.
- Treating `standalone` as `present` with CSS hidden after the fact
  while still running following scenes, transition hooks, or the audio
  bed.
- Flattening `composition+index` to direct scene id lookup and losing
  range / behavior overrides for the addressed entry.
- Representing inter-scene transition suppression as fake scenes,
  sentinel manifest entries, scene metadata, or by mutating an
  entry's contents. (Truncating the *resolved* slice to a one-entry
  slice that keeps the addressed head entry verbatim is selection,
  not mutation, and is the mechanism ADR-017 chose.)
- Suppressing all audio when the requirement only names the surrounding
  audio bed.
- Persisting the last standalone target or mode outside the URL.
