---
id: PUL-F031
title: "Workbench chrome surface"
status: ACTIVE
type: FUNCTIONAL
priority: MUST
wave: 1
created_at: 2026-05-09T01:43:51.818650Z
updated_at: 2026-05-17T22:44:11.718471Z
---

# PUL-F031 — Workbench chrome surface

## Statement

The runtime SHALL render a workbench chrome surface around the scene stage. Chrome SHALL be workbench-owned, mounted before the first scene navigation, and SHALL NOT be created or mutated by scene modules. Chrome rendering SHALL be governed by the active workbench mode: `mode=present` renders chrome fully; modes that explicitly suppress chrome (e.g., `mode=standalone`, `mode=screenshot`) SHALL hide it. Chrome SHALL persist across scene navigations within a composition without being torn down between scenes.

## Rationale

Per ADR-007 and ADR-016, chrome is the persistent UI a presenter and reviewer rely on to orient navigation and presenter affordances. Chrome must be workbench-owned to keep mode dispatch in the runtime core (PUL-A008) and to prevent scene modules owning UI that should outlive scene cleanup. PUL-F013 ACTIVE depends on this requirement landing.

## Traceability

- IMPLEMENTS → GITHUB_ISSUE `77` (PUL-F031: Workbench chrome surface)
- IMPLEMENTS → PULL_REQUEST `119` (feat: add PUL-F031 workbench chrome surface)
- IMPLEMENTS → CODE_FILE `src/runtime/workbench-chrome.ts`
- IMPLEMENTS → CODE_FILE `src/runtime/scene-loader.ts`
- IMPLEMENTS → CODE_FILE `src/main.ts`
- IMPLEMENTS → ADR `docs/adrs/031-workbench-chrome-surface.md` (ADR-031: Workbench Chrome Surface)
- TESTS → TEST `tests/runtime/workbench-chrome.test.ts`
- TESTS → TEST `tests/runtime/scene-loader-chrome.test.ts`
