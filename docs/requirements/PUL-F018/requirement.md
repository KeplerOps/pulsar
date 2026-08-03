---
id: PUL-F018
title: "Workbench mode — screenshot"
status: ACTIVE
type: FUNCTIONAL
priority: MUST
wave: 1
created_at: 2026-04-30T19:17:02.849756Z
updated_at: 2026-05-21T17:01:55.363946Z
---

# PUL-F018 — Workbench mode — screenshot

## Statement

In `mode=screenshot`, the runtime SHALL render the addressed scene at the addressed beat (or first frame if no beat) with all asset preloads resolved, no animation in progress, all audio suppressed, and any randomness sourced from a deterministic seed.

## Rationale

Deterministic visual regression hooks for agents and reviewers.

## Traceability

- TESTS → TEST `tests/scenes/screenshot-rng-fixture.test.ts` (Screenshot RNG fixture scene: same-seed identical projection, different-seed divergence, contract shape)
- TESTS → TEST `tests-e2e/screenshot-mode.spec.ts` (Playwright e2e: two loads of the same screenshot URL replay a byte-identical random sequence)
- DOCUMENTS → ADR `ADR-007` (Browser as the Default Workbench and Agent Collaboration Surface)
- DOCUMENTS → ADR `ADR-008` (Agent-Native Authoring as a First-Class Architectural Constraint)
- DOCUMENTS → GITHUB_ISSUE `27` (PUL-F018: Workbench mode — screenshot)
- DOCUMENTS → ADR `ADR-021` (ADR-021: Workbench Mode `screenshot` — Runner Capture-Bundle Hint at the Loader/Runner Seam)
- DOCUMENTS → DOCUMENTATION `docs/design/pul-f018-screenshot-mode-preflight.md` (PUL-F018 Screenshot Mode Preflight (codex architecture preflight design context))
- DOCUMENTS → TEST `tests/runtime/composition-resolver.test.ts` (Composition-resolver tests — URL screenshot-mode runner capture-hint forwarding describe block (PUL-F018 resolver: headScreenshot to plan[0] only, key-presence, no-op, independence))
- DOCUMENTS → TEST `tests/runtime/scene-navigation.test.ts` (Scene-navigation tests — URL screenshot-mode capture forwarding describe block (PUL-F018 bridge: screenshot → headScreenshot plumbing, slice truncation under screenshot, independence from beat / repeat / hold / cueGate))
- IMPLEMENTS → GITHUB_ISSUE `131` (PUL-F018: screenshot-mode runtime (frame freeze, preload await, deterministic seed))
- IMPLEMENTS → CODE_FILE `src/runtime/rng.ts` (Deterministic seeded PRNG (mulberry32 + xmur3) — the sanctioned randomness source for PUL-F018)
- DOCUMENTS → TEST `tests/runtime/scene-loader-screenshot-prompter.test.ts` (Loader tests — screenshot-mode runner capture-hint forwarding describe block (PUL-F018 boundary: loader → adapter screenshot, slice truncation, ctx.mode seam, beat-alongside-screenshot, range/behavior preserved). Split from scene-loader.test.ts (ADR-025).)
- IMPLEMENTS → CODE_FILE `src/runtime/scene-loader.ts` (Loader: WorkbenchSceneCtx.rng, deriveNavigationSeed, per-occurrence RNG threading, screenshot mode dispatch)
- IMPLEMENTS → CODE_FILE `src/runtime/timeline.ts` (GSAP composition timeline: screenshot frame freeze (positionMaster seek-to-beat-or-0 + pause))
- IMPLEMENTS → CODE_FILE `src/runtime/audio.ts` (Audio service: screenshot audio suppression via AudioOutputPolicy 'silent' (muted sounds))
- IMPLEMENTS → CODE_FILE `src/runtime/composition-resolver.ts` (Composition resolver: asset-preload fence — every declared preload awaited before create/timeline/master playback)
- TESTS → TEST `tests/runtime/rng.test.ts` (PRNG determinism: same seed → identical sequence, distinct seeds diverge, draws bounded [0,1))
- TESTS → TEST `tests/runtime/scene-loader-screenshot-seed.test.ts` (deriveNavigationSeed purity/distinctness + loader ctx.rng determinism and per-occurrence independence)
