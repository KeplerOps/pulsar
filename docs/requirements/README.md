# Requirements

Source of truth: Ground Control project `pulsar`. This directory holds
the narrative artifacts GC has no first-class type for: personas, use
cases, user stories. Requirement records, relations, and ADR linkage
live in GC.

## Layout

- `conventions.md` — UID, series, statement style, status, priority, wave, relations.
- `personas/` — one file per persona.
- `use-cases/` — use case maps.
- `user-stories/` — stories grouped by use case.

## Workflow

1. Personas identified.
2. Use cases mapped per persona.
3. User stories drafted per use case.
4. Functional and quality requirements extracted into GC.
5. Relations between requirements added in GC.
6. ADR linkage added in GC.
7. Priority and wave assigned.
8. Requirements ratified `DRAFT` → `ACTIVE`.
