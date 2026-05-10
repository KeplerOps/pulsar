# PUL-F021 Pause and Resume Preflight

PUL-F021 specifies live presenter input: pause the active timeline and
resume from the same point. It is a presenter transport requirement
under `mode=present`; it is not `mode=paused`, not beat hold, and not
scrub.

ADR-024 records the binding architecture decision: extend the existing
presenter command seam from ADR-023. Do not add a pause-specific input
surface or lifecycle path.

## Boundary

Pause/resume must flow through the existing runtime path:

- `src/runtime/navigation.ts` owns URL grammar. PUL-F021 adds no query
  parameter, no mode, and no URL-derived pause state.
- `effectiveMode()` owns mode derivation. Presenter pause/resume is
  available only under effective `present`.
- `src/runtime/scene-loader.ts` owns per-navigation mode dispatch and
  builds the presenter controller only when `mode=present` and the
  workbench supplied a `presenterCommands` source.
- `src/runtime/presenter.ts` owns command kinds, command shape
  validation, boundary diagnostics, handler isolation, and abort-tied
  subscription cleanup.
- `src/runtime/scene-navigation.ts` and
  `src/runtime/composition-resolver.ts` only forward `presenter`; they
  do not interpret pause/resume.
- The timeline runner owns transport behavior. For GSAP this means
  native pause/resume from the current playhead position.

Do not call `loader.handle()`, abort the navigation, invoke
`cleanup(ctx)`, remount the scene, mutate URL/history, or persist a
pause point to satisfy pause/resume.

## Required Reuse

Implementation must reuse these incumbents:

- URL and mode validation: `parseNavigationSearch()`,
  `NAVIGATION_MODES`, `effectiveMode()`, and loader-side
  `validateModeGrammar`.
- Presenter input schema: `PRESENTER_COMMAND_KINDS`,
  `PresenterCommand`, `isPresenterCommand`, `PresenterCommandSource`,
  `PresenterController`, and `createPresenterController`.
- Presenter scoping and cleanup: `SceneLoaderOptions.presenterCommands`
  plus the existing loader -> bridge -> resolver forwarding chain.
- Lifecycle orchestration: `loadSceneNavigationTarget()` and
  `resolveComposition()`. Pause/resume must not add a parallel
  cleanup path.
- Error handling: existing plain `Error` diagnostics through the
  presenter controller's `onError` sink. No pause-specific exception
  hierarchy.
- Runner contract: ADR-003's GSAP transport API (`pause()` and
  resumed `play()` from the current playhead). Do not hand-roll
  timers or scene-local pause flags.
- Test locations and shapes: `tests/runtime/presenter.test.ts` for the
  command boundary; `scene-loader.test.ts`, `scene-navigation.test.ts`,
  and `composition-resolver.test.ts` for seam forwarding; the future
  GSAP runner tests for same-point behavior.

## Cross-Cutting Layers

| Layer | Requirement for PUL-F021 |
|-------|--------------------------|
| URL grammar | No new key. `mode=paused` remains first-frame inspection. Unknown URL keys stay ignored by `parseNavigationSearch()`. |
| Mode gate | `NAVIGATION_MODES` is unchanged. The loader builds presenter control only for effective `present`. |
| Command shape gate | Extend `PRESENTER_COMMAND_KINDS` with `pause` and `resume`. Keep `isPresenterCommand` as the only validator. |
| Command payload safety | Commands stay flat and discriminator-based. Do not forward arbitrary objects to the runner. Freeze the emitted command copy as today. |
| Auth surface | None in this repo. Do not add HTTP/WebSocket/remote control for PUL-F021. A future remote source must authenticate before emitting into `PresenterCommandSource`. |
| Secret/config/env surface | None. No env vars, process argv tokens, config files, localStorage, sessionStorage, cookies, or `history.state` are involved. |
| OS-level exposure | None. Do not put presenter tokens or pause state in process argv, URLs, files, or shell commands. |
| Lifecycle and cleanup | `AbortSignal` still means navigation supersession/dispose. `pause` and `resume` do not abort and do not trigger cleanup. |
| Error envelope | Invalid commands and handler exceptions use the presenter controller's existing `onError` path. Do not include raw future payloads in error text. |
| Observability | Do not add `data-pulsar-mode-*` or pause-state stage attributes until a concrete UI/status requirement needs them. |

## Guardrails

- Add `pause` and `resume` to the existing command union; do not create
  `PauseCommandSource`, `PauseController`, a second event type, or a
  parallel validator.
- Pause/resume is not a sticky state. If no scene runner is active
  (for example during preload before any runner subscribed), the
  command has no active timeline to affect. Do not queue pause for the
  next scene unless a future requirement says so.
- Pause while already paused and resume while already playing are
  idempotent. They should not surface errors to presenters.
- Navigation abort wins over pause state. After abort, presenter
  controller cleanup drops later commands and the resolver still owns
  exactly-once cleanup.
- Same-point resume means the active timeline instance's current
  playhead. It does not mean first frame, last beat, URL `beat=`, or a
  persisted checkpoint.
- Pause/resume composes with — does not override — the PUL-F020
  beat-pacing commands (`hold` / `advance` / `skip-forward` /
  `skip-backward`). `pause` snapshots beat-pacing state and freezes
  the playhead; `resume` restores both without clearing a prior
  `hold`. Only `resume` unfreezes transport — `advance` / `hold` /
  `skip-*` received while paused update the state `resume` will
  restore but never implicitly resume. ADR-024 *Cross-command
  precedence* is the binding rule the GSAP runner and its tests must
  honor; do not let seam-only delivery imply a particular composition
  behavior.
- `presenter` stays every-scene under `mode=present`; do not make it
  head-only and do not truncate composition slices for pause/resume.
- The placeholder runner can ignore pause/resume until the GSAP runner
  lands. That keeps PUL-F021 DRAFT; do not claim ACTIVE on seam-only
  delivery.

## Extensibility

The extension point is `PresenterCommand.kind`. If a future presenter
command needs data, extend `PresenterCommand` as a discriminated union
with kind-specific fields and update `isPresenterCommand` in the same
module. Do not add a second command schema.

If a future UI needs to display paused/playing state, add a separate
runner-to-workbench status surface. Do not overload
`PresenterCommandSource`, URL mode, or stage diagnostics as a state
store.

## Non-Goals

PUL-F021 should not implement the keyboard listener, on-screen
presenter UI, remote presenter protocol, GSAP runner, master mute,
scrub controls, `mode=paused`, persistence, status indicators, or
requirement status transition. It should not change scene or
composition schemas.

## Anti-Patterns

- Treating `pause` as `mode=paused`.
- Reusing the PUL-F020 `hold` command for resumable pause.
- Treating `resume` as a `hold` release, or treating `advance` /
  `skip-*` received while paused as an implicit `resume` — only
  `resume` unfreezes transport (ADR-024 *Cross-command precedence*).
- Implementing pause by aborting the navigation and later recreating
  the scene.
- Storing the playhead in URL/history/localStorage to support resume.
- Adding scene-local `if (paused)` branches or raw timer gates.
- Adding a duplicate exception hierarchy or duplicate command
  validator.
- Letting pause/resume commands leak into non-present modes.
