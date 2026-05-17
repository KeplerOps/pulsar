# PUL-Q005 Validation Actionability Preflight

Date: 2026-05-17

PUL-Q005 tightens the diagnostic contract of the existing runtime
validation pass: every validation finding must name the offending
entity and the failed condition in human-readable form. This is
message and finding-shape hardening over PUL-F028 / ADR-008, not a new
validator.

## Boundary

- `src/runtime/validation.ts` remains the canonical validation API.
  Actionability belongs on `Finding` records and the messages produced
  by `validateRuntime()` / `assertNoValidationFindings()`.
- The requirement applies to errors reported by the validation pass,
  not to lifecycle, navigation, presenter, audio, asset fetch, or
  timeline-runtime exceptions.
- Existing validation categories remain authoritative unless a later
  requirement widens the pass: scene schema, duplicate scene id,
  composition manifest shape, unknown scene reference, and asset URL
  resolvability.
- Collection remains separate from rendering. Browser boot, CI, and
  any future report formatter must consume the same findings instead
  of inventing per-surface message grammars.
- A malformed scene id cannot be repaired by synthesizing an identity.
  If a scene id is absent or invalid, the diagnostic must identify the
  record position or field path and the failing id condition; it must
  not create a fake scene id.

## Required Reuse

Implementation must build on these incumbents:

- Validation contract: `Finding`, `FindingCode`, `validateRuntime()`,
  and `assertNoValidationFindings()`.
- Scene schema and field grammar: `assertSceneModule()`,
  `SceneModule`, `isKebabIdentifier()`, and `KEBAB_IDENTIFIER_FORM`.
- Composition shape and references: `assertCompositionManifest()`,
  `entryId()`, and `findUnregisteredEntries()`.
- Registry uniqueness: `createIdRegistry()` duplicate handling and
  existing duplicate-id message grammar.
- Asset policy: `resolveAssetUrl()`, `DEFAULT_ALLOWED_SCHEMES`, and
  the existing `baseUrl` / `allowedSchemes` parameters.
- Error rendering: `describeError()`, existing `Error` /
  `AggregateError` style, browser `console.error` validation output,
  and the `data-pulsar-validation-failed` stage marker.
- Tests and workflow: Vitest suites under `tests/runtime/*`,
  repository graph validation precedent from PUL-P002, and ADR-009's
  `pnpm test`, `pnpm typecheck`, and `pnpm lint` tooling.

## Cross-Cutting Layers

| Layer | Guardrail |
|-------|-----------|
| Scene schema gate | Use `assertSceneModule()` for field and condition detail. Validation may add context around that message, but must not fork the required-field table, caption grammar, audio-membership rule, or cleanup requirement. |
| Scene identity | Prefer the actual `scene.id` when it is a valid string. For missing or malformed ids, report the scene record position or field path plus the id rule; do not use `scene ?` alone as the only locator. |
| Duplicate-id registry | Duplicate findings must continue to come from the id-registry path and must name the duplicated id. If position is added for actionability, add it as validation context; do not change registry semantics. |
| Composition schema gate | Manifest-shape findings must name the composition id and the failing entry or field condition emitted by `assertCompositionManifest()`. Do not check references before the manifest shape is accepted. |
| Composition reference check | Unknown-reference findings must name composition id, entry index, referenced scene id, and the failed condition that the id is not registered. Use `findUnregisteredEntries()` for ordering. |
| Asset URL policy | Asset findings must name the declaring scene when known, the asset string/path, and the failed condition from `resolveAssetUrl()`. Honor `baseUrl` and `allowedSchemes`; do not copy URL parsing or fetch assets. |
| Browser error envelope | Browser boot may log `pulsar validation [code]: message` and set `data-pulsar-validation-failed`. Messages must be self-contained because console output and `AggregateError.errors` are both user-facing diagnostic paths. |
| CI/report envelope | CI may render finding fields differently, but it must use `Finding` data directly. Do not parse messages to recover ids, asset paths, or indexes. |
| Auth and secret handling | Validation does not require credentials. Do not include headers, cookies, authorization values, env values, request init objects, raw scene objects, full captions, DOM nodes, or registry dumps in findings. |
| Config and env binding | The only validation policy parameters in scope are the asset `baseUrl` and `allowedSchemes` knobs already mirrored from the preloader. No env vars, hidden config files, browser storage, or argv policy is needed. |
| OS/process exposure | Keep validation in process. If a future CLI wraps it, pass non-secret policy through typed options and print bounded findings; do not put secrets or whole serialized scene graphs in argv. |
| Observability | Existing test failure output, browser console error lines, and the stage validation marker are sufficient. Do not add telemetry, SARIF, artifacts, or a logging framework for PUL-Q005. |

## Actionability Contract

Every finding must carry enough structured context for a renderer to
locate the offending declaration without parsing `message`.

Minimum context by category:

- `scene-schema-invalid`: scene id when usable; otherwise scene record
  index or field path; failed field/condition in the message.
- `duplicate-scene-id`: duplicated scene id, and duplicate occurrence
  position if available.
- `composition-manifest-invalid`: composition id plus manifest entry
  index or field condition when the underlying schema error has one.
- `unknown-scene-reference`: composition id, entry index, referenced
  scene id, and "not registered" condition.
- `asset-unresolvable`: declaring scene id when usable, asset path or
  URL, and the URL/scheme/baseUrl condition from `resolveAssetUrl()`.

Messages may be terse, but they must be standalone. A reader seeing
only one `Error.message` from `AggregateError.errors` must still know
which declaration to edit and why it failed.

## Extensibility

The required seam is validation finding context, not a second error
system. If future validators add captions, timeline beat existence,
audio declarations, or export-only checks, extend `FindingCode` and
add narrowly named optional context fields rather than introducing a
parallel diagnostic DTO.

Keep renderer-specific output at the edge. A future JSON report,
GitHub annotation formatter, or local CLI should consume stable
finding fields and choose presentation there. It should not change the
canonical validation messages or validation categories.

## Gotchas And Anti-Patterns

- Do not satisfy actionability only by improving console formatting.
  `assertNoValidationFindings()` and CI output also expose validation
  failures.
- Do not rely on `scene ?` as the only locator for malformed scene
  records. Use record position or field path when no valid id exists.
- Do not parse existing message strings to populate structured fields.
  Carry context from the validation phase that already has it.
- Do not introduce `ValidationError`, `SceneValidationError`, or a
  duplicate exception hierarchy. The repo uses findings plus
  `AggregateError` at this boundary.
- Do not add a second scene schema, composition schema, asset URL
  parser, duplicate-id map, config surface, workflow, or logger.
- Do not echo raw scene objects, full captions, request headers,
  cookies, auth values, env values, DOM nodes, or registry internals.
- Do not run scene lifecycle hooks, fetch assets, import modules, start
  Vite, read files, or probe the network to make messages more
  actionable.

## Non-Goals

PUL-Q005 does not add new validation categories, a public CLI, a JSON
report format, GitHub annotations, telemetry, persistence, asset
existence checks, CDN health checks, decode checks, timeline beat
existence linting, source-code policy scanning, or requirement status
transitions.

It should not change scene metadata, composition manifest shape,
navigation URL grammar, workbench modes, lifecycle ordering, audio
behavior, registry mutability, asset preloading behavior, or CI
workflow shape.
