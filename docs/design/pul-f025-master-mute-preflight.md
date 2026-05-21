# PUL-F025 Master Mute Preflight

PUL-F025 specifies presenter input that toggles master mute. Master
mute silences audio without changing timeline state.

This note is design guidance only. It is not an implementation plan.
No new ADR is needed. ADR-004 owns master mute as audio-engine runtime
state, ADR-023 owns the presenter command seam, ADR-024 owns
pause/resume transport semantics, and ADR-016 records the current
present-mode integration boundary.

The current repository already has the presenter command seam, browser
keyboard source, same-origin presenter bridge, GSAP composition
timeline adapter, and loader-side master-mute handler. Follow-up work
for issue #132 must harden and test those incumbents, not add a second
input, command, audio, or timeline path. Stale issue text that says a
surface is missing is not permission to add a duplicate surface.

## Current Boundary

Master mute must stay on the existing workbench -> presenter -> loader
-> audio path:

- `src/runtime/navigation.ts` owns URL grammar, `NAVIGATION_MODES`, and
  `effectiveMode()`. PUL-F025 adds no query key, mode, URL-derived mute
  state, or history mutation.
- `src/main.ts` is the browser composition root. It wires the keyboard
  source, same-origin presenter bridge, combined
  `PresenterCommandSource`, and `SceneLoaderOptions.presenterCommands`,
  and disposes those long-lived surfaces during Vite HMR teardown.
- `src/system/presenter/keyboard-source.ts` owns DOM keydown to
  `PresenterCommand` translation. `KeyM` maps to
  `toggle-master-mute` through `KeyboardPresenterBindings`; do not
  duplicate that map in the loader, runner, scenes, or tests.
- `src/system/presenter/bridge.ts` owns same-origin
  `BroadcastChannel` fan-out and `combinePresenterSources()`. It is a
  local workbench bridge, not an auth boundary or remote presenter
  protocol.
- `src/runtime/presenter.ts` owns the single command schema, command
  allowlist, shape guard, frozen defensive copy, handler isolation, and
  abort-tied controller cleanup.
- `src/runtime/scene-loader.ts` owns mode scoping and the PUL-F025
  audio subscriber. It builds a `PresenterController` only when
  `effectiveMode(target) === 'present'` and a source was supplied, then
  subscribes the loader-owned mute handler against the per-navigation
  `AudioService`.
- `src/runtime/audio.ts` owns master mute. The handler calls
  `AudioService.mute(!AudioService.isMuted())`, which delegates to the
  engine's master-mute state. Howler stays behind
  `createHowlerAudioEngine()`.
- `src/runtime/timeline.ts` owns timeline transport. It may subscribe
  to the same presenter controller for beat and pause/resume commands,
  but it ignores `toggle-master-mute`; audio-owned commands are not
  transport commands.
- `src/runtime/scene-navigation.ts` and
  `src/runtime/composition-resolver.ts` forward presenter state and own
  lifecycle cleanup. They do not interpret mute.

## Architecture Decisions

- Master mute is audio-owned runtime state, not scene state, timeline
  state, URL state, chrome state, storage state, or a composition
  behavior override.
- The command kind is `toggle-master-mute`: a presenter command is an
  input fact, not a target state. The audio handler reads current engine
  state at receipt time and flips it. Do not keep a second mute boolean.
- Presenter input is active only through the loader's effective
  `present` gate. Sources may exist globally, but non-present
  navigations do not build the controller and therefore cannot toggle
  mute through this path.
- The mute handler is additive, not a filter. The runner may still see
  `toggle-master-mute`, but must ignore it as not the master's concern.
- Master mute must not pause, resume, seek, repeat, kill, rebuild, or
  otherwise mutate the master timeline. Playback continues silently
  while muted and audibly after unmute.
- The PUL-Q010 responsiveness path is the synchronous loader-owned
  subscriber: accepted `toggle-master-mute` -> `audio.isMuted()` ->
  `audio.mute(...)` -> engine `setMasterMute(...)`. Do not insert
  timers, promises, fades, animation frames, runner hops, or UI status
  waits on that path.

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
- Presenter scoping and dispatch: `SceneLoaderOptions.presenterCommands`
  and the loader's `buildPresenterPipe` / per-navigation
  `AbortController` path.
