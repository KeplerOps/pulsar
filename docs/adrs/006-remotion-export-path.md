# ADR-006: Remotion as a Parallel Export Path, Not the Live Runtime

## Status

Accepted

## Date

2026-04-30

## Context

Pulsar is expected to produce both **live** browser experiences and
**rendered** video artifacts derived from the same scene library:

- MP4 trailers.
- Social cuts (vertical, square, short).
- Looping background videos.
- Cold-open or teaser clips.
- Internal previews and review reels.

Remotion is a strong fit for the rendered side. It renders React
components to video using a normal browser pipeline, with frame-level
control, and ships a managed render service for headless export.

There are two ways to use Remotion:

1. **As the live runtime** — author every scene as a React component
   inside Remotion, and play it back live in the browser. Then the
   rendered exports are "the same code, headless."
2. **As a parallel export path** — keep a vanilla-JS / framework-light
   live runtime for in-browser presentation, and have a separate
   Remotion project that consumes the same scene metadata and
   composition manifests to produce video artifacts.

Option 1 sounds clean but has costs:

- It forces React on every scene author for every scene, including
  text-heavy DOM scenes that don't need React.
- It conflates "live cinematic playback" with "headless frame
  rendering," which have different perf, asset-loading, and presenter
  requirements.
- It locks the live runtime into Remotion's lifecycle, sequencing,
  and asset model — the very framework-coupling
  [ADR-001](001-custom-experience-runtime.md) avoided with reveal.js
  and Spectacle.

Option 2 keeps each path good at its own job. The cost is some
duplication of rendering code between the live scene and its export
counterpart for the subset of scenes that actually get exported.

## Decision

Remotion is adopted as a **parallel export path**, not as the live
runtime.

- The live runtime continues to follow ADRs 001–005: custom runtime,
  scene/composition model, GSAP timelines, Howler audio, DOM/CSS as
  default surface.
- A separate Remotion project (in a sibling directory or workspace
  package) consumes:
  - the same scene metadata (id, duration, captions, asset list),
  - the same composition manifests (or trailer-specific subsets),
  - shared visual primitives where it's reasonable to share (colors,
    fonts, brand surfaces).
- For each scene that needs an exported version, an export-side
  rendering is implemented in Remotion. It does not have to be a
  literal port of the live scene — it can be tuned for a fixed-frame
  render, no presenter input, no live audio unlock dance, etc.
- The live runtime remains the source of truth for *what* the
  experience is (scenes, compositions, timing intent, audio cues). The
  Remotion project is the source of truth for *how* a given
  composition renders to video.

Adoption is staged: the export path is not part of the initial
runtime. It enters when there is a concrete trailer or video artifact
to ship. Until then, no Remotion code is in the repo.

## Consequences

### Positive

- The live runtime stays unencumbered by frame-rendering concerns
  (deterministic seeking, fixed FPS, headless asset loading).
- Remotion scenes are free to be tuned for video — different easing,
  different durations, different layout — without compromising the
  live experience.
- Trailers, social cuts, and video artifacts get a real, supported
  toolchain instead of screen-recording the live runtime.
- The shared scene metadata + composition manifests give both paths a
  single conceptual model even when their rendering code differs.

### Negative

- Some scenes will have two implementations (live and export). For
  those scenes, visual changes need to be made twice.
- Two render pipelines mean two places where assets must be
  available, two places where fonts must be embedded, etc.

### Risks

| Risk | Mitigation |
|------|-----------|
| Live and export versions of the same scene drift visually | Share design tokens (colors, fonts, spacing); audit exports against a recent live recording before shipping. |
| The export path becomes a permanent second-class citizen | Treat exported artifacts as real deliverables with their own ADRs and version control, not throwaway render scripts. |
| Pressure to "just author everything in Remotion to avoid duplication" returns | This ADR is the canonical pushback. If duplication ever exceeds the cost of merging, write a successor ADR rather than silently merging. |
| Remotion's render service / dependencies change underneath us | The live runtime is unaffected; only the exporter has to track Remotion versions. |

## Related ADRs

- [ADR-001](001-custom-experience-runtime.md) — establishes a
  framework-light live runtime.
- [ADR-002](002-scene-registry-and-compositions.md) — the metadata and
  manifests both runtimes consume.
- [ADR-005](005-dom-css-default-rendering-surface.md) — establishes
  DOM/CSS as the default surface in the live runtime, separate from
  Remotion's own rendering model.
