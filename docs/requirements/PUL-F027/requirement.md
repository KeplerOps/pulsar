---
id: PUL-F027
title: "Caption metadata and prompter content"
status: ACTIVE
type: FUNCTIONAL
priority: MUST
wave: 2
created_at: 2026-04-30T19:17:26.822588Z
updated_at: 2026-05-11T04:23:51.549818Z
---

# PUL-F027 — Caption metadata and prompter content

## Statement

Each scene SHALL declare its captions in metadata as a list of `{ at, text }` entries, where `at` is a millisecond offset or a beat label. The runtime SHALL derive the prompter view from this same metadata.

## Rationale

Single source of truth for prompter and captions (ADR-008).

## Traceability

- DOCUMENTS → ADR `ADR-002` (Scene Registry and Composition Manifests as the Core Abstraction)
- DOCUMENTS → ADR `ADR-008` (Agent-Native Authoring as a First-Class Architectural Constraint)
- IMPLEMENTS → CODE_FILE `src/runtime/scene.ts` (Scene schema — Caption.at number|string union, isCaptionAt predicate, describeCaptionFault indexed validator)
- IMPLEMENTS → CODE_FILE `src/runtime/prompter.ts` (Prompter — buildPrompterScript derives view from scene.captions; carries widened Caption.at through structurally)
- IMPLEMENTS → ADR `ADR-027` (ADR-027 — Caption Timestamp Grammar: refines the caption-shape clauses in ADR-002 / ADR-022)
- TESTS → TEST `tests/runtime/scene.test.ts` (Scene schema tests — caption block: numeric+beat-label accept, every reject path, indexed error format pinned)
- TESTS → TEST `tests/runtime/prompter.test.ts` (Prompter tests — mixed numeric + beat-label passthrough pinned)
- IMPLEMENTS → GITHUB_ISSUE `36` (PUL-F027: Caption metadata and prompter content)
