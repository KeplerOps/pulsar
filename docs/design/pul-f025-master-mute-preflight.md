# PUL-F025 Master Mute Preflight

PUL-F025 specifies presenter input that toggles master mute. Master
mute silences audio without changing timeline state.

No new ADR is needed for this preflight. ADR-004 already owns master
mute as runtime audio-engine state, and ADR-023 / ADR-024 already own
the presenter command source, validation, mode scoping, and abort-tied
subscription cleanup. PUL-F025 composes those two incumbents.

## Boundary

Master mute must stay on the existing runtime path:

- `src/runtime/presenter.ts` owns presenter command kinds, command
  shape validation, handler isolation, and abort-tied cleanup. Add the
  master-mute command there; do not create an audio-specific command
  bus, validator, controller, or event type.
- `src/runtime/scene-loader.ts` is the only runtime seam that has both
  the per-navigation `PresenterController` and the per-navigation
  `AudioService`. It is the correct place to bind accepted presenter
  mute input to `audio.mute(!audio.isMuted())`.
- `src/runtime/audio.ts` owns master mute. The implementation must call
  `AudioService.mute()` / `isMuted()` and let the service delegate to
  `AudioEngine.setMasterMute()`. Do not import Howler or call
  `Howler.mute()` outside the audio boundary.
- `src/runtime/timeline.ts` owns timeline transport. Master mute must
  not pause, seek, repeat, kill, rebuild, or otherwise mutate the
  master timeline.
- `src/runtime/navigation.ts` owns URL grammar. PUL-F025 adds no query
  parameter, no mode, no persisted mute state, and no history mutation.
- `src/runtime/scene-navigation.ts` and
  `src/runtime/composition-resolver.ts` remain lifecycle/pass-through
  layers. They should not learn audio mute semantics.

The intended command kind is `toggle-master-mute`: a presenter command
is an input fact, not timeline state. The runtime audio handler toggles
the engine's current master-mute state at command receipt time.

## Required Reuse

Use these canonical incumbents:

- Presenter input schema: `PRESENTER_COMMAND_KINDS`,
  `PresenterCommand`, `isPresenterCommand`,
  `PresenterCommandSource`, `PresenterController`, and
  `createPresenterController`.
- Presenter mode gate: `effectiveMode()`,
  `SceneLoaderOptions.presenterCommands`, and the loader's existing
  `mode === 'present'` controller construction.
- Audio service: `AudioService.mute()`, `AudioService.isMuted()`,
  `AudioEngine.setMasterMute()`, `AudioEngine.isMasterMuted()`,
  `createHowlerAudioEngine()`, and `noopAudioEngine`.
- Lifecycle and cleanup: the existing per-navigation
  `AbortController.signal`. The mute subscription must be tied to the
  same controller cleanup as every other presenter subscription.
- Error handling: the presenter controller's existing handler
  try/catch and loader `onError` diagnostic sink. Do not add a mute
  exception hierarchy or navigation failure envelope.
- Tests: the existing presenter boundary tests, scene-loader presenter
  seam tests, and audio service / engine tests. Keep mute behavior
  covered at the seam where it lives.

## Cross-Cutting Layers

