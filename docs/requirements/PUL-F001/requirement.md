---
id: PUL-F001
title: "Scene module shape"
status: ACTIVE
type: FUNCTIONAL
priority: MUST
wave: 0
created_at: 2026-04-30T19:16:11.856896Z
updated_at: 2026-05-03T00:43:09.810404Z
---

# PUL-F001 — Scene module shape

## Statement

A scene module SHALL export an object containing the fields `id`, `title`, `tags`, `assets`, `captions`, `defaultNext`, `standalone`, `trailerSafe`, `create`, `timeline`, and `cleanup`. The `duration` field SHALL be present and SHALL be either a non-negative integer in milliseconds or `null` for an open-ended/interrupt-driven scene.

## Rationale

Defines the contract every scene satisfies. Required by the scene/composition model (ADR-002) and the agent-native authoring constraint (ADR-008).

## Traceability

- DOCUMENTS → ADR `ADR-002` (Scene Registry and Composition Manifests as the Core Abstraction)
- DOCUMENTS → ADR `ADR-008` (Agent-Native Authoring as a First-Class Architectural Constraint)
- IMPLEMENTS → CODE_FILE `src/runtime/scene.ts` (SceneModule contract + assertSceneModule + isSceneModule)
- TESTS → TEST `tests/runtime/scene.test.ts` (SceneModule contract Vitest spec — 62 tests covering every clause)
- IMPLEMENTS → GITHUB_ISSUE `6` (PUL-F001: Scene module shape)
