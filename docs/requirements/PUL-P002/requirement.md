---
id: PUL-P002
title: "Validation runs in CI"
status: ACTIVE
type: CONSTRAINT
priority: MUST
wave: 0
created_at: 2026-04-30T19:18:50.946517Z
updated_at: 2026-05-12T16:16:44.803906Z
---

# PUL-P002 — Validation runs in CI

## Statement

The validation pass MUST run in CI on every pull request. CI MUST fail when validation reports any error.

## Rationale

Validation that does not gate merges does not protect the loop (ADR-008).

## Traceability

- CONSTRAINS → ADR `ADR-008` (Agent-Native Authoring as a First-Class Architectural Constraint)
- IMPLEMENTS → CODE_FILE `src/workbench-graph.ts` (Canonical workbench-graph module — single source for scenes + compositions consumed by main.ts AND the CI gate)
- IMPLEMENTS → CODE_FILE `src/main.ts` (Workbench bootstrap — imports canonical graph for boot-time validation)
- IMPLEMENTS → CONFIG `.github/workflows/ci.yml` (CI workflow — pnpm test:coverage job runs the validation gate on every PR)
- TESTS → TEST `tests/runtime/workbench-graph.test.ts` (Workbench-graph integration gate — asserts zero findings + fault-injection per PUL-F028 clause)
- IMPLEMENTS → GITHUB_ISSUE `60` (Issue #60 — PUL-P002 validation runs in CI)
- IMPLEMENTS → PULL_REQUEST `106` (PR #106 — bundle PUL-P001..P005 + workbench-graph CI gate)
