# PUL-F020 Presenter Controls Preflight

PUL-F020 specifies runtime acceptance of presenter input under
`mode=present`: advance to the next beat, hold the current beat, skip
forward, and skip backward. Beat progression must be interruptible
without breaking timeline state.

This note is design guidance only. It is not an implementation plan.

## Current Boundary

The current repository already has the presenter-control seam and the
browser input surfaces that issue #132 described as pending. Follow-up
work must harden and test those seams, not add a second runtime path.

- `src/runtime/navigation.ts` owns the URL grammar, `NAVIGATION_MODES`,
  and `effectiveMode()`. Presenter input is not URL state.
- `src/main.ts` is the browser composition root. It wires the keyboard
  source, same-origin presenter bridge, practice overlay subscriber,
  and `SceneLoaderOptions.presenterCommands`, and disposes those
  long-lived surfaces during Vite HMR teardown.
- `src/system/presenter/keyboard-source.ts` owns DOM keyboard event to
  `PresenterCommand` translation. It is parameterized by
  `KeyboardPresenterBindings`; do not duplicate the key map elsewhere.
- `src/system/presenter/bridge.ts` owns same-origin
  `BroadcastChannel` fan-out and `combinePresenterSources()`. It is a
  local workbench bridge, not an auth boundary or remote protocol.
- `src/runtime/presenter.ts` owns the single command schema,
  allowlist, shape guard, defensive frozen copy, handler isolation, and
  abort-tied controller cleanup.
- `src/runtime/scene-loader.ts` owns mode scoping. It builds a
  `PresenterController` only when `effectiveMode(target) === 'present'`
  and a source was supplied, then threads it into `ctx.presenter` and
  the timeline adapter options.
- `src/runtime/scene-navigation.ts` and
  `src/runtime/composition-resolver.ts` forward `presenter`; they do
  not interpret commands. `mode=present` runs the full composition
  slice, so presenter forwarding is not head-only.
- `src/runtime/timeline.ts` owns command-to-master-transport behavior
  through `MasterTimeline`, namespaced beat labels, and segment-start
  labels. The runner is the only layer that should translate
  `advance`, `hold`, `skip-forward`, and `skip-backward` into
  `play()`, `pause()`, or `seek()`.
- `src/system/helpers/timing.ts` owns scene-authoring helpers such as
  `addAdvanceGate()`, `aSleep()`, and `holdUntilAdvance()`. Scenes use
  these helper seams rather than binding keyboard events.

## Architecture Decisions

- Presenter controls are a command stream, not a workbench mode, URL
  parameter, persistent state, manifest field, or scene schema field.
- The command bus is single-source. `PRESENTER_COMMAND_KINDS` and
  `isPresenterCommand()` are the only runtime command allowlist and
  validator.
- Local keyboard input and cross-window bridge input are workbench
  sources. They may be composed into one `PresenterCommandSource`, but
  the loader remains the mode gate.
- Timeline behavior is runner-owned. Loader, resolver, scenes, chrome,
  and keyboard code must not call GSAP transport methods to satisfy
  PUL-F020.
- F020 beat-pacing state must not be conflated with F021 transport
  pause/resume. GSAP exposes one `paused()` bit, but the runtime
  semantics are not one bit:
  - `hold` is a beat-pacing hold. It must not be implemented as a
    toggle that resumes playback on a second `hold`.
  - `pause` / `resume` are explicit transport-freeze commands owned by
    PUL-F021. Only `resume` unfreezes an explicit pause.
  - `advance` may release a beat hold or move to the next authored beat
    / segment boundary, but it must not silently clear an explicit
    PUL-F021 pause.
  - `skip-forward` / `skip-backward` may seek the frozen playhead while
    paused, but they must not implicitly resume playback when ADR-024's
    explicit pause gate is active.
  Any private state needed to distinguish those cases belongs inside
  the timeline adapter, not in URL state, loader state, scene globals,
  or storage.
- Skip semantics are discrete navigation. They seek to canonical master
  labels: authored beats via `MasterTimeline.beats()` and scene
  boundaries via `sceneSegmentLabel()` / the segment label map. Do not
  treat skip as scrub or arbitrary millisecond seeking.

