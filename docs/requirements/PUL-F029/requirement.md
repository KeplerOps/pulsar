---
id: PUL-F029
title: "Scene-level error isolation"
status: ACTIVE
type: FUNCTIONAL
priority: MUST
wave: 1
created_at: 2026-04-30T19:17:33.258752Z
updated_at: 2026-05-12T02:53:55.260016Z
---

# PUL-F029 — Scene-level error isolation

## Statement

When a scene throws or otherwise fails during `create`, `timeline`, or `cleanup`, the runtime SHALL surface the failure with scene context and SHALL NOT halt the active composition. The presenter SHALL be able to advance past the failed scene.

## Rationale

Recoverability during live presentation.

## Traceability

- DOCUMENTS → ADR `ADR-007` (Browser as the Default Workbench and Agent Collaboration Surface)
- IMPLEMENTS → GITHUB_ISSUE `38` (PUL-F029: Scene-level error isolation)
- IMPLEMENTS → CODE_FILE `src/runtime/composition-resolver.ts`
- IMPLEMENTS → CODE_FILE `src/runtime/scene-loader.ts`
- IMPLEMENTS → CODE_FILE `src/runtime/scene-navigation.ts`
- IMPLEMENTS → ADR `ADR-028` (Scene-Level Error Isolation)
- TESTS → TEST `tests/runtime/composition-resolver.test.ts`
- TESTS → TEST `tests/runtime/scene-loader.test.ts`
- TESTS → TEST `tests/runtime/scene-loader-audio.test.ts`
- TESTS → TEST `tests/runtime/scene-navigation.test.ts`
