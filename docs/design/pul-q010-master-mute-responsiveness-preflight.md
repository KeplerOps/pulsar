# PUL-Q010 Master Mute Responsiveness Preflight

PUL-Q010 adds a latency bound to the existing master-mute contract:
engaging master mute must silence active audio playback within 100 ms.

No new ADR is needed. ADR-004 already owns master mute as
audio-engine runtime state, and the PUL-F025 preflight already fixes
the command path through ADR-023's presenter seam. This note narrows
the timing boundary so the implementation does not invent a second
mute mechanism.

## Boundary

The timing path stays on the existing runtime path:

- `src/runtime/presenter.ts` remains the only presenter command schema,
  validator, controller, and abort-tied subscription boundary.
- `src/runtime/scene-loader.ts` remains the only seam with both the
  accepted `toggle-master-mute` command and the per-navigation
  `AudioService`. The mute handler must stay a synchronous,
  loader-owned subscriber.
- `src/runtime/audio.ts` remains the only audio-engine boundary.
  Silencing means `AudioService.mute(true)` delegates to
  `AudioEngine.setMasterMute(true)` / `Howler.mute(true)`; it is not a
  fade, stop, unload, remount, timeline pause, or scene cleanup.
- `src/runtime/timeline.ts`, `src/runtime/composition-resolver.ts`, and
  scene modules remain out of the mute timing path. They must not learn
  responsiveness-specific state.

Measure the runtime guarantee from the accepted presenter command
arriving at the controller boundary to the audio engine master-mute
call returning. Future UI/browser tests may include the workbench input
event, but the canonical runtime seam is the accepted
`toggle-master-mute` command, not an arbitrary DOM event.

## Required Reuse

Use the existing incumbents:

- Presenter input: `PRESENTER_COMMAND_KINDS`, `isPresenterCommand`,
  `PresenterCommandSource`, `PresenterController`, and
  `createPresenterController`.
- Mode scoping: `effectiveMode()`, `SceneLoaderOptions.presenterCommands`,
  and the loader's present-only controller construction.
- Audio boundary: `AudioService.mute()`, `AudioService.isMuted()`,
  `AudioEngine.setMasterMute()`, `AudioEngine.isMasterMuted()`,
  `createHowlerAudioEngine()`, and `noopAudioEngine`.
- Error/diagnostic path: presenter controller handler isolation and the
  loader `onError` sink. PUL-Q010 should not add an exception hierarchy,
  telemetry framework, stage attribute, or command log.
- Tests: extend the existing audio-service tests and
  scene-loader-present seam tests. Any timing test must use a
  deterministic fake engine/source for runtime latency and only use
  browser/audio integration tests for Howler behavior where necessary.

## Cross-Cutting Layers

| Layer | Guardrail |
|-------|-----------|
| Presenter command validation | Only a validated `toggle-master-mute` command reaches the handler. Do not add `mute`, `unmute`, `master-mute`, or a second validator. |
| Mode and URL grammar | The handler exists only under effective `present`. Do not add mute URL parameters, new modes, history state, storage keys, or persisted mute state. |
| Audio engine boundary | The handler calls `audio.mute(!audio.isMuted())`. Howler remains hidden behind `createHowlerAudioEngine()`; active playback is silenced through engine master mute, not by iterating sounds in the loader. |
| Lifecycle and cleanup | The handler must not abort navigation, call `cleanup(ctx)`, stop groups, unload sounds, rebuild services, or wait for resolver/timeline completion. |
| Error envelope | Malformed commands and handler failures continue through the existing `onError` sink. Diagnostics must not include raw future remote payloads, source URLs, Howler handles, stacks, cookies, env, or scene objects. |
| Config / env / OS exposure | No env vars, config files, CLI flags, process argv tokens, shell commands, cookies, localStorage, sessionStorage, or credentials are needed. |
| Auth / remote input | No auth surface exists here. A future remote presenter bridge must authenticate before emitting into `PresenterCommandSource`; the controller still shape-checks every emitted command. |
| Observability | CI assertions and existing `onError` diagnostics are sufficient. Do not add per-command logs or analytics for a latency requirement. |

## Guardrails

- The mute path must be synchronous and allocation-light: read current
  engine state, flip it, return. Do not await, debounce, throttle,
  schedule with timers, use animation frames, or defer behind runner
  callbacks.
- The loader-owned mute subscriber should remain independent of runner
  subscribers. A slow or throwing runner handler must not sit before
  the audio mute action on the critical path.
- Do not implement the 100 ms bound with a fade duration. A fade is
  audible during the fade and cannot prove "silence within 100 ms."
- Do not re-check or iterate scene audio declarations at command time.
  The command must work before any sound is registered and while audio
  is already playing.
- Preserve engine-level state. `stopAll()` and scene cleanup must not
  reset master mute.
- Post-abort commands remain inert through the existing presenter and
  audio-service cleanup semantics.

## Extensibility

The extension seam is the presenter command payload plus the audio
service. If a future requirement needs explicit target state, add a
kind such as `set-master-mute` with a `muted: boolean` field to the
same `PresenterCommand` discriminated union and validate it in
`isPresenterCommand`. The timing-sensitive behavior still belongs
behind `AudioService.mute()`, not in UI, runner, scene, timeline, or
Howler-specific call sites.

If future status UI needs latency reporting, add an injected monotonic
clock/test seam at the presenter/audio boundary or a bounded workbench
status surface. Do not use `Date.now()` in scene code, persistent
storage, URL state, or source payload logs for this requirement.

## Non-Goals

PUL-Q010 should not implement visible mute UI, keyboard listeners,
remote presenter protocol, auth, telemetry, persistence, volume buses,
ducking, fade curves, per-scene mute, playback stopping, export audio,
scrub cue gating, audio unlock, requirement status transition, or
GitHub/Ground Control workflow automation.

It should not change scene schemas, composition schemas, URL grammar,
asset preload rules, audio source validation, resolver lifecycle,
timeline transport, or presenter command source ownership.

## Anti-Patterns

- Adding a second mute controller, event bus, schema, validator, or
  exception family.
- Importing Howler outside `src/runtime/audio.ts` or reaching into
  Howler from tests that can assert through `AudioEngine`.
- Implementing silence by pause, fade, stop, unload, navigation abort,
  scene remount, `cleanup(ctx)`, or timeline mutation.
- Waiting for logs, UI state, unlock prompts, preloader work, runner
  subscription delivery, or composition lifecycle before muting.
- Persisting mute state in URL, history, storage, cookies, env, config,
  or process argv.
