# Issue 162 Single Control Plane Preflight

Date: 2026-06-07

Issue 162 is a runtime re-architecture. It replaces the GSAP master
timeline execution model with one imperative control plane while
preserving the L2 scene library and the existing scene/composition
authoring contracts where they still carry value.

This document is architecture guidance only. It is not an implementation
plan.

## Boundary

- Keep `SceneModule`, scene registries, composition registries, and
  composition manifests as the declaration and validation boundary.
- Keep `src/system/chrome`, `src/system/templates`, and
  `src/system/helpers` as the L2 authoring layer.
- Replace the runtime execution spine: no `composeMasterTimeline`, no
  master `addPause` advance gate, no timeline-runner mode hints, and no
  fire-and-forget async body running beside a master timeline.
- Present mode runs the ordered manifest through one scene activation at
  a time. Prompter remains the captions-only lifecycle bypass.
- GSAP remains a per-scene animation library injected through `ctx.gsap`;
  it must not sequence scenes.
- Howler remains behind the runtime audio boundary, but the scene-facing
  service should be the thin bed/cue/fade/stop surface used by decks.

## Required Reuse

Implementation must build on these incumbents:

- Scene schema: `SceneModule`, `defineScene`, `assertSceneModule()`,
  `sceneDeclaresAudio()`.
- Composition schema: `CompositionManifest`,
  `assertCompositionManifest()`, `entryId()`,
  `findUnregisteredEntries()`, `createCompositionRegistry()`.
- Registry shape: `createSceneRegistry()`, `createIdRegistry()`,
  kebab identity via `isKebabIdentifier()` and `KEBAB_IDENTIFIER_FORM`.
- Navigation boundary: `parseNavigationSearch()`,
  `validateBeatGrammar()`, `validateModeGrammar()`, `effectiveMode()`,
  `resolveSceneNavigation()`, and stage diagnostics in
  `createSceneLoader()`.
- Validation: `validateRuntime()` and `assertNoValidationFindings()`.
  Do not add a second graph validator for the new control plane.
- Lifecycle/error surface: `SceneActivation`, `SceneFailureEvent`,
  `describeError()`, `describeErrorDetailed()`, `formatSceneContext()`,
  `onError`, `AggregateError`, and `Error.cause`.
- Scene context: `WorkbenchSceneCtx`, `buildNavigationServices()`,
  `ctx.stage`, `ctx.chrome`, `ctx.audio`, `ctx.presenter`, `ctx.gsap`,
  `ctx.rng`, and `ctx.activation`.
- Presenter boundary: `PRESENTER_COMMAND_KINDS`, `PresenterCommand`,
  `isPresenterCommand()`, `PresenterCommandSource`,
  `PresenterController`, and `createPresenterController()`.
- Audio boundary: `createAudioService()`, `AudioService.stopGroup()`,
  `AudioService.stopAll()`, `createHowlerAudioEngine()`,
  `noopAudioEngine`, `AudioError`, `AUDIO_OUTPUT_POLICIES`, and
  `resolveAssetUrl()`.
- Asset policy: `scene.assets`, `scene.audio`,
  `createAssetPreloader()`, `AssetUrlPolicy`,
  `DEFAULT_ALLOWED_SCHEMES`, and post-redirect scheme re-checks.
- Chrome/presenter L2: `mountChromeSlots()`, `createDomWorkbenchChrome()`,
  `createKeyboardPresenterSource()`, `createPresenterBridge()`,
  `combinePresenterSources()`, and existing chrome helpers.
- Test gates: Vitest runtime/system suites, source-policy suites under
  `pnpm policy`, Playwright browser tests under `pnpm test:browsers`,
  plus `pnpm lint` and `pnpm typecheck`.

## Cross-Cutting Layers

| Layer | Guardrail |
|-------|-----------|
| Scene trust model | Scene modules remain trusted repo-owned code. Do not claim the new control plane sandboxes scene bodies. `docs/scene-trust-model.md` remains binding. |
| Scene schema gate | `assertSceneModule()` remains the one scene-shape validator. If the async body needs an adapter, put it in one L2/runtime helper that returns a valid `SceneModule`; do not add `ImperativeSceneModule`, `RunnableScene`, or a parallel registry. |
| Composition graph | Keep manifests declarative and ordered. No `next()` callbacks, per-scene flow control objects, hidden scene lists, or dynamic registration. |
| URL grammar | URL parsing remains in `navigation.ts`. Removing speculative modes must update `NAVIGATION_MODES`, mode validation, docs, tests, and chrome/audio policy together. Do not store mode, pause, or advance state in URL/history/storage. |
| Runtime validation | `validateRuntime()` remains pure metadata validation. It must not execute scene bodies, fetch assets, inspect function source, or prove code safety. |
| Asset security | Audio and other resources continue through `scene.assets`, `scene.audio`, `resolveAssetUrl()`, `baseUrl`, `allowedSchemes`, and the preloader. Do not introduce `audioSrc`, arbitrary `play(url)`, or bed URLs outside the existing policy. |
| Audio unlock | Present-mode audio unlock stays at the loader/workbench boundary before audio-bearing lifecycle work. Scenes do not create unlock buttons or touch Howler globals. |
| Presenter commands | Every command passes `isPresenterCommand()`. The control plane consumes sanitized commands; scenes do not install keyboard listeners, direct `BroadcastChannel` listeners, or second command schemas. |
| Lifecycle/cancellation | One activation control plane owns sleep, advance, abort, and teardown. `AbortSignal` means navigation supersession/dispose, not pause/resume. Sleep helpers must subscribe once and unregister; no polling loops. |
| DOM/chrome | Workbench chrome is persistent and workbench-owned. Scene cleanup must wipe only scene-owned DOM/chrome slots for that activation; it must not clear the whole document or remove the chrome surface. |
| GSAP | Scene animation may use `ctx.gsap`. No scene imports GSAP directly, and no runtime master timeline sequences scenes or owns presenter advance. Kill or revert scene-local animations through the activation disposal registry. |
| Audio teardown | Scene audio reaches Howler only through `ctx.audio`. The control plane must fade/stop/unload scene audio on scene exit and stop all navigation audio on supersession. No raw `<audio>` or Howler handles in ordinary scenes. |
| Error envelope | Public diagnostics may include ids, phases, mode, composition/index, and bounded messages. Do not serialize raw scene objects, DOM nodes, captions, headers, cookies, env, auth values, stacks, Howler handles, GSAP timelines, or raw `cause`. |
| Observability | Use `onError`, stage attributes, and rendered-state tests. Do not add telemetry, per-frame logs, resource dumps, or high-cardinality diagnostics without a separate telemetry policy. |
| OS/config exposure | No env vars, process argv tokens, shell commands, temp files, browser storage, cookies, or hidden config are needed for control-plane state. Keep state in memory and activation-scoped. |
| Source policy | Existing A001/A002/A008/Q001/Q007 scans are canonical. Widen scene-module scan scope where needed so `src/decks/**/scenes/**` follows the same rules as `src/scenes/**`. |

