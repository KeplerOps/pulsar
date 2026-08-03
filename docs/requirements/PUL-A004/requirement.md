---
id: PUL-A004
title: "Live runtime is independent of the export pipeline"
status: ACTIVE
type: CONSTRAINT
priority: MUST
wave: 0
created_at: 2026-04-30T19:18:22.241247Z
updated_at: 2026-05-12T21:26:34.152746Z
---

# PUL-A004 — Live runtime is independent of the export pipeline

## Statement

The runtime core SHALL NOT import Remotion or any video-rendering library. Export functionality SHALL live in a separate codebase that consumes the same scene metadata and composition manifests.

## Rationale

Separation of concerns between live playback and headless export (ADR-006).

## Traceability

- CONSTRAINS → ADR `ADR-006` (Remotion as a Parallel Export Path, Not the Live Runtime)
- TESTS → TEST `tests/runtime/policy-a004-export-pipeline.test.ts` (PUL-A004 source-policy gate (Vitest))
- IMPLEMENTS → CODE_FILE `tests/runtime/source-policy.ts`
- IMPLEMENTS → GITHUB_ISSUE `53`
