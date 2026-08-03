---
id: PUL-F026
title: "Rehearsal mode"
status: ACTIVE
type: FUNCTIONAL
priority: SHOULD
wave: 2
created_at: 2026-04-30T19:17:23.797423Z
updated_at: 2026-05-11T03:00:39.520922Z
---

# PUL-F026 — Rehearsal mode

## Statement

The runtime SHALL provide a rehearsal mode in which audio is silenced or logged as cues without altering timeline state.

## Rationale

Author rehearsal without disturbing audio output.

## Traceability

- DOCUMENTS → ADR `ADR-004` (Howler.js as the Audio Engine)
- IMPLEMENTS → CODE_FILE `src/runtime/audio.ts` (Audio service — AudioOutputPolicy union, log-cues emission, AudioCueLogEntry discriminated union, boundary validation)
- IMPLEMENTS → CODE_FILE `src/runtime/scene-loader.ts` (Scene loader — audioOutputPolicyFor(mode) dispatches mode=rehearsal to outputPolicy 'log-cues'; onAudioCue threaded into per-navigation AudioService)
- IMPLEMENTS → CODE_FILE `src/runtime/navigation.ts` (URL grammar — NAVIGATION_MODES includes 'rehearsal' (eighth workbench mode))
- IMPLEMENTS → ADR `ADR-004` (ADR-004 — Output policy subsection documents rehearsal-mode contract on the audio-service seam)
- TESTS → TEST `tests/runtime/audio.test.ts` (Audio service tests — outputPolicy log-cues emission, validation, freeze, sequence, no-URL invariant; legacy silent rejection)
- TESTS → TEST `tests/runtime/scene-loader-audio.test.ts` (Scene loader rehearsal tests — outputPolicy wiring, FULL slice preservation, head-entry override preservation, ctx.mode reach)
- TESTS → TEST `tests/runtime/navigation.test.ts` (Navigation grammar tests — 'rehearsal' accepted as URL mode value; allowlist contains it)
- IMPLEMENTS → GITHUB_ISSUE `35` (PUL-F026: Rehearsal mode)
