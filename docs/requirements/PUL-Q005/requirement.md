---
id: PUL-Q005
title: "Validation actionability"
status: ACTIVE
type: NON_FUNCTIONAL
priority: MUST
wave: 0
created_at: 2026-04-30T19:17:54.279739Z
updated_at: 2026-05-17T05:32:34.781854Z
---

# PUL-Q005 — Validation actionability

## Statement

Each error reported by the validation pass SHALL identify the offending entity (scene id, asset path, composition id) and the failing condition in human-readable form.

## Rationale

Validation that does not produce actionable errors is a runtime smell, not a runtime feature.

## Traceability

- DOCUMENTS → ADR `ADR-008` (Agent-Native Authoring as a First-Class Architectural Constraint)
- IMPLEMENTS → GITHUB_ISSUE `44` (Issue #44: PUL-Q005: Validation actionability)
- IMPLEMENTS → CODE_FILE `src/runtime/validation.ts` (Runtime validation pass — sceneIndex carry-through, scenes[index] message rewrites for no-usable-id branches, programmatic entryIndex via CompositionManifestError)
- IMPLEMENTS → CODE_FILE `src/runtime/composition.ts` (Composition manifest validator — CompositionManifestError exposes offending entry index programmatically so validation findings carry it without message parsing)
- TESTS → TEST `tests/runtime/validation.test.ts` (PUL-Q005 actionability suite (Vitest) — scene-record position locators, duplicate-id occurrence index, asset record-position prefix, programmatic entryIndex, AggregateError self-containment)
- DOCUMENTS → DOCUMENTATION `docs/design/pul-q005-validation-actionability-preflight.md` (PUL-Q005 validation actionability preflight design note)
- IMPLEMENTS → PULL_REQUEST `113` (PR #113: Add PUL-Q005 validation actionability locators)
