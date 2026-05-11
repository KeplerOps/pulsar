# PUL-F024 Audio Orchestration Preflight

PUL-F024 makes ADR-004 concrete: audio is a runtime service, not
scene-owned Howler code. Scenes access audio through `ctx.audio`;
the runtime owns engine construction, per-scene scoping, cleanup,
autoplay unlock state, master mute, fades, sprites, looping, and
named groups.

## Boundary

Implementation must stay on the existing runtime path:

- `src/runtime/scene-loader.ts` builds a fresh per-navigation scene
  context. `ctx.audio` belongs beside `ctx.gsap` and `ctx.mode`; scenes
  must not import Howler or read global audio state.
- `src/runtime/composition-resolver.ts` owns preload -> create ->
  timeline -> cleanup ordering and error envelopes. Audio cleanup must
  run through this lifecycle, not through a second scene runner.
- `src/runtime/timeline.ts` remains the timing surface. Audio cues
  should be fired from GSAP timeline callbacks / transport state; do
  not add a parallel cue scheduler.
- `src/runtime/asset-preloader.ts` remains the network validation and
  preload boundary for scene-declared assets. Audio URLs are assets,
  not a second fetch inventory.
- `src/runtime/scene.ts` remains the scene schema gate. If PUL-F024
  needs typed audio declarations, extend `SceneModule` and
  `assertSceneModule()` once; do not add a parallel audio-scene
  schema.
- `src/runtime/navigation.ts` and workbench modes remain URL-owned.
  Audio mute/unlock/group state is runtime state, not new URL grammar.

## Required Reuse

Use these canonical incumbents:

- Scene shape: `SceneModule`, `assertSceneModule()`,
  `createSceneRegistry()`.
- Lifecycle and cleanup: `createSceneLoader()`,
  `loadSceneNavigationTarget()`, `resolveComposition()`, and the
  per-navigation `AbortSignal`.
- Timeline cues: `ctx.gsap`, `MasterTimeline`, and
  `createGsapCompositionTimeline()`.
- Asset validation: `scene.assets`, `createAssetPreloader()`,
  `DEFAULT_ALLOWED_SCHEMES`, redirect re-checks, `baseUrl`, and
  fetch `AbortSignal` wiring. If Howler-side URL validation needs the
  same resolver, extract the existing helper; do not copy the rules.
- Identifier rules for named groups / sound ids:
  `isKebabIdentifier()` and `KEBAB_IDENTIFIER_FORM`.
- Error and observability: `describeError()`, existing stage attrs
  (`data-pulsar-scene-target`, `data-pulsar-composition-target`,
  `data-pulsar-navigation-error`), and the loader `onError` sink.
- Tests: Vitest seam tests under `tests/runtime/*`, split across
  service, loader context, resolver cleanup, and timeline-cue behavior.

## Cross-Cutting Layers

| Layer | Guardrail |
|-------|-----------|
| Dependency / supply chain | Add Howler through `package.json` and `pnpm-lock.yaml`. Import it only inside the runtime audio boundary; scenes must consume `ctx.audio`. |
| Browser autoplay policy | Centralize unlock / mute state in the audio service or workbench bootstrap. Scenes must not attach their own unlock gesture handlers or construct hidden `<audio>` elements. |
| Scene schema gate | `assertSceneModule()` remains the only scene-shape validator. Any audio declaration extension must reuse `scene.assets` for URLs and validate sound / group ids with `isKebabIdentifier()`. |
| Asset security | Audio sources must be declared before use and pass the same scheme / redirect validation as other assets. Do not let `ctx.audio.play(url)` fetch arbitrary scene-provided strings. |
| Lifecycle / cleanup | Every handle created through `ctx.audio` is scoped to the active scene by default and stopped on scene cleanup / navigation abort. Named groups are service-managed scopes, not lifecycle owners. |
| Timeline integration | Cue firing belongs in timeline callbacks or active transport state. `headCueGate: 'monotonic-forward'`, screenshot, scrub, paused, and loop modes must influence whether cues fire; they must not fork the resolver lifecycle. |
| Error envelope | Audio setup or playback failures surfaced through lifecycle keep `composition resolution failed:` wrapping. Non-fatal cue/playback diagnostics use `onError` / stage diagnostics without unmounting unless lifecycle invariants are broken. |
| Config / env / OS | No env vars, process argv tokens, shell commands, persisted browser storage, cookies, or credentials are needed for PUL-F024. Do not put audio source secrets or unlock state in URLs. |
| Observability | Use the existing `onError` sink. Cue logging for rehearsal mode must be bounded and explicit; no per-frame logs or analytics until a telemetry policy exists. |

## Guardrails

- The service API should expose semantic ids (`play`, `fade`, `stop`,
  `stopGroup`, sprite names, loop flags), not raw Howler instances.
- Group names are audio routing / cleanup scopes. Do not conflate them
  with scene ids, composition ids, timeline labels, presenter commands,
  or asset URLs.
- Per-scene cleanup is automatic. A scene may stop a group explicitly,
  but it must not be responsible for final teardown.
- Fades and looping should be idempotent under repeated calls and
  navigation abort. A fade started by a superseded scene must not keep
  changing volume after cleanup.
- Screenshot and paused modes must suppress audible playback. Scrub
  mode must honor monotonic-forward cue gating once cues exist.
- Master mute and future ducking are runtime state. Do not add
  per-scene mute booleans or duplicate presenter command buses.
- Raw Web Audio escape hatches require explicit cleanup registration
  with the runtime; ordinary scenes use `ctx.audio` only.

## Extensibility

The extension seam is a small `AudioService` exposed through
`WorkbenchSceneCtx.audio`, backed by one runtime-owned Howler engine
adapter. The necessary parameter is the scene activation scope:
construct or bind the context audio facade with the active scene id /
activation token so the service can stop all sounds from that scene
without relying on author discipline.

Named groups should be parameters on service calls and service-owned
state, not schema branches. Future variations such as ducking, bus
volume, rehearsal cue logging, spatial panning, or export-mode silence
extend the service facade and runtime adapter; they do not change
scene lifecycle, URL grammar, or composition manifest semantics.

## Non-Goals

- No new URL parameters, storage keys, cookies, env vars, CLI flags,
  remote protocol, analytics stream, or persistence format.
- No replacement for `createAssetPreloader()` and no duplicate audio
  asset inventory separate from scene-declared assets.
- No new resolver, scene registry, exception hierarchy, or workflow
  state machine.
- No authoring UI, waveform editor, DAW-style scheduler, export audio
  mixdown, or requirement status transition during this preflight.

## Anti-Patterns

- Importing Howler, constructing `<audio>`, or using raw Web Audio in
  ordinary scene modules.
- Passing arbitrary URLs to playback APIs.
- Duplicating identifier regexes, asset validators, error envelopes, or
  cleanup queues.
- Treating audio groups as composition flow control or timeline labels.
- Letting fades, loops, sprites, or muted state survive scene cleanup
  unless they are explicitly global service state.
- Adding scene-local unlock buttons, keyboard listeners, or presenter
  command handling for audio.
