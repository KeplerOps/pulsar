# Architecture Recommendations

Date: 2026-04-30

## Executive Recommendation

Do not migrate the originating custom runtime wholesale to reveal.js or
Spectacle. The project is moving beyond slideware into timed, cinematic,
media-rich presentation experiences. The better direction is to refactor
the originating runtime into a deliberate "experience runtime": a small
composition system for scenes, timelines, audio, reusable chunks, and
alternate outputs such as trailers.

Recommended stack:

- Custom experience runtime for scene registration, navigation, composition,
  metadata, and presenter controls.
- Browser-first local workbench for rapid human/agent collaboration, with every
  scene addressable by URL.
- GSAP for timeline sequencing and animation orchestration.
- Howler.js for audio playback, fades, sprites, loops, and sound grouping.
- DOM/CSS for text-heavy presentation surfaces, terminals, documents, chat,
  dashboards, and branded slides.
- Optional PixiJS layer for 2D cinematic/game-like visuals.
- Optional Remotion export path for rendered trailers and social/video cuts.
- Optional Theatre.js prototype if visual timeline authoring becomes important.

Avoid making Phaser, Three.js, PixiJS, or Remotion the default runtime until a
specific scene type clearly requires them.

## Origin and Motivating Patterns

The originating custom runtime is not a conventional deck. It is a custom
theatrical runtime implemented with plain HTML, CSS, and JavaScript modules,
with the following building blocks observed in the source repo:

- An `index.html` that defines a persistent stage with fixed regions for
  title, brandmark, act frame, centerpiece, flash, vignette, scanlines,
  grain, and bars.
- An entry script that runs an async presenter loop, dispatches scenes by
  number, handles skipped beats, supports URL jumps via `?scene=N` /
  `?slide=N`, and maps keyboard input to runtime state.
- A shared mutable state module exposing runtime state such as
  `advanceSignal`, `direction`, and `currentSlide`.
- A utility module with interruptible timing, typewriter effects, source
  marks, centerpiece mounting, and chrome-reset helpers.
- A structured metadata table with per-scene metadata for later acts and
  helper shells for more conventional presentation-style scenes.
- A scenes module containing a large set of scene functions, many of
  which are closer to scripted sequences than slides.
- A practice/rehearsal module implementing rehearsal captions tied to
  scene numbers and timed chunks.
- A prompter module rendering a separate script view from the practice
  script.

This shape matters. The originating runtime already has features that
slide frameworks usually do not model well:

- Interruptible cinematic beats.
- Timed typing and staged reveals.
- Persistent stage chrome across scenes.
- Manual and URL-addressable navigation.
- Presenter rehearsal captions.
- A separate prompter view.
- Chart visualizations.
- Image-heavy and simulation-like scenes.
- Growing need for sound.
- Need to reuse chunks as standalone pieces, recomposed talks, or trailers.
- Direct browser navigation to the scene being edited.

That last point is especially important for agent collaboration. The browser
is the easiest shared display target: the coding agent can change a scene,
and the human can jump directly to the relevant URL to inspect it without
navigating through the whole talk.

## reveal.js Assessment

reveal.js is a strong slide framework. It would make sense for a more standard
HTML/Markdown deck that needs:

- Speaker view.
- Markdown authoring.
- Fragments.
- Overview mode.
- PDF export.
- Plugin ecosystem.

It is not the best default for Pulsar because the project needs a runtime
that treats scenes as programmable, timeline-driven experiences. A
reveal.js migration would likely put the cinematic runtime inside a slide
framework, leaving two runtimes to coordinate.

Use reveal.js only for simpler companion decks or static derivatives.

## Spectacle Assessment

Spectacle is a React presentation framework. It is useful when a project wants
React component authoring, JSX/MDX workflows, presenter mode, and PDF export.

It is less compelling here because the originating repo has no
package-managed frontend stack and the core need is not React-based slide
composition. Adopting Spectacle would introduce React and build tooling
while still leaving the hardest problems — cinematic timing, audio, scene
reuse, and trailer composition — to custom code.

Use Spectacle only if future companion decks are intentionally React-native
and mostly slide-like.

## Recommended Architecture

The core abstraction should be a reusable scene module, not a slide.

Example shape:

```js
export const scene = {
  id: "scene-c",
  title: "Feature Reveal",
  duration: 42000,
  tags: ["act-i", "reveal", "trailer", "sound"],
  assets: [
    "assets/scene-c/blackout.jpg",
    "assets/audio/stinger.mp3",
  ],
  captions: [
    { at: 0, text: "OPENING HOOK CAPTION." },
  ],
  create(ctx) {
    // Mount DOM, Pixi container, or other scene-specific elements.
  },
  timeline(ctx) {
    const tl = ctx.gsap.timeline();
    return tl;
  },
  cleanup(ctx) {
    // Stop audio, remove listeners, clear mounted scene state.
  },
};
```

