# PUL-F014 Standalone Mode Preflight

PUL-F014 specifies `mode=standalone`: render one scene as an isolated
authoring / inspection target, with surrounding chrome, inter-scene
transitions, and the audio bed suppressed. The scene still runs through
the runtime lifecycle and sees the effective mode through `ctx.mode`.

This is a mode-dispatch requirement across existing runtime seams. It
is not a new scene model, router, composition schema, lifecycle,
workbench shell, or generic mode-policy framework.

## Current State

The repo now has real seams for all three suppressed facets:

- Single-scene execution is already structural. The loader's
  `applySingleSceneSlice()` and the bridge-level `truncateToHead()`
  preserve the addressed head entry's `range` / `behavior` overrides
  and drop following entries.
- Chrome exists. `src/runtime/workbench-chrome.ts`
  `chromeVisibilityFor('standalone') === 'hidden'`, and the loader
  dispatches chrome synchronously from the URL-derived effective mode.
- Inter-scene transitions exist as `behavior.transition` declarations
  consumed by `src/runtime/timeline.ts` through a `TransitionRegistry`.
  Standalone suppresses them by running a one-entry slice; no
  transition can be inserted before a non-existent second segment.
- Audio exists as a per-navigation `AudioService` selected by
  `audioOutputPolicyFor(mode)`, but there is no distinct
  composition-level audio-bed contract yet. `standalone` must not be
  made silent globally to fake audio-bed suppression, because the
  requirement names only the surrounding bed, not scene-owned sound.

## Boundary

`standalone` selection must reuse the existing navigation path:

- `src/runtime/navigation.ts` owns the `mode` URL grammar and the
  `NAVIGATION_MODES` allowlist.
- `effectiveMode()` owns effective mode derivation.
- `src/runtime/scene-loader.ts` owns per-navigation mode dispatch,
  `ctx.mode` construction, chrome dispatch, audio-service construction,
  cancellation, stage diagnostics, and error surfacing.
- `src/runtime/scene-navigation.ts` owns target resolution and
  composition slicing.
- `src/runtime/composition-resolver.ts` owns preload -> create ->
  timeline -> cleanup ordering, abort propagation, and exactly-once
  cleanup.
- `src/runtime/workbench-chrome.ts` owns chrome visibility.
- `src/runtime/audio.ts` owns audio output policy, Howler
  encapsulation, source allowlists, cue logging, and cleanup.
- `src/runtime/timeline.ts` owns master timeline composition and
  transition insertion.
- `src/main.ts` is the browser composition root that wires chrome,
  transition registry, audio engine, unlock adapter, validation, and
  HMR disposal.

Do not add a second route, mode enum, `standalone` boolean, scene schema
field, manifest flag, or local URL parser. URL input remains the only
source of mode selection; `standalone` must not be recovered from
localStorage, sessionStorage, cookies, `history.state`, or prior
in-memory navigation state.

## Required Reuse

Implementation must reuse these cross-cutting concerns:

- Identifier validation: `src/runtime/identifier.ts`.
- URL and mode validation: `parseNavigationSearch()` and
  `NAVIGATION_MODES`, plus the loader's defensive mode / beat grammar
  checks for hand-built targets.
- Effective mode derivation: `effectiveMode()`.
- Scene and composition validation:
  `assertSceneModule()`, `createSceneRegistry()`,
  `assertCompositionManifest()`, `createCompositionRegistry()`, and
  `validateRuntime()` over the canonical `src/workbench-graph.ts`
  declarations.
- Navigation resolution: `resolveSceneNavigation()` and
  `loadSceneNavigationTarget()`.
- Lifecycle orchestration: `resolveComposition()` with injected
  preloader and `CompositionTimelineAdapter` seams.
- Asset handling: `createAssetPreloader()` with the existing scheme,
  redirect, `baseUrl`, and `AbortSignal` rules.
- Chrome: `WorkbenchChromeAdapter`, `createDomWorkbenchChrome()`, and
  `chromeVisibilityFor()`.
- Audio: `createHowlerAudioEngine()`, `createAudioService()`,
  `AudioOutputPolicy`, `scene.audio`, `allowedSources`, `stopGroup()`,
  `stopAll()`, and the existing `onAudioCue` / `onError` sinks.
- Timeline / transitions: `createGsapCompositionTimeline()`,
  `composeMasterTimeline()`, `TransitionRegistry`, and
  `behavior.transition`.
- Error rendering: `describeError()` plus the existing
  `data-pulsar-navigation-error` stage diagnostic and `onError` sink.
- Cancellation and cleanup: one per-navigation `AbortController`,
  forwarded to preload, timeline, audio, presenter, and prompter
  adapters; cleanup remains resolver-owned.

If implementation needs a shared suppression representation, it must
live at the workbench / adapter boundary that owns chrome, audio, and
timeline execution. The resolver must remain mode-opaque and must not
learn about chrome, Howler, GSAP, presenter controls, or DOM
suppression attributes.

## Cross-Cutting Layers

