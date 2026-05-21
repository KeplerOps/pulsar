# PUL-F013 Present Mode Preflight

PUL-F013 is the default live workbench integration contract for
`mode=present`: full chrome, audible playback, inter-scene
transitions, and presenter input. The repo now has canonical seams for
all four facets. Future work must preserve and extend those seams
rather than adding a second present-mode runtime.

This note is design guidance only. It is not an implementation plan.

## Current Boundary

`present` mode is selected only through the existing navigation
boundary:

- `src/runtime/navigation.ts` owns the `mode` URL grammar,
  `NAVIGATION_MODES`, and `effectiveMode()` defaulting absent `mode`
  to `present`.
- `src/runtime/scene-loader.ts` owns mode dispatch, stage diagnostics,
  per-navigation `AbortController`, audio-service construction,
  presenter-controller construction, chrome dispatch, audio unlock, and
  single-scene slice truncation for non-present modes.
- `src/runtime/scene-navigation.ts` owns scene/composition target
  resolution and slice snapshots.
- `src/runtime/composition-resolver.ts` owns lifecycle ordering,
  abort propagation, scene-failure isolation, and exactly-once cleanup.
- `src/runtime/timeline.ts` owns GSAP timeline validation,
  composition-master construction, presenter command to transport
  handling, and inter-scene transition invocation.
- `src/main.ts` is the browser composition root. It wires the runtime
  seams to the L2 chrome slots, transition registry, keyboard source,
  cross-window presenter bridge, audio unlock adapter, and graph
  validation gate.

Do not add a parallel `present` flag, route, controller, enum, storage
state, or manifest selector. `mode=present` and omitted `mode` converge
only at `effectiveMode()`.

## Required Reuse

Implementation must reuse these cross-cutting concerns:

- Identifier validation: `src/runtime/identifier.ts`.
- URL and mode validation: `parseNavigationSearch()`,
  `NAVIGATION_MODES`, `effectiveMode()`, and the loader's defensive
  mode/beat grammar checks for hand-built `NavigationTarget` values.
- Scene and composition schemas: `assertSceneModule()`,
  `createSceneRegistry()`, `assertCompositionManifest()`,
  `createCompositionRegistry()`, and the `WORKBENCH_SCENES` /
  `WORKBENCH_COMPOSITIONS` graph in `src/workbench-graph.ts`.
- Structural validation: `validateRuntime()` plus the existing
  browser boot marker `data-pulsar-validation-failed`.
- Lifecycle orchestration: `loadSceneNavigationTarget()` and
  `resolveComposition()`; the resolver remains DOM-, mode-, GSAP-,
  Howler-, and chrome-opaque except for injected adapters.
- Timeline and transitions: `createTimelineEngine()`,
  `createGsapCompositionTimeline()`, `composeMasterTimeline()`,
  `Transition`, `TransitionRegistry`, and
  `src/system/transitions/defaultTransitions()`.
- Chrome: `createDomWorkbenchChrome()`, `chromeVisibilityFor()`,
  `WorkbenchChromeAdapter`, and L2 `mountChromeSlots()`.
- Audio: `createHowlerAudioEngine()`, `createAudioService()`,
  `AudioOutputPolicy`, scene `audio` declarations, source allowlists,
  and the loader-owned audio unlock gate.
- Presenter input: `PresenterCommand`, `PRESENTER_COMMAND_KINDS`,
  `isPresenterCommand()`, `PresenterCommandSource`,
  `createPresenterController()`, `createKeyboardPresenterSource()`,
  `createPresenterBridge()`, and `combinePresenterSources()`.
- Error surfacing: `describeErrorDetailed()`, `formatSceneContext()`,
  loader `onError`, `data-pulsar-navigation-error`, and
  `data-pulsar-scene-failures`.
- Cleanup: one navigation abort signal, presenter auto-detach via a
  separate presenter abort signal, resolver cleanup, audio
  `stopGroup()` / `stopAll()`, chrome disposal, transition overlay
  removal, keyboard disposal, bridge disposal, and MutationObserver
  disconnect in HMR teardown.

## Cross-Cutting Gates

Security and validation layers the design passes through:

