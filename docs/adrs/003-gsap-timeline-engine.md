# ADR-003: GSAP as the Timeline Engine

## Status

Accepted

## Date

2026-04-30

## Context

Pulsar scenes are timed sequences: motion, reveals, audio cues,
captions, and presenter beats fire in a coordinated order. The runtime
needs a real **timeline model**, not just a chain of `setTimeout` /
sleep helpers.

The timeline engine must support:

- Nested timelines: a composition's master timeline contains scene
  timelines, and a scene timeline may contain sub-timelines.
- Labels: named points within a timeline so trailers and rehearsal
  cuts can address a sub-range like `["intro", "hook"]`.
- Pauses, resumes, seeks, and speed changes for presenter control and
  rehearsal.
- Callbacks at arbitrary points so audio and state can be triggered
  without coupling rendering to time math.
- Interruption: presenter input must be able to advance, hold, or skip
  in the middle of a timed beat.
- DOM-friendly tweening with sane handling of transforms, opacity,
  scroll, and the usual CSS surface.

A hand-rolled `sleep(ms)` / `aSleep(ms)` / `holdUntilAdvance()` helper
is fine for prototypes. It does not compose. It does not seek. It does
not survive the moment a scene needs to be paused, scrubbed, exported,
or lifted into a trailer cut.

Candidates considered:

- **GSAP** (`gsap.timeline()`): mature, widely used, well-documented
  timeline model. First-class labels, nesting, seeking, callbacks, and
  speed control. DOM-aware, framework-agnostic.
- **Anime.js**: smaller and lighter, but the timeline ergonomics
  (especially nesting and labels) are weaker than GSAP's.
- **Motion / Framer Motion**: React-coupled and animation-state-coupled
  rather than pure timeline orchestration; not aligned with a
  framework-agnostic core runtime.
- **Hand-rolled**: re-implementing a timeline engine is a lot of
  surface area for no payoff.
- **Theatre.js**: interesting as an authoring tool layered on top of a
  timeline runtime, not as the runtime itself.

## Decision

Use **GSAP timelines** as the sequencing spine of the runtime.

- Each scene's `timeline(ctx)` returns a GSAP timeline (or a function
  that constructs one).
- The runtime composes scene timelines into a master timeline for a
  composition.
- The runtime exposes `gsap` and timeline utilities through the scene
  context (`ctx.gsap`) so scene modules do not import GSAP directly.
- Trailer-friendly subranges are expressed as labels inside a scene's
  timeline, so a composition entry can reference them by name.
- Presenter interrupts (advance, hold, skip) are implemented in terms of
  timeline operations: `play()`, `pause()`, `seek(label)`, `tweenTo()`.

Theatre.js may be prototyped later as a visual authoring layer over
GSAP timelines if timeline authoring becomes tedious in code. It is not
adopted in this ADR.

## Consequences

### Positive

- A first-class timeline model for nesting, labels, seeking, and speed
  changes is available without writing it ourselves.
- Trailer cuts and rehearsal subranges become straightforward: address
  a labeled segment of a scene timeline.
- Audio cues, state updates, and external side effects can hang off
  timeline callbacks instead of being interleaved with sleep math.
- DOM and (via plugins) canvas/SVG animation are covered by one engine,
  reducing the surface area scenes have to learn.

### Negative

- GSAP becomes a runtime dependency. Bundle size and license terms (the
  standard GSAP license is free for most uses; bonus plugins have
  separate terms) must be tracked.
- Authors have a new API surface to learn; existing prototype code
  using `sleep`/`aSleep`/`holdUntilAdvance` must be ported to timelines
  as it migrates into Pulsar.

### Risks

| Risk | Mitigation |
|------|-----------|
| Bundle size of GSAP plus plugins grows the runtime | Pin to core GSAP unless a specific scene justifies a plugin; treat plugins as opt-in per scene. |
| License confusion around bonus / Club GSAP plugins | Default to the core, freely-licensable surface; require explicit ADR / approval before adopting a paid plugin. |
| Direct `gsap.*` calls in scene code break if the engine ever changes | Route GSAP through `ctx.gsap` and a small runtime wrapper; scenes don't import the library directly. |
| Hand-rolled timing helpers in prototype code linger past migration | Migration plan converts sleep chains to GSAP timelines scene by scene; do not maintain both indefinitely. |

## Related ADRs

- [ADR-002](002-scene-registry-and-compositions.md) — defines the scene
  shape that returns a timeline.
- [ADR-001](001-custom-experience-runtime.md) — establishes that the
  custom runtime owns sequencing rather than a slide framework.
