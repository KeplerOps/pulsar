---
id: PUL-F021
title: "Pause and resume"
status: ACTIVE
type: FUNCTIONAL
priority: MUST
wave: 1
created_at: 2026-04-30T19:17:10.386106Z
updated_at: 2026-05-18T21:22:51.494576Z
---

# PUL-F021 — Pause and resume

## Statement

The runtime SHALL accept presenter input to pause the active timeline and SHALL accept input to resume from the same point.

## Rationale

Presenter recovery during interruptions (questions, technical pauses).

## Traceability

- DOCUMENTS → ADR `ADR-007` (Browser as the Default Workbench and Agent Collaboration Surface)
- DOCUMENTS → GITHUB_ISSUE `30` (PUL-F021: Pause and resume)
- DOCUMENTS → ADR `ADR-024` (ADR-024: Presenter Pause/Resume — Runner-Owned Transport State on the Existing Presenter Command Seam (extends ADR-023 with the pause/resume command kinds; pins the cross-command precedence contract; PUL-F021 stays DRAFT until the GSAP runner lands))
- DOCUMENTS → DOCUMENTATION `docs/design/pul-f021-pause-resume-preflight.md` (PUL-F021 Pause and Resume Preflight (codex architecture preflight design context: boundary, required reuse of the ADR-023 incumbents, cross-cutting layer table, guardrails incl. cross-command precedence, extensibility point, non-goals, anti-patterns))
- DOCUMENTS → TEST `tests/runtime/presenter.test.ts` (Presenter pure-module tests — PUL-F021 seam coverage: PRESENTER_COMMAND_KINDS pins the six-kind list; isPresenterCommand admits `pause` / `resume` (and rejects `paused`); createPresenterController forwards `pause` then `resume` to the runner in order)
- DOCUMENTS → CODE_FILE `src/runtime/presenter.ts` (Presenter command module — PRESENTER_COMMAND_KINDS extended with the PUL-F021 `pause` / `resume` kinds; ADR-024 contract recorded in the module docstring. Forward-looking: DRAFT until the GSAP runner proves same-point behavior.)
- DOCUMENTS → TEST `tests/runtime/scene-loader-present.test.ts` (Loader tests — presenter-controls dispatch describe block: PUL-F021 `pause` / `resume` delivered to the runner through the mode=present loader dispatch alongside the PUL-F020 four kinds. Split from scene-loader.test.ts (ADR-025).)
- IMPLEMENTS → CODE_FILE `src/runtime/timeline.ts` (GSAP composition timeline runner — pause freezes the master at the current playhead and resume continues from the same point; ADR-024 cross-command precedence (only resume unfreezes an explicit pause).)
- IMPLEMENTS → CODE_FILE `src/system/presenter/keyboard-source.ts` (Keyboard presenter source — DEFAULT_KEYBOARD_BINDINGS maps KeyK (pause) and KeyL (resume) into PresenterCommands, the presenter input surface for PUL-F021.)
- TESTS → TEST `tests/runtime/timeline.test.ts` (Timeline tests — presenter command transport describe block: pause freezes the master and resume continues from the same playhead; beat-pacing commands received while explicitly paused never resume (ADR-024).)
- TESTS → TEST `tests/system/presenter-keyboard.test.ts` (Keyboard presenter tests — KeyK emits pause and KeyL emits resume.)
- IMPLEMENTS → GITHUB_ISSUE `132` (PUL-F020 / PUL-F021 / PUL-F025: wire presenter keyboard input + GSAP pause/resume)
