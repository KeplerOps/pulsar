---
id: PUL-A010
title: "Live and export share scene metadata"
status: ACTIVE
type: CONSTRAINT
priority: SHOULD
wave: 3
created_at: 2026-04-30T19:18:44.804081Z
updated_at: 2026-05-18T03:20:51.029768Z
---

# PUL-A010 — Live and export share scene metadata

## Statement

Any export pipeline SHALL consume the same scene metadata and composition manifests as the live runtime. Export-specific metadata SHALL NOT replace live-runtime metadata.

## Rationale

Shared metadata keeps the scene library as the single source of truth across surfaces (ADR-006).

## Traceability

- CONSTRAINS → ADR `ADR-006` (Remotion as a Parallel Export Path, Not the Live Runtime)
- TESTS → TEST `tests/runtime/policy-a010-export-metadata-share.test.ts` (PUL-A010 export-metadata-share source-policy gate)
- IMPLEMENTS → DOCUMENTATION `docs/design/pul-a010-live-export-metadata-preflight.md` (PUL-A010 design preflight)
- IMPLEMENTS → GITHUB_ISSUE `58` (PUL-A010: Live and export share scene metadata)
- IMPLEMENTS → PULL_REQUEST `121` (feat: add PUL-A010 live/export shared scene metadata gate)
