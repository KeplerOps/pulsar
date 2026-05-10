# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for Pulsar.
ADRs capture significant architectural decisions along with their context,
rationale, and consequences.

## Format

We use [MADR](https://adr.github.io/madr/) (Markdown Any Decision Records).
Each ADR includes:

- **Status**: `proposed`, `accepted`, `deprecated`, or `superseded by ADR-XXX`
- **Context**: The problem or situation driving the decision
- **Decision**: What we chose and why
- **Consequences**: Trade-offs (positive, negative, risks)

## Principles

- ADRs are **immutable** once accepted. To reverse a decision, create a
  new ADR that supersedes it.
- ADRs are **numbered sequentially** and never reused.
- ADRs are **versioned with code** — they live in the repo, not a wiki.

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [000](000-template.md) | ADR Template | — |
| [001](001-custom-experience-runtime.md) | Custom Experience Runtime, Not a Slide Framework | Accepted |
| [002](002-scene-registry-and-compositions.md) | Scene Registry and Composition Manifests as the Core Abstraction | Accepted (§Resolution ordering superseded by ADR-025) |
| [003](003-gsap-timeline-engine.md) | GSAP as the Timeline Engine | Accepted |
| [004](004-howler-audio-engine.md) | Howler.js as the Audio Engine | Accepted |
| [005](005-dom-css-default-rendering-surface.md) | DOM/CSS as the Default Rendering Surface | Accepted |
| [006](006-remotion-export-path.md) | Remotion as a Parallel Export Path, Not the Live Runtime | Accepted |
| [007](007-browser-workbench.md) | Browser as the Default Workbench and Agent Collaboration Surface | Accepted |
| [008](008-agent-native-authoring.md) | Agent-Native Authoring as a First-Class Architectural Constraint | Accepted |
| [009](009-repo-layout-and-build-tooling.md) | Repo Layout and Build Tooling | Accepted |
| [010](010-issue-tag-taxonomy.md) | GitHub Issue Tag Taxonomy | Accepted |
| [011](011-composition-resolver-orchestration.md) | Composition Resolver as a Pure Orchestrator with Injected Adapters | Accepted (per-scene `runTimeline` ordering superseded by ADR-025) |
| [012](012-asset-preloader-fetch-and-drain.md) | Asset Preloader — Warm Bytes via Fetch + Drain; Decode-Complete is Future Work | Accepted |
| [013](013-url-navigation-grammar-boundary.md) | URL Navigation Grammar Boundary | Accepted |
| [014](014-url-scene-target-selection.md) | Loading the Addressed Scene as the Runtime Navigation Target | Accepted |
| [015](015-url-beat-positioning.md) | URL Beat Positioning as Timeline-Runner State | Accepted |
| [016](016-workbench-mode-present.md) | Workbench Mode `present` — Contract Boundary and Adapter Seams | Accepted |
| [017](017-workbench-mode-standalone.md) | Workbench Mode `standalone` — Single-Scene Execution at the Loader | Accepted |
| [018](018-workbench-mode-loop.md) | Workbench Mode `loop` — Runner Repeat Hint at the Loader/Runner Seam | Accepted |
| [019](019-workbench-mode-paused.md) | Workbench Mode `paused` — Runner Hold-at-First-Frame Hint at the Loader/Runner Seam | Accepted |
| [020](020-workbench-mode-scrub.md) | Workbench Mode `scrub` — Runner Cue-Gate Hint at the Loader/Runner Seam | Accepted |
| [021](021-workbench-mode-screenshot.md) | Workbench Mode `screenshot` — Runner Capture-Bundle Hint at the Loader/Runner Seam | Accepted |
| [022](022-workbench-mode-prompter.md) | Workbench Mode `prompter` — Loader-Side Lifecycle Bypass with Captions Aggregation Seam | Accepted |
| [023](023-presenter-controls.md) | Presenter Controls — Per-Navigation Command Source at the Loader/Runner Seam | Accepted |
| [024](024-presenter-pause-resume.md) | Presenter Pause/Resume — Runner-Owned Transport State on the Existing Presenter Command Seam | Accepted |
| [025](025-timeline-adapter-boundary.md) | Timeline Adapter and Composition Master — Revising the Resolution Lifecycle | Accepted (supersedes ADR-002 §Resolution + ADR-011 ordering) |
| [026](026-named-timeline-beats.md) | Named Timeline Beats — Scene-Local Kebab Labels, Validated at Compose Time, Referenced Through the Master | Accepted |
