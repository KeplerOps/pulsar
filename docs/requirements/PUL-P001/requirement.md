---
id: PUL-P001
title: "Mandatory cleanup contract"
status: ACTIVE
type: CONSTRAINT
priority: MUST
wave: 0
created_at: 2026-04-30T19:18:48.252403Z
updated_at: 2026-05-12T16:16:40.928203Z
---

# PUL-P001 — Mandatory cleanup contract

## Statement

Every scene module MUST export a `cleanup(ctx)` function. The runtime MUST invoke it on scene exit. Cleanup leaks (DOM, listeners, audio, timeline objects) MUST be treated as runtime defects.

## Rationale

Cleanup is the runtime invariant that makes scoped agent edits safe (ADR-008).

## Traceability

- CONSTRAINS → ADR `ADR-008` (Agent-Native Authoring as a First-Class Architectural Constraint)
- IMPLEMENTS → CODE_FILE `src/runtime/scene.ts` (SceneModule contract + assertSceneModule (cleanup required field))
- IMPLEMENTS → CODE_FILE `src/runtime/composition-resolver.ts` (Composition resolver — mandatory cleanup invocation on every scene exit (including failure paths))
- IMPLEMENTS → CODE_FILE `src/runtime/scene-loader.ts` (Scene loader — cleanup-before-handoff for every navigation)
- IMPLEMENTS → CODE_FILE `src/runtime/validation.ts` (Validation pass — clause (d) detects scenes that do not export cleanup)
- TESTS → TEST `tests/runtime/scene.test.ts` (Scene contract tests — cleanup field shape)
- TESTS → TEST `tests/runtime/composition-resolver.test.ts` (Composition resolver tests — mandatory cleanup invocation)
- TESTS → TEST `tests/runtime/validation.test.ts` (Validation tests — clause (d) missing-cleanup detection)
- IMPLEMENTS → GITHUB_ISSUE `59` (Issue #59 — PUL-P001 mandatory cleanup contract)
