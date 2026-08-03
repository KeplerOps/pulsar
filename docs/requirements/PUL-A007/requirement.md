---
id: PUL-A007
title: "Scene id format"
status: ACTIVE
type: CONSTRAINT
priority: MUST
wave: 0
created_at: 2026-04-30T19:18:36.039619Z
updated_at: 2026-05-03T02:28:47.712651Z
---

# PUL-A007 — Scene id format

## Statement

Scene ids SHALL be lowercase ASCII consisting of letters, digits, and hyphens. Ids SHALL NOT be reused across scenes.

## Rationale

Stable, URL-safe, kebab-case ids are the agent-addressable identity contract (ADR-002, ADR-008).

## Traceability

- IMPLEMENTS → CODE_FILE `src/runtime/identifier.ts` (Kebab-case identifier predicate — KEBAB_IDENTIFIER_PATTERN + isKebabIdentifier)
- CONSTRAINS → ADR `ADR-002` (Scene Registry and Composition Manifests as the Core Abstraction)
- CONSTRAINS → ADR `ADR-008` (Agent-Native Authoring as a First-Class Architectural Constraint)
- IMPLEMENTS → CODE_FILE `src/runtime/scene.ts` (Scene id format guard — SCENE_ID_PATTERN, isSceneId, isSceneIdOrNull)
- IMPLEMENTS → CODE_FILE `src/runtime/registry.ts` (Scene id uniqueness enforcement — createSceneRegistry duplicate-id detection)
- TESTS → TEST `tests/runtime/scene.test.ts` (Scene id format spec — 32 cases under "scene id format (PUL-A007)" + 9 defaultNext cases)
- TESTS → TEST `tests/runtime/registry.test.ts` (Scene id uniqueness spec — duplicate-id describe block in registry.test.ts)
- IMPLEMENTS → GITHUB_ISSUE `10` (PUL-A007: Scene id format)
