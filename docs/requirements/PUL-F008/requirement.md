---
id: PUL-F008
title: "URL parameter — scene"
status: ACTIVE
type: FUNCTIONAL
priority: MUST
wave: 1
created_at: 2026-04-30T19:16:32.220250Z
updated_at: 2026-05-03T22:55:21.997950Z
---

# PUL-F008 — URL parameter — scene

## Statement

When the `scene` URL parameter is present, the runtime SHALL load the addressed scene as the navigation target.

## Rationale

Direct scene addressing is the basis of agent verification and reviewer use.

## Traceability

- DOCUMENTS → ADR `ADR-007` (Browser as the Default Workbench and Agent Collaboration Surface)
- IMPLEMENTS → CODE_FILE `src/runtime/scene-navigation.ts` (Scene navigation dispatch — resolveSceneNavigation + loadSceneNavigationTarget bridge)
- IMPLEMENTS → CODE_FILE `src/runtime/scene-loader.ts` (Scene loader — createSceneLoader state machine + WorkbenchSceneCtx)
- IMPLEMENTS → CODE_FILE `src/runtime/composition-registry.ts` (Composition registry — addressability path the `composition` URL parameter consults)
- IMPLEMENTS → CODE_FILE `src/main.ts` (Workbench entry — wires F007's bootstrapNavigation to F008's SceneLoader so URL targets drive the lifecycle)
- DOCUMENTS → ADR `ADR-014` (Loading the Addressed Scene as the Runtime Navigation Target)
- TESTS → TEST `tests/runtime/scene-navigation.test.ts` (Scene navigation dispatch tests — locator kinds, slice immutability, identity guarantees, lifecycle integration)
- TESTS → TEST `tests/runtime/scene-loader.test.ts` (Scene loader tests — queue supersession, cleanup-before-handoff, error surfacing, abort coordination)
- TESTS → TEST `tests/runtime/composition-registry.test.ts` (Composition registry tests — id validation, manifest validation, deep-frozen snapshot, generator inputs)
- IMPLEMENTS → GITHUB_ISSUE `17` (PUL-F008: URL parameter — scene)
- IMPLEMENTS → PULL_REQUEST `70` (Add scene URL parameter resolver (PUL-F008))
