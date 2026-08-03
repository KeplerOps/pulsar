---
id: PUL-Q009
title: "Asset failure surfacing"
status: ACTIVE
type: NON_FUNCTIONAL
priority: MUST
wave: 0
created_at: 2026-04-30T19:18:06.915217Z
updated_at: 2026-05-17T07:28:53.653512Z
---

# PUL-Q009 — Asset failure surfacing

## Statement

When an asset declared by a scene fails to load during preload, the runtime SHALL surface the failure with the scene id and asset path before mounting the scene.

## Rationale

Silent asset failures cause unexplained visual breakage at presentation time.

## Traceability

- DOCUMENTS → ADR `ADR-002` (Scene Registry and Composition Manifests as the Core Abstraction)
- IMPLEMENTS → CODE_FILE `src/runtime/error.ts` (Shared error helpers — describeErrorDetailed bounded multi-cause renderer (PUL-Q009 public-surface seam))
- IMPLEMENTS → CODE_FILE `src/runtime/scene-loader.ts` (Scene loader — surfaceError renders via describeErrorDetailed so scene id + every failing asset path land on data-pulsar-navigation-error and onError (PUL-Q009))
- TESTS → TEST `tests/runtime/error.test.ts` (describeErrorDetailed unit tests — AggregateError/cause walking, default unbounded branches, depth bound, cycle guard, PUL-Q009 every-asset-path invariant)
- TESTS → TEST `tests/runtime/scene-loader.test.ts` (Scene loader integration test — PUL-Q009: AggregateError-shaped preload throw surfaces scene id + every asset path via onError and data-pulsar-navigation-error, create(ctx) never called)
- IMPLEMENTS → GITHUB_ISSUE `48` (PUL-Q009: Asset failure surfacing)
