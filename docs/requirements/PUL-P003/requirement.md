---
id: PUL-P003
title: "ADR format"
status: ACTIVE
type: CONSTRAINT
priority: MUST
wave: 0
created_at: 2026-04-30T19:18:53.607786Z
updated_at: 2026-05-12T16:16:48.616768Z
---

# PUL-P003 — ADR format

## Statement

Architecture decisions MUST be recorded as ADRs in MADR format under `docs/adrs/` and mirrored in Ground Control.

## Rationale

Single, machine-readable, versioned source for architectural decisions.

## Traceability

- IMPLEMENTS → DOCUMENTATION `docs/adrs/000-template.md` (Local MADR template — the format every ADR follows)
- IMPLEMENTS → DOCUMENTATION `docs/adrs/README.md` (ADR index + MADR declaration + immutability + sequential-numbering principles)
- CONSTRAINS → ADR `ADR-008` (Agent-native authoring — names ADR/GC mirroring discipline as a binding architectural constraint)
- IMPLEMENTS → GITHUB_ISSUE `61` (Issue #61 — PUL-P003 ADR format)
