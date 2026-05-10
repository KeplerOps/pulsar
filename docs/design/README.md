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

Design docs are mutable. Decisions are captured as ADRs (immutable once
accepted).
