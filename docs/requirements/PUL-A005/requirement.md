---
id: PUL-A005
title: "Composition is declarative"
status: ACTIVE
type: CONSTRAINT
priority: MUST
wave: 0
created_at: 2026-04-30T19:18:25.743385Z
updated_at: 2026-05-12T21:26:35.304298Z
---

# PUL-A005 — Composition is declarative

## Statement

Compositions SHALL be expressed as declarative manifests of scene ids. The runtime SHALL NOT support imperative dispatch (e.g., `if/else` branching or position-based dispatch in a control script) as the source of truth for composition order.

## Rationale

Manifests-over-flow-control is a binding constraint of the agent-native model (ADR-002, ADR-008).

## Traceability

- CONSTRAINS → ADR `ADR-002` (Scene Registry and Composition Manifests as the Core Abstraction)
- CONSTRAINS → ADR `ADR-008` (Agent-Native Authoring as a First-Class Architectural Constraint)
- TESTS → TEST `tests/runtime/policy-a005-declarative-composition.test.ts` (PUL-A005 source-policy gate (Vitest))
- IMPLEMENTS → CODE_FILE `src/compositions/default.ts` (Reference declarative composition manifest)
- IMPLEMENTS → GITHUB_ISSUE `54`
