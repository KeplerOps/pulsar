---
id: PUL-F016
title: "Workbench mode — paused"
status: ACTIVE
type: FUNCTIONAL
priority: MUST
wave: 1
created_at: 2026-04-30T19:16:56.297381Z
updated_at: 2026-05-18T21:22:29.570206Z
---

# PUL-F016 — Workbench mode — paused

## Statement

In `mode=paused`, the runtime SHALL mount the addressed scene and hold it at its first frame without advancing the timeline.

## Rationale

Layout/styling review without motion.

## Traceability

- DOCUMENTS → ADR `ADR-007` (Browser as the Default Workbench and Agent Collaboration Surface)
- DOCUMENTS → ADR `ADR-019` (ADR-019: Workbench Mode `paused` — Runner Hold-at-First-Frame Hint at the Loader/Runner Seam)
- DOCUMENTS → DOCUMENTATION `docs/design/pul-f016-paused-mode-preflight.md` (PUL-F016 Paused Mode Preflight (codex architecture preflight design context))
- DOCUMENTS → GITHUB_ISSUE `25` (PUL-F016: Workbench mode — paused)
- DOCUMENTS → TEST `tests/runtime/composition-resolver.test.ts` (Composition-resolver tests — URL paused-mode runner hold-hint forwarding describe block (PUL-F016 resolver layer: headHold plumbed to plan[0]'s run input only, key-presence semantics, no-op interpretation, independent from headBeat and headRepeat))
- DOCUMENTS → TEST `tests/runtime/scene-navigation.test.ts` (Scene-navigation tests — URL paused-mode hold forwarding describe block (PUL-F016 bridge layer: hold → headHold plumbing, bridge-level slice truncation under hold as structural defense via shared truncateToHead helper, independence from beat and repeat))
- DOCUMENTS → TEST `tests/runtime/scene-loader-paused-scrub.test.ts` (Loader tests — paused-mode hold-hint forwarding (PUL-F016): loader→adapter hold hint, slice truncation, ctx.mode seam, pending-until-abort runner contract. Split from scene-loader.test.ts (ADR-025).)
- IMPLEMENTS → CODE_FILE `src/runtime/timeline.ts` (GSAP composition timeline adapter — positionMaster() holds the composed master at frame 0 (seek(0) + pause()) for headHold === 'first-frame'; runMasterUntilDone() parks the held master without advancing (PUL-F016 hold-at-first-frame mechanic))
- IMPLEMENTS → CODE_FILE `src/runtime/scene-loader.ts` (Scene loader — maps effectiveMode === 'paused' to the runner hold hint hold: 'first-frame' and mounts the addressed scene through the resolver lifecycle (PUL-F016 mode dispatch))
- TESTS → TEST `tests/runtime/timeline.test.ts` (GSAP timeline adapter tests — createGsapCompositionTimeline behavioral test: a scene tween's animated value stays at frame 0 under headHold: 'first-frame', including after wall-clock time elapses (PUL-F016 acceptance criterion 2))
- TESTS → TEST `tests/scenes/paused-fixture.test.ts` (Paused verification fixture unit tests — PUL-F001 contract assertions, the onUpdate tween-value->attribute mapping, and ctx-defensiveness coverage for the PUL-F016 paused-mode verification fixture scene)
- TESTS → TEST `tests-e2e/paused-mode.spec.ts` (Playwright paused-mode spec — boots the paused fixture under mode=paused and asserts data-pulsar-paused-progress holds at "0" past the tween duration, with a mode=loop control (PUL-F016 browser acceptance gate))
- IMPLEMENTS → GITHUB_ISSUE `129` (PUL-F016: paused-mode GSAP runner — actual hold at first frame)
