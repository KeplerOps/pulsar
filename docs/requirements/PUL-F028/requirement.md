---
id: PUL-F028
title: "Validation"
status: ACTIVE
type: FUNCTIONAL
priority: MUST
wave: 0
created_at: 2026-04-30T19:17:30.249579Z
updated_at: 2026-05-11T05:32:27.744008Z
---

# PUL-F028 — Validation

## Statement

The runtime SHALL provide a validation pass that detects: scene ids referenced in compositions but not present in the registry; assets referenced in scene metadata but not resolvable; duplicate scene ids; scenes that do not export a `cleanup` function.

## Rationale

Validation catches structural breakage before agents or humans waste time on it (ADR-008).

## Traceability

- DOCUMENTS → ADR `ADR-008` (Agent-Native Authoring as a First-Class Architectural Constraint)
- IMPLEMENTS → CODE_FILE `src/runtime/validation.ts` (validateRuntime — structural validation pass over scenes, compositions, asset policy; the four clauses of PUL-F028)
- IMPLEMENTS → CODE_FILE `src/runtime/id-registry.ts` (createIdRegistry — onDuplicate collector hook lets the validator aggregate duplicate scene-ids without throwing while runtime boot stays fail-fast)
- IMPLEMENTS → CODE_FILE `src/main.ts` (Workbench entry — invokes validateRuntime + assertNoValidationFindings at boot against the same scenes/compositions handed to the registry constructors, halting before lifecycle effects on a broken graph)
- TESTS → TEST `tests/runtime/validation.test.ts` (Vitest suite — clause-by-clause coverage for validateRuntime + assertNoValidationFindings (33 tests))
- TESTS → TEST `tests/runtime/id-registry.test.ts` (Vitest suite — locks the onDuplicate collector contract validation depends on (5 tests))
- DOCUMENTS → DOCUMENTATION `CHANGELOG.md` (CHANGELOG — [Unreleased] / Added entry for the runtime validation pass)
- DOCUMENTS → DOCUMENTATION `docs/design/pul-f028-validation-preflight.md` (Design preflight — architectural guardrails for PUL-F028: reuse contracts, no side effects, asset-policy seam)
- IMPLEMENTS → GITHUB_ISSUE `37` (PUL-F028: Validation)