## Required Reuse

Implementation must reuse these incumbents:

- URL and mode validation: `parseNavigationSearch()`,
  `NAVIGATION_MODES`, `effectiveMode()`, and loader-side defensive mode
  checks for hand-built `NavigationTarget` values.
- Presenter input schema and cleanup: `PRESENTER_COMMAND_KINDS`,
  `PresenterCommand`, `isPresenterCommand()`,
  `PresenterCommandSource`, `PresenterController`, and
  `createPresenterController()`.
- Browser input surfaces: `createKeyboardPresenterSource()`,
  `DEFAULT_KEYBOARD_BINDINGS`, `KeyboardPresenterBindings`,
  `createPresenterBridge()`, and `combinePresenterSources()`.
- Lifecycle orchestration: `createSceneLoader()`,
  `loadSceneNavigationTarget()`, `resolveComposition()`, the
  per-navigation `AbortSignal`, and resolver cleanup. Presenter
  commands must not add a cleanup path.
- Timeline transport and beat grammar: `createGsapCompositionTimeline()`,
  `MasterTimeline`, `assertSceneTimeline()`, `MasterTimeline.beats()`,
  `sceneSegmentLabel()`, `sceneTimelineLabel()`, and
  `parseSceneTimelineLabel()`.
- Scene authoring helpers: `addAdvanceGate()`, `aSleep()`, and
  `holdUntilAdvance()` for presenter-driven waits and advance gates.
- Error rendering and diagnostics: `describeErrorDetailed()`,
  `formatSceneContext()`, loader `onError`,
  `data-pulsar-navigation-error`, and `data-pulsar-scene-failures`.
- Workbench cleanup: HMR disposal of navigation listeners, loader,
  chrome, transition overlay, keyboard source, presenter bridge,
  stage observer, practice renderer, scrub controls, and GSAP ticker
  callbacks.

## Cross-Cutting Layers

| Layer | Canonical gate | Required behavior |
|-------|----------------|-------------------|
| URL grammar | `parseNavigationSearch()` | Add no presenter query keys. Unknown query keys stay ignored; malformed canonical keys fail through the navigation error path. |
| Mode selection | `effectiveMode()` in the loader | Recompute mode per navigation. Do not read `window.location`, localStorage, sessionStorage, cookies, `history.state`, env, argv, or cached state inside the runner or source. |
| Keyboard input | `createKeyboardPresenterSource()` | Translate only configured bindings, ignore editable targets, prevent default only for bound keys, and dispose the listener on HMR. The documented mapping must expose every accepted command that the UI claims to support, including `skip-forward`. |
| Cross-window input | `createPresenterBridge()` | Validate inbound channel data with `isPresenterCommand()`. Treat `BroadcastChannel` as same-origin convenience only; never as remote authorization. No tokens or secrets in channel names or messages. |
| Source composition | `combinePresenterSources()` | Merge sources once at the composition root. Avoid double-wiring the same keyboard source, which would duplicate commands. |
| Command shape | `PRESENTER_COMMAND_KINDS` / `isPresenterCommand()` | Keep commands flat and discriminator-based unless a future kind needs data. Unknown kinds are dropped before the runner and reported through the existing diagnostic sink. |
| Command payload safety | `createPresenterController()` | Fan out one frozen defensive copy per accepted emission, isolate throwing subscribers, and auto-detach on abort/completion. |
| Timeline shape | `assertSceneTimeline()` / `MasterTimeline` | Only GSAP timelines or null enter the master. Beat labels are kebab-case finite scene-local labels copied into namespaced master labels. |
| Lifecycle | loader abort + resolver cleanup | Presenter commands do not abort, remount, or call `cleanup(ctx)` directly. Superseding navigation still aborts and cleans up exactly once. |
| Audio sibling command | loader mute subscriber + `AudioService` | `toggle-master-mute` may share the bus, but the timeline runner ignores audio-owned commands and audio code does not inspect beat commands. |
| Error envelope | `describeErrorDetailed()` and loader `onError` | Do not serialize raw future remote payloads, stacks, DOM nodes, scene objects, captions, cookies, headers, env, auth values, GSAP instances, or Howler handles. |
| Config/env/OS exposure | package scripts and in-browser state | No env vars, config files, CLI flags, process argv tokens, shell commands, files, cookies, or browser storage are needed for F020. |
| Structural validation | `validateRuntime()` over `WORKBENCH_SCENES` / `WORKBENCH_COMPOSITIONS` | Presenter controls do not bypass the canonical graph validation pass or create a deck-only registry path. |