## Intended Design Guardrails

- The control-plane context should expose `sleep(ms)` and an
  advance-aware wait primitive that are already abort-bound. Scene code
  should not call `aSleep(ms, { controller })`, thread controllers
  through every dwell, or poll `signal.aborted` between beats.
- Disposal should be activation-scoped and deterministic. It should own
  timers, intervals, event listeners, GSAP animations/tweens, audio
  groups/handles, chrome wipes, and explicit disposables.
- `SceneActivation` is the identity parameter. Repeated scene ids must
  not collide on DOM, audio, listener, rng, or disposal ownership.
- The L2 `presenterDrivenScene` helper should become a compatibility
  bridge to the control plane or be replaced by a helper with the same
  authoring benefit. It must not keep the old master-label gate or
  fire-and-forget body.
- Tests should assert post-advance rendered state: no active outgoing
  DOM/chrome content, no live timers/listeners registered by the scene,
  no scene audio still registered or playing, and no stale async body
  mutating the next scene.
- Policy tests that currently lock in the deleted layer should be
  removed or rewritten around the new invariants, not carried forward as
  compatibility anchors.

## Extensibility

The seam for the next reasonable change is the scene activation control
plane, parameterized by `SceneActivation`.

Future variations should extend that one seam:

- audio ducking, crossfade, or buses as `AudioService` capabilities;
- richer presenter controls as new `PresenterCommand.kind` variants
  validated in `presenter.ts`;
- visual inspection or export as explicit control-plane run policies
  chosen at the loader boundary;
- untrusted scenes as a separate import/execution model with a
  capability-reduced context, not per-scene booleans.

Do not spread future variation across scene schema branches, URL state,
mode-specific scene code, duplicated validators, or global maps.

## Gotchas

- `local-calgary-v2` is under `src/decks/local-*`. Whole-tree policy
  gates scoped only to `src/scenes/**` will not protect the proof deck.
- `fadeAndStop()` currently schedules a post-fade `setTimeout`.
  Scene-exit teardown must either own that timer or move the behavior
  behind the audio service so it cannot fire after disposal.
- Helper-level async animations (`typeInto`, topology loops, intervals,
  staggered chrome effects) need disposal registration. Fixing only the
  top-level scene loop is insufficient.
- `cleanup(ctx)` can throw, and partial `create` can allocate resources
  before throwing. Preserve the existing isolation and aggregate-error
  behavior while adding automatic teardown.
- Audio source membership and unlock predicates depend on `scene.audio`
  being a subset of `scene.assets`. Do not reintroduce a second audio
  inventory while slimming `audio.ts`.
- Workbench chrome must not be torn down between scenes in a composition.
  Scene exit wipes slots/content, not the chrome root.
- Existing Playwright specs for loop/paused/scrub/screenshot express
  now-deleted contracts. Remove or quarantine them with the mode removal
  instead of making the new control plane emulate them.

## Anti-Patterns

- Keeping `composeMasterTimeline`, `ADVANCE_GATE_LABEL`, or master
  labels as hidden sequencing.
- Starting scene bodies with `void run()` and hoping cleanup flips a
  flag they poll.
- Hand-threading a presenter controller or abort controller into every
  sleep call.
- Adding `try/finally` boilerplate to every scene for runtime-owned
  audio/chrome/timer cleanup.
- Importing GSAP or Howler in scene modules, or constructing raw
  `<audio>` elements.
- Adding duplicate scene, composition, audio, presenter, or mode
  validators.
- Adding a new exception hierarchy for control-plane teardown.
- Treating tests of helper internals as proof of rendered teardown.
- Reintroducing screenshot/scrub/loop/paused behavior while claiming the
  master timeline is gone.
- Persisting control-plane state in URL parameters, `history.state`,
  localStorage, sessionStorage, cookies, env vars, or files.

## Non-Goals

- No new deck content.
- No third-party scene sandbox, plugin loader, marketplace, upload flow,
  remote presenter protocol, auth system, telemetry stream, persistence
  format, or export renderer.
- No reintroduction of scrub, screenshot, loop, paused, standalone, or
  rehearsal modes in this change.
- No generic mode-policy framework beyond what remains necessary for
  `present` and `prompter`.
- No second scene schema, composition manifest shape, asset inventory,
  audio declaration DTO, presenter command bus, or validation pass.
- No requirement status transition or traceability automation during
  this preflight.
