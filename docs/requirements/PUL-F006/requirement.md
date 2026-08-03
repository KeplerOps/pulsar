---
id: PUL-F006
title: "Per-scene cleanup invocation"
status: ACTIVE
type: FUNCTIONAL
priority: MUST
wave: 0
created_at: 2026-04-30T19:16:26.871770Z
updated_at: 2026-05-03T16:13:26.887100Z
---

# PUL-F006 — Per-scene cleanup invocation

## Statement

The runtime SHALL invoke `cleanup(ctx)` on every scene exit, including normal advance, presenter skip, runtime error within the scene, and composition end.

## Rationale

Cleanup is the runtime's lifecycle guarantee; without it, scoped agent edits cannot be safe.

## Traceability

- DOCUMENTS → ADR `ADR-002` (Scene Registry and Composition Manifests as the Core Abstraction)
- DOCUMENTS → ADR `ADR-008` (Agent-Native Authoring as a First-Class Architectural Constraint)
- IMPLEMENTS → CODE_FILE `src/runtime/composition-resolver.ts` (Composition resolver — runScene cleanup-always invariant + AbortSignal contract)
- TESTS → TEST `tests/runtime/composition-resolver.test.ts` (Composition resolver Vitest spec — PUL-F006 describe block (10 tests covering normal advance, presenter skip via AbortSignal, runtime error, composition end, exactly-once invariant))
- DOCUMENTS → ADR `ADR-011` (Composition Resolver as a Pure Orchestrator with Injected Adapters — risk-table entry updated for the AbortSignal seam landing at PUL-F006)
- IMPLEMENTS → GITHUB_ISSUE `15` (PUL-F006: Per-scene cleanup invocation)
