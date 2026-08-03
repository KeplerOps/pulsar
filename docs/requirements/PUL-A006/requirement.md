---
id: PUL-A006
title: "Live runtime is independent of slide frameworks"
status: ACTIVE
type: CONSTRAINT
priority: MUST
wave: 0
created_at: 2026-04-30T19:18:33.320260Z
updated_at: 2026-05-12T21:26:36.251439Z
---

# PUL-A006 — Live runtime is independent of slide frameworks

## Statement

The runtime core SHALL NOT import or depend on slide-framework primitives (e.g., reveal.js or Spectacle). Slide frameworks MAY be used in companion projects, separate from the runtime core.

## Rationale

Avoids the two-runtime coordination cost rejected in ADR-001.

## Traceability

- CONSTRAINS → ADR `ADR-001` (Custom Experience Runtime, Not a Slide Framework)
- TESTS → TEST `tests/runtime/policy-a006-slide-frameworks.test.ts` (PUL-A006 source-policy gate (Vitest))
- IMPLEMENTS → CODE_FILE `tests/runtime/source-policy.ts`
- IMPLEMENTS → GITHUB_ISSUE `55`
