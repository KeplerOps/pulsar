---
id: PUL-Q004
title: "Resource cleanup completeness"
status: ACTIVE
type: NON_FUNCTIONAL
priority: MUST
wave: 0
created_at: 2026-04-30T19:17:51.650358Z
updated_at: 2026-05-16T22:17:19.401929Z
---

# PUL-Q004 — Resource cleanup completeness

## Statement

After `cleanup(ctx)` has run for a scene, no DOM nodes, event listeners, audio handles, or timeline objects created by the scene SHALL remain attached to the runtime.

## Rationale

Cleanup leaks make scoped agent edits unsafe and corrupt subsequent scenes.

## Traceability

- DOCUMENTS → ADR `ADR-002` (Scene Registry and Composition Manifests as the Core Abstraction)
- DOCUMENTS → ADR `ADR-008` (Agent-Native Authoring as a First-Class Architectural Constraint)
- IMPLEMENTS → GITHUB_ISSUE `43` (Issue #43: PUL-Q004: Resource cleanup completeness)
- IMPLEMENTS → PULL_REQUEST `110` (PR #110: add PUL-Q004 resource cleanup completeness source-policy gate)
- TESTS → TEST `tests/runtime/policy-q004-resource-cleanup.test.ts` (PUL-Q004 resource cleanup source-policy gate (Vitest))
- DOCUMENTS → DOCUMENTATION `docs/design/pul-q004-resource-cleanup-preflight.md` (PUL-Q004 resource cleanup preflight design note)
- IMPLEMENTS → CODE_FILE `src/runtime/composition-resolver.ts` (Composition resolver — reverse-mount-order cleanup(ctx) on every exit path (happy, abort, phase failure, per-scene isolation))
- IMPLEMENTS → CODE_FILE `src/runtime/scene-loader.ts` (Scene loader — navigation completion teardown (audio.stopAll, presenterAbort.abort, controller.abort) on every exit path)
- IMPLEMENTS → CODE_FILE `src/runtime/audio.ts` (Audio service — AudioService.stopAll() on navigation signal abort: stops + unloads every sound registered by the scene)
- IMPLEMENTS → CODE_FILE `src/runtime/timeline.ts` (Timeline adapter — MasterTimeline.kill() on natural completion and abort; composeMasterTimeline kills every scene-returned timeline on compose failure)
- IMPLEMENTS → CODE_FILE `src/runtime/presenter.ts` (Presenter controller — tearDownAll on per-navigation AbortSignal; subscriptions detached and source unsubscribed once)
