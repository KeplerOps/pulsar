# PUL-F017 Scrub Mode Preflight

PUL-F017 specifies `mode=scrub`: display timeline controls allowing
the user to scrub forward, backward, and to named beats; audio cues
SHALL fire only on monotonic forward playback.

The loader, bridge, resolver, GSAP timeline adapter, Howler-backed
audio service, and workbench chrome surface now exist. The remaining
implementation is not another seam-only PR: it must connect the
existing scrub-mode cue hint to real audio-cue gating and mount a
workbench-owned transport UI for scrub mode.

## Current State

- `mode=scrub` is already part of `NAVIGATION_MODES`.
- The loader already derives `effectiveMode(target) === 'scrub'`
  and forwards `cueGate: 'monotonic-forward'`.
- The bridge and loader already truncate scrub composition slices to
  the addressed head entry while preserving object-form `range` /
  `behavior` overrides.
- `CompositionTimelineRunOptions.headCueGate` already reaches the
  GSAP timeline adapter.
- `MasterTimeline` already exposes `play`, `pause`, `seek`,
  `setSpeed`, `time`, `duration`, `labels`, and `beats()`.
- `createGsapCompositionTimeline({ onMaster })` already exposes the
  live master as the intended workbench transport seam.
- `AudioService` already owns `load`, `play`, `fade`, `stop`,
  `stopGroup`, `mute`, output policy, validation, cleanup, and cue
  logging for rehearsal.
- `createDomWorkbenchChrome()` and the L2 chrome slots already mount a
  persistent workbench-owned chrome surface. Chrome is visible under
  `scrub` by policy.

Open gap:

- The GSAP adapter still treats `headCueGate` as a no-op. It also
  auto-plays the master under scrub, which is incompatible with an
  inspection UI that needs a live, user-driven playhead.
- The audio service has no dynamic cue gate. Timeline callbacks can
  still call `ctx.audio.play(...)` during reverse playback or direct
  seeks.
- The chrome surface has no scrub transport controls and no named
  beat jump UI.

## Boundary

Scrub implementation must stay on the existing runtime path:

- `src/runtime/navigation.ts` owns URL grammar, `NAVIGATION_MODES`,
  and `effectiveMode()`. Do not add `scrub=true`, `direction=`,
  `time=`, or a second parser.
- `src/runtime/scene-loader.ts` remains the mode dispatch boundary:
  parser-equivalent `mode` / `beat` validation, one navigation
  `AbortController`, audio-service construction, chrome dispatch,
  stage diagnostics, and lifecycle handoff.
- `src/runtime/scene-navigation.ts` remains the target-resolution and
  slice-snapshot boundary. Composition validation still runs before
  truncation.
- `src/runtime/composition-resolver.ts` remains GSAP-free and
  mode-opaque. It may forward a narrow adapter option, as it already
  does for `headBeat`, `headRepeat`, `headHold`, `headCueGate`,
  `headScreenshot`, and presenter, but it must not implement scrub.
- `src/runtime/timeline.ts` owns GSAP transport, master playhead
  state, named beat enumeration, direction/time-crossing detection,
  and the workbench-facing `MasterTimeline` contract.
- `src/runtime/audio.ts` owns whether an accepted audio cue produces
  output or is suppressed. Do not implement cue gating in chrome event
  handlers or scene modules.
- `src/runtime/workbench-chrome.ts` / `src/system/chrome/*` own the
  DOM surface for scrub controls. Scenes must not create, query,
  retain, or mutate scrub controls.

## Required Reuse

Build on these canonical incumbents:

- URL and mode: `parseNavigationSearch()`, `NAVIGATION_MODES`,
  `NavigationMode`, `effectiveMode()`, and loader
  `validateModeGrammar()`.
- Beat naming and validation: `isKebabIdentifier()`,
  `sceneTimelineLabel()`, `parseSceneTimelineLabel()`,
  `MasterTimeline.beats()`, `MasterTimeline.labelFor()`, and
  `MasterTimeline.seek()`. Do not parse namespaced beat strings in the
  UI.
- Timeline transport: `MasterTimeline` and
  `createGsapCompositionTimeline({ onMaster })`. Do not expose raw
  GSAP timelines to chrome.