Compositions should be separate from scenes:

```js
export const fullTalk = [
  "cold-open",
  "scene-a",
  "scene-b",
  "scene-c",
  "scene-d",
];

export const trailer90 = [
  "cold-open-hook",
  "first-payoff",
  "tension-overload",
  "feature-reveal",
];
```

The runtime should resolve a composition into scenes, load assets, mount each
scene, run its timeline, respond to presenter controls, and clean up before the
next scene.

## Proposed Runtime Layers

### 1. Scene Registry

Replace manual `if/else` dispatch with a registry:

```js
export const scenes = {
  "cold-open": coldOpenScene,
  "scene-a": sceneA,
  "scene-c": sceneC,
};
```

Each scene should have stable metadata:

- `id`
- `title`
- `duration`
- `tags`
- `assets`
- `captions`
- `defaultNext`
- `standalone`
- `trailerSafe`

### 2. Composition Manifests

Decks, sections, trailers, rehearsal cuts, and standalone demos should be
manifests over the same scene modules:

- Full long-form presentation.
- Mid-length conference version.
- Short cold-open-only demo.
- Trailer cut.
- Customer- or audience-specific subset.
- Practice chunk.

This is the biggest structural unlock. It lets scenes become assets instead of
being hard-coded positions in one deck.

### 3. Browser Workbench

The browser should remain the default display and collaboration target.

The runtime should make every useful work unit directly addressable:

- `?scene=scene-c`
- `?scene=scene-c&mode=standalone`
- `?composition=trailer90&scene=tension-overload`
- `?composition=fullTalk&index=17`
- `?scene=capability-curve&beat=threshold-labels`

The goal is fast human/agent iteration:

- The agent edits a specific scene module.
- The browser URL points directly at that scene.
- The human refreshes or hot-reloads and inspects the exact target.
- Screenshots and visual checks can run against the same URL.
- The same scene can later be loaded inside a full talk, short talk, or trailer.

This should be treated as a core runtime feature, not a debug convenience.

Useful workbench modes:

- `present`: normal presenter-controlled runtime.
- `standalone`: single scene, no surrounding talk flow.
- `loop`: scene repeats for visual/audio tuning.
- `paused`: scene mounts at first frame and waits.
- `scrub`: timeline controls are visible.
- `screenshot`: deterministic state for visual checks.
- `prompter`: script/caption view for the selected scene or composition.

The direct URL model also gives coding agents a stable contract. An agent can
report "I changed `scene-c`; inspect it at `?scene=scene-c&mode=standalone`"
instead of asking the human to manually advance through the presentation.

### 4. Timeline Engine

Use GSAP timelines as the sequencing spine. Timelines should handle:

- Nested scene timelines.
- Labels.
- Pauses.
- Seeking.
- Speed changes.
- Callbacks for audio and state changes.
- Trailer cuts using partial timeline ranges.

The current `sleep`, `aSleep`, and `holdUntilAdvance` helpers in the
originating runtime are a useful prototype, but the project will benefit
from first-class timelines once sound, recomposition, and trailers become
normal.

### 5. Audio Engine

Use Howler.js for:

- Sound effects.
- Background beds.
- Audio sprites.
- Fades.
- Looping.
- Volume groups.
- Optional spatial audio.

The runtime should expose audio through context:

```js
ctx.audio.play("stinger");
ctx.audio.fade("bed", 0.8, 0.15, 1200);
ctx.audio.stopGroup("scene");
```

Do not scatter raw audio elements through individual scenes unless a scene has a
specific reason to own low-level playback.

### 6. Rendering Surfaces

Keep DOM/CSS as the default rendering surface. It remains the right tool for:

- Terminal recreations.
- Chat interfaces.
- Emails and documents.
- Dashboards.
- Case views.
- Brand slides.
- Evidence boards.
- Text-heavy motion.

Add PixiJS only for scenes that need a 2D scene graph, sprites, particle
systems, parallax, many moving objects, or game-like HUD animation.

Add Three.js only for real 3D scenes: camera moves, 3D environments, object
flythroughs, or spatial maps.

### 7. Export Path

Use Remotion as a parallel export path, not as the live runtime. The likely
future need is to turn scene manifests into:

- MP4 trailers.
- Social cuts.
- Cold-open video assets.
- Looping background videos.
- Conference teaser clips.

The live runtime and Remotion exporter can share scene metadata and composition
manifests even if they do not share all rendering code.

## Library Notes

### GSAP

Best fit for the immediate architecture. It gives the project a proven timeline
model without forcing a full rendering framework.

Use for:

