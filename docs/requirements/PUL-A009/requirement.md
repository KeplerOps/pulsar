---
id: PUL-A009
title: "Captions and prompter share metadata source"
status: ACTIVE
type: CONSTRAINT
priority: MUST
wave: 2
created_at: 2026-04-30T19:18:42.131179Z
updated_at: 2026-05-18T01:10:18.552804Z
---

# PUL-A009 — Captions and prompter share metadata source

## Statement

The prompter view SHALL be derived from the same caption metadata used by the runtime. There SHALL NOT be a separate authoring source for prompter content.

## Rationale

Single source of truth (ADR-008).

## Traceability

- CONSTRAINS → ADR `ADR-008` (Agent-Native Authoring as a First-Class Architectural Constraint)
- IMPLEMENTS → CODE_FILE `src/runtime/scene.ts` (Caption interface + SceneModule.captions field + assertSceneModule schema gate — the canonical single-source authoring slot for prompter content (PUL-A009))
- IMPLEMENTS → CODE_FILE `src/runtime/prompter.ts` (buildPrompterScript — single derivation seam reading exclusively from SceneModule.captions (PUL-A009 clause 1))
- IMPLEMENTS → CODE_FILE `src/runtime/scene-loader.ts` (mode=prompter loader dispatch — routes navigation through buildPrompterScript(target) so prompter view is derived from caption metadata (PUL-A009 clause 1))
- IMPLEMENTS → DOCUMENTATION `docs/design/pul-a009-captions-prompter-single-source-preflight.md` (PUL-A009 design preflight — consolidates binding guardrails for the single-source contract)
- TESTS → TEST `tests/runtime/policy-a009-captions-single-source.test.ts` (PUL-A009 source-policy gate — 131 scanner self-tests + 4 runtime-tree assertions covering four sub-rules (interface fields, parallel schema declarations, prompter Caption import boundary, scene-module object literals))
- TESTS → TEST `tests/runtime/prompter.test.ts` (Prompter derivation behavior tests — pin buildPrompterScript reading exclusively from scene.captions (PUL-A009 clause 1, pre-existing))
- IMPLEMENTS → GITHUB_ISSUE `57` (PUL-A009: Captions and prompter share metadata source)