## Extensibility

- New keyboard mappings belong in `KeyboardPresenterBindings` and tests
  for `createKeyboardPresenterSource()`, not in the loader, runner, or
  scene modules.
- Future on-screen controls should implement `PresenterCommandSource`
  and be composed with existing sources. They should not call the
  loader, resolver, or `MasterTimeline` directly.
- Future remote presenter protocols must authenticate and authorize
  before emitting into `PresenterCommandSource`. The presenter
  controller remains the local shape gate, not the security boundary.
- Future command payloads extend `PresenterCommand` as a discriminated
  union and update `isPresenterCommand()` in the same module. Do not add
  a second command schema.
- Future presenter status UI needs a separate runner/workbench status
  surface. Do not overload `PresenterCommandSource`, URL grammar, stage
  error attributes, or timeline labels as a state store.
- L2-only commands such as `toggle-practice` may ride the same bus only
  with explicit ownership. Runtime transport code must ignore
  non-transport commands.

## Gotchas

- Issue text may be stale. In this checkout keyboard and GSAP command
  plumbing already exist; evaluate the live incumbents before adding
  anything.
- `MasterTimeline.isPaused()` is not enough to distinguish beat hold,
  GSAP addPause gates, and explicit PUL-F021 pause. Treating all three
  as the same state creates resume/advance bugs.
- `advance` and `skip-forward` are different commands. A keyboard map
  that exposes only `advance` and `skip-backward` does not prove the
  full PUL-F020 input surface.
- `hold` and `pause` are different commands. Reusing one for the other
  breaks ADR-024 cross-command precedence.
- `mode=present` and absent `mode` are equivalent only through
  `effectiveMode()`. Branching on `target.mode === 'present'` misses the
  default-present path.
- Presenter forwarding is full-slice under `mode=present`. Making it
  head-only silently drops controls for later scenes.
- Source-level validation and controller-level validation are both
  useful. Do not remove the controller guard because keyboard or bridge
  sources currently emit typed objects.
- Same-origin `BroadcastChannel` delivery is asynchronous and may be
  unavailable. The bridge must remain inert when unsupported.

## Non-Goals

PUL-F020 should not implement new URL grammar, new workbench modes,
remote presenter auth, persistence, telemetry, new scene or composition
schemas, a second event bus, a second command validator, a new
exception hierarchy, direct Howler or raw audio handling, scrub-mode
controls, export behavior, requirement status transition, or
traceability automation.

It should not redesign PUL-F021 pause/resume or PUL-F025 master mute.
Those commands share the presenter seam but retain separate behavior
ownership.

## Anti-Patterns

- Attaching keyboard listeners in scenes, decks, templates, or the
  runtime core.
- Duplicating `PRESENTER_COMMAND_KINDS`, `NAVIGATION_MODES`, beat-label
  parsing, or segment-label parsing.
- Reading mode from globals inside the keyboard source or timeline
  adapter.
- Implementing beat controls by mutating URL/history, browser storage,
  scene globals, or manifest data.
- Calling `cleanup(ctx)`, aborting navigation, or remounting scenes for
  `advance`, `hold`, or `skip-*`.
- Using `setTimeout`, polling, or wall-clock state to detect presenter
  commands.
- Treating skip as scrub or as arbitrary millisecond seek.
- Letting audio-owned commands, practice-overlay commands, or future UI
  commands leak into master-timeline transport behavior.
- Emitting raw remote/channel payloads into public diagnostics.
