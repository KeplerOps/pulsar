# PUL-F030 Audio Unlock Interaction Preflight

PUL-F030 refines ADR-004 for live presentation: when an effective
`mode=present` navigation resolves to a composition slice that declares
audio, the runtime must present one explicit user-gesture interaction
and satisfy browser autoplay policy before the composition begins.

ADR-029 is the binding decision. This note names the repo-wide
contracts the implementation must reuse.

## Boundary

- `src/runtime/navigation.ts` remains the URL grammar owner. Do not add
  `unlock=`, `audio=`, `autoplay=`, a new mode, or a second mode enum.
  Use `effectiveMode()` so omitted `mode` and explicit `mode=present`
  follow the same present-mode path.
- `src/runtime/scene-navigation.ts` remains the composition-slice
  resolver. The unlock decision uses the resolved composition slice.
  Do not re-resolve manifests, bypass registries, or flatten object-form
  entries.
- `src/runtime/scene-loader.ts` is the runtime coordination point. It
  sees mode, composition context, the navigation `AbortSignal`, the
  audio engine, and the workbench adapters. The unlock gate belongs
  before `loadSceneNavigationTarget()` starts resolver lifecycle work.
- `src/runtime/audio.ts` remains the only Howler boundary. Any
  browser-audio-context resume/unlock call must be hidden behind the
  existing audio engine/service contract. The workbench and loader must
  not import Howler.
- The workbench bootstrap (`src/main.ts`) owns visible DOM gesture
  collection or supplies an injected adapter for it. Scenes never add
  unlock buttons, hidden `<audio>` elements, global key listeners, or
  raw Web Audio unlock code.
- `src/runtime/composition-resolver.ts` stays mode-opaque. Unlock is
  not a lifecycle phase, timeline hint, scene failure, cleanup hook, or
  resolver option.

## Required Reuse

- Mode and URL validation: `parseNavigationSearch()`,
  `NAVIGATION_MODES`, `effectiveMode()`, and loader-side
  `validateModeGrammar()`.
- Scene and composition contracts: `SceneModule`,
  `assertSceneModule()`, `createSceneRegistry()`,
  `assertCompositionManifest()`, `createCompositionRegistry()`, and the
  frozen `SceneNavigationCompositionContext` slice.
- Audio boundary: `AudioEngine`, `createHowlerAudioEngine()`,
  `noopAudioEngine`, `AudioService`, `createAudioService()`, and the
  existing audio error classes.
- Audio declaration/source policy: `scene.assets`,
  `collectAudioSources()`, `resolveAssetUrl()`,
  `DEFAULT_ALLOWED_SCHEMES`, `isKebabIdentifier()`, and
  `KEBAB_IDENTIFIER_FORM`. If a static audio declaration is added, add
  it to the existing scene schema once and require every source to
  reference `scene.assets`.
- Lifecycle and cleanup: one per-navigation `AbortController.signal`,
  `loadSceneNavigationTarget()`, `resolveComposition()`, resolver-owned
  cleanup, and audio `stopAll()` / `stopGroup(sceneId)` cleanup.
- Errors and observability: `describeError()`, loader `onError`,
  `data-pulsar-navigation-error`, and existing scene-failure
  diagnostics. Do not add an unlock exception hierarchy or logging
  framework.
- Tests: existing Vitest suites under `tests/runtime/*`, especially
  scene-loader mode tests, audio tests, navigation tests, and
  validation tests.

## Cross-Cutting Layers