- Audio service: `AudioService`, `createAudioService()`,
  `AudioOutputPolicy`, `AUDIO_OUTPUT_POLICIES`,
  `assertSoundDefinition()`, `assertPlayOptions()`,
  `AudioError` subclasses, `stopGroup()`, and `stopAll()`.
- Asset and audio-source security: `scene.assets`, `scene.audio`,
  `collectAudioSources()`, `createAssetPreloader()`,
  `resolveAssetUrl()`, and `DEFAULT_ALLOWED_SCHEMES`.
- Lifecycle and cleanup: `loadSceneNavigationTarget()`,
  `resolveComposition()`, per-navigation `AbortSignal`,
  `onSceneCleaned`, and resolver cleanup aggregation.
- Workbench chrome: `createDomWorkbenchChrome()`,
  `chromeVisibilityFor()`, `mountChromeSlots()`, and the existing
  `main.ts` bootstrap wiring.
- Error and observability: `describeError()`,
  `describeErrorDetailed()`, `formatSceneContext()`,
  `data-pulsar-navigation-error`, `data-pulsar-scene-target`,
  `data-pulsar-composition-target`, `data-pulsar-scene-failures`, and
  loader `onError`.
- Source-policy gates: PUL-A001 (`ctx.gsap`, no scene GSAP imports),
  PUL-A002 (`ctx.audio`, no scene Howler / `Audio()`), PUL-Q003
  (URL-only targeting), PUL-Q004 (resource cleanup), PUL-Q007 (no
  eval / remote dynamic code), and PUL-Q008 (DOM / accessibility).

## Intended Design

The scrub UI is a workbench transport surface over the active master
timeline. It should be wired from `src/main.ts` or another
workbench-owned bootstrap module by using the existing
`createGsapCompositionTimeline({ onMaster })` seam and the existing
chrome surface. The UI reads `master.duration()` and `master.beats()`,
drives transport through `MasterTimeline` methods, and tears down or
disables itself when navigation aborts or a new master arrives.

The runner must treat `headCueGate: 'monotonic-forward'` as a real
scrub-mode run policy, not just an audio flag. A scrub activation must
leave the addressed head scene mounted with a live master for user
inspection instead of auto-playing to completion and letting resolver
cleanup remove the scene before controls can operate. Implement that
inside the timeline adapter's run-mode decision, not by parking the
loader or bypassing cleanup.

Cue gating belongs between GSAP transport and `AudioService`. Prefer a
narrow audio cue-gate port or a small `AudioService` extension that the
timeline adapter can toggle based on playhead movement direction. The
adapter should not receive raw Howler handles or full scene objects.
The audio service should validate cue calls first and then suppress
output when the current crossing is not monotonic forward. Suppression
must not mask malformed sound ids, sprite names, group names, source
URLs, volume/rate ranges, or disposed-service behavior.

The required extensibility seam is:

- timeline: a workbench-safe transport API on `MasterTimeline` for
  scrub operations and direction-aware cue evaluation;
- audio: a dynamic cue eligibility gate distinct from static
  `AudioOutputPolicy`;
- chrome: a dedicated scrub-controls slot/component under workbench
  chrome, not scene DOM.

This keeps future variations local: step size, playback speed,
reverse playback, beat filtering, compact controls, or additional cue
gate modes extend these seams rather than URL grammar, scene schema,
composition manifests, or resolver workflow.

## Cross-Cutting Layers

