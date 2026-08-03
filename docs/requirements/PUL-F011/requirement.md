---
id: PUL-F011
title: "URL parameter — beat"
status: ACTIVE
type: FUNCTIONAL
priority: MUST
wave: 1
created_at: 2026-04-30T19:16:40.223481Z
updated_at: 2026-05-18T18:48:08.228349Z
---

# PUL-F011 — URL parameter — beat

## Statement

When the `beat` URL parameter is present, the runtime SHALL position the active scene's timeline at the named timeline label. If the label does not exist, the runtime SHALL surface an error and remain at the scene's first beat.

## Rationale

Named beats are the agent-friendly time grammar (ADR-003, ADR-008).

## Traceability

- DOCUMENTS → ADR `ADR-007` (Browser as the Default Workbench and Agent Collaboration Surface)
- DOCUMENTS → ADR `ADR-003` (GSAP as the Timeline Engine)
- DOCUMENTS → CODE_FILE `src/runtime/composition-resolver.ts` (Composition resolver — `headBeat` / `onBeatMissing` forwarding to plan[0]'s run input only (PUL-F011 runtime contract))
- DOCUMENTS → CODE_FILE `src/runtime/scene-navigation.ts` (Scene navigation bridge — beat / onBeatMissing forwarded as headBeat / onBeatMissing to resolveComposition (PUL-F011 runtime contract))
- DOCUMENTS → CODE_FILE `src/runtime/scene-loader.ts` (Scene loader — extracts target.beat, builds non-fatal onBeatMissing closure with abort/dispose/once-only guards, defense-in-depth grammar checks (PUL-F011 runtime contract))
- DOCUMENTS → TEST `tests/runtime/composition-resolver.test.ts` (Resolver tests — head-only beat/onBeatMissing forwarding + paired-required precondition (PUL-F011 runtime contract))
- DOCUMENTS → TEST `tests/runtime/scene-navigation.test.ts` (Bridge tests — beat / onBeatMissing forwarded only to head scene of slice + paired-required precondition (PUL-F011 runtime contract))
- DOCUMENTS → ADR `ADR-015` (URL Beat Positioning as Timeline-Runner State — names beat as runner-boundary state, missing-label is non-fatal, no parallel beat schema, current-state note explaining DRAFT status pending GSAP runner)
- DOCUMENTS → GITHUB_ISSUE `20` (PUL-F011: URL parameter — beat (forward-looking; runtime contract delivered, end-to-end seek pending PUL-F022/F023 GSAP runner))
- DOCUMENTS → TEST `tests/runtime/scene-loader-beat-mode.test.ts` (Loader tests — beat positioning (PUL-F011): pending-runner mounted-during-diagnostic, abort/dispose suppression, once-only, throwing-onError non-fatal, defense-in-depth grammar. Split from scene-loader.test.ts (ADR-025).)