| Layer | Guardrail |
|-------|-----------|
| URL grammar / mode gate | The gate applies only when `effectiveMode(target) === 'present'` and the resolved target carries a composition slice that declares audio. Unknown modes still fail through `validateModeGrammar()`. |
| Programmatic navigation | Hand-built `NavigationTarget`s pass the same loader mode validation before unlock decisions. Do not trust caller-side TypeScript casts. |
| Scene schema | `ctx.audio.load()` inside `create(ctx)` is too late to decide whether to prompt. The declaration predicate must be static and canonical. If current metadata is insufficient, extend `SceneModule` / `assertSceneModule()` once; do not sniff file extensions or inspect scene code. |
| Composition schema | Do not add audio flags to composition manifests. Composition audio presence is derived from the resolved scene slice so existing composition slicing, `range`, and `behavior` semantics remain intact. |
| Asset security | Audio sources remain declared assets. They must pass the same `scene.assets` membership and `resolveAssetUrl()` scheme policy as the audio service and preloader. No `ctx.audio.play(url)` or unlock-time URL fetch path. |
| Workbench gesture surface | The visible prompt is a workbench concern. It should receive bounded semantic context only, such as composition id, scene ids/count, and `AbortSignal`; not raw scene objects, source URLs, headers, cookies, or Howler handles. |
| Audio engine boundary | Unlock/resume browser audio through `src/runtime/audio.ts`. `noopAudioEngine` must satisfy the same contract deterministically. Master mute and output policy are separate state and must not be reset by unlock. |
| Lifecycle / cancellation | Waiting for a gesture must block preload/create/timeline for that navigation and must be abort-aware. A stale gesture after supersession or dispose must not start the old composition or write stale diagnostics. |
| Error envelope | A failed unlock is a navigation-level failure surfaced through loader `onError` and `data-pulsar-navigation-error` using `describeError()`. Do not serialize raw DOM events, audio sources, scene objects, stacks, headers, cookies, or auth values. |
| Config / env / OS exposure | No env vars, process argv tokens, CLI flags, config files, cookies, localStorage, sessionStorage, history state, or persisted "unlocked" state are needed. Do not put composition/audio state or secrets in command-line arguments or URLs. |
| Auth / remote input | No remote-auth surface exists. A future remote presenter source must authenticate before emitting into an existing workbench/presenter source; PUL-F030 should not add HTTP, WebSocket, or token handling. |
| Observability | Reuse existing stage diagnostics and `onError`. Do not add analytics, per-pointer logs, or stage attributes for unlock state until a concrete UI/status requirement needs them. |

## Extensibility

The required extension point is a loader/workbench unlock adapter plus
an audio-boundary unlock operation. Keep it parameterized by:

- the per-navigation `AbortSignal`,
- semantic composition context,
- the current audio engine's unlock capability.

That shape allows later variations such as branded prompt copy,
keyboard vs pointer activation, already-unlocked short-circuiting,
status UI, or remote presenter initiation without changing scene
lifecycle, URL grammar, composition manifests, or `ctx.audio`.

If a static audio declaration is introduced, keep the predicate reusable
as a small scene-schema helper so validation, loader gating, and future
authoring checks agree on "declares audio." Do not make the workbench
parse audio definitions independently.

## Gotchas And Anti-Patterns

- Do not rely on Howler `autoUnlock` alone. It can remain an engine
  fallback, but it does not satisfy the explicit pre-composition
  interaction.
- Do not prompt per scene, per cue, or per `ctx.audio.play()`.
- Do not gate non-present modes. Rehearsal logs/suppresses audio,
  screenshot and paused are silent, prompter bypasses lifecycle, and
  standalone/loop/scrub have their own mode contracts.
- Do not broaden PUL-F030 to direct `scene=` targets unless a separate
  requirement says so. This requirement names present-mode composition
  loads.
- Do not use file extension, MIME guesses, asset URL substrings, or
  runtime observation of `ctx.audio.load()` as the declaration test.
- Do not mutate composition manifests to mark audio. Derive from scene
  metadata in the resolved slice.
- Do not let the unlock prompt start lifecycle work after the
  navigation was aborted.
- Do not reset master mute, output policy, presenter state, timeline
  state, or URL state as part of unlock.
- Do not add scene-local unlock UI, hidden media elements, Howler
  imports outside `audio.ts`, or raw Web Audio calls in ordinary scenes.
- Do not create a new exception hierarchy, config surface, persistence
  key, auth surface, telemetry stream, or workflow controller.

## Non-Goals

PUL-F030 should not implement audio orchestration, cue scheduling,
master mute, rehearsal cue logging, scrub cue gating, presenter
transport controls, chrome/status UI beyond the required gesture,
remote presenter protocols, auth, telemetry, persistence, export
audio, decode-complete preloading, requirement status transition, or
GitHub/Ground Control workflow automation.

It should not change URL grammar, workbench mode names, composition
manifest semantics, resolver lifecycle ordering, timeline transport,
scene cleanup policy, asset scheme policy, or the scene-facing
`ctx.audio` playback API except for the minimum static audio
declaration needed to know whether a present composition requires
unlock.
