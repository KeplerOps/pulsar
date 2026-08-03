---
id: PUL-F010
title: "URL parameter — index"
status: ACTIVE
type: FUNCTIONAL
priority: MUST
wave: 1
created_at: 2026-04-30T19:16:37.197252Z
updated_at: 2026-05-04T22:19:50.990001Z
---

# PUL-F010 — URL parameter — index

## Statement

When the `index` URL parameter is present alongside a `composition`, the runtime SHALL position playback at the given zero-based index within the composition.

## Rationale

Compatibility shim for positional navigation; scene id remains the source of truth for identity.

## Traceability

- DOCUMENTS → ADR `ADR-007` (Browser as the Default Workbench and Agent Collaboration Surface)
- IMPLEMENTS → CODE_FILE `src/runtime/navigation.ts` (URL grammar parser — accepts `composition` + `index` and emits `composition-index` locator)
- IMPLEMENTS → CODE_FILE `src/runtime/scene-navigation.ts` (Scene navigation dispatcher — `composition-index` resolves head to `manifest[index]`, slices forward, range-checks the index)
- IMPLEMENTS → CODE_FILE `src/runtime/scene-loader.ts` (Scene loader — drives the `composition-index` snapshot through the lifecycle and records `data-pulsar-scene-target`/`data-pulsar-composition-target`)
- TESTS → TEST `tests/runtime/navigation.test.ts` (URL parser tests — pin `index` parsing (zero-based, base-10, safe-integer) and `composition+index` combination)
- TESTS → TEST `tests/runtime/scene-navigation.test.ts` (Dispatcher tests — pin `composition-index` slice from index, range/non-integer/empty-composition error paths)
- TESTS → TEST `tests/runtime/scene-loader.test.ts` (Loader-boundary regression anchors for PUL-F010 — index>1 selects manifest[index]; varying-index sequence resolves to different heads)
- DOCUMENTS → ADR `ADR-013` (URL Navigation Grammar Boundary — names `composition`+`index` as the positional locator, defines `index` as composition-scoped non-identity)
- DOCUMENTS → ADR `ADR-014` (Scene Navigation Dispatch — names `composition`+`index` as PUL-F010 positional behavior, head is `manifest[index]`)
- IMPLEMENTS → GITHUB_ISSUE `19` (PUL-F010: URL parameter — index)
