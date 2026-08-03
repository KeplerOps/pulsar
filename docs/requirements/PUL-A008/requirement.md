---
id: PUL-A008
title: "Mode dispatch in core"
status: ACTIVE
type: CONSTRAINT
priority: MUST
wave: 1
created_at: 2026-04-30T19:18:39.441198Z
updated_at: 2026-05-17T21:55:03.440234Z
---

# PUL-A008 — Mode dispatch in core

## Statement

Workbench mode dispatch SHALL be implemented in the runtime core. Scene modules SHALL NOT contain mode-specific branches except where they must respond to mode hints (e.g., suppressing audio in `mode=screenshot`).

## Rationale

Mode behavior must be uniform across scenes (ADR-007, ADR-008).

## Traceability

- CONSTRAINS → ADR `ADR-007` (Browser as the Default Workbench and Agent Collaboration Surface)
- CONSTRAINS → ADR `ADR-008` (Agent-Native Authoring as a First-Class Architectural Constraint)
- IMPLEMENTS → CODE_FILE `src/runtime/navigation.ts` (URL navigation grammar — NAVIGATION_MODES allowlist, parseNavigationSearch, effectiveMode (pure URL-derived mode dispatch boundary for PUL-A008 clause 1))
- IMPLEMENTS → CODE_FILE `src/runtime/scene-loader.ts` (Scene loader — per-navigation mode dispatch: validateModeGrammar, audioOutputPolicyFor(mode), mode→runner-input hints, buildPresenterPipe, ctx.mode threading (PUL-A008 clause 1 in the runtime core))
- IMPLEMENTS → DOCUMENTATION `docs/design/pul-a008-mode-dispatch-core-preflight.md` (PUL-A008 architectural preflight — consolidated repo-wide guardrails for mode-dispatch boundary, required reuse, cross-cutting layers, extensibility seam, and anti-patterns)
- IMPLEMENTS → GITHUB_ISSUE `56` (Issue #56 — PUL-A008: Mode dispatch in core)
- TESTS → TEST `tests/runtime/policy-a008-mode-dispatch.test.ts` (PUL-A008 source-policy gate — scene-local mode-literal branch detector (binary equality, switch/case, .includes membership) with const-alias resolution)