| Layer | Requirement for PUL-F025 |
|-------|--------------------------|
| URL grammar / mode validation | `NAVIGATION_MODES`, `parseNavigationSearch()`, `effectiveMode()`, and loader-side mode validation remain unchanged. Presenter mute is active only when the loader builds presenter controls for effective `present`. |
| Presenter command shape | Extend the existing command allowlist with `toggle-master-mute`. Keep `isPresenterCommand` as the only boundary validator and keep emitted commands flat/frozen. |
| Auth / remote input | No auth surface exists in this repo. A future remote presenter protocol must authenticate/authorize before emitting into `PresenterCommandSource`; the controller still shape-checks every emitted command. |
| Audio boundary | The handler calls `AudioService.mute()` / `isMuted()`. Howler remains hidden behind `createHowlerAudioEngine()` in `audio.ts`. |
| Timeline state | The handler must not touch `MasterTimeline`, runner hints, URL beat, pause/resume state, `AbortController`, or `cleanup(ctx)`. Existing playback continues silently while muted and continues audibly when unmuted. |
| Lifecycle / cleanup | Presenter subscriptions auto-detach on navigation abort. Master mute state is engine-level runtime state and is not reset by per-navigation `stopAll()` or scene cleanup. |
| Error envelopes | Malformed commands are dropped at the presenter controller and reported through `onError`. A mute-handler exception is non-fatal and must not become `composition resolution failed:` or unmount the scene. Do not include raw future remote payloads in diagnostics. |
| Config / env / OS exposure | No env vars, config files, process argv tokens, URLs, cookies, localStorage, sessionStorage, files, or shell commands are needed. Do not persist mute state or presenter secrets. |
| Observability | Reuse `onError` for diagnostics. Do not add stage attributes, analytics, or per-command logs for mute state until a concrete UI/status requirement needs them. |

## Guardrails

- Master mute is audio-owned runtime state, not a scene flag, URL mode,
  timeline label, composition behavior override, or transport command.
- Toggle semantics read the current engine state at receipt time. Do
  not keep a second boolean in the loader, runner, UI, scene, or
  browser storage.
- Presenter input remains scoped to `mode=present`. Do not let mute
  commands leak into standalone, loop, paused, scrub, screenshot, or
  prompter navigations.
- The command is accepted even before any sound has been registered.
  `noopAudioEngine` must round-trip the mute state the same way the
  Howler engine does.
- The timeline runner may ignore audio-owned commands. It must not
  interpret `toggle-master-mute` as pause, hold, cue gating, speed,
  seek, or scene navigation.
- Do not add visible mute indicators, keyboard listeners, remote
  protocols, or workbench chrome in PUL-F025 unless a separate
  requirement supplies that surface.

## Extensibility

The extension seam is `PresenterCommand.kind` plus the audio service
target. Future presenter audio controls should extend the same command
schema in `src/runtime/presenter.ts` and dispatch to `AudioService`,
not add a second input bus.

If a future command needs data, extend `PresenterCommand` as a
discriminated union with kind-specific fields and update
`isPresenterCommand` in the same module. Examples: explicit
`set-master-mute` with a `muted` boolean, bus volume, ducking, or
rehearsal cue logging. The parameter belongs on the command payload
and the behavior belongs behind `AudioService`; it must not leak
Howler handles or timeline internals.

If a future UI needs mute status, add a separate status/read surface
from audio/workbench state. Do not overload `PresenterCommandSource`,
URL grammar, stage error diagnostics, or timeline labels as a state
store.

## Non-Goals

PUL-F025 should not implement keyboard listeners, on-screen controls,
remote presenter protocol, auth, telemetry, persistence, mute UI
status, per-scene volume, ducking, bus volume, scrub cue gating,
export mixdown, or requirement status transition. It should not change
scene schemas, composition schemas, URL grammar, asset preload rules,
or the resolver lifecycle.

## Anti-Patterns

- Adding `mute=true` / `muted` URL parameters, storage keys, cookies,
  config flags, or history state.
- Importing Howler outside `src/runtime/audio.ts`.
- Adding scene-local mute booleans, hidden `<audio>` controls, or raw
  Web Audio mute code for ordinary scenes.
- Implementing mute by pausing or killing the timeline.
- Implementing mute by aborting navigation, remounting scenes, or
  calling `cleanup(ctx)`.
- Duplicating presenter command validation or adding
  `MuteCommandSource` / `MuteController`.
- Reusing `hold`, `pause`, `mode=paused`, `headCueGate`, or
  screenshot silence semantics for master mute.
- Resetting master mute on scene cleanup or navigation completion.
