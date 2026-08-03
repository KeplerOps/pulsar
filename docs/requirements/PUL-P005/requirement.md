---
id: PUL-P005
title: "ADR linkage discipline"
status: ACTIVE
type: CONSTRAINT
priority: MUST
wave: 0
created_at: 2026-04-30T19:18:58.802715Z
updated_at: 2026-05-12T16:16:55.165490Z
---

# PUL-P005 — ADR linkage discipline

## Statement

When any ADR motivates or constrains a requirement, the requirement MUST have a traceability link to that ADR with link type DOCUMENTS or CONSTRAINS as appropriate.

## Rationale

Bidirectional traceability between ADRs and requirements.

## Traceability

- IMPLEMENTS → DOCUMENTATION `docs/requirements/conventions.md` (ADR Linkage section — gc_create_traceability_link with DOCUMENTS/CONSTRAINS for ADR artifacts)
- CONSTRAINS → ADR `ADR-008` (Agent-native authoring — names the bidirectional ADR/requirement linkage discipline)
- IMPLEMENTS → GITHUB_ISSUE `63` (Issue #63 — PUL-P005 ADR linkage discipline)
