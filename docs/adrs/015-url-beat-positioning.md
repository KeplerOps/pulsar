# ADR-015: URL Beat Positioning as Timeline-Runner State

## Status

Accepted

## Date

2026-05-05

## Context

PUL-F011 requires `beat=<label>` to position the active scene's
timeline at the named timeline label. If the label does not exist, the
runtime must surface an error and remain at the scene's first beat.

The URL parser already accepts and validates `beat` as a kebab-case
identifier (`src/runtime/navigation.ts`, PUL-F007 / ADR-013). The scene
navigation dispatcher records the parsed target but deliberately does
not consume `beat` (`src/runtime/scene-navigation.ts`, ADR-014). The
composition resolver delegates timeline execution to
`SceneTimelineRunner` (`src/runtime/composition-resolver.ts`, ADR-011)
and treats a runner rejection as a lifecycle failure: it wraps the
error, calls `cleanup(ctx)`, and aborts the composition.

That resolver failure path is correct for real timeline failures, but
it is the wrong shape for an unknown URL beat. PUL-F011 says the scene
remains at its first beat. Throwing the missing-label error through the
resolver would unmount the scene and violate the requirement.

## Decision

`beat` is timeline-runner state, not URL-parser, scene-registry,
composition-manifest, or scene-loader dispatch state.

Implementation that satisfies PUL-F011 must reuse the existing URL
grammar and navigation target shape. `parseNavigationSearch` continues
to validate only identifier form and legal parameter combinations. It
must not inspect scene modules or timelines. `resolveSceneNavigation`
continues to resolve only the active scene/composition slice. It must
not inspect labels, build timelines, or duplicate timeline-runner
logic.

The concrete timeline runner is the first layer that has all required
inputs in one place: the active scene module, the concrete
`scene.timeline(ctx)` return value, the composition entry's `range` /
`behavior` overrides, the cancellation signal, and the optional URL
beat. Label existence and seeking therefore belong there.

`beat` targets only the active scene at the head of the resolved
navigation target. In a composition slice, it positions that first
scene's timeline only; it is not a global search through later scenes
and it does not rewrite the manifest slice.

"Remain at the scene's first beat" means keep the active scene mounted
at its initial timeline position. It does not require a new mandatory
scene metadata field, a duplicated beat manifest, or a required
`start` label on every timeline.

An unknown beat is a non-fatal navigation-positioning diagnostic. The
runtime must surface it through the existing workbench error surface
(`data-pulsar-navigation-error` plus the loader's error sink) while
allowing the active scene to stay mounted at the initial timeline
position. Do not report an unknown beat by rejecting the resolver's
`runTimeline` call, because that path exists for lifecycle failures and
will run `cleanup(ctx)`.

Valid beat seeking must use the timeline engine's label API. Do not
create a second beat schema in scene metadata, composition manifests,
URL parsing, or registries. Composition entry `range` remains a
timeline-runner concern too; any future beat-vs-range interaction must
be handled in the same runner boundary, not split across navigation and
composition code.

## Consequences

### Positive

- PUL-F011 reuses the existing grammar, dispatch, lifecycle, error
  rendering, and stage observability boundaries.
- Missing beat handling satisfies "surface an error and remain" without
  weakening the resolver's mandatory-cleanup invariant for real
  lifecycle failures.
- Beat labels stay canonical in GSAP timelines; no duplicate manifest
  or metadata source can drift.

### Negative

- The runner boundary needs a way to receive the optional URL beat and
  surface a non-fatal positioning diagnostic. That is a small adapter
  extension, but it must be explicit.
- Tests must distinguish missing-label diagnostics from timeline
  failures. Both mention timeline labels, but only one is fatal.

### Risks

| Risk | Mitigation |
|------|------------|
| Unknown beat is thrown through `resolveComposition`, so cleanup unmounts the scene | Treat missing labels as non-fatal navigation-positioning diagnostics; runner rejection remains reserved for lifecycle failures. |
| URL parsing starts resolving beat labels | Keep ADR-013's boundary: parser validates only shape and combinations, never runtime existence. |
| Scene authors add a parallel `beats` metadata list | Labels in the returned timeline are the source of truth; metadata lists would drift and are rejected unless a future ADR supersedes this one. |
| `beat` in a composition is interpreted as "find this label anywhere in the remaining composition" | Scope `beat` to the active head scene only. Later scenes run normally. |
| Composition `range` and URL `beat` get validated by different layers | Keep both concerns in the timeline runner, where the concrete timeline and per-entry overrides are already present. |

## Current state (2026-05-05)

PR #74 lands the runtime contract this ADR mandates: the parser
emits `NavigationTarget.beat`; the dispatcher and resolver forward
it to the head scene's run input; the scene loader supplies a
non-fatal `onBeatMissing` callback that surfaces
`data-pulsar-navigation-error` and the configured `onError` sink
without unmounting the scene. Defense-in-depth at the loader
re-validates kebab-case shape and the "beat requires a scene-like
target" combination rule before any side effect.

The contract is delivered. **PUL-F011 remains DRAFT** because the
end-to-end seek path requires a real timeline engine — ADR-003's
GSAP runner. The placeholder runner in `src/main.ts` honestly
reports "every beat missing" against its `null` timeline, so the
diagnostic path (PUL-F011 clause 2) is exercisable today, but the
positioning path (PUL-F011 clause 1) is not testable until labels
exist in real timelines.

PUL-F023 ("Named timeline beats") is the requirement that delivers
labelled timelines through the GSAP runner; PUL-F022 ("Timeline
orchestration") is the broader composition / play / pause / seek
spine. When those land, the GSAP runner replaces the placeholder
in `src/main.ts` and PUL-F011 transitions to ACTIVE without further
contract changes — the seek path is `if (timeline.labels[input.beat]
=== undefined) input.onBeatMissing?.(); else timeline.seek(input.beat)`.

## Related ADRs

- [ADR-003](003-gsap-timeline-engine.md) — labels and seeking are part
  of the GSAP timeline contract.
- [ADR-007](007-browser-workbench.md) — `beat` is part of the
  workbench URL grammar.
- [ADR-011](011-composition-resolver-orchestration.md) — the
  composition resolver delegates timeline execution to an injected
  runner and treats runner rejection as a lifecycle failure.
- [ADR-013](013-url-navigation-grammar-boundary.md) — URL parsing is a
  grammar boundary only.
- [ADR-014](014-url-scene-target-selection.md) — scene navigation
  resolves the active scene/composition slice and records `beat`
  without consuming it.
