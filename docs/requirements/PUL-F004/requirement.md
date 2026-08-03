---
id: PUL-F004
title: "Composition resolution"
status: ACTIVE
type: FUNCTIONAL
priority: MUST
wave: 0
created_at: 2026-04-30T19:16:21.159163Z
updated_at: 2026-05-03T05:09:06.257026Z
---

# PUL-F004 — Composition resolution

## Statement

Given a composition manifest, the runtime SHALL: (a) verify every referenced scene id exists in the registry; (b) preload assets declared by each scene; (c) mount each scene in order via `create(ctx)`; (d) run its timeline; (e) tear it down via `cleanup(ctx)` before mounting the next scene.

## Rationale

Defines the runtime's lifecycle for playing a composition.

## Traceability

- IMPLEMENTS → CODE_FILE `src/runtime/composition-resolver.ts` (Composition resolver — resolveComposition orchestrator)
- TESTS → TEST `tests/runtime/composition-resolver.test.ts` (Composition resolver Vitest spec — 35 cases covering every PUL-F004 clause)
- DOCUMENTS → ADR `ADR-011` (Composition Resolver as a Pure Orchestrator with Injected Adapters)
- IMPLEMENTS → GITHUB_ISSUE `13` (PUL-F004: Composition resolution)
- DOCUMENTS → ADR `ADR-002` (Scene Registry and Composition Manifests as the Core Abstraction)