- Audio boundary: `AudioService.mute()`, `AudioService.isMuted()`,
  `AudioEngine.setMasterMute()`, `AudioEngine.isMasterMuted()`,
  `createHowlerAudioEngine()`, and `noopAudioEngine`.
- Timeline boundary: `createGsapCompositionTimeline()` and
  `MasterTimeline` remain transport-only for presenter commands.
  `toggle-master-mute` is ignored there.
- Lifecycle orchestration: `loadSceneNavigationTarget()`,
  `resolveComposition()`, resolver cleanup, per-scene
  `onSceneCleaned`, and audio `stopGroup()` / `stopAll()` teardown.
  Master mute is not reset by those cleanup paths.
- Error rendering and diagnostics: presenter controller `onError`,
  loader `onError`, `describeErrorDetailed()`,
  `data-pulsar-navigation-error`, and `data-pulsar-scene-failures`.
- Structural validation: `validateRuntime()` over
  `WORKBENCH_SCENES` / `WORKBENCH_COMPOSITIONS`. Presenter mute does
  not bypass graph validation or create a deck-only registry path.
- Test locations and shapes: `tests/runtime/presenter.test.ts`,
  `tests/runtime/scene-loader-present.test.ts`,
  `tests/runtime/audio.test.ts`, `tests/runtime/audio-engine.test.ts`,
  `tests/system/presenter-keyboard.test.ts`, and
  `tests/system/presenter-bridge.test.ts`.

## Cross-Cutting Layers

| Layer | Canonical gate | Required behavior |
|-------|----------------|-------------------|
| URL grammar | `parseNavigationSearch()` | Add no `mute`, `muted`, `masterMute`, or presenter query keys. Unknown keys stay non-semantic; malformed canonical keys fail through the navigation error path. |
| Mode selection | `effectiveMode()` in the loader | Recompute mode per navigation. Treat absent mode as present through the helper, not by checking `target.mode === 'present'`. |
| Keyboard input | `createKeyboardPresenterSource()` | Translate only configured bindings, ignore editable targets, prevent default only for bound keys, and dispose the listener on HMR. `KeyM` remains the local mute binding unless `KeyboardPresenterBindings` is deliberately changed. |
| Cross-window input | `createPresenterBridge()` | Validate inbound channel data with `isPresenterCommand()`. Treat `BroadcastChannel` as same-origin convenience only; no tokens, secrets, source URLs, timeline state, scene objects, or raw audio data in channel names or messages. |
| Source composition | `combinePresenterSources()` | Merge sources once at the composition root. Avoid double-wiring the same keyboard source, which would duplicate toggles. |
| Command shape | `PRESENTER_COMMAND_KINDS` / `isPresenterCommand()` | Keep `toggle-master-mute` on the existing allowlist. Do not add `mute`, `unmute`, `master-mute`, a second schema, or a second validator. |
| Command payload safety | `createPresenterController()` | Fan out one frozen defensive copy per accepted emission, isolate throwing subscribers, and auto-detach on abort/completion. |
| Auth surface | None in this repo | Do not add HTTP/WebSocket/remote control for PUL-F025. A future remote source must authenticate and authorize before emitting into `PresenterCommandSource`. |
| Secret/config/env surface | Existing browser bootstrap and package scripts | No env vars, config files, CLI flags, process argv tokens, shell commands, files, cookies, localStorage, sessionStorage, credentials, or persistent browser state are needed. |
| Audio source validation | `AudioService` / `resolveAssetUrl()` | Mute does not register or resolve sources. Do not re-check scene audio declarations at command time or route mute through asset allowlists. |
| Audio engine boundary | `AudioService` -> `AudioEngine` | Silence through engine master mute. Do not import Howler outside `src/runtime/audio.ts`, iterate sounds in the loader, fade, stop, unload, or rebuild services. |
| Timeline transport | `MasterTimeline` in `src/runtime/timeline.ts` | Timeline state is untouched. The runner ignores audio-owned commands and audio code does not inspect beat, pause, or skip commands. |
| Lifecycle and cleanup | Loader abort + resolver cleanup | `toggle-master-mute` does not abort, remount, call `cleanup(ctx)`, stop groups, or complete the navigation. Post-abort commands are inert through existing cleanup. |
| Error envelope | Presenter `onError`, loader `onError`, `describeErrorDetailed()` | Malformed commands and handler failures use existing diagnostics. Do not serialize raw future remote payloads, stacks, DOM nodes, scene objects, captions, cookies, headers, env, auth values, source URLs, GSAP instances, Howler handles, or audio buffers. |
| Observability | Existing tests and optional `onError` diagnostics | Do not add per-command logs, analytics, stage attributes, or visible mute status until a concrete UI/status requirement needs them. |