| Layer | Canonical gate | Required behavior |
|-------|----------------|-------------------|
| URL grammar | `parseNavigationSearch()` and loader defensive checks | Unknown `mode`, invalid `beat`, invalid composition addressing, or forged programmatic targets fail through the navigation error envelope. No alternate query key such as `present=true`. |
| Mode dispatch | `effectiveMode()` and `SceneLoaderOptions` | Mode is recomputed per navigation from the parsed target. No localStorage, sessionStorage, cookies, `history.state`, process env, argv, or cached prior mode. |
| Graph validation | `validateRuntime()` over `WORKBENCH_SCENES` / `WORKBENCH_COMPOSITIONS` | Browser boot and CI must validate the same graph before lifecycle effects. Do not create a test-only or deck-only registry path. |
| Manifest shape | `assertCompositionManifest()` | Keep `behavior` as the existing adapter-owned override bag. Do not add fake transition scenes, mode selector fields, or duplicate manifest schemas. |
| Timeline shape | `assertSceneTimeline()` and `MasterTimeline` | Scene timelines are GSAP timelines or null; beats are kebab-case finite labels. Presenter, beat, loop, paused, scrub, screenshot, and transition behavior extend the master transport seam. |
| Transition declaration | `TransitionRegistry` plus `behavior.transition` | Use registered transition names. If `durationMs` or future transition parameters are strengthened, validate once at the transition boundary before invoking implementations; do not duplicate checks in every deck. |
| Asset/audio sources | `scene.assets`, `scene.audio`, `createAssetPreloader()`, `resolveAssetUrl()`, `createAudioService()` | Audio sources must be declared before use and pass existing scheme/redirect/source allowlist checks. Scenes must not import Howler or create raw `<audio>` as the default path. |
| Audio unlock | `AudioUnlockAdapter` | The workbench adapter receives only composition id, scene ids, signal, and `unlock()`. It must not receive scene objects, source URLs, cookies, headers, Howler handles, or DOM events as public diagnostics. |
| Presenter command shape | `isPresenterCommand()` | Keyboard, bridge, tests, and future remotes emit into one `PresenterCommandSource`. Unknown commands are dropped with diagnostics; a future remote source authenticates before this seam. |
| DOM/chrome | `createDomWorkbenchChrome()` and `mountChromeSlots()` | Chrome is workbench-owned, mounted once, hidden with the `hidden` property where required, and disposed on HMR. Scene cleanup must never remove chrome or the transition overlay. |
| Error envelopes | `describeErrorDetailed()`, loader attributes, `onError` | Public diagnostics stay bounded. Do not serialize raw causes, stacks, DOM nodes, scene objects, full captions, cookies, headers, env, auth values, or engine handles. |
| OS/process exposure | package scripts and in-process tests | No secrets or serialized scene graphs in argv. Present-mode runtime behavior is browser/in-process state, not shell state. |

No authentication surface exists for local keyboard or same-origin
`BroadcastChannel`. If a future remote presenter protocol appears,
authentication and authorization must sit before it emits into
`PresenterCommandSource`; the controller remains the local shape gate.

## Extensibility Seams

- New transition implementations register in
  `src/system/transitions/defaultTransitions()`. New transition
  parameters belong under `behavior.transition` and must be parsed at
  the timeline/transition boundary, not by scenes or the resolver.
- New presenter commands extend `PRESENTER_COMMAND_KINDS`,
  `PresenterCommand`, `isPresenterCommand()`, and the single runner
  transport dispatch in `src/runtime/timeline.ts`.
- Chrome variants extend `chromeVisibilityFor()` /
  `WorkbenchChromeAdapter` and L2 `ChromeSlots`. Do not introduce a
  generic `ModePolicy` until more than one concrete surface needs the
  same representation.
- Audio variations extend `AudioOutputPolicy` or `AudioService`.
  Do not add per-scene mute booleans, duplicate audio buses, or direct
  Howler imports.
- Browser smoke/e2e checks should assert the observable incumbents:
  `data-pulsar-chrome-visibility`, `data-pulsar-transition`, absence
  of navigation/validation errors, audible/silent policy effects,
  presenter keyboard effects, and cleanup/disposal behavior.

## Guardrails

- `mode=present` runs the full composition slice. Only `standalone`,
  `loop`, `paused`, `scrub`, and `screenshot` use the shared
  single-scene truncation defense.
- Inter-scene transitions are master-timeline insertions. Do not
  encode transitions as scenes, lifecycle hooks, URL state, stage
  attributes, or manifest rewrites.
- Presenter input is a command stream, not a mode. It must not mutate
  URL/history, call scene `cleanup()` directly, remount scenes, or
  persist playhead state.
- Chrome and transition overlay are workbench-owned siblings of
  `#stage`. Scenes may receive L2 slot refs through `ctx.chrome`, but
  they do not create, remount, or dispose the surface.
- Audio is per navigation. Scene-owned sound uses `ctx.audio` and
  declared sources; the loader/resolver own stop/unload sequencing.
- Missing beats and scene failures use existing non-fatal/fatal
  diagnostic paths. Do not throw from diagnostic sinks to force
  lifecycle behavior.
- HMR disposal must clean every long-lived surface that `main.ts`
  constructs: navigation listener, loader, chrome, transition overlay,
  keyboard source, presenter bridge, stage observer, and practice
  renderer.

## Non-Goals

This preflight should not add runtime code, new workbench modes, export
behavior, authoring UI, persistence, telemetry, authentication,
workflow automation, requirement status transitions, traceability
links, or a generic mode-policy framework. It should not redesign the
scene schema, composition manifest, timeline engine, audio API,
presenter command bus, validation pass, or error hierarchy.

## Anti-Patterns

- Re-implementing `mode=present` as a standalone app route or scene.
- Creating a second transition adapter when `TransitionRegistry` and
  `composeMasterTimeline()` already provide the seam.
- Duplicating `PRESENTER_COMMAND_KINDS`, `NAVIGATION_MODES`, audio
  source validation, or manifest validation in L2 modules.
- Binding keyboard listeners inside scene modules or individual decks.
- Letting `BroadcastChannel` become a remote-control auth boundary.
- Treating unknown transition names or malformed transition parameters
  as deck-local behavior without a central policy decision.
- Swallowing `AggregateError.errors`, raw asset-preloader failures, or
  scene-failure context.
- Persisting mode, target, mute, or presenter state in browser storage.
