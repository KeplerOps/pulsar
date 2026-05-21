# ADR-028: Scene-Level Error Isolation

## Status

Accepted

## Date

2026-05-12

## Context

PUL-F029 requires recoverability during a live presentation: when one
scene fails during `create`, `timeline`, or `cleanup`, the runtime must
surface the failure with scene context, keep the active composition from
halting, and let the presenter advance past the failed scene.

This cuts across the lifecycle resolver, workbench loader, presenter
controls, timeline adapter, audio service, scene schema, validation pass,
and diagnostic surface. It must not become a second scene contract, a
second navigation workflow, or a scene-authored error system.

Existing runtime boundaries already cover parts of the need:

- `SceneModule` and `assertSceneModule` define the scene shape. Failure
  isolation must not add a required hook or parallel schema.
- The composition resolver owns calls to `create(ctx)`, `timeline(ctx)`,
  and `cleanup(ctx)`, wraps unknown thrown values, and runs cleanup for
  touched scenes. It is the lifecycle isolation boundary.
- `describeError` is the shared unknown-error-to-message helper. Any
  future truncation, redaction, or cause unwrapping belongs there, not in
  each lifecycle phase.
- The scene loader owns workbench diagnostics through the injected
  `onError` sink and stage attributes. It is the browser-facing error
  surface.
- Presenter input is already scoped through the presenter command source
  and controller. Advancing past a failed scene must use that transport
  seam rather than direct DOM listeners or a new input workflow.
- The audio service already scopes playback to navigation and scene
  groups. A failed scene must not bypass the existing stop/unload paths.

## Decision

Treat scene lifecycle failures as runtime-owned scene failure events at
the resolver/loader boundary.

The failure event shape is a runtime diagnostic contract, not a new
scene schema. It must carry:

- lifecycle phase: `create`, `timeline`, or `cleanup`;
- scene id;
- composition context when known: composition id and entry index;
- current workbench mode when known;
- a message from `describeError(cause)`. If diagnostic truncation or
  redaction is needed, it belongs in that shared helper.

The public diagnostic must not include raw scene objects, DOM nodes,
caption bodies, request headers, cookies, environment variables, auth
values, full stacks, or serialized `Error.cause`. Programmatic `cause`
may remain attached to the internal `Error` / `AggregateError` object.

The composition resolver remains the canonical lifecycle boundary:

- A `create` failure marks that scene failed, attempts that scene's
  `cleanup(ctx)`, surfaces the failure, and continues resolving the
  remaining active composition.
- A `timeline(ctx)` failure marks that scene failed, attempts cleanup for
  that scene, surfaces the failure, and contributes no normal scene
  timeline segment for that scene.
- A `cleanup(ctx)` failure is surfaced with scene context and collected,
  but cleanup continues for sibling scenes and does not block the next
  navigation or presenter advancement.
- Cleanup-only and multi-fault cases use the existing aggregate-error
  pattern. Do not add a parallel exception hierarchy for PUL-F029.

The scene loader remains the browser/workbench diagnostic boundary:

- Route scene failure diagnostics through the existing `onError` sink and
  stage error surface.
- Keep navigation queue, abort, and cleanup-before-handoff semantics
  intact. A failed scene must not poison later queued navigations.
- Do not persist failure state in URL parameters, `history.state`,
  localStorage, cookies, or environment-derived config.

The presenter advances past a failed scene through the existing
presenter/timeline transport seam. The implementation may need a
timeline-adapter parameter for a failed-scene placeholder or skip marker,
but it must not introduce a second presenter command schema, direct
keyboard listener, or scene-authored escape hatch.

## Consequences

### Positive

- Scene failures become recoverable without weakening the scene contract.
- Operators see the failing scene and phase instead of a generic
  composition failure.
- Existing validation, navigation, presenter, audio, and error surfaces
  stay canonical.
- Future policy changes can live behind a resolver-level failure policy
  or timeline-adapter placeholder seam without rewriting scenes.

### Negative

- The resolver and timeline adapter need a more nuanced failure state
  than simple "throw aborts the whole composition".
- Tests must cover partial lifecycle execution and multi-fault cleanup
  cases.
- A failed scene may leave visual gaps unless the runtime supplies a
  neutral placeholder or explicit skip behavior.

### Risks

| Risk | Mitigation |
|------|-----------|
| Scene failures are confused with invalid scene schemas, malformed URLs, or unresolved assets | Keep PUL-F029 scoped to `create`, `timeline`, and `cleanup`. Existing schema, navigation, and preloader errors keep their current boundaries. |
| A new `SceneError` hierarchy duplicates existing wrappers | Use existing `Error`, `AggregateError`, `Error.cause`, and `describeError`; add structured fields only at the diagnostic event boundary. |
| The public error surface leaks secrets or content | Public messages include ids, phase, mode, composition/index, and `describeError` output only. Do not serialize raw causes, stacks, scene data, DOM, captions, headers, cookies, env, or auth values. |
| Cleanup failures are swallowed during recovery | Surface cleanup failures, aggregate multi-fault cases, and still continue sibling cleanup and navigation teardown. |
| Presenter recovery becomes a separate workflow | Keep advancement on the existing presenter command and timeline transport seam. No direct DOM listeners or scene-local recovery controls. |
| Audio from a failed scene leaks after skip | Keep `ctx.audio` and `stopGroup(sceneId)` / `stopAll()` as the only audio cleanup path. |

## Non-Goals

- No new scene lifecycle hook such as `onError`, `recover`, or
  `fallback`.
- No schema change to `SceneModule`.
- No retry UI, persistent error history, telemetry stream, or production
  logging framework.
- No change to URL grammar, workbench modes, presenter command kinds, or
  composition manifest shape.
- No reclassification of validation, navigation grammar, registry, or
  asset-preload failures as scene lifecycle failures.

## Related ADRs

- [ADR-001](001-custom-experience-runtime.md) - the runtime owns
  lifecycle, navigation, cleanup, and error handling.
- [ADR-002](002-scene-registry-and-compositions.md) - scenes and
  compositions provide the context for failure diagnostics.
- [ADR-003](003-gsap-timeline-engine.md) - presenter advancement and
  failed-scene skipping must stay on the timeline transport seam.
- [ADR-004](004-howler-audio-engine.md) - failed scenes still use the
  runtime audio cleanup path.
- [ADR-007](007-browser-workbench.md) - diagnostics surface through the
  workbench, not per-scene UI.
- [ADR-008](008-agent-native-authoring.md) - failure isolation must
  preserve the small scene contract and mandatory cleanup invariant.
