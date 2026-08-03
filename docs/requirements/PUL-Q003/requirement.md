---
id: PUL-Q003
title: "URL state determinism"
status: ACTIVE
type: NON_FUNCTIONAL
priority: MUST
wave: 1
created_at: 2026-04-30T19:17:48.165212Z
updated_at: 2026-05-16T06:08:17.783953Z
---

# PUL-Q003 — URL state determinism

## Statement

URL parameters SHALL fully determine the runtime's targeted state. The runtime SHALL NOT use `localStorage`, `sessionStorage`, cookies, or other persisted state to determine which scene, beat, composition, or mode is targeted.

## Rationale

Agents and reviewers must be able to share URLs that produce the same target on any machine.

## Traceability

- DOCUMENTS → ADR `ADR-007` (Browser as the Default Workbench and Agent Collaboration Surface)
- IMPLEMENTS → TEST `tests/runtime/policy-q003-url-state-determinism.test.ts` (Vitest source-policy gate — structural enforcement of the persisted-state ban across src/**/*.ts)
- IMPLEMENTS → DOCUMENTATION `docs/design/pul-q003-url-state-determinism-preflight.md` (Design preflight — guardrails for URL-only target selection, alias-aware enforcement, line-scoped exemptions)
- TESTS → TEST `tests/runtime/navigation.test.ts` (PUL-Q003 behavioral describe block — seeds host globals with misleading values, asserts parseNavigationSearch/bootstrapNavigation/subscribeNavigation/effectiveMode ignore them)
- IMPLEMENTS → GITHUB_ISSUE `42` (PUL-Q003: URL state determinism)
