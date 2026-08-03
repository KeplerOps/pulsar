---
id: PUL-A001
title: "Timeline library encapsulation"
status: ACTIVE
type: CONSTRAINT
priority: MUST
wave: 0
created_at: 2026-04-30T19:18:12.240742Z
updated_at: 2026-05-12T21:26:30.999476Z
---

# PUL-A001 — Timeline library encapsulation

## Statement

Scene modules SHALL NOT import the timeline library directly. Scene timelines SHALL be constructed via the timeline utilities exposed on the scene context.

## Rationale

Encapsulating the timeline library lets the runtime swap implementations without breaking scenes (ADR-003).

## Traceability

- CONSTRAINS → ADR `ADR-003` (GSAP as the Timeline Engine)
- CONSTRAINS → ADR `ADR-008` (Agent-Native Authoring as a First-Class Architectural Constraint)
- TESTS → TEST `tests/runtime/policy-a001-timeline-encapsulation.test.ts` (PUL-A001 source-policy gate (Vitest))
- IMPLEMENTS → CODE_FILE `tests/runtime/source-policy.ts`
- IMPLEMENTS → GITHUB_ISSUE `50`
