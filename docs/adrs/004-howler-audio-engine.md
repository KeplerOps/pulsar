# ADR-004: Howler.js as the Audio Engine

## Status

Accepted

## Date

2026-04-30

## Context

Pulsar experiences are sound-rich: stingers, beds, ambient loops,
spoken-word cues, transition whooshes, and per-scene SFX. The runtime
needs an audio layer with:

- Sound effects with low-latency playback.
- Background beds with crossfade in/out.
- Audio sprites (multiple cues packed in a single asset).
- Fades, looping, and grouped cleanup.
- Volume groups (e.g. mute-all, duck the bed during a stinger).
- Optional spatial / panning for cinematic moments.
- Browser-autoplay-policy handling without each scene re-implementing
  the dance.

The default web audio surfaces (`<audio>`, raw Web Audio API) work,
but:

- `<audio>` elements scattered across scenes leak playback when scenes
  are torn down or revisited.
- Raw Web Audio is powerful but verbose and easy to misuse.
- Scene-by-scene audio code accumulates copies of the same primitives
  (fade, sprite, loop, group stop) with subtle differences.

Howler.js is a small, focused library that wraps Web Audio with a
predictable API for sounds, sprites, fades, looping, and groups. It is
widely used, framework-agnostic, and well-suited to the runtime's
needs. Heavier alternatives (Tone.js, full DAW-style stacks) are
overkill for cinematic playback.

## Decision

Use **Howler.js** as Pulsar's audio engine, exposed through the runtime
scene context rather than imported directly by scene modules.

- The runtime constructs a small audio service over Howler that
  manages: registered sounds, scene groups, master mute, and rehearsal
  mode (silent, with optional cue logging).
- Scenes declare audio assets and cues in their metadata
  (see [ADR-002](002-scene-registry-and-compositions.md)).
- Scenes interact with audio through the context:

  ```js
  ctx.audio.play("ransom-stinger");
  ctx.audio.fade("bed", 0.8, 0.15, 1200);
  ctx.audio.stopGroup("scene");
  ```

- The runtime guarantees per-scene cleanup: when a scene's `cleanup()`
  runs, its audio group is stopped.
- Master mute, rehearsal mode, and (eventually) export-mode hooks are
  handled by the audio service, not by individual scenes.

Scenes that need behavior outside the standard audio service (e.g., a
scene whose sound design requires spatial / programmatic synthesis) may
drop down to Web Audio explicitly, but must still register cleanup with
the runtime so the lifecycle is preserved.

## Consequences

### Positive

- One consistent audio API across scenes; no copies of fade/sprite/loop
  primitives.
- Per-scene cleanup is guaranteed by the runtime, not the author.
- Master mute and rehearsal mode are global capabilities, not
  per-scene checkboxes.
- Howler is small and widely battle-tested; it does not impose a
  framework.

### Negative

- Adds Howler.js as a runtime dependency.
- Scenes that want the full Web Audio API must coordinate with the
  audio service (and write their own teardown), rather than just
  ignoring it.

### Risks

| Risk | Mitigation |
|------|-----------|
| Audio cues drift from scene timelines | Hang audio calls off timeline callbacks (ADR-003) so timing is in one place. |
| Browser autoplay policies surprise users at presentation time | The audio service centralizes the unlock dance; scenes do not each implement it. |
| Heavy assets bloat first-load times | Declare audio in scene metadata and preload only what the active composition needs. |
| Scenes bypass the service to use raw `<audio>` | Treat raw `<audio>` in scene code as a smell; route through `ctx.audio` unless the scene has a documented reason. |

## Implementation

PUL-F024 lands the runtime side in `src/runtime/audio.ts`:

- `createHowlerAudioEngine()` is the only Howler import site; `ctx.audio`
  is a per-navigation `AudioService` (`load` / `play` / `fade` / `stop` /
  `stopGroup` / `mute`) the scene loader builds over that engine, bound
  to the navigation's `AbortSignal` so every sound is stopped + unloaded
  on supersession / dispose / completion. A workbench with no audio
  backend wired falls back to a silent no-op engine.
