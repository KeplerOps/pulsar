---
id: PUL-Q008
title: "Accessibility of DOM/CSS scenes"
status: ACTIVE
type: NON_FUNCTIONAL
priority: MUST
wave: 2
created_at: 2026-04-30T19:18:03.891358Z
updated_at: 2026-05-17T18:58:11.029152Z
---

# PUL-Q008 — Accessibility of DOM/CSS scenes

## Statement

Scenes rendered via DOM/CSS SHALL preserve the browser's native accessibility tree: text remains selectable, focus order follows DOM order, and ARIA attributes are not stripped by the runtime.

## Rationale

DOM/CSS as the default surface (ADR-005) only pays off if the runtime does not undermine it.

## Traceability

- DOCUMENTS → ADR `ADR-005` (DOM/CSS as the Default Rendering Surface)
- IMPLEMENTS → CODE_FILE `src/scenes/dom-css-accessibility-fixture.ts` (DOM/CSS accessibility fixture scene)
- IMPLEMENTS → CODE_FILE `src/workbench-graph.ts` (Workbench graph registration of the accessibility fixture)
- IMPLEMENTS → DOCUMENTATION `docs/design/pul-q008-dom-css-accessibility-preflight.md` (PUL-Q008 architecture preflight design note)
- TESTS → TEST `tests/runtime/policy-q008-dom-css-accessibility.test.ts` (PUL-Q008 source-policy gate (Vitest))
- TESTS → TEST `tests/scenes/dom-css-accessibility-fixture.test.ts` (PUL-Q008 fixture scene unit tests)
- TESTS → TEST `tests-e2e/dom-css-accessibility.spec.ts` (PUL-Q008 Playwright spec (chromium/firefox/webkit))
- IMPLEMENTS → GITHUB_ISSUE `47` (Issue #47 — PUL-Q008 implementation)
