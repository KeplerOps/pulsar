---
id: PUL-Q002
title: "Browser support"
status: ACTIVE
type: NON_FUNCTIONAL
priority: MUST
wave: 0
created_at: 2026-04-30T19:17:44.744805Z
updated_at: 2026-05-13T03:30:30.960495Z
---

# PUL-Q002 — Browser support

## Statement

The runtime SHALL function in the latest stable releases of Chromium-based browsers, Firefox, and WebKit-based browsers as of the project release.

## Rationale

Defines the supported environment without overreaching to legacy browsers.

## Traceability

- IMPLEMENTS → CODE_FILE `src/workbench-graph.ts` (Workbench graph registration (placeholder + fixture))
- IMPLEMENTS → CONFIG `.github/workflows/ci.yml` (CI workflow with browser-support job)
- IMPLEMENTS → CONFIG `package.json` (package.json (@playwright/test dep + test:browsers script))
- TESTS → TEST `tests-e2e/browser-support.spec.ts` (Playwright cross-engine smoke spec)
- TESTS → TEST `tests/runtime/policy-q002-browser-support.test.ts` (PUL-Q002 source-policy structural gate)
- TESTS → TEST `tests/scenes/browser-support-fixture.test.ts` (Browser support fixture scene unit tests)
- IMPLEMENTS → GITHUB_ISSUE `41` (PUL-Q002: Browser support)
- IMPLEMENTS → PULL_REQUEST `108` (PUL-Q002: Browser support gate)
- IMPLEMENTS → ADR `docs/adrs/030-browser-support.md` (ADR-030: Browser Support Contract)
- IMPLEMENTS → DOCUMENTATION `docs/design/pul-q002-browser-support-preflight.md` (PUL-Q002 Browser Support Preflight (codex))
- IMPLEMENTS → CONFIG `playwright.config.ts` (Playwright config (3 engine projects + webServer))
- IMPLEMENTS → CODE_FILE `src/scenes/browser-support-fixture.ts` (Browser support fixture scene (real GSAP timeline))
