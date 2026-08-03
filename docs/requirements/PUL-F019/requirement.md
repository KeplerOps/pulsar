---
id: PUL-F019
title: "Workbench mode — prompter"
status: ACTIVE
type: FUNCTIONAL
priority: MUST
wave: 1
created_at: 2026-04-30T19:17:05.438511Z
updated_at: 2026-05-18T18:48:18.112074Z
---

# PUL-F019 — Workbench mode — prompter

## Statement

In `mode=prompter`, the runtime SHALL render a script/caption view derived from the captions metadata of the addressed scene or composition. Visual rendering of the scene SHALL be suppressed.

## Rationale

Prompter and reviewer caption review.

## Traceability

- DOCUMENTS → ADR `ADR-007` (Browser as the Default Workbench and Agent Collaboration Surface)
- DOCUMENTS → ADR `ADR-008` (Agent-Native Authoring as a First-Class Architectural Constraint)
- DOCUMENTS → GITHUB_ISSUE `28` (PUL-F019: Workbench mode — prompter)
- DOCUMENTS → ADR `ADR-022` (ADR-022: Workbench Mode `prompter` — Loader-Side Lifecycle Bypass with Captions Aggregation Seam)
- DOCUMENTS → TEST `tests/runtime/prompter.test.ts` (Prompter pure-function tests — buildPrompterScript (PUL-F019 captions aggregation: single-scene, full composition slice, composition+scene non-head, structural caption clone, manifest-metadata passthrough, deep-frozen output, source-isolation invariants))
- DOCUMENTS → TEST `tests/runtime/scene-loader-screenshot-prompter.test.ts` (Loader tests — prompter-mode caption-view dispatch describe block (PUL-F019 boundary: structural lifecycle suppression, full-slice captions aggregation, renderer dispatch + abort lifecycle). Split from scene-loader.test.ts (ADR-025).)