| Layer | Guardrail |
|-------|-----------|
| URL grammar / public input | `mode=standalone` is accepted only through `NAVIGATION_MODES`; unknown or repeated `mode` values keep failing through the navigation grammar envelope. Unknown query keys must not influence suppression. |
| Programmatic navigation | Loader-side `validateModeGrammar()` must reject forged mode strings before `effectiveMode()` reaches `ctx.mode`, chrome, or audio. |
| Source of truth | `effectiveMode(target)` is recomputed per navigation from the parsed target. No storage, cookies, `history.state`, env vars, argv, config files, or previous in-memory state. |
| Graph validation | Browser boot and CI must continue using `validateRuntime()` over `WORKBENCH_SCENES` / `WORKBENCH_COMPOSITIONS` before lifecycle effects. Do not create a standalone-only graph path. |
| Scene schema | Do not add `standaloneAudio`, `hideChrome`, `audioBed`, or mode-selector fields to scene modules. Scenes may read `ctx.mode` only as a bounded hint for scene-owned behavior. |
| Composition schema | Do not represent standalone by mutating manifests, inserting sentinel scenes, fake transitions, or mode flags. If a composition-level audio-bed declaration becomes necessary, extend the existing composition-registration boundary once and validate it there; do not hide it in per-entry `behavior` unless it is truly entry-scoped. |
| Asset and audio-source security | Scene audio sources must remain declared assets and pass `scene.audio` / `allowedSources` plus `resolveAssetUrl()` scheme checks. The composition bed source carries the same scheme discipline but a **separate** allowlist: it is gated against the bed declaration's own `src`, not the scene-facing `scene.audio` allowlist — adding the bed URL to `allowedSources` would let a scene `ctx.audio.load()` it as its own sound and replay the bed even under `mode=standalone`. No `ctx.audio.play(url)` or query-derived fetch path. |
| Chrome / DOM ownership | Workbench chrome is mounted once outside `#stage` and hidden through `chromeVisibilityFor()` / `hidden`. Scene cleanup must not remove chrome or the transition overlay. |
| Timeline / transitions | Standalone transition suppression comes from one-entry execution. Do not add a runner flag, URL flag, fake transition name, or CSS-only hide that still composes following segments. |
| Audio output | Do not map `standalone` to `outputPolicy: 'silent'` unless the requirement changes to suppress all scene-owned audio. The required seam is a bed-specific policy or scope on the existing audio service. |
| Error envelope | Keep existing public envelopes: `navigation grammar is invalid:`, `scene navigation failed:`, `composition resolution failed:`, `beat positioning failed:`, and scene-failure diagnostics via `formatSceneContext()`. Do not serialize raw scene objects, DOM nodes, full captions, source URLs, headers, cookies, env, auth values, or engine handles. |
| Source policy / security | Keep scene modules inside the existing A002/A008/Q007 gates: no direct Howler or `<audio>`, no scene-owned mode dispatch branches for central behavior, no dynamic remote code execution. |
| OS / config exposure | No mode, target, audio source, token, or graph payload belongs in process argv, env bindings, local files, browser storage, cookies, or persisted history state. |

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

- Chrome suppression is already workbench-shell behavior:
  `chromeVisibilityFor('standalone')` returns `hidden`, and loader
  dispatch occurs before target resolution / lifecycle. Do not make
  scenes own global chrome state to preserve template visuals.
- Audio-bed suppression is audio-service behavior per ADR-004. It must
  not suppress scene-owned sound effects unless a later requirement says
  standalone is silent. The current `AudioOutputPolicy` values express
  whole-service output (`audible`, `silent`, `log-cues`); the bed needs
  its own scope or policy parameter on the existing audio seam.
- Inter-scene transition suppression is timeline-slice behavior. The
  GSAP master only inserts transitions between segments that exist in
  the slice; under standalone there is one segment. Do not encode
  transition suppression by mutating manifest entry CONTENTS (e.g.,
  swapping a scene id, editing a `range` value, rewriting a
  `behavior` blob, inserting a sentinel entry, or declaring a fake
  `none` transition). Truncating the resolved slice at the loader to a
  one-entry slice that preserves the addressed head entry verbatim is
  the chosen mechanism for single-scene execution under
  `mode=standalone` and is recorded in ADR-017 — that is selection, not
  rewriting.

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
- Do not let L2 chrome-slot usage blur ownership. `ctx.chrome` slot refs
  are a template-system affordance mounted inside the workbench chrome
  surface; hidden standalone chrome means content written only into
  those slots is intentionally suppressed. Essential single-scene
  inspection content belongs in the scene's stage DOM, or the template
  requirement must explicitly redefine what counts as scene-owned.

## Extensibility

The required seams stay subsystem-specific:

- Chrome variants extend `chromeVisibilityFor()` /
  `WorkbenchChromeAdapter`.
- Transition variations extend `TransitionRegistry` and
  `behavior.transition` validation at the timeline boundary.
- Audio-bed suppression extends `AudioService` / `AudioServiceOptions`
  with a bed-specific scope or policy, selected by the loader from
  `effectiveMode(target)`. The parameter must distinguish
  composition-level bed playback from ordinary scene `ctx.audio`
  playback.

Do not extract a generic `ModePolicy` until more than two concrete
subsystems need the same representation and the representation is
stable enough to avoid concept loss.

## Non-Goals

PUL-F014 should not implement `present`, `loop`, `paused`, `scrub`,
`screenshot`, or `prompter`; presenter controls; export behavior;
decode-complete asset semantics; authoring UI; persistence; remote
control; authentication; telemetry; a generic mode-policy framework; or
new scene metadata.

This preflight should not transition requirement status or create
traceability links. The implementation that follows owns tests and any
Ground Control workflow step.

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
- Treating the present-mode audio unlock gate as the audio-bed
  suppression mechanism. Unlock gating applies only to present-mode
  audio-declaring composition navigations; standalone must stay out of
  that gate.
- Adding a composition-level bed as a fake first scene, fake
  transition, scene-local ambient loop, global Howler singleton call,
  or browser `<audio>` element.
- Persisting the last standalone target or mode outside the URL.
