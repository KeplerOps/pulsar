---
id: PUL-Q007
title: "No remote code execution"
status: ACTIVE
type: NON_FUNCTIONAL
priority: MUST
wave: 0
created_at: 2026-04-30T19:18:00.409884Z
updated_at: 2026-05-12T21:26:30.134542Z
---

# PUL-Q007 — No remote code execution

## Statement

The runtime SHALL NOT use `eval`, `new Function`, dynamic `import()` of remote URLs at runtime, or any equivalent mechanism that would execute code not present in the published bundle.

## Rationale

Bounded code surface; CSP-compatible; no surprise execution paths.

## Traceability

- TESTS → TEST `tests/runtime/policy-q007-remote-code-execution.test.ts` (PUL-Q007 source-policy gate (Vitest))
- IMPLEMENTS → CODE_FILE `tests/runtime/source-policy.ts` (Shared source-policy scanner module)
