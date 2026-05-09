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

Design docs are mutable. Decisions are captured as ADRs (immutable once
accepted).
