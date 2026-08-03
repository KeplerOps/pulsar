---
id: PUL-F017
title: "Workbench mode — scrub"
status: ACTIVE
type: FUNCTIONAL
priority: MUST
wave: 1
created_at: 2026-04-30T19:16:59.346844Z
updated_at: 2026-05-21T09:05:04.571682Z
---

# PUL-F017 — Workbench mode — scrub

## Statement

In `mode=scrub`, the runtime SHALL display timeline controls allowing the user to scrub forward, backward, and to named beats. Audio cues SHALL fire only on monotonic forward playback.

## Rationale

Timing and beat-alignment inspection.

## Traceability

- DOCUMENTS → ADR `ADR-007` (Browser as the Default Workbench and Agent Collaboration Surface)
- IMPLEMENTS → GITHUB_ISSUE `130` (PUL-F017: scrub-mode timeline controls + monotonic-forward cue gating)
- IMPLEMENTS → CODE_FILE `src/runtime/timeline.ts` (GSAP timeline adapter — scrub run mode (held live master), MasterTimeline.reverse(), direction-driven audio cue gate toggling)
- IMPLEMENTS → CODE_FILE `src/runtime/audio.ts` (Audio service — dynamic cue-eligibility gate (createCueGate); play() suppresses cues while the gate is closed)
- IMPLEMENTS → CODE_FILE `src/system/chrome/scrub.ts` (Workbench scrub-mode transport controls — play/pause/reverse, drag scrubber, named-beat jump buttons)
- IMPLEMENTS → CODE_FILE `src/runtime/scene-loader.ts` (Scene loader — builds the shared cue gate under mode=scrub and wires it into the audio service and timeline adapter)
- IMPLEMENTS → CODE_FILE `src/main.ts` (Workbench bootstrap — mounts the scrub controls and attaches the master via the timeline adapter onMaster hook under mode=scrub)
- IMPLEMENTS → CODE_FILE `src/scenes/scrub-fixture.ts` (Scrub verification fixture scene — observable progress + named beat for mode=scrub)
- DOCUMENTS → ADR `ADR-020` (ADR-020: Workbench Mode `scrub` — Runner Cue-Gate Hint at the Loader/Runner Seam)
- DOCUMENTS → DOCUMENTATION `docs/design/pul-f017-scrub-mode-preflight.md` (PUL-F017 Scrub Mode Preflight (codex architecture preflight design context))
- DOCUMENTS → GITHUB_ISSUE `26` (PUL-F017: Workbench mode — scrub)
- DOCUMENTS → TEST `tests/runtime/composition-resolver.test.ts` (Composition-resolver tests — URL scrub-mode runner cue-gate-hint forwarding describe block (PUL-F017 resolver: headCueGate to plan[0] only, key-presence semantics, no-op interpretation, independence))
- DOCUMENTS → TEST `tests/runtime/scene-navigation.test.ts` (Scene-navigation tests — URL scrub-mode cue-gate forwarding describe block (PUL-F017 bridge: cueGate → headCueGate plumbing, bridge-level slice truncation under cueGate via shared truncateToHead helper, independence from beat / repeat / hold))
- IMPLEMENTS → CODE_FILE `src/runtime/composition-resolver.ts` (Composition resolver — forwards the audioCueGate control opaquely to the timeline adapter (mode-opaque per ADR-011))
- IMPLEMENTS → CODE_FILE `src/runtime/scene-navigation.ts` (Scene-navigation bridge — forwards audioCueGate from the loader through to resolveComposition)
- TESTS → TEST `tests/runtime/scrub-cue-gating.test.ts` (Monotonic-forward cue gating — a cue at master time T fires on a forward crossing and is suppressed on a reverse crossing)
- TESTS → TEST `tests/system/scrub-controls.test.ts` (Scrub transport controls — play/pause/reverse/seek drive the master, named-beat jump, sync, attach/detach/dispose)
- TESTS → TEST `tests/scenes/scrub-fixture.test.ts` (Scrub verification fixture scene — contract shape, progress projection, midpoint beat, ctx defensiveness)
- TESTS → TEST `tests/runtime/timeline.test.ts` (Timeline adapter — scrub run mode holds the master live, reverse(), and direction-driven cue-gate toggling)
- TESTS → TEST `tests/runtime/audio.test.ts` (Audio service — createCueGate and play() suppression while the cue gate is closed (post-validation))
- TESTS → TEST `tests/runtime/scene-loader-paused-scrub.test.ts` (Scene loader — scrub-mode cue-gate wiring (shared instance into the audio service and timeline adapter) plus the cue-gate-hint forwarding seam)