## Extensibility

- New keyboard mappings belong in `KeyboardPresenterBindings` and tests
  for `createKeyboardPresenterSource()`, not in the loader, runner, or
  scene modules.
- Additional local input devices or on-screen controls should implement
  `PresenterCommandSource` and be merged once at the composition root.
  They should not call `AudioService` or `MasterTimeline` directly.
- Future remote presenter protocols must authenticate and authorize
  before emitting into `PresenterCommandSource`; the presenter
  controller remains the local shape gate, not the security boundary.
- Future explicit target-state mute should extend `PresenterCommand` as
  a discriminated union, for example `set-master-mute` with
  `muted: boolean`, and update `isPresenterCommand()` in the same
  module. The behavior still belongs behind `AudioService`.
- Future presenter audio controls such as bus volume, ducking, or
  per-output routing extend the audio service seam. They do not expose
  Howler handles, mutate timeline state, or create a second command bus.
- Future mute status UI needs a separate audio/workbench status surface.
  Do not overload `PresenterCommandSource`, URL grammar, timeline
  labels, cue logs, or error attributes as a state store.
- L2-only commands such as `toggle-practice` may ride the same command
  bus only with explicit ownership. Runtime audio and timeline code
  must ignore unrelated commands.

## Gotchas

- Issue text may be stale. In this checkout keyboard, bridge, timeline
  command plumbing, and loader-side mute dispatch already exist;
  evaluate the live incumbents before adding anything.
- Toggle semantics read engine state at command receipt time. A cached
  loader/UI boolean will desynchronize across services, navigations,
  and repeated toggles.
- `stopAll()`, scene cleanup, navigation completion, and composition
  handoff must not reset master mute. It is engine-level runtime state.
- Source-level validation and controller-level validation are both
  useful. Do not remove the controller guard because keyboard or bridge
  sources currently emit typed objects.
- Same-origin `BroadcastChannel` delivery is asynchronous and may be
  unavailable. It must stay inert when unsupported and must not become a
  security boundary by implication.
- Double-wiring the keyboard source or bridge turns one key press into
  two toggles, which nets to no audible change. Source composition is a
  single composition-root responsibility.
- The loader-owned mute subscriber must stay before runner subscribers
  on the controller fan-out path so slow or throwing runner handlers do
  not delay the PUL-Q010 mute flip.
- `toggle-master-mute` is accepted even before any sound is registered.
  `noopAudioEngine` must round-trip mute state the same way the Howler
  engine does.

## Non-Goals

PUL-F025 should not implement new URL grammar, a new workbench mode,
new scene or composition schemas, a second keyboard listener, a second
presenter bridge, remote presenter auth, visible mute UI, telemetry,
persistence, traceability automation, requirement status transition,
volume buses, ducking, per-scene mute, export audio, scrub cue gating,
or audio unlock behavior.

It should not redesign PUL-F020 beat controls, PUL-F021 pause/resume,
present-mode chrome, command transport, lifecycle, validation, or the
audio service. The implementation may touch existing seams only to
reuse or harden them.

## Anti-Patterns

- Adding `mute=true`, `muted`, or `masterMute` URL parameters, history
  state, storage keys, cookies, config flags, env vars, or process argv
  state.
- Importing Howler outside `src/runtime/audio.ts`.
- Adding scene-local mute booleans, hidden `<audio>` controls, raw Web
  Audio mute code, or deck-local audio buses for ordinary mute.
- Implementing silence by pause, resume, hold, seek, fade, stop,
  unload, navigation abort, scene remount, `cleanup(ctx)`, or timeline
  mutation.
- Duplicating `PRESENTER_COMMAND_KINDS`, `DEFAULT_KEYBOARD_BINDINGS`,
  `NAVIGATION_MODES`, audio output policies, source URL validation, or
  error rendering.
- Adding `MuteCommandSource`, `MuteController`, `MuteError`, a second
  event type, a second command validator, or a mute-specific workflow
  path.
- Letting audio-owned commands, practice-overlay commands, or future UI
  commands leak into master-timeline transport behavior.
- Emitting raw remote/channel payloads into public diagnostics.
