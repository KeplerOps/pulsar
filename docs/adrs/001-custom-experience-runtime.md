# ADR-001: Custom Experience Runtime, Not a Slide Framework

## Status

Proposed

## Date

2026-04-30

## Context

Pulsar's target output is a timed, cinematic, media-rich browser
experience — not a deck of bullet slides. The runtime must be able to:

- Run interruptible cinematic beats with timed, staged reveals.
- Hold a persistent stage chrome across scenes (titles, brandmarks, act
  frames, vignettes, scanlines, grain, bars, flashes).
- Mix text-heavy surfaces (terminals, chat, documents, dashboards,
  evidence boards, brand surfaces) with optional 2D and 3D visuals.
- Drive multiple synchronized layers: motion, audio, captions, prompter,
  and presenter controls.
- Support manual navigation and URL-addressable jumps to any scene,
  beat, composition, or workbench mode.
- Serve as the **authoring workbench** as well as the live runtime: a
  coding agent edits a scene and the human inspects the exact target
  scene in the browser without advancing through the whole talk
  (see [ADR-007](007-browser-workbench.md)).
- Reuse scenes across multiple compositions: full talks, short cuts,
  trailers, standalone demos, rehearsal cuts.
- Export some compositions as rendered video (MP4, social cuts, looping
  backgrounds) without owning a separate parallel codebase.

Established slide frameworks each optimize for a different shape of
content:

- **reveal.js** is excellent for HTML/Markdown decks with fragments,
  speaker notes, overview mode, and PDF export. Its mental model is
  slides with transitions; cinematic/timeline work has to be retrofitted
  into slide containers.
- **Spectacle** is excellent for React-authored decks where the team
  wants JSX/MDX, presenter mode, and PDF export. It assumes a React
  build chain and a slide-shaped composition model.

Both are strong frameworks. Neither natively models scenes as
programmable, timeline-driven, recomposable units. Adopting one as the
core runtime would push the cinematic, timeline, audio, prompter, and
trailer concerns into custom code wrapped *around* the slide framework,
producing two runtimes to coordinate instead of one.

A custom runtime, by contrast, can treat scenes as the primary
abstraction and adopt slide frameworks (or anything else) as companion
tools where they specifically help.

## Decision

Build Pulsar as a custom **experience runtime** rather than adopting
reveal.js or Spectacle as the core.

The custom runtime owns:

- Scene registration, lifecycle (create, timeline, cleanup), and
  navigation.
- Composition resolution: turning a manifest of scene ids into a
  presentable sequence with shared chrome and continuity.
- Timeline orchestration (delegated to a timeline library; see ADR-003).
- Audio orchestration (delegated to an audio library; see ADR-004).
- Presenter controls and rehearsal/prompter views.
- URL-addressable navigation (e.g. `?composition=...&scene=...&beat=...`).
- The **browser workbench**: a first-class authoring/inspection surface
  with workbench modes (`present`, `standalone`, `loop`, `paused`,
  `scrub`, `screenshot`, `prompter`) and a stable URL contract usable
  by coding agents (see [ADR-007](007-browser-workbench.md)).
- Asset preloading, error handling, and per-scene cleanup.

Slide frameworks may be used as **companion** tools where they fit:

- A separate companion deck for a static, slide-shaped derivative of
  some content can be authored in reveal.js.
- A React-native companion deck can use Spectacle if a downstream team
  prefers that workflow.

They are not adopted as the core runtime, and Pulsar scenes are not
authored as reveal.js slides or Spectacle components.

## Consequences

### Positive

- The core abstraction is a scene, not a slide. Scenes can carry their
  own timelines, assets, captions, and metadata without bending around
  slide-frame containers.
- One runtime, not two — no impedance between cinematic logic and a
  slide framework's lifecycle.
- The runtime is free to express compositions, trailers, standalone
  demos, and rehearsal cuts as first-class manifests over the same scene
  library.
- The runtime can grow specialized rendering surfaces (DOM, canvas,
  WebGL, video export) without renegotiating with a host framework.

### Negative

- Pulsar must implement features that slide frameworks ship out of the
  box: presenter view, fragments-style staged reveals (covered via
  timelines), markdown/MDX authoring (if ever needed), PDF export,
  overview mode.
- No prebuilt plugin ecosystem to draw from.

### Risks

| Risk | Mitigation |
|------|-----------|
| Runtime accumulates ad-hoc features instead of clean layers | Hold the line on the layered architecture (registry, compositions, timeline, audio, surfaces, export) and write ADRs for each layer choice. |
| Re-implementing speaker-notes/presenter-mode poorly | Treat the prompter and presenter views as first-class subsystems, not afterthoughts. |
| Pressure to "just use reveal.js" for one off needs leaks slide semantics back into the core | Keep companion decks fully separate; do not import slide-framework primitives into core scene authoring. |

## Related ADRs

- [ADR-002](002-scene-registry-and-compositions.md) — defines the scene
  and composition model the custom runtime owns.
- [ADR-003](003-gsap-timeline-engine.md) — timeline engine choice.
- [ADR-004](004-howler-audio-engine.md) — audio engine choice.
- [ADR-005](005-dom-css-default-rendering-surface.md) — default
  rendering surface.
- [ADR-006](006-remotion-export-path.md) — export path for rendered
  video.
- [ADR-007](007-browser-workbench.md) — browser as the default
  authoring/inspection surface with workbench modes.
- [ADR-008](008-agent-native-authoring.md) — agent-native authoring as
  a first-class architectural constraint.
