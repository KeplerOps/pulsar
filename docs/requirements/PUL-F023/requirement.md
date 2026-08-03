---
id: PUL-F023
title: "Named timeline beats"
status: ACTIVE
type: FUNCTIONAL
priority: MUST
wave: 2
created_at: 2026-04-30T19:17:16.129340Z
updated_at: 2026-05-10T16:43:05.834955Z
---

# PUL-F023 — Named timeline beats

## Statement

Scene timelines SHALL support named labels (beats) referenceable by URL, presenter input, and other runtime subsystems.

## Rationale

Named beats are the agent-friendly time grammar (ADR-003, ADR-008).

## Traceability

- DOCUMENTS → ADR `ADR-003` (GSAP as the Timeline Engine)
- DOCUMENTS → ADR `ADR-008` (Agent-Native Authoring as a First-Class Architectural Constraint)
- IMPLEMENTS → CODE_FILE `src/runtime/timeline.ts` (Named timeline beats — kebab-case beat-label + position validation (assertSceneTimeline), the MasterTimeline beat-query surface (labels/hasLabel/seek/labelFor/beats), parseSceneTimelineLabel)
- TESTS → TEST `tests/runtime/timeline.test.ts` (Named timeline beats tests — beat-label/position validation, leak-on-rejection, parseSceneTimelineLabel, MasterTimeline.beats(), resolver bad-beat envelope, terminal-beat resolve-immediately)
- IMPLEMENTS → ADR `ADR-026` (Named Timeline Beats — Scene-Local Kebab Labels, Validated at Compose Time, Referenced Through the Master)
- DOCUMENTS → DOCUMENTATION `docs/design/pul-f023-named-timeline-beats-preflight.md` (PUL-F023 Named Timeline Beats — codex architecture preflight design note)
