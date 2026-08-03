---
id: PUL-Q010
title: "Master mute responsiveness"
status: ACTIVE
type: NON_FUNCTIONAL
priority: SHOULD
wave: 2
created_at: 2026-04-30T19:18:09.218996Z
updated_at: 2026-05-17T20:54:46.835420Z
---

# PUL-Q010 — Master mute responsiveness

## Statement

Master mute SHALL silence active audio playback within 100 milliseconds of being engaged.

## Rationale

Bounded responsiveness for the presenter's audio control.

## Traceability

- DOCUMENTS → ADR `ADR-004` (Howler.js as the Audio Engine)
- IMPLEMENTS → GITHUB_ISSUE `49` (PUL-Q010: Master mute responsiveness)
- IMPLEMENTS → DOCUMENTATION `docs/design/pul-q010-master-mute-responsiveness-preflight.md` (PUL-Q010 master-mute responsiveness preflight — runtime seam, required reuse, guardrails, extensibility)
- IMPLEMENTS → CODE_FILE `src/runtime/scene-loader.ts` (Scene loader — buildPresenterPipe subscribes the audio handler ahead of any runner subscriber so toggle-master-mute synchronously calls audio.mute(!audio.isMuted()) before any other listener runs (PUL-Q010 critical path).)
- IMPLEMENTS → CODE_FILE `src/runtime/audio.ts` (Runtime audio service — AudioService.mute(...) synchronously calls engine.setMasterMute(...); createHowlerAudioEngine().setMasterMute(b) synchronously calls Howler.mute(b) (PUL-Q010 engine boundary).)
- IMPLEMENTS → CODE_FILE `src/runtime/presenter.ts` (Presenter controller — synchronous centralWrapped fan-out: validation + per-subscriber try/catch keep a throwing runner subscriber from masking the PUL-Q010 audio flip.)
- TESTS → TEST `tests/runtime/scene-loader-present.test.ts` (Loader presenter-seam PUL-Q010 tests — synchronous engine flip on next statement after emit(), audio handler runs before runner subscriber, slow runner busy-loop cannot delay the flip, throwing runner subscriber cannot prevent the flip.)
- TESTS → TEST `tests/runtime/audio.test.ts` (Audio-service PUL-Q010 tests — engine.setMasterMute is invoked synchronously from AudioService.mute (no microtask hop); mute path adds zero per-sound handle calls even when sounds are loaded and playing.)
- TESTS → TEST `tests/runtime/audio-engine.test.ts` (Audio-engine PUL-Q010 production-Howler-boundary test — createHowlerAudioEngine().setMasterMute(b) forwards synchronously to Howler.mute(b) via monkey-patched spy.)
