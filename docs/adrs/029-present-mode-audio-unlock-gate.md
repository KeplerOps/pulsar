# ADR-029: Present-Mode Audio Unlock Gate Before Composition Start

## Status

Accepted

## Date

2026-05-12

## Context

PUL-F030 requires:

> On loading `mode=present` for a composition that declares audio, the
> runtime SHALL provide a single explicit user-gesture interaction that
> satisfies browser autoplay policy before the composition begins.

ADR-004 already centralizes audio behind the runtime-owned Howler
adapter and forbids scene-local unlock code. Its implementation note
relied on Howler's passive `autoUnlock`: a scene may call `play()`
before the browser audio context is resumed, then Howler resumes after
the first user gesture.

That is not enough for PUL-F030. PUL-F030 requires an explicit
presenter interaction before the composition lifecycle begins, not a
deferred first cue after scenes have mounted.

## Decision

Supersede ADR-004's passive-autounlock clause for present-mode
composition loads that declare audio.

The runtime SHALL gate `mode=present` composition playback behind one
workbench-owned explicit user gesture when the resolved composition
slice declares audio. The gate runs before the resolver lifecycle:
before asset preload, scene `create(ctx)`, scene `timeline(ctx)`, and
master timeline playback.

The gate belongs at the loader/workbench boundary because that layer
has all required facts:

- the effective workbench mode from `effectiveMode()`,
- the resolved composition slice from `resolveSceneNavigation()`,
- the per-navigation `AbortSignal`,
- the runtime audio engine boundary from ADR-004,
- the visible workbench DOM surface that can collect a user gesture.

Scenes do not own autoplay policy. They still use `ctx.audio` only.
The composition resolver remains mode-opaque and must not prompt,
inspect DOM, import Howler, or learn audio-unlock semantics.

The unlock operation itself remains behind the runtime audio boundary.
The workbench or loader must not import Howler directly. A no-audio
engine resolves the same unlock contract without visible policy work.

## Consequences

### Positive

- Browser autoplay policy is satisfied before the first scene starts,
  so a present-mode composition cannot begin with a suspended first
  cue.
- The gesture is centralized once per navigation, not copied into
  scenes or repeated per scene.
- The resolver and timeline contracts stay unchanged.
- Future status UI can observe the same loader/workbench gate instead
  of reading Howler globals or scene state.

### Negative

- The runtime needs a static way to know that a composition slice
  declares audio before lifecycle execution. Imperative
  `ctx.audio.load()` calls inside `create(ctx)` are too late for this
  requirement.
- A present-mode navigation with audio can now wait for presenter
  interaction before any preload or scene mount work begins.
- Test harnesses need a deterministic unlock adapter so runtime tests
  do not depend on browser audio APIs.

### Risks

| Risk | Mitigation |
|------|------------|
| Audio declaration drifts into a second schema | If a declaration field is needed, add it to the existing `SceneModule` / `assertSceneModule()` contract and require its sources to reference `scene.assets`. Do not add a composition-level audio manifest or separate audio DTO. |
| Unlock UI leaks into scenes | Keep gesture collection in the workbench surface and unlock execution behind the runtime audio boundary. Scenes continue to receive only `ctx.audio`. |
| A stale unlock click starts a superseded navigation | The gate must be tied to the same per-navigation `AbortSignal` the loader already uses for preload, timeline, presenter cleanup, and audio disposal. |
| Non-present modes inherit present-mode prompting | Gate only for effective `present` composition navigations that declare audio. Screenshot, paused, rehearsal, prompter, scrub, loop, and standalone keep their existing contracts. |
| The implementation keeps relying on Howler `autoUnlock` alone | Treat Howler auto-unlock as a fallback inside the engine, not as satisfaction of PUL-F030's explicit pre-composition interaction. |

## Related ADRs

- [ADR-004](004-howler-audio-engine.md) - Howler remains the audio
  engine and `ctx.audio` remains the scene-facing API.
- [ADR-007](007-browser-workbench.md) - mode selection is URL-owned.
- [ADR-013](013-url-navigation-grammar-boundary.md) - URL parsing
  preserves absent `mode`; the loader derives effective `present`.
- [ADR-014](014-url-scene-target-selection.md) - composition targets
  are resolved before lifecycle execution.
- [ADR-016](016-workbench-mode-present.md) - `mode=present` is the
  baseline mode that renders audio.
- [ADR-025](025-timeline-adapter-boundary.md) - the resolver lifecycle
  remains preload, create, timeline, cleanup; unlock happens before
  that lifecycle starts.
