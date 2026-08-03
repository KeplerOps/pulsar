---
id: PUL-F012
title: "URL parameter — mode"
status: ACTIVE
type: FUNCTIONAL
priority: MUST
wave: 1
created_at: 2026-04-30T19:16:42.530916Z
updated_at: 2026-05-05T21:37:36.354958Z
---

# PUL-F012 — URL parameter — mode

## Statement

When the `mode` URL parameter is present, the runtime SHALL select the corresponding workbench mode. If `mode` is absent, the runtime SHALL default to `present`.

## Rationale

Mode is selected by URL only; not by stored state.

## Traceability

- IMPLEMENTS → PULL_REQUEST `75` (PUL-F012: URL parameter `mode`)
- DOCUMENTS → ADR `ADR-007` (Browser as the Default Workbench and Agent Collaboration Surface)
- IMPLEMENTS → CODE_FILE `src/runtime/navigation.ts` (effectiveMode helper — pure URL-only mode dispatch boundary (target?.mode ?? 'present'))
- IMPLEMENTS → CODE_FILE `src/runtime/scene-loader.ts` (SceneLoader — runtime-core seam: buildCtx(effectiveMode(target)) per navigation, validateModeGrammar defense-in-depth, abort-on-builder-throw, WorkbenchSceneCtx.mode field)
- IMPLEMENTS → CODE_FILE `src/main.ts` (Workbench entry — buildCtx: (mode) =&gt; ({ stage, mode }) wires per-navigation effective mode into WorkbenchSceneCtx)
- IMPLEMENTS → CODE_FILE `src/scenes/placeholder.ts` (Placeholder isWorkbenchCtx predicate — validates ctx.mode against NAVIGATION_MODES and ctx.stage shape so PUL-F012's mode-aware ctx contract is enforced at the scene boundary)
- TESTS → TEST `tests/runtime/navigation.test.ts` (effectiveMode tests — per-mode round-trip + URL-only-source spy installation on localStorage/sessionStorage/document.cookie/history.state)
- TESTS → TEST `tests/scenes/placeholder.test.ts` (Placeholder ctx-shape tests — pin no-op contract on malformed mode and malformed stage shapes)
- DOCUMENTS → ADR `ADR-013` (URL Navigation Grammar Boundary — names the parser-vs-runtime-core boundary for PUL-F012 (parser preserves absent mode; runtime core derives effective `present` and exposes ctx.mode))
- IMPLEMENTS → GITHUB_ISSUE `21` (PUL-F012: URL parameter — mode)
- TESTS → TEST `tests/runtime/scene-loader-beat-mode.test.ts` (SceneLoader mode-dispatch tests — buildCtx input + ctx.mode threading + no-leak across navigations + defense-in-depth + abort-on-builder-throw. Split from scene-loader.test.ts (ADR-025).)
