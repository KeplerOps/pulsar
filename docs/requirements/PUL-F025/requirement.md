---
id: PUL-F025
title: "Master mute"
status: ACTIVE
type: FUNCTIONAL
priority: MUST
wave: 1
created_at: 2026-04-30T19:17:21.493234Z
updated_at: 2026-05-18T21:23:02.557254Z
---

# PUL-F025 — Master mute

## Statement

The runtime SHALL accept presenter input to toggle master mute. Master mute SHALL silence audio without altering timeline state.

## Rationale

Presenter audio control during live runs.

## Traceability

- DOCUMENTS → ADR `ADR-004` (Howler.js as the Audio Engine)
- DOCUMENTS → GITHUB_ISSUE `34` (PUL-F025: Master mute)
- DOCUMENTS → DOCUMENTATION `docs/design/pul-f025-master-mute-preflight.md` (PUL-F025 master mute preflight — codex architecture guardrails for composing ADR-004 master mute with the ADR-023 presenter command seam (no new ADR; runtime-side handler in scene-loader buildLoad))
- DOCUMENTS → CODE_FILE `src/runtime/presenter.ts` (Presenter module — PRESENTER_COMMAND_KINDS adds the PUL-F025 toggle-master-mute kind; createPresenterController refactored to centralized validation + contained subscribe-time throws. PUL-F025 stays DRAFT pending presenter UI.)
- DOCUMENTS → CODE_FILE `src/runtime/scene-loader.ts` (Scene loader — buildPresenterPipe subscribes a per-navigation audio handler that calls audio.mute(!audio.isMuted()) on toggle-master-mute; separate presenterAbort signal so the navigation signal stays un-aborted on success.)
- DOCUMENTS → TEST `tests/runtime/presenter.test.ts` (Presenter pure-module tests — PUL-F025 coverage: seven-kind allowlist incl. toggle-master-mute; isPresenterCommand accept/reject coverage; centralized validation (one onError per emission); contained subscribe-time throw via onError.)
- DOCUMENTS → TEST `tests/runtime/scene-loader-present.test.ts` (Loader tests — presenter master-mute dispatch (PUL-F025 / ADR-004): toggle, round-trip, timeline-state-untouched, mode scoping, engine round-trip, cross-scene persistence, abort detach, post-completion teardown.)
- IMPLEMENTS → CODE_FILE `src/system/presenter/keyboard-source.ts` (Keyboard presenter source — DEFAULT_KEYBOARD_BINDINGS maps KeyM to toggle-master-mute, the presenter input surface for PUL-F025.)
- TESTS → TEST `tests/system/presenter-keyboard.test.ts` (Keyboard presenter tests — KeyM emits toggle-master-mute.)
- IMPLEMENTS → GITHUB_ISSUE `132` (PUL-F020 / PUL-F021 / PUL-F025: wire presenter keyboard input + GSAP pause/resume)