| Layer | Guardrail |
|-------|-----------|
| URL grammar | `mode=scrub` and optional `beat=` keep flowing through `parseNavigationSearch()`. Unknown modes, repeated keys, malformed beat ids, and invalid locator shapes keep failing through the existing grammar envelope. |
| Programmatic target defense | Hand-built targets still pass loader `validateModeGrammar()` / `validateBeatGrammar()` before reaching chrome, audio, or timeline code. |
| Target resolution | `resolveSceneNavigation()` still validates composition existence, member scenes, ambiguity, empty manifests, and indexes before single-scene truncation. No direct-scene fallback. |
| Scene/composition schemas | No `scrub`, `beats`, `markers`, `cueGate`, `controls`, or transport fields on `SceneModule` or composition manifests. GSAP labels remain the beat source of truth. |
| Timeline validation | Scene timelines still pass `assertSceneTimeline()`; beat labels are kebab-case and finite. UI times pass through `MasterTimeline.seek()` / speed validation, not direct GSAP mutation. |
| Audio validation | `AudioService.load()` / `play()` / `fade()` / `stop()` / `stopGroup()` keep existing shape, id, sprite, group, source, and range validation. Cue suppression is post-validation and pre-output. |
| Asset security | Audio source URLs still come from `scene.audio` and `scene.assets`, pass `resolveAssetUrl()` / `DEFAULT_ALLOWED_SCHEMES`, and are preloaded with the navigation `AbortSignal`. Scrub controls must not turn URL params or beat labels into fetches/imports. |
| Lifecycle / cleanup | One navigation signal still drives preloader, timeline adapter, audio service, presenter controller, prompter disposal, and cleanup. Scrub pause/play/reverse/seek is transport state, not navigation abort. |
| Chrome / DOM | Controls live under workbench chrome. Hidden chrome uses the existing chrome policy. Controls must not re-parent `#stage`, remove scene nodes, trap focus when hidden, or let scene cleanup remove chrome. |
| Error envelope | Use existing `onError` and stage diagnostics. Public messages may include ids, beat names, mode, bounded numeric times, and operation names. Never serialize raw scene objects, DOM nodes, GSAP objects, Howler handles, source URLs with credentials, headers, cookies, env, argv, stacks, or raw `cause`. |
| Source policy | Existing scans must still pass: scenes do not import GSAP/Howler or construct audio elements; runtime does not use eval/remote dynamic imports or persisted state for target selection. |
| OS/config exposure | Scrub cursor, direction, selected beat, audio gate state, and target state are transient in-memory runtime state. Do not write them to env, process argv, browser storage, cookies, files, or shell commands. |
| Observability | Avoid per-frame and pointer-move logs. If diagnostics are needed, log bounded state transitions or rejected inputs through existing sinks only. |

## Gotchas And Anti-Patterns

- Auto-playing scrub mode to completion before the user can interact.
- Implementing controls by mutating raw GSAP timelines from DOM event
  handlers.
- Exposing full `AudioService` or Howler handles to chrome when a
  narrow cue-gate port is enough.
- Implementing monotonic-forward gating as master mute, `outputPolicy:
  'silent'`, or a per-scene `if (ctx.mode === 'scrub')` branch.
- Suppressing audio before validation, which would hide malformed
  scene cue calls.
- Treating direct seek, hydration, jump-to-beat, drag preview, or
  reverse playback as forward cue crossings.
- Replaying skipped cues after a seek or beat jump.
- Parsing beat label strings in chrome instead of using
  `master.beats()` / `labelFor()` / `seek()`.
- Adding duplicate schemas, DTOs, exception families, validators,
  routers, storage keys, or generic mode-policy abstractions.
- Reusing lower-third / prompter / practice UI slots in a way that
  makes scrub controls collide with existing chrome content. Add a
  named workbench transport slot if the existing slots are not a clean
  fit.
- Creating high-frequency `onError` or console output during pointer
  scrubbing.

## Tests And Workflow

Source changes should add a Towncrier fragment; docs-only preflight
changes do not need one. PUL-F017 should move DRAFT -> ACTIVE only
after all behavior is implemented and IMPLEMENTS / TESTS traceability
links exist.

Required behavioral coverage for implementation:

- loader/bridge/resolver seam tests remain green for head-only
  `cueGate`, slice truncation, key-presence semantics, `beat`
  forwarding, and missing-beat diagnostics;
- timeline tests prove the scrub run mode keeps the scene mounted for
  controls and exposes beats through the master;
- audio/timeline tests prove a cue at master time `T` fires when the
  playhead crosses `T` monotonically forward and does not fire on
  reverse crossing, direct seek, hydration, or jump-to-beat;
- chrome or browser tests prove controls appear only under
  `mode=scrub`, can scrub forward/backward, and can jump to named
  beats without overlapping existing chrome.

## Non-Goals

- No new URL grammar, router, storage format, environment binding,
  CLI flag, auth surface, telemetry stream, or persistence.
- No scene authoring/editing UI for beats or cues.
- No duplicate beat metadata or cue schema.
- No raw GSAP or Howler exposure to scenes or chrome.
- No resolver-owned scrub logic and no second lifecycle.
- No composition-wide scrub transport beyond the already-addressed
  head-scene slice. Cross-scene/windowed scrubbing needs a separate
  requirement because it changes lifecycle ownership.
