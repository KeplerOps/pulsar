---
id: PUL-F003
title: "Composition manifest format"
status: ACTIVE
type: FUNCTIONAL
priority: MUST
wave: 0
created_at: 2026-04-30T19:16:17.718055Z
updated_at: 2026-05-03T03:52:17.839316Z
---

# PUL-F003 — Composition manifest format

## Statement

A composition manifest SHALL be a declarative ordered list of scene id references. Each entry MAY be a bare scene id string or an object containing a scene id and per-entry overrides for sub-range or behavior.

## Rationale

Compositions are first-class artifacts separate from scenes; they enable recomposition (full talk, short cut, trailer) without forking scenes.

## Traceability

- IMPLEMENTS → CODE_FILE `src/runtime/composition.ts` (Composition manifest format — types + assertCompositionManifest + isCompositionManifest)
- TESTS → TEST `tests/runtime/composition.test.ts` (Composition manifest format Vitest spec — clauses C1-C3 + AC1-AC2 + ADR-002 fixtures)
- IMPLEMENTS → GITHUB_ISSUE `12` (PUL-F003: Composition manifest format)
- DOCUMENTS → ADR `ADR-002` (Scene Registry and Composition Manifests as the Core Abstraction)
- DOCUMENTS → ADR `ADR-008` (Agent-Native Authoring as a First-Class Architectural Constraint)
