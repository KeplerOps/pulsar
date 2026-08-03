---
id: PUL-P004
title: "Requirement lifecycle"
status: ACTIVE
type: CONSTRAINT
priority: MUST
wave: 0
created_at: 2026-04-30T19:18:56.704654Z
updated_at: 2026-05-12T16:16:52.067116Z
---

# PUL-P004 — Requirement lifecycle

## Statement

Requirements MUST follow the lifecycle DRAFT → ACTIVE → DEPRECATED. A requirement MUST NOT transition to ACTIVE until it is implemented and traceability links to source and tests are in place.

## Rationale

Status accurately reflects implementation state.

## Traceability

- IMPLEMENTS → DOCUMENTATION `docs/requirements/conventions.md` (Status Lifecycle section — DRAFT→ACTIVE→DEPRECATED rule + implementation+traceability preconditions for ACTIVE)
- CONSTRAINS → ADR `ADR-008` (Agent-native authoring — requirement lifecycle discipline + manifest-over-flow-control)
- IMPLEMENTS → GITHUB_ISSUE `62` (Issue #62 — PUL-P004 requirement lifecycle)
