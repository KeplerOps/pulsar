# ADR-005: DOM/CSS as the Default Rendering Surface

## Status

Accepted

## Date

2026-04-30

## Context

Pulsar scenes span a wide range of surfaces: simulated terminals, chat
interfaces, document and email mockups, dashboards, evidence boards,
case views, brand surfaces, text-heavy motion, plus occasional
sprite-driven or 3D moments.

For the bulk of these surfaces, DOM/CSS is the strongest tool:

- It handles real text, with real fonts, real selection, real
  accessibility semantics, and real responsive layout.
- It composes with HTML form elements, links, and rich layout features
  for "interactive document" scenes.
- It is the easiest surface for authors to prototype, inspect, and
  debug.
- It composes naturally with animation libraries (see
  [ADR-003](003-gsap-timeline-engine.md)) for motion.

Canvas/WebGL stacks are powerful, but they are heavier than this
content needs:

- **PixiJS** is excellent for 2D scene graphs, sprites, particles,
  parallax, and game-like HUDs — but is overkill for a chat window or
  a terminal.
- **Three.js** is excellent for 3D environments, camera flythroughs,
  spatial maps, and post-processing — but is overkill for any 2D
  content.
- **Phaser** is excellent for game mechanics, entity systems, and
  player input — but Pulsar is cinematic, not a game runtime.

Asset-format libraries (Rive, Lottie / dotLottie) are useful as content
*inside* a scene, not as the rendering core for a scene.

Adopting any of these as the default rendering surface would turn every
ordinary text-and-motion scene into a canvas-or-WebGL exercise, raising
the floor for what should be cheap content and forcing scene authors to
re-implement DOM affordances inside a scene graph.

## Decision

DOM/CSS is **the default rendering surface** in Pulsar. Other surfaces
are opt-in per scene.

- DOM/CSS is the right tool for: terminals, chat UIs, emails and
  documents, dashboards, case views, evidence boards, brand surfaces,
  and text-heavy motion. Most scenes should live here.
- **PixiJS** may be added inside a specific scene that needs a 2D scene
  graph: sprites, particle systems, parallax, many moving objects, or
  a game-like HUD. It is not part of the runtime core.
- **Three.js** may be added inside a specific scene that needs real 3D:
  3D environments, camera flythroughs, spatial maps, or WebGL
  post-processing. Cinematic intent alone is not enough; the scene
  must actually need 3D.
- **Phaser** is not adopted by default. Consider it only if a future
  scene type needs game mechanics: branching mission logic, entity
  systems, collisions, persistent world state, or player input beyond
  presenter controls.
- **Rive** and **Lottie / dotLottie** are treated as asset formats that
  scenes consume. They are not the scene rendering surface; a scene
  hosts a Rive or Lottie asset inside its DOM (or canvas) layout.

The runtime exposes consistent mounting points and lifecycle hooks for
all surfaces, so a Pixi-based scene and a DOM-based scene look the
same to navigation, timelines, and audio.

## Consequences

### Positive

- Most scenes are cheap to author: HTML + CSS + a timeline.
- Accessibility, text rendering, and layout get the browser's full
  capability for free.
- Specialized surfaces (Pixi, Three) are still reachable, but only for
  scenes that genuinely need them.
- The runtime does not impose a canvas/WebGL toolchain on every scene
  author.

### Negative

- High-density 2D motion (lots of sprites, particles) is awkward in
  pure DOM and will eventually motivate Pixi inside specific scenes.
- Scenes that mix rendering surfaces (DOM + Pixi, DOM + Three) need a
  clear story for stacking, sizing, and z-order.

### Risks

| Risk | Mitigation |
|------|-----------|
| Pixi or Three creeps in "just in case" and inflates the runtime | Keep them as scene-local dependencies; the runtime core does not import them. |
| Surfaces drift in style and ergonomics between scenes | Provide a small set of reusable scene shells (DOM, Pixi-stage, Three-stage) so authors don't reinvent mounting. |
| Asset-format libraries (Rive, Lottie) sneak into the runtime core as defaults | Treat them as scene-level assets only; do not add them to the runtime context API. |
| Authors over-reach into Three for scenes that don't need 3D | Code review: a Three.js scene must justify the 3D, not just the cinematic vibe. |

## Related ADRs

- [ADR-002](002-scene-registry-and-compositions.md) — defines the scene
  contract that all surfaces conform to.
- [ADR-003](003-gsap-timeline-engine.md) — timeline engine drives
  animation regardless of surface.
