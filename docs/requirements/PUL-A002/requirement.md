---
id: PUL-A002
title: "Audio library encapsulation"
status: ACTIVE
type: CONSTRAINT
priority: MUST
wave: 0
created_at: 2026-04-30T19:18:16.076099Z
updated_at: 2026-05-12T21:26:32.142508Z
---

# PUL-A002 — Audio library encapsulation

## Statement

Scene modules SHALL access audio playback only via the runtime audio context. Scenes SHALL NOT instantiate `HTMLAudioElement` or directly import the audio library, except where a scene drops down to raw Web Audio with a documented justification and registers cleanup with the runtime.

## Rationale

Per-scene cleanup and master mute depend on routed audio access (ADR-004, ADR-008).

## Traceability

- CONSTRAINS → ADR `ADR-004` (Howler.js as the Audio Engine)
- CONSTRAINS → ADR `ADR-008` (Agent-Native Authoring as a First-Class Architectural Constraint)
- TESTS → TEST `tests/runtime/policy-a002-audio-encapsulation.test.ts` (PUL-A002 source-policy gate (Vitest))
- IMPLEMENTS → CODE_FILE `tests/runtime/source-policy.ts`
- IMPLEMENTS → GITHUB_ISSUE `51`
