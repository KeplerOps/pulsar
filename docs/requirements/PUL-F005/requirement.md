---
id: PUL-F005
title: "Per-scene asset declaration and preload"
status: ACTIVE
type: FUNCTIONAL
priority: MUST
wave: 0
created_at: 2026-04-30T19:16:24.194542Z
updated_at: 2026-05-03T06:16:32.805167Z
---

# PUL-F005 — Per-scene asset declaration and preload

## Statement

Each scene SHALL declare its required assets in metadata. The runtime SHALL preload declared assets for the active composition before the scene mounts.

## Rationale

Predictable asset behavior enables reasoning by humans and agents and enables deterministic screenshot rendering.

## Traceability

- DOCUMENTS → ADR `ADR-002` (Scene Registry and Composition Manifests as the Core Abstraction)
- DOCUMENTS → ADR `ADR-008` (Agent-Native Authoring as a First-Class Architectural Constraint)
- IMPLEMENTS → CODE_FILE `src/runtime/asset-preloader.ts` (Asset preloader — createAssetPreloader factory (clause b))
- IMPLEMENTS → CODE_FILE `src/runtime/scene.ts` (SceneModule.assets field declaration + assertSceneModule field-guard (clause a))
- TESTS → TEST `tests/runtime/asset-preloader.test.ts` (Asset preloader Vitest spec — 34 cases covering every PUL-F005 clause-(b) behavior)
- DOCUMENTS → ADR `ADR-012` (Asset Preloader — Warm Bytes via Fetch + Drain; Decode-Complete is Future Work)
- IMPLEMENTS → GITHUB_ISSUE `14` (PUL-F005: Per-scene asset declaration and preload)
- DOCUMENTS → DOCUMENTATION `docs/asset-url-policy.md` (Asset URL and credential policy (production))
