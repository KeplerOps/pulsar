---
id: PUL-Q001
title: "Screenshot determinism"
status: DRAFT
type: NON_FUNCTIONAL
priority: MUST
wave: 1
created_at: 2026-04-30T19:17:41.993185Z
updated_at: 2026-04-30T19:17:41.993185Z
---

# PUL-Q001 — Screenshot determinism

## Statement

For a given code revision and a given workbench URL with `mode=screenshot`, the rendered output SHALL be byte-identical across reloads on the same browser engine and platform.

## Rationale

Determinism is what makes screenshot mode useful for visual regression and agent verification.

## Traceability

- DOCUMENTS → ADR `ADR-007` (Browser as the Default Workbench and Agent Collaboration Surface)
- DOCUMENTS → ADR `ADR-008` (Agent-Native Authoring as a First-Class Architectural Constraint)
- DOCUMENTS → GITHUB_ISSUE `40` (PUL-Q001: Screenshot determinism)
- DOCUMENTS → TEST `tests/runtime/screenshot-determinism-source.test.ts` (PUL-Q001 — screenshot determinism source scan (structural gate))
- DOCUMENTS → GITHUB_ISSUE `133` (PUL-Q001: empirical byte-equality verification for screenshot mode)
