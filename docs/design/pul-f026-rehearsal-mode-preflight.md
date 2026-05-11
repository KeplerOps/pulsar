# PUL-F026 Rehearsal Mode Preflight

PUL-F026 specifies a rehearsal mode in which runtime audio is silenced
or logged as cues without altering timeline state. This is an
audio-output policy for author rehearsal. It is not master mute,
paused mode, scrub cue gating, screenshot capture, presenter input,
or a new timeline lifecycle.

ADR-004 already owns rehearsal as an audio-service capability. The
implementation should add the smallest workbench-mode contract needed
to select it and keep all audio behavior behind `ctx.audio`.

## Boundary

Rehearsal must stay on the existing runtime path:

- `src/runtime/navigation.ts` owns URL mode grammar. If rehearsal is
  URL-addressable, add `mode=rehearsal` to `NAVIGATION_MODES` and let
  `parseNavigationSearch()` / `effectiveMode()` remain the only mode
  parser/defaulting path.
- `src/runtime/scene-loader.ts` owns mode dispatch and per-navigation
  `ctx` construction. It is the correct place to map effective
  `rehearsal` to an audio output policy when calling
  `createAudioService()`.
- `src/runtime/audio.ts` owns audible playback, silent playback, and
  cue logging. Rehearsal must be implemented in `AudioService` /
  `AudioServiceOptions`, not by importing Howler elsewhere, muting the
  engine globally, or adding scene-local audio code.
- `src/runtime/timeline.ts` owns master timeline transport. Rehearsal
  must not pause, seek, repeat, kill, retime, or rebuild the master.
  It should run through the same timeline state transitions the
  equivalent non-rehearsal navigation would run.
- `src/runtime/scene-navigation.ts` and
  `src/runtime/composition-resolver.ts` remain mode-opaque lifecycle
  layers. They should not learn rehearsal semantics or add a
  rehearsal-specific lifecycle branch.
- `src/runtime/presenter.ts` is not the selector for rehearsal. Do not
  model rehearsal as a presenter command or by reusing
  `toggle-master-mute`.

Rehearsal should not use the single-scene truncation path unless a
separate requirement says so. For a composition target, it should
preserve the same scene slice and timeline progression as normal
playback from that target; only audio output changes.

## Required Reuse

Implementation must reuse these canonical incumbents:

- URL grammar and mode validation: `NAVIGATION_MODES`,
  `parseNavigationSearch()`, `effectiveMode()`, and the loader's
  `validateModeGrammar()` defense-in-depth check.
- Scene/composition contracts: `SceneModule`, `assertSceneModule()`,
  `createSceneRegistry()`, `assertCompositionManifest()`, and
  `createCompositionRegistry()`.
- Navigation and lifecycle: `resolveSceneNavigation()`,
  `loadSceneNavigationTarget()`, `resolveComposition()`, one
  per-navigation `AbortController.signal`, and resolver-owned cleanup.
- Timeline state: `createGsapCompositionTimeline()`,
  `MasterTimeline`, `composeMasterTimeline()`, and the existing normal
  run path. Rehearsal adds no `headHold`, `headRepeat`, `headCueGate`,
  or `headScreenshot` hint.
- Audio boundary: `AudioService`, `createAudioService()`,
  `AudioServiceOptions`, `AudioEngine`, `createHowlerAudioEngine()`,
  and `noopAudioEngine`. Keep Howler hidden in `audio.ts`.
- Audio validation: `assertSoundDefinition()`, `assertPlayOptions()`,
  `isKebabIdentifier()`, `KEBAB_IDENTIFIER_FORM`, range checks,
  sprite checks, group validation, and `allowedSources`.
- Asset security: `scene.assets`, `collectAudioSources()`,
  `createAssetPreloader()`, `resolveAssetUrl()`,
  `DEFAULT_ALLOWED_SCHEMES`, redirect re-checks, `baseUrl`, and fetch
  `AbortSignal` wiring.
- Error and observability: `describeError()`, loader `onError`, and
  `data-pulsar-navigation-error`. Cue logging must use an explicit
  bounded sink, not ad hoc `console.log` calls scattered through the
  timeline or scenes.
- Tests: extend existing navigation mode tests, scene-loader mode
  seam tests, audio service tests, and timeline non-mutation tests.
  Do not create a parallel rehearsal harness.

## Cross-Cutting Layers

