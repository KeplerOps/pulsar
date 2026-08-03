---
id: PUL-Q006
title: "Error surfacing context"
status: ACTIVE
type: NON_FUNCTIONAL
priority: MUST
wave: 1
created_at: 2026-04-30T19:17:57.358657Z
updated_at: 2026-05-17T18:02:11.621921Z
---

# PUL-Q006 — Error surfacing context

## Statement

When the runtime surfaces an error, the error message SHALL include the scene id and (where applicable) the beat label or the timeline phase (`create`, `timeline`, `cleanup`).

## Rationale

Scoped diagnosis is essential for the agent loop and for live presenter recovery.

## Traceability

- DOCUMENTS → ADR `ADR-007` (Browser as the Default Workbench and Agent Collaboration Surface)
- IMPLEMENTS → CODE_FILE `src/runtime/error.ts` (Shared error helpers — formatSceneContext canonical scene-error context renderer (PUL-Q006))
- IMPLEMENTS → CODE_FILE `src/runtime/scene-loader.ts` (Scene loader — buildOnSceneFailed.renderMessage + buildOnBeatMissing compose scene-error context via formatSceneContext (PUL-Q006))
- TESTS → TEST `tests/runtime/error.test.ts` (formatSceneContext unit tests — empty/scene-only/scene+phase/scene+beat output shapes (PUL-Q006))
- TESTS → TEST `tests/runtime/pul-q006-error-context.test.ts` (PUL-Q006 cross-surface invariant suite — every runtime-error surface pinned for scene id + (phase or beat))
- DOCUMENTS → DOCUMENTATION `docs/design/pul-q006-error-surfacing-context-preflight.md` (PUL-Q006 architecture preflight design note — guardrails, cross-cutting layers, intended design)
- IMPLEMENTS → GITHUB_ISSUE `45` (PUL-Q006: Error surfacing context)