- Scene timelines.
- Nested sequences.
- Labels and pauses.
- DOM animation.
- Timeline seeking.
- Reusable chunks.

Source: https://gsap.com/docs/v3/GSAP/Timeline/

### Howler.js

Best fit for browser audio. It is small, focused, and covers the likely needs
for sound-rich scenes.

Use for:

- Sound effects.
- Music beds.
- Fades.
- Audio sprites.
- Looping.
- Grouped cleanup.

Source: https://howlerjs.com/

### PixiJS

Good optional layer for 2D cinematic rendering.

Use when DOM/CSS starts to struggle with:

- Sprites.
- Particles.
- Parallax scenes.
- High-volume animated objects.
- Game-like HUDs.
- Canvas/WebGL visual effects.

Sources:

- https://pixijs.com/
- https://pixijs.com/7.x/guides/basics/what-pixijs-is

### Remotion

Good export layer, not the live presentation runtime. It is relevant because the
project explicitly wants trailers and recomposed cuts.

Use for:

- Rendering MP4s.
- Trailer generation.
- Social clips.
- Exported cold opens.

Source: https://cloudrun.remotion.dev/

### Theatre.js

Worth prototyping if timeline authoring becomes tedious in code. It is more
interesting as an animation authoring tool than as the core runtime.

Use for:

- Visual motion tuning.
- Timeline curves.
- Camera/property animation.
- Director-like editing workflow.

Source: https://www.theatrejs.com/

### Phaser

Consider only if the experience becomes genuinely game-like.

Use if future work requires:

- Branching mission mechanics.
- Entity systems.
- Collision.
- Player input beyond presenter controls.
- Persistent world state.
- Game scene lifecycle.

It is probably too heavy as the default for cinematic presentations.

Sources:

- https://docs.phaser.io/phaser/getting-started/what-is-phaser
- https://docs.phaser.io/phaser/concepts/scenes

### Three.js

Use only for real 3D. Do not add it merely because the work is cinematic.

Use for:

- 3D environments.
- Camera flythroughs.
- 3D spatial maps.
- Spatial objects.
- WebGL post-processing.

Source: https://threejs.org/docs/pages/WebGLRenderer.html

### Rive

Good for interactive vector animation assets with state machines. Treat it as
an asset/runtime inside a scene, not the presentation runtime itself.

Source: https://rive.app/docs/runtimes/web

### Lottie / dotLottie

Good for packaged motion graphics, especially when assets come from a design
pipeline. Treat it as an asset format inside scenes.

Source: https://developers.lottiefiles.com/docs/dotlottie-player/dotlottie-web/

### reveal.js

Useful for conventional decks, Markdown slides, fragments, speaker notes, and
PDF export. Not recommended as the core runtime for this project direction.

Sources:

- https://revealjs.com/
- https://revealjs.com/speaker-view/
- https://revealjs.com/markdown/
- https://revealjs.com/pdf-export/

### Spectacle

Useful for React-based presentation authoring. Not recommended as the default
runtime unless the project intentionally moves to React-first slides.

Source: https://www.npmjs.com/package/spectacle/v/5.7.2

## Migration Plan

### Phase 1: Stabilize the Originating Runtime

- Create a scene registry.
- Move scene dispatch out of the entry script.
- Give every scene a stable `id`, title, and tags.
- Keep numeric scene navigation as a compatibility layer.
- Add a composition manifest that reproduces the originating runtime's order.

### Phase 2: Unify Metadata

- Merge the existing scene-metadata table, scene functions, and practice
  script into or behind a shared scene/composition model.
- Keep existing practice captions, but attach them to scene IDs instead of
  only scene numbers.
- Let the prompter render from compositions rather than directly from the
  practice script.

### Phase 3: Introduce GSAP

- Start with one or two scenes that currently use complex sleep chains.
- Convert those scenes to GSAP timelines.
- Preserve presenter interrupt behavior.
- Add labels for trailer-friendly subranges.

### Phase 4: Introduce Howler

- Add an audio context/service.
- Define audio assets in scene metadata.
- Support per-scene cleanup.
- Support master mute and rehearsal mode.

### Phase 5: Composition and Trailer Workflows

- Add alternate manifests: full talk, short talk, cold open, trailer.
- Add URL parameters for `?composition=trailer90&scene=...`.
- Add a way to launch a single scene standalone.
- Add browser workbench modes for standalone, loop, paused, scrub, screenshot,
  and prompter views.
- Prototype a Remotion export path for one trailer or cold-open sequence.

## Design Principle

The important shift is from "deck as a linear file" to "scene library plus
compositions." A scene should be able to stand alone, appear inside a full talk,
appear in a shorter talk, or be reused as part of a trailer. The custom runtime
should own that model. External libraries should be adopted where they make a
specific layer stronger, not where they force the project back into slide
semantics.
