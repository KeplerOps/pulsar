---
id: PUL-F020
title: "Presenter controls — advance, hold, skip"
status: ACTIVE
type: FUNCTIONAL
priority: MUST
wave: 1
created_at: 2026-04-30T19:17:08.111959Z
updated_at: 2026-05-18T21:22:41.156959Z
---

# PUL-F020 — Presenter controls — advance, hold, skip

## Statement

In `mode=present`, the runtime SHALL accept presenter input to advance to the next beat, hold the current beat, skip forward, and skip backward. Beat progression SHALL be interruptible without breaking timeline state.

## Rationale

Required for live presentation control.

## Traceability

- DOCUMENTS → ADR `ADR-007` (Browser as the Default Workbench and Agent Collaboration Surface)
- DOCUMENTS → GITHUB_ISSUE `29` (PUL-F020: Presenter controls — advance, hold, skip)
- DOCUMENTS → ADR `ADR-023` (ADR-023: Presenter Controls — Per-Navigation Command Source at the Loader/Runner Seam)
- DOCUMENTS → DOCUMENTATION `docs/design/pul-f020-presenter-controls-preflight.md` (PUL-F020 Presenter Controls Preflight (codex architecture preflight design context))
- DOCUMENTS → TEST `tests/runtime/presenter.test.ts` (Presenter pure-module tests (PUL-F020 boundary: command kinds + validator + per-navigation controller — abort teardown, post-abort/post-unsubscribe emission guards, idempotent source unsubscribe, frozen defensive copy, sibling isolation))
- DOCUMENTS → TEST `tests/runtime/scene-navigation.test.ts` (Scene-navigation tests — URL present-mode presenter forwarding describe block (PUL-F020 bridge: presenter to runner single + composition, every-scene NOT head-only, no-truncation under presenter, key-presence omission))
- DOCUMENTS → TEST `tests/runtime/scene-loader-present.test.ts` (Loader tests — presenter-controls dispatch (PUL-F020): mode=present forwarding, per-mode negatives, every-kind delivery, abort-detaches, cleanup-before-handoff, onError. Split from scene-loader.test.ts; updated for ADR-025 single timeline.run forwarding.)
- IMPLEMENTS → CODE_FILE `src/runtime/timeline.ts` (GSAP composition timeline runner — applyPresenterCommandToMaster translates advance / hold / skip-forward / skip-backward into master transport (PUL-F020); per-activation held / explicitlyPaused state distinguishes a beat hold from an explicit pause.)
- IMPLEMENTS → CODE_FILE `src/system/presenter/keyboard-source.ts` (Keyboard presenter source — DEFAULT_KEYBOARD_BINDINGS maps ArrowRight/Space (advance), KeyP (hold), ArrowLeft/PageUp (skip-backward), PageDown (skip-forward) into PresenterCommands under mode=present.)
- TESTS → TEST `tests/runtime/timeline.test.ts` (Timeline tests — presenter command transport describe block: advance releases a hold and seeks to the next beat; hold is idempotent (not a toggle); skip-forward/skip-backward seek segments.)
- TESTS → TEST `tests/system/presenter-keyboard.test.ts` (Keyboard presenter tests — PageDown emits skip-forward, PageUp emits skip-backward; end-to-end dispatch: a real keydown drives the master timeline to the next segment.)
- IMPLEMENTS → GITHUB_ISSUE `132` (PUL-F020 / PUL-F021 / PUL-F025: wire presenter keyboard input + GSAP pause/resume)
