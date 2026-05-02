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
| [001](001-custom-experience-runtime.md) | Custom Experience Runtime, Not a Slide Framework | Proposed |
| [002](002-scene-registry-and-compositions.md) | Scene Registry and Composition Manifests as the Core Abstraction | Proposed |
| [003](003-gsap-timeline-engine.md) | GSAP as the Timeline Engine | Proposed |
| [004](004-howler-audio-engine.md) | Howler.js as the Audio Engine | Proposed |
| [005](005-dom-css-default-rendering-surface.md) | DOM/CSS as the Default Rendering Surface | Proposed |
| [006](006-remotion-export-path.md) | Remotion as a Parallel Export Path, Not the Live Runtime | Proposed |
| [007](007-browser-workbench.md) | Browser as the Default Workbench and Agent Collaboration Surface | Proposed |
| [008](008-agent-native-authoring.md) | Agent-Native Authoring as a First-Class Architectural Constraint | Proposed |
