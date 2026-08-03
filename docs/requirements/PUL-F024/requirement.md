---
id: PUL-F024
title: "Audio orchestration"
status: ACTIVE
type: FUNCTIONAL
priority: MUST
wave: 2
created_at: 2026-04-30T19:17:18.796248Z
updated_at: 2026-05-11T00:35:38.890208Z
---

# PUL-F024 — Audio orchestration

## Statement

The runtime SHALL provide an audio service exposing per-scene playback, fades, sprites, looping, and named groups. Each scene SHALL access audio only via the runtime context.

## Rationale

Centralized audio lifecycle and cleanup (ADR-004).

## Traceability

- DOCUMENTS → ADR `ADR-004` (Howler.js as the Audio Engine)
- IMPLEMENTS → GITHUB_ISSUE `33` (PUL-F024: Audio orchestration)
- IMPLEMENTS → CODE_FILE `src/runtime/audio.ts` (Runtime audio service (createHowlerAudioEngine + createAudioService + noopAudioEngine))
- IMPLEMENTS → CODE_FILE `src/runtime/scene-loader.ts` (Scene loader — ctx.audio threading, audioEngine option, onSceneCleaned wiring)
- IMPLEMENTS → CODE_FILE `src/runtime/composition-resolver.ts` (Composition resolver — onSceneCleaned hook for runtime per-scene audio group teardown)
- TESTS → TEST `tests/runtime/audio.test.ts` (createAudioService — load/play/fade/stop/stopGroup/mute/stopAll, sprites, signal binding, error isolation, runtime validators)
- TESTS → TEST `tests/runtime/audio-engine.test.ts` (createHowlerAudioEngine smoke tests (Howler boundary in node noAudio mode))
- TESTS → TEST `tests/runtime/scene-loader-audio.test.ts` (Scene loader ↔ audio integration — ctx.audio threading, signal binding, silent mode, slice-asset enforcement, prompter bypass, noop fallback)
- DOCUMENTS → DOCUMENTATION `docs/design/pul-f024-audio-orchestration-preflight.md` (PUL-F024 audio orchestration preflight (codex architecture guidance))
- IMPLEMENTS → PULL_REQUEST `92` (Implement PUL-F024 audio orchestration: ctx.audio + Howler boundary (ADR-004))