| Layer | Guardrail |
|-------|-----------|
| URL grammar / mode validation | `mode=rehearsal` must be accepted only through `NAVIGATION_MODES` and rejected everywhere the existing parser/loader rejects unknown modes. No `rehearsal=true`, `audio=silent`, or duplicate parser. |
| Programmatic navigation | Loader-side `validateModeGrammar()` must reject hand-built targets with unknown modes before `buildCtx` receives them. |
| Scene and composition schemas | No new scene field, composition behavior key, cue schema, or manifest override is needed. Existing scene assets and timeline callbacks remain the source of audio cue calls. |
| Asset security | Rehearsal audio sources still must be declared in `scene.assets`, pass `resolveAssetUrl()` scheme checks, and belong to `allowedSources`. Cue logs must not include raw source URLs, credentials, cookies, or request headers. Log semantic ids only. |
| Audio shape validation | `ctx.audio.load()` / `play()` / `fade()` / `stop()` keep the existing sound id, sprite, group, volume, and range checks. Log only after the same boundary validation that audible playback uses. |
| Audio output policy | Rehearsal is per-navigation audio-service state. Do not implement it by calling `AudioService.mute(true)`, `Howler.mute(true)`, changing engine master mute, or resetting master mute on completion. |
| Timeline state | The master timeline should see the same run mode as non-rehearsal playback for the same target. No rehearsal-specific seek, pause, repeat, speed, label, cleanup, or abort behavior. |
| Lifecycle / cleanup | Audio services remain bound to the navigation `AbortSignal`; `stopGroup(sceneId)` and `stopAll()` keep their existing cleanup guarantees. Cue logging must stop when the service is disposed. |
| Error envelopes | Synchronous audio contract violations keep existing `AudioError` subclasses and resolver wrapping. Non-fatal async audio failures still route through `onError`. Do not add a rehearsal exception hierarchy or leak raw cue payloads in errors. |
| Auth / remote input | No auth surface exists in this repo for rehearsal. If future remote rehearsal controls arrive, authenticate before emitting into existing command/workbench seams; keep local shape validation at the boundary. |
| Config / env / OS exposure | No env vars, process argv tokens, CLI flags, files, cookies, localStorage, sessionStorage, or history state are needed. Do not expose rehearsal choices through process arguments or persisted browser state. |
| Observability | Cue logging must be explicit, bounded, and low-volume. Avoid per-frame logs; audio cue logs should represent accepted audio operations such as `play`/sprite cue attempts. |

## Rehearsal Contract

Rehearsal mode means: resolve the addressed target through the
existing URL/registry/composition path, preload declared assets, run
normal `create(ctx)` and `timeline(ctx)`, and drive the master timeline
as normal while the audio service suppresses audible output or records
accepted cue attempts.

- A direct `scene` target rehearses that scene.
- A `composition` target rehearses the normal composition slice from
  the beginning.
- A `composition+scene` or `composition+index` target rehearses the
  resolved slice from the addressed head scene onward, preserving the
  head entry's `range` / `behavior` overrides.
- `beat=<label>` under rehearsal should reuse the existing
  `headBeat` / `onBeatMissing` path if rehearsal supports beat
  positioning. The beat seek is existing navigation positioning, not a
  rehearsal-specific timeline mutation.

## Extensibility

The required extension point is an audio output policy on the existing
audio-service seam. Prefer one small parameter owned by `audio.ts`,
for example a policy equivalent to `audible` / `silent` /
`log-cues`, plus an optional cue-log sink supplied by the loader or
workbench bootstrap. Keep `silent` screenshot/paused behavior and
rehearsal behavior expressed through that same audio-service policy
instead of adding mode-specific branches throughout the runtime.

Cue-log entries should be semantic and stable: sound id, sprite name
when present, group when present, operation, and a monotonic sequence
or timestamp if needed. They should not expose Howler handles, source
URLs, absolute paths, request headers, or raw scene objects.

Future variations such as "silent rehearsal" vs "cue-log rehearsal",
export silence, ducking, bus volume, or audio status UI should extend
the same `AudioServiceOptions` / `AudioService` seam. They should not
create a second URL grammar, scene schema, timeline hint family,
exception hierarchy, or presenter command bus.

## Gotchas And Anti-Patterns

- Do not conflate rehearsal with master mute. Master mute is
  engine-level persistent state; rehearsal is per-navigation output
  policy.
- Do not conflate rehearsal with `mode=paused`, `mode=scrub`, or
  `mode=screenshot`. Those modes change playhead behavior or capture
  semantics; rehearsal must not.
- Do not implement rehearsal by pausing audio cues in timeline
  callbacks. Scenes should keep calling `ctx.audio`; the service
  decides whether the cue is audible or logged.
- Do not log cue attempts before validating the sound id, sprite,
  group, and option shape. Rehearsal logs should represent accepted
  runtime cues, not malformed inputs.
- Do not log every animation frame, playhead tick, label crossing, or
  pointer event. Rehearsal cue logs are audio-operation logs.
- Do not add `data-pulsar-mode-*` suppression attributes, hidden
  storage keys, or mode state outside the URL parser/loader path.
- Do not add raw `<audio>` elements, Web Audio nodes, or Howler
  imports in scenes to work around rehearsal.
- Do not swallow lifecycle failures because rehearsal is "only" an
  authoring mode. Preload, create, timeline, and cleanup failures
  retain the same envelopes as normal playback.

## Non-Goals

PUL-F026 should not implement keyboard listeners, presenter controls,
remote rehearsal protocols, auth, persistence, analytics streams,
audio waveform UI, cue editing, scene schema changes, composition
schema changes, export mixdown, deterministic screenshot behavior,
scrub controls, master-mute UI, or requirement status transition.

It should not add a new resolver, timeline runner, cue scheduler,
asset inventory, validation library, logging framework, exception
hierarchy, repository, workflow controller, env binding, or
process-level configuration surface.
