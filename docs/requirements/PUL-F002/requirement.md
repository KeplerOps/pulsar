---
id: PUL-F002
title: "Scene registry"
status: ACTIVE
type: FUNCTIONAL
priority: MUST
wave: 0
created_at: 2026-04-30T19:16:14.315443Z
updated_at: 2026-05-03T01:28:03.625542Z
---

# PUL-F002 — Scene registry

## Statement

The runtime SHALL register scenes by their `id` field in a single registry. The registry SHALL be the only mechanism by which scenes are addressable for navigation.

## Rationale

Stable scene identity is the basis of compositions, URL navigation, and agent edits.

## Traceability

- DOCUMENTS → ADR `ADR-002` (Scene Registry and Composition Manifests as the Core Abstraction)
- DOCUMENTS → ADR `ADR-008` (Agent-Native Authoring as a First-Class Architectural Constraint)
- IMPLEMENTS → CODE_FILE `src/runtime/registry.ts` (Scene registry — createSceneRegistry / SceneRegistry)
- TESTS → TEST `tests/runtime/registry.test.ts` (Scene registry contract spec (35 tests))
- IMPLEMENTS → GITHUB_ISSUE `8` (PUL-F002: Scene registry)
