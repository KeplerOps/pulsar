# ADR-004: Howler.js as the Audio Engine

## Status

Proposed

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

## Related ADRs

- [ADR-002](002-scene-registry-and-compositions.md) — defines where
  audio assets and cues are declared.
- [ADR-003](003-gsap-timeline-engine.md) — timeline callbacks are how
  most audio cues fire.
