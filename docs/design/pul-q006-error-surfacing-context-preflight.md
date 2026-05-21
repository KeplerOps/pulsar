# PUL-Q006 Error Surfacing Context Preflight

Date: 2026-05-17

PUL-Q006 requires runtime-surfaced errors to include the scene id and,
where applicable, either the beat label or lifecycle/timeline phase
(`create`, `timeline`, `cleanup`). This is diagnostic context hardening
over existing error surfaces. It is not a new error hierarchy, logger,
validation pass, scene schema, or recovery workflow.

## Boundary

- `src/runtime/error.ts` remains the shared unknown-error renderer.
  Public surfaces use `describeErrorDetailed()` when cause /
  `AggregateError` detail must be visible; internal wrappers continue
  to use `describeError()` for terse local messages.
- `src/runtime/composition-resolver.ts` remains the lifecycle owner.
  `SceneFailureEvent` is the canonical structured contract for
  `create`, `timeline`, and `cleanup` failures.
- `src/runtime/scene-loader.ts` remains the browser/workbench
  diagnostic boundary through `onError`,
  `data-pulsar-navigation-error`, and
  `data-pulsar-scene-failures`.
- `src/runtime/timeline.ts` remains the beat-label contract. Authored
  labels are validated by `assertSceneTimeline()`; URL-requested
  missing beats surface through the non-fatal `onBeatMissing` path.
- `src/runtime/navigation.ts` remains the URL grammar gate for `beat`
  and `mode`, with loader-side defense-in-depth for programmatic
  `NavigationTarget` values.

## Required Reuse

Implementation must build on these incumbents:

- Scene identity and lifecycle phase: `SceneFailureEvent`,
  `SceneFailurePhase`, `buildSceneFailure()`, `notifyFailure()`, and
  loader `buildOnSceneFailed()`.
- Public error rendering: `describeError()`,
  `describeErrorDetailed()`, `Error`, `AggregateError`, and
  `Error.cause`.
- Beat handling: `isKebabIdentifier()`, `KEBAB_IDENTIFIER_FORM`,
  `assertSceneTimeline()`, `SceneTimelineLabelError`,
  `headBeat`, `onBeatMissing`, and `buildOnBeatMissing()`.
- Navigation and mode validation: `parseNavigationSearch()`,
  `NAVIGATION_MODES`, `effectiveMode()`, `validateBeatGrammar()`, and
  `validateModeGrammar()`.
- Existing browser surfaces: loader `onError`,
  `data-pulsar-navigation-error`, and
  `data-pulsar-scene-failures`.
- Tests already pinning the seams:
  `tests/runtime/error.test.ts`,
  `tests/runtime/composition-resolver.test.ts`,
  `tests/runtime/scene-loader*.test.ts`, and
  `tests/runtime/timeline.test.ts`.

## Cross-Cutting Layers

| Layer | Guardrail |
|-------|-----------|
| Scene schema gate | `assertSceneModule()` is only the static scene contract. Do not add scene fields, `onError` hooks, or duplicate lifecycle validation for PUL-Q006. |
| Lifecycle resolver | `create`, `timeline`, and `cleanup` throws must pass through `SceneFailureEvent` so scene id and phase stay structured before rendering. Preload, registry, manifest, abort, and timeline-adapter failures keep their existing composition-wide semantics. |
| Loader error envelope | Public messages emitted through `onError` and stage attributes must include scene id plus phase or beat when the active boundary has that context. Keep the raw `cause` programmatic; do not serialize stacks, scene objects, DOM, captions, headers, cookies, env, auth values, or request init. |
| Beat grammar | URL beat values must pass the parser and loader defense-in-depth checks. Missing-label diagnostics must stay non-fatal through `onBeatMissing`; malformed authored labels remain `SceneTimelineLabelError` failures from `assertSceneTimeline()`. |
| Timeline adapter | Use `headBeat` / `onBeatMissing` and the existing `MasterTimeline` label helpers. Do not parse namespaced label strings outside `parseSceneTimelineLabel()` or infer beat context from rendered messages. |
| Asset/audio/presenter errors | These keep their existing boundaries. Add scene/phase/beat context only where the runtime already knows it; do not widen payloads or leak engine handles, source URLs beyond existing asset diagnostics, or presenter command internals. |
| Validation pass | `validateRuntime()` remains structural validation. PUL-Q006 does not add validation findings or make validation execute lifecycle hooks, timelines, fetches, or audio. |
| Config/env/OS exposure | No env vars, browser storage, localStorage, cookies, argv, shell commands, or generated command lines are needed. Diagnostic context is derived in process from typed runtime values. |
| Observability | Browser console/stage and test failure output are sufficient. Do not add telemetry, persistence, SARIF, or a logging framework for this requirement. |

## Intended Design

The intended design is a narrow context-normalization pass at existing
surfacing seams. Lifecycle failures should continue to originate as
`SceneFailureEvent` with `{ sceneId, phase, entryIndex, message,
cause }`, and the loader should render the browser-facing message with
scene id, phase, composition/index when known, and mode. Beat-related
diagnostics should stay split by source: malformed or invalid authored
labels fail in `assertSceneTimeline()` with scene id and label;
missing URL beats use `onBeatMissing` and surface a message naming the
requested beat and head scene id.

The extensibility seam is a shared context renderer or helper near
`src/runtime/error.ts` / `src/runtime/scene-loader.ts` that accepts a
small structured context object. It should be parameterized by
`sceneId`, `phase`, and `beat` rather than by ad hoc string fragments,
so future contexts such as composition entry, occurrence index, or
runner mode can be added without reparsing existing messages.

## Gotchas And Anti-Patterns

- Do not introduce `RuntimeError`, `SceneError`, `BeatError`, or a
  parallel exception hierarchy. Existing `Error` / `AggregateError`
  plus structured event fields are sufficient.
- Do not satisfy the requirement by parsing `Error.message` to recover
  scene id, phase, or beat. Carry context from the boundary that has it.
- Do not send all errors through `data-pulsar-scene-failures`.
  Navigation, preload, manifest, registry, validation, and adapter
  failures keep their existing surfaces.
- Do not make missing URL beats fatal. The `onBeatMissing` path is
  intentionally non-fatal.
- Do not call lifecycle hooks, construct timelines, fetch assets, or
  read DOM state only to improve an error message.
- Do not echo raw causes, stacks, full captions, scene objects, DOM
  nodes, request headers, cookies, auth values, env values, or process
  arguments in public diagnostics.
- Do not duplicate the kebab-case identifier regex, URL grammar, mode
  allowlist, or master-label parser.

## Non-Goals

PUL-Q006 does not add recovery UI, retries, presenter command kinds,
telemetry, persistent error history, a new logging system, new URL
parameters, new workbench modes, source maps, stack rendering, or
network/asset validation.

It does not change scene metadata, composition manifest shape,
navigation grammar, timeline orchestration, audio behavior, validation
categories, resolver failure classification, or requirement status.
