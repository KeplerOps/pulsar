---
id: PUL-F009
title: "URL parameter — composition"
status: ACTIVE
type: FUNCTIONAL
priority: MUST
wave: 1
created_at: 2026-04-30T19:16:34.529380Z
updated_at: 2026-05-04T21:59:05.145881Z
---

# PUL-F009 — URL parameter — composition

## Statement

When the `composition` URL parameter is present, the runtime SHALL resolve the addressed composition manifest and use it as the navigation context.

## Rationale

Required for presenting and inspecting scenes within a specific composition.

## Traceability

- DOCUMENTS → ADR `ADR-007` (Browser as the Default Workbench and Agent Collaboration Surface)
- IMPLEMENTS → CODE_FILE `src/runtime/navigation.ts` (URL grammar parser — recognizes `composition` parameter and emits composition locator kinds)
- IMPLEMENTS → CODE_FILE `src/runtime/scene-navigation.ts` (Scene navigation dispatcher — resolves the addressed composition manifest as navigation context)
- IMPLEMENTS → CODE_FILE `src/runtime/scene-loader.ts` (Scene loader — drives the resolved composition through lifecycle, records `data-pulsar-composition-target`)
- IMPLEMENTS → CODE_FILE `src/runtime/composition-registry.ts` (Composition registry — id-keyed composition lookup that the `?composition=` URL parameter consults)
- IMPLEMENTS → CODE_FILE `src/main.ts` (Workbench entry — wires `bootstrapNavigation` → loader so `?composition=` is honored at startup and on popstate)
- TESTS → TEST `tests/runtime/navigation.test.ts` (URL parser tests — pin parser handling of `composition`, `composition+scene`, `composition+index`)
- TESTS → TEST `tests/runtime/scene-navigation.test.ts` (Dispatcher tests — pin composition-manifest resolution, slice snapshot, missing/empty/range error paths)
- TESTS → TEST `tests/runtime/scene-loader.test.ts` (Loader tests — pin PUL-F009 canonical cases (composition-only, composition-index) at the loader boundary)
- IMPLEMENTS → GITHUB_ISSUE `18` (PUL-F009: URL parameter — composition)