- Sound ids are registered against URLs the scene already declared in
  `scene.assets` via `ctx.audio.load(id, { src, sprite? })` at mount
  time — there is no separate `audio:` field on `SceneModule` (ADR-008
  #5: the only asset inventory is `scene.assets`, which the PUL-F005
  preloader warms before `create(ctx)`). Sound ids and group names obey
  the kebab-case rule (ADR-008 #1); source URLs pass the same scheme
  allowlist as other assets (PUL-F005).
- The service is per-navigation: under single-scene workbench modes that
  is one scene; under `mode=present` it is shared across the whole
  composition slice (the resolver mounts the slice with one ctx and
  forbids it repeating a scene id). The sound-id namespace and the
  source allowlist are therefore composition-slice-scoped, not per-scene
  — multi-scene compositions pick distinct sound ids (the same
  stable-identity discipline scene ids obey), and re-registering an id
  with the same definition is idempotent (a shared transition SFX).
- Per-scene audio teardown is runtime-driven, not author discipline:
  a scene scopes a sound to itself with `play(id, { group: <its-scene-id> })`,
  and the resolver's per-scene post-`cleanup(ctx)` hook
  (`ResolveCompositionOptions.onSceneCleaned`, wired by the loader to
  `ctx.audio.stopGroup(sceneId)`) stops that group when that scene's
  `cleanup` runs — so "when a scene's `cleanup()` runs, its audio group
  is stopped" is enforced by the runtime. Sounds not scoped to a scene
  group are torn down when the navigation's cleanup phase completes
  (`stopAll()` — every sound stopped + unloaded), which in the ADR-025
  mount-all model is when every scene's `cleanup()` has run. Finer
  granularity (a per-entry container/handle threaded through `create` /
  `timeline` / `cleanup` so each scene gets its own `ctx.audio` facade
  and `play()`s are attributed without the `group` convention) is a
  documented resolver follow-up — the same one that would let a
  composition slice repeat a scene id.
- Master mute is held on the engine (persistent runtime state), not as a
  per-scene checkbox. The per-navigation audio output policy is a
  literal-typed `AudioOutputPolicy` on `AudioServiceOptions` (default
  `'audible'`): `mode=screenshot` / `mode=paused` build the service
  `'silent'` (audible playback suppressed — ADR-019 / ADR-021);
  `mode=rehearsal` (PUL-F026) builds it `'log-cues'` — also muted at
  engine construction, with each accepted audio operation (`play` /
  `fade` / `stop` / `stopGroup`) emitted as a semantic
  `AudioCueLogEntry` to the workbench's optional `onAudioCue` sink.
  `'audible'` is the default for every other mode. Future variations
  (export silence, ducking, bus volume, an audio-status UI) extend
  this same union rather than scattering branches across the runtime.
- **PUL-Q010 latency bound (≤ 100 ms).** Master mute engagement under
  PUL-F025 is bounded end to end: from the accepted
  `'toggle-master-mute'` presenter command at the controller boundary
  (`src/runtime/presenter.ts` `centralWrapped`) to
  `AudioEngine.setMasterMute(...)` returning, the path is one
  synchronous call chain — no `await`, `queueMicrotask`, timer, fade
  interpolation, or runner hop. The loader-owned audio handler
  (`src/runtime/scene-loader.ts` `buildPresenterPipe`) is subscribed to
  the controller BEFORE the runner subscribes via
  `input.presenter.subscribe(...)`, so it runs FIRST in the controller's
  subscription-order fan-out and a slow or throwing runner subscriber
  cannot push the engine flip past the bound. The per-subscriber
  try/catch in `centralWrapped` keeps a throwing runner subscriber
  from masking the audio flip. Tests pinning these properties live at
  `tests/runtime/scene-loader-present.test.ts` (PUL-Q010 block in the
  PUL-F025 describe — synchronous observability of the engine flip
  on the next statement after `emit()`, ordering, slow-runner
  immunity, throwing-runner isolation),
  `tests/runtime/audio.test.ts` (PUL-Q010 block in the master-mute
  describe — synchronous engine delegation with no per-sound
  iteration on the mute path), and
  `tests/runtime/audio-engine.test.ts` (PUL-Q010
  production-Howler-boundary test —
  `createHowlerAudioEngine.setMasterMute(b)` forwards synchronously
  to `Howler.mute(b)`). The wall-clock budget collapses to
  "synchronous" at this seam because a single synchronous call chain
  costs sub-millisecond on any realistic V8; the structural
  observability checks above are the gate of record. Detailed
  guardrails: `docs/design/pul-q010-master-mute-responsiveness-preflight.md`.
- Rehearsal (PUL-F026) lives entirely on this audio-service seam — not
  as a head-only timeline-runner hint, not as a slice truncation, not
  as a presenter command. Rehearsal preserves the same composition
  slice and the same master timeline progression as the equivalent
  non-rehearsal navigation; only audio output changes. The cue log
  carries semantic ids only (sound id, sprite, group, operation,
  monotonic sequence, numeric envelope parameters) — never source
  URLs, Howler handles, absolute paths, or raw scene objects. `load`
  and `mute` are NOT cues (registration and engine-level state).
  Validation throws never emit. Post-dispose calls never emit. A
  throwing sink is swallowed.
- Browser autoplay policy is centralized by Howler's default Web Audio
  mode + `Howler.autoUnlock`: a `play()` made before the first user
  gesture is deferred (the suspended `AudioContext` blocks playback) and
  replayed when the first gesture resumes the context — no cue is lost,
  and the runtime does not re-implement the unlock dance per scene.
  `onloaderror` (a source that fails to fetch / decode) is the one async
  failure that surfaces; it routes to the service's non-fatal `onError`
  sink and is suppressed once the service is disposed (so a stale scene
  cannot write over the active navigation's error state).
- `headCueGate` (PUL-F017 / ADR-020) is plumbed to the timeline adapter
  but does not yet gate audio cues; scenes hang `ctx.audio` cues off
  their own timeline callbacks. Wiring scrub's monotonic-forward cue
  gate to the audio service is a follow-up that extends `AudioService`.

## Subsequent Updates

### 2026-05-21: Composition audio bed (PUL-F014)

The "background beds" the Context names are now a first-class concept
on this seam. A composition may declare a single composition-level
audio bed — a continuous looping source that belongs to the
composition, not to any one scene — at the composition-registration
boundary (`CompositionRegistryEntry.audioBed`, an `AudioBedDeclaration`
of `{ src, volume? }`). The per-navigation `AudioService` gains two
construction options:

- `bed` — the resolved composition's `AudioBedDeclaration`. When
  supplied, `createAudioService` starts it looping at construction and
  tears it down with `stopAll()` / abort, exactly like every other
  sound. The bed is registered under a non-kebab internal key, so it is
  unreachable through the scene-facing `load` / `play` / `stop` API —
  composition-level bed playback stays distinct from scene-owned
  `ctx.audio` playback.
- `bedSuppressed` — a bed-specific scope, deliberately separate from
  `AudioOutputPolicy`. The loader sets it for `mode=standalone`
  (PUL-F014 / ADR-017): a scene inspected on its own runs as if no
  surrounding composition existed, so the bed never plays. Scene-owned
  `ctx.audio` is unaffected — unlike `outputPolicy: 'silent'`, which
  would also silence the scene's own audio.

Bed sources pass the same `resolveAssetUrl()` scheme allowlist scene
sounds pass, but their membership allowlist is the bed declaration's
own `src` — **not** the scene-facing `allowedSources` (the slice's
`scene.audio`). The bed declaration is authoritative for the bed
exactly as `scene.audio` is for scenes. Routing the bed source through
`allowedSources` would expose the bed URL to `ctx.audio.load()`,
letting a scene register and replay the bed as its own sound even
under `mode=standalone` where the bed is suppressed; gating the bed
against its own declaration keeps the scene allowlist limited to
`scene.audio`. The runtime validation pass (PUL-F028) rejects a
malformed `audioBed` at boot. A future crossfade / ducking / multi-bed
need extends `AudioBedDeclaration` at this one seam rather than
scattering bed flags.

## Related ADRs

- [ADR-002](002-scene-registry-and-compositions.md) — defines where
  audio assets and cues are declared.
- [ADR-003](003-gsap-timeline-engine.md) — timeline callbacks are how
  most audio cues fire.
- [ADR-008](008-agent-native-authoring.md) — #1 kebab ids, #5 the only
  asset inventory is `scene.assets`.
- [ADR-017](017-workbench-mode-standalone.md) — `mode=standalone`
  suppresses the composition audio bed through the `bedSuppressed`
  scope added here.
