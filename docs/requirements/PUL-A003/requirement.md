---
id: PUL-A003
title: "Optional rendering libraries are scene-local"
status: ACTIVE
type: CONSTRAINT
priority: MUST
wave: 0
created_at: 2026-04-30T19:18:19.087658Z
updated_at: 2026-05-12T21:26:33.394301Z
---

# PUL-A003 — Optional rendering libraries are scene-local

## Statement

The runtime core SHALL NOT import PixiJS, Three.js, or Phaser. Adoption of any of these libraries SHALL be scene-local.

## Rationale

Keeps the core lightweight and lets specialized rendering be opt-in per scene (ADR-005).

## Traceability

- CONSTRAINS → ADR `ADR-005` (DOM/CSS as the Default Rendering Surface)
- TESTS → TEST `tests/runtime/policy-a003-rendering-libraries.test.ts` (PUL-A003 source-policy gate (Vitest))
- IMPLEMENTS → CODE_FILE `tests/runtime/source-policy.ts`
- IMPLEMENTS → GITHUB_ISSUE `52`
