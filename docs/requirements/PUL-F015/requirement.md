---
id: PUL-F015
title: "Workbench mode — loop"
status: ACTIVE
type: FUNCTIONAL
priority: MUST
wave: 1
created_at: 2026-04-30T19:16:49.907011Z
updated_at: 2026-05-18T21:22:19.926385Z
---

# PUL-F015 — Workbench mode — loop

## Statement

In `mode=loop`, the runtime SHALL run the addressed scene's timeline and restart it on completion.

## Rationale

Repeated visual/audio inspection during authoring.

## Traceability

- DOCUMENTS → ADR `ADR-007` (Browser as the Default Workbench and Agent Collaboration Surface)
- DOCUMENTS → ADR `ADR-018` (ADR-018: Workbench Mode `loop` — Runner Repeat Hint at the Loader/Runner Seam)
- DOCUMENTS → DOCUMENTATION `docs/design/pul-f015-loop-mode-preflight.md` (PUL-F015 Loop Mode Preflight (codex architecture preflight design context))
- DOCUMENTS → GITHUB_ISSUE `24` (PUL-F015: Workbench mode — loop)
- DOCUMENTS → TEST `tests/runtime/composition-resolver.test.ts` (Composition-resolver tests — URL loop-mode runner repeat-hint forwarding describe block (PUL-F015 resolver layer: headRepeat plumbed to plan[0]'s run input only, key-presence semantics, no-op interpretation, independent from headBeat))
- DOCUMENTS → TEST `tests/runtime/scene-navigation.test.ts` (Scene-navigation tests — URL loop-mode repeat forwarding describe block (PUL-F015 bridge layer: repeat → headRepeat plumbing, bridge-level slice truncation under repeat as structural defense, independence from beat))
- IMPLEMENTS → CODE_FILE `src/runtime/timeline.ts` (GSAP timeline adapter — positionMaster() sets master.repeat(-1) for headRepeat==='until-aborted' and runMasterUntilDone() plays the looping master (PUL-F015 restart-on-completion, artifact of record))
- TESTS → TEST `tests/runtime/timeline.test.ts` (Timeline adapter tests — observes the master completing >=2 distinct iterations under headRepeat (PUL-F015 restart-on-completion unit verification))
- TESTS → TEST `tests-e2e/loop-mode.spec.ts` (Loop-mode Playwright spec — boots ?scene=loop-fixture&mode=loop and polls data-pulsar-loop-iteration to >=2 across chromium/firefox/webkit (PUL-F015 restart-on-completion e2e verification))
- TESTS → TEST `tests/scenes/loop-fixture.test.ts` (Loop fixture scene unit tests — per-iteration counter increment and fresh-counter-per-navigation (PUL-F015 loop verification harness))
- IMPLEMENTS → GITHUB_ISSUE `128` (PUL-F015: loop-mode GSAP runner — actual timeline restart on completion)
- DOCUMENTS → TEST `tests/runtime/scene-loader-standalone-loop.test.ts` (Loader tests — loop-mode repeat-hint forwarding (PUL-F015): loader→adapter repeat hint, slice truncation, ctx.mode seam. Split from scene-loader.test.ts (ADR-025).)
