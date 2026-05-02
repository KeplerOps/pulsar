# Positioning and Landscape

Date: 2026-04-30

## Category

Pulsar is a code-first runtime for composing live, cinematic, reusable
narrative scenes. Coding agents are a primary authoring interface.

Scenes are software artifacts. Talks, demos, and trailers are
recompositions of those artifacts.

## Adjacent OSS Projects

Pulsar overlaps with several existing project categories. None covers
the same shape.

### Presentation Frameworks

reveal.js, Spectacle. Strong for HTML/Markdown decks with fragments,
speaker notes, overview, PDF export. Not built around reusable
cinematic scene modules, audio-first timing, or recomposable trailers.

- https://revealjs.com/
- https://www.npmjs.com/package/spectacle

### Programmatic Video

Remotion. Renders React components to MP4 with frame-level control.
Adopted as a parallel export path (ADR-006), not as the live runtime.

- https://www.remotion.dev/

### Code Animation

Motion Canvas. Code-first animation video authoring. No live
presentation runtime, no prompter, no composition model.

- https://motioncanvas.io/

### Timeline Authoring

Theatre.js. Motion authoring for the web (DOM, WebGL, JS values).
Useful as an optional authoring layer over the timeline engine, not
the runtime itself.

- https://www.theatrejs.com/

### Game / Rendering Engines

Phaser, PixiJS, Three.js. Per ADR-005, opt-in inside specific scenes
that need 2D scene-graph or 3D rendering. Not the runtime core.

- https://phaser.io/
- https://pixijs.com/
- https://threejs.org/

### AI Deck Tools

Tome, Gamma, Canva, Pitch. Optimized for nontechnical slide
generation and template editing. Different artifact shape.

## Differentiation

The differentiator is structural legibility for coding agents. The
authoring loop is human-directed and agent-implemented:

- The human describes intent.
- The agent edits one scene module.
- The human inspects the exact target via a workbench URL (ADR-007).

This loop requires structure existing creative tools do not provide:
stable scene ids, declarative manifests, named beats, mandatory
cleanup, deterministic screenshot mode, validation. It also requires
escape hatches code-only frameworks usually skip: a scene can drop
down to raw DOM, raw Web Audio, or raw canvas as long as it satisfies
the scene contract.

Pulsar treats this as a binding architectural constraint (ADR-008),
not a feature.

## Strategic Risks

### Too broad

Trying to be a deck tool, video tool, animation tool, and game engine
at once makes the project incoherent. Core stays narrow: scene
runtime plus composition.

### Too much framework

Over-prescribed structure makes one-off scenes painful. Escape hatches
exist for that.

### Too little structure

Free-form HTML/CSS/JS gives up the recomposition and agent-safe
editing properties. Scene contract, manifests, and lifecycle hooks
are non-negotiable.
