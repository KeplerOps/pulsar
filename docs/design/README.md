# Design Documents

Design context for Pulsar. Source material for the ADRs in `../adrs/`.

| Document | Purpose |
|----------|---------|
| [architecture-recommendations.md](architecture-recommendations.md) | Stack choices, runtime layers, library notes, migration plan. |
| [issue-078-osv-scanner-preflight.md](issue-078-osv-scanner-preflight.md) | CI security-scanner boundary and guardrails for advisory OSV coverage. |
| [positioning-and-landscape.md](positioning-and-landscape.md) | Category, adjacent OSS projects, differentiation, strategic risks. |
| [pul-p002-validation-ci-preflight.md](pul-p002-validation-ci-preflight.md) | Guardrails for gating pull-request CI on the canonical runtime validation pass. |
| [pul-p003-adr-format-preflight.md](pul-p003-adr-format-preflight.md) | Guardrails for keeping ADR markdown and Ground Control ADR records aligned without duplicate schemas or workflow logic. |
| [pul-a001-timeline-library-encapsulation-preflight.md](pul-a001-timeline-library-encapsulation-preflight.md) | Guardrails for statically enforcing scene timeline-library encapsulation through the runtime adapter and scene context. |
| [pul-a002-a006-import-bans-preflight.md](pul-a002-a006-import-bans-preflight.md) | Cluster-level guardrails for the PUL-A002..A006 source-policy gates (audio, rendering, export, slide-framework bans plus the PUL-A005 declarative-manifest shape rule). |
| [pul-a008-mode-dispatch-core-preflight.md](pul-a008-mode-dispatch-core-preflight.md) | Guardrails for keeping workbench mode dispatch centralized in the runtime core rather than scene modules. |
| [pul-q003-url-state-determinism-preflight.md](pul-q003-url-state-determinism-preflight.md) | Guardrails for enforcing URL-only runtime target selection without persisted browser or host state. |
| [pul-q004-resource-cleanup-preflight.md](pul-q004-resource-cleanup-preflight.md) | Guardrails for enforcing scene resource cleanup completeness through existing lifecycle, audio, timeline, presenter, and prompter boundaries. |
| [pul-q005-validation-actionability-preflight.md](pul-q005-validation-actionability-preflight.md) | Guardrails for making runtime validation findings locate the offending declaration and failed condition without duplicating validation schemas or error systems. |
| [pul-q006-error-surfacing-context-preflight.md](pul-q006-error-surfacing-context-preflight.md) | Guardrails for surfacing runtime errors with scene, beat, and lifecycle phase context through existing diagnostic seams. |
| [pul-q007-runtime-code-execution-preflight.md](pul-q007-runtime-code-execution-preflight.md) | Guardrails for statically banning runtime code execution outside the published bundle. |
| [pul-q008-dom-css-accessibility-preflight.md](pul-q008-dom-css-accessibility-preflight.md) | Guardrails for preserving native browser text selection, focus order, and ARIA semantics in DOM/CSS scenes. |
| [pul-q009-asset-failure-surfacing-preflight.md](pul-q009-asset-failure-surfacing-preflight.md) | Guardrails for surfacing asset preload failures with scene and asset context before mounting. |
| [pul-q010-master-mute-responsiveness-preflight.md](pul-q010-master-mute-responsiveness-preflight.md) | Guardrails for bounding master-mute latency without duplicating presenter or audio boundaries. |
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
| [pul-f031-workbench-chrome-surface-preflight.md](pul-f031-workbench-chrome-surface-preflight.md) | Guardrails for implementing a persistent workbench-owned chrome surface around the scene stage. |

Design docs are mutable. Decisions are captured as ADRs (immutable once
accepted).
