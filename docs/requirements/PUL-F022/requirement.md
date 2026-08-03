---
id: PUL-F022
title: "Timeline orchestration"
status: ACTIVE
type: FUNCTIONAL
priority: MUST
wave: 2
created_at: 2026-04-30T19:17:13.492296Z
updated_at: 2026-05-10T15:53:24.356372Z
---

# PUL-F022 — Timeline orchestration

## Statement

Each scene SHALL produce a timeline that the runtime composes into a master timeline for the active composition. The composed timeline SHALL support play, pause, seek, speed change, and named labels.

## Rationale

Timeline composition is the runtime's sequencing spine (ADR-003).

## Traceability

- DOCUMENTS → ADR `ADR-003` (GSAP as the Timeline Engine)
- IMPLEMENTS → CODE_FILE `src/runtime/timeline.ts` (GSAP timeline adapter — ctx.gsap, composeMasterTimeline, MasterTimeline, createGsapCompositionTimeline)
- IMPLEMENTS → CODE_FILE `src/runtime/composition-resolver.ts` (Composition resolver — mount-all → compose-master → play → cleanup-all lifecycle (ADR-025))
- IMPLEMENTS → ADR `ADR-025` (Timeline Adapter and Composition Master — Revising the Resolution Lifecycle)
- TESTS → TEST `tests/runtime/timeline.test.ts` (GSAP timeline adapter tests — engine, assertSceneTimeline, composeMasterTimeline, MasterTimeline transport, createGsapCompositionTimeline)
- TESTS → TEST `tests/runtime/composition-resolver.test.ts` (Composition resolver tests — mount-all → compose-master → play → cleanup-all lifecycle, abort checkpoints, failure semantics)
- IMPLEMENTS → GITHUB_ISSUE `31` (PUL-F022: Timeline orchestration)
