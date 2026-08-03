---
id: PUL-F030
title: "Audio unlock interaction"
status: ACTIVE
type: FUNCTIONAL
priority: MUST
wave: 2
created_at: 2026-04-30T19:17:36.159441Z
updated_at: 2026-05-12T04:25:43.563737Z
---

# PUL-F030 — Audio unlock interaction

## Statement

On loading `mode=present` for a composition that declares audio, the runtime SHALL provide a single explicit user-gesture interaction that satisfies browser autoplay policy before the composition begins.

## Rationale

Centralizes the autoplay-policy unlock once, not per scene.

## Traceability

- DOCUMENTS → ADR `ADR-004` (Howler.js as the Audio Engine)
- IMPLEMENTS → GITHUB_ISSUE `39` (PUL-F030: Audio unlock interaction)
- IMPLEMENTS → PULL_REQUEST `104` (Implement PUL-F030 present-mode audio unlock interaction (ADR-029))
- IMPLEMENTS → ADR `ADR-029` (Present-Mode Audio Unlock Gate Before Composition Start)
- IMPLEMENTS → CODE_FILE `src/runtime/scene.ts` (SceneModule.audio field + sceneDeclaresAudio predicate)
- IMPLEMENTS → CODE_FILE `src/runtime/audio.ts` (AudioEngine.unlock — Web Audio + HTML5 fallback)
- IMPLEMENTS → CODE_FILE `src/runtime/scene-loader.ts` (Audio unlock gate (AudioUnlockAdapter seam + resolveUnlockGate))
- IMPLEMENTS → CODE_FILE `src/runtime/audio-unlock-dom.ts` (Workbench DOM unlock adapter factory)
- IMPLEMENTS → CODE_FILE `src/main.ts` (Production workbench wiring of the unlock adapter)
- TESTS → TEST `tests/runtime/scene.test.ts` (scene.audio schema + sceneDeclaresAudio predicate tests)
- TESTS → TEST `tests/runtime/audio-engine.test.ts` (AudioEngine.unlock branch tests (Web Audio, HTML5, fail-close, idempotency))
- TESTS → TEST `tests/runtime/scene-loader-audio.test.ts` (PUL-F030 gate trigger / bypass / supersession / fail-loud tests)
- TESTS → TEST `tests/runtime/audio-unlock-dom.test.ts` (Workbench DOM unlock adapter contract tests)
