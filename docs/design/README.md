# Design Documents

Design context for Pulsar. Source material for the ADRs in `../adrs/`.

| Document | Purpose |
|----------|---------|
| [architecture-recommendations.md](architecture-recommendations.md) | Stack choices, runtime layers, library notes, migration plan. |
| [issue-078-osv-scanner-preflight.md](issue-078-osv-scanner-preflight.md) | CI security-scanner boundary and guardrails for advisory OSV coverage. |
| [positioning-and-landscape.md](positioning-and-landscape.md) | Category, adjacent OSS projects, differentiation, strategic risks. |
| [pul-f013-present-mode-preflight.md](pul-f013-present-mode-preflight.md) | Guardrails for implementing default `mode=present` behavior. |
| [pul-f014-standalone-mode-preflight.md](pul-f014-standalone-mode-preflight.md) | Guardrails for implementing isolated `mode=standalone` behavior. |
| [pul-f015-loop-mode-preflight.md](pul-f015-loop-mode-preflight.md) | Guardrails for implementing repeated `mode=loop` scene-timeline playback. |
| [pul-f016-paused-mode-preflight.md](pul-f016-paused-mode-preflight.md) | Guardrails for implementing first-frame `mode=paused` behavior. |
| [pul-f017-scrub-mode-preflight.md](pul-f017-scrub-mode-preflight.md) | Guardrails for implementing scrub-mode timeline controls and audio cue gating. |
| [pul-f018-screenshot-mode-preflight.md](pul-f018-screenshot-mode-preflight.md) | Guardrails for implementing deterministic screenshot-mode capture. |
| [pul-f020-presenter-controls-preflight.md](pul-f020-presenter-controls-preflight.md) | Guardrails for implementing presenter advance, hold, and skip commands. |
| [pul-f021-pause-resume-preflight.md](pul-f021-pause-resume-preflight.md) | Guardrails for implementing presenter pause and resume commands. |
| [pul-f022-timeline-orchestration-preflight.md](pul-f022-timeline-orchestration-preflight.md) | Guardrails for implementing GSAP-backed master timeline orchestration. |
| [pul-f023-named-timeline-beats-preflight.md](pul-f023-named-timeline-beats-preflight.md) | Guardrails for implementing named timeline beats. |
| [pul-f024-audio-orchestration-preflight.md](pul-f024-audio-orchestration-preflight.md) | Guardrails for implementing runtime-owned audio orchestration. |
| [pul-f025-master-mute-preflight.md](pul-f025-master-mute-preflight.md) | Guardrails for implementing presenter master mute. |
| [pul-f026-rehearsal-mode-preflight.md](pul-f026-rehearsal-mode-preflight.md) | Guardrails for implementing rehearsal audio suppression or cue logging without timeline-state changes. |
| [pul-f027-caption-metadata-prompter-preflight.md](pul-f027-caption-metadata-prompter-preflight.md) | Guardrails for widening caption metadata timing and keeping prompter content single-sourced. |
| [pul-f028-validation-preflight.md](pul-f028-validation-preflight.md) | Guardrails for implementing structural runtime validation without duplicating schemas, registries, asset policy, or lifecycle logic. |
| [pul-f030-audio-unlock-interaction-preflight.md](pul-f030-audio-unlock-interaction-preflight.md) | Guardrails for implementing present-mode audio unlock before an audio-declaring composition begins. |

Design docs are mutable. Decisions are captured as ADRs (immutable once
accepted).
