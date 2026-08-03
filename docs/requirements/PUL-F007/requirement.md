---
id: PUL-F007
title: "URL navigation grammar"
status: ACTIVE
type: FUNCTIONAL
priority: MUST
wave: 1
created_at: 2026-04-30T19:16:29.545448Z
updated_at: 2026-05-03T17:12:34.426448Z
---

# PUL-F007 — URL navigation grammar

## Statement

The runtime SHALL accept the URL parameters `scene`, `composition`, `index`, `beat`, and `mode`. Parameter combinations SHALL be parsed at startup and on `popstate`.

## Rationale

URL grammar is the agent contract for inspection (ADR-007).

## Traceability

- DOCUMENTS → ADR `ADR-002` (Scene Registry and Composition Manifests as the Core Abstraction)
- DOCUMENTS → ADR `ADR-007` (Browser as the Default Workbench and Agent Collaboration Surface)
- IMPLEMENTS → CODE_FILE `src/runtime/navigation.ts` (URL navigation grammar parser, popstate subscriber, and runtime-entry bootstrap)
- IMPLEMENTS → CODE_FILE `src/main.ts` (Runtime entry calls bootstrapNavigation(globalThis) so URL params are parsed at startup and on popstate)
- TESTS → TEST `tests/runtime/navigation.test.ts` (Vitest suite covering parser, subscribeNavigation, bootstrapNavigation, and ADR-013 invariants)
- DOCUMENTS → ADR `ADR-013` (URL Navigation Grammar Boundary)
- IMPLEMENTS → GITHUB_ISSUE `16` (PUL-F007: URL navigation grammar)
- IMPLEMENTS → PULL_REQUEST `69` (Add URL navigation grammar parser (PUL-F007))
