---
id: PUL-F013
title: "Workbench mode — present"
status: ACTIVE
type: FUNCTIONAL
priority: MUST
wave: 1
created_at: 2026-04-30T19:16:45.215253Z
updated_at: 2026-05-18T21:21:55.903870Z
---

# PUL-F013 — Workbench mode — present

## Statement

In `mode=present`, the runtime SHALL render full chrome, audio, and inter-scene transitions, and SHALL respond to presenter input.

## Rationale

Default presentation behavior.

## Traceability

- DOCUMENTS → ADR `ADR-007` (Browser as the Default Workbench and Agent Collaboration Surface)
- DOCUMENTS → ADR `ADR-016` (ADR-016: Workbench Mode `present` — Contract Boundary and Adapter Seams)
- DOCUMENTS → DOCUMENTATION `docs/design/pul-f013-present-mode-preflight.md` (PUL-F013 Present Mode Preflight (codex architecture preflight design context))
- DOCUMENTS → GITHUB_ISSUE `22` (PUL-F013: Workbench mode — present)
- IMPLEMENTS → CODE_FILE `src/main.ts` (Workbench composition root — wires chrome, audio, transition registry + overlay, and keyboard + bridge presenter sources into the scene loader)
- IMPLEMENTS → CODE_FILE `src/runtime/timeline.ts` (Timeline engine — Transition/TransitionRegistry contract; applySegmentTransition invokes inter-scene transitions while composing the GSAP master timeline)
- IMPLEMENTS → CODE_FILE `src/runtime/workbench-chrome.ts` (Workbench chrome surface — mode-governed chrome rendering for mode=present)
- IMPLEMENTS → CODE_FILE `src/runtime/audio.ts` (Audio service — Howler-backed per-navigation AudioService rendering audio under mode=present)
- IMPLEMENTS → CODE_FILE `src/runtime/presenter.ts` (Presenter command schema + boundary validator — the runtime seam that responds to presenter input)
- IMPLEMENTS → CODE_FILE `src/runtime/scene-loader.ts` (Scene loader — present-mode dispatch building per-navigation audio service, presenter controller, and chrome dispatch)
- IMPLEMENTS → CODE_FILE `src/system/transitions/registry.ts` (Default inter-scene transition implementations — cut, dissolve, hard-slam, hold-on-black, push)
- TESTS → TEST `tests/runtime/scene-loader-present.test.ts` (Present-mode scene-loader tests — chrome, audio, transitions, and presenter seams under mode=present)
- TESTS → TEST `tests/system/transitions.test.ts` (Inter-scene transition contract tests — default transition implementations)
- TESTS → TEST `tests-e2e/pulsar-intro.spec.ts` (Present-mode e2e — chrome surface, transition overlay, present playback, keyboard advance under chromium/firefox/webkit)
