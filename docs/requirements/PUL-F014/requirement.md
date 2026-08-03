---
id: PUL-F014
title: "Workbench mode — standalone"
status: ACTIVE
type: FUNCTIONAL
priority: MUST
wave: 1
created_at: 2026-04-30T19:16:47.883215Z
updated_at: 2026-05-18T21:22:09.246924Z
---

# PUL-F014 — Workbench mode — standalone

## Statement

In `mode=standalone`, the runtime SHALL render a single scene with surrounding chrome, inter-scene transitions, and audio bed suppressed; the scene SHALL run as if no surrounding composition existed.

## Rationale

Single-scene authoring/inspection without surrounding talk.

## Traceability

- DOCUMENTS → ADR `ADR-007` (Browser as the Default Workbench and Agent Collaboration Surface)
- IMPLEMENTS → CODE_FILE `src/runtime/audio.ts` (Audio service — composition audio bed seam (AudioBedDeclaration, bed, bedSuppressed))
- IMPLEMENTS → CODE_FILE `src/runtime/scene-loader.ts` (Scene loader — bed wiring + mode=standalone bed suppression)
- IMPLEMENTS → CODE_FILE `src/runtime/composition-registry.ts` (Composition registry — audioBed registration boundary)
- DOCUMENTS → ADR `ADR-017` (ADR-017: Workbench Mode `standalone` — Single-Scene Execution at the Loader)
- DOCUMENTS → DOCUMENTATION `docs/design/pul-f014-standalone-mode-preflight.md` (PUL-F014 Standalone Mode Preflight (codex architecture preflight design context))
- DOCUMENTS → GITHUB_ISSUE `23` (PUL-F014: Workbench mode — standalone)
- IMPLEMENTS → CODE_FILE `src/runtime/scene-navigation.ts` (Scene-navigation resolver — threads audioBed onto the composition context)
- IMPLEMENTS → CODE_FILE `src/runtime/validation.ts` (Runtime validation — audioBed shape check (composition-audio-bed-invalid finding))
- TESTS → TEST `tests/runtime/audio.test.ts` (Audio service tests — composition audio bed + assertAudioBedDeclaration)
- TESTS → TEST `tests/runtime/scene-loader-audio.test.ts` (Loader audio tests — composition audio bed play + standalone suppression)
- TESTS → TEST `tests/runtime/composition-registry.test.ts` (Composition registry tests — audioBed storage, deep-freeze, validation)
- TESTS → TEST `tests/runtime/scene-navigation.test.ts` (Scene-navigation tests — audioBed threaded into composition context)
- TESTS → TEST `tests/runtime/validation.test.ts` (Validation tests — composition-audio-bed-invalid findings)
- TESTS → TEST `tests/system/standalone-audio-bed.test.ts` (System test — composition audio bed end-to-end (play vs standalone suppression))
- IMPLEMENTS → GITHUB_ISSUE `127` (PUL-F014: standalone-mode chrome and audio-bed suppression)
- TESTS → TEST `tests/runtime/scene-loader-standalone-loop.test.ts` (Loader tests — standalone-mode single-scene execution (PUL-F014): slice-truncation mechanism, ctx.mode seam, and the three suppression surfaces (chrome / audio-bed / inter-scene transitions) now all shipped)
