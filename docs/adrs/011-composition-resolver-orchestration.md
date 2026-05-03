# ADR-011: Composition Resolver as a Pure Orchestrator with Injected Adapters

## Status

Accepted

## Date

2026-05-03

## Context

[ADR-002](002-scene-registry-and-compositions.md) §Resolution defines
the runtime's lifecycle for playing a composition: validate every
referenced scene id, preload assets, mount each scene via `create(ctx)`,
run its timeline, tear it down via `cleanup(ctx)`, advance. PUL-F004 is
the requirement that ships that lifecycle.

Two of the five clauses depend on subsystems that do not yet exist:

- The asset preloader is first mentioned in PUL-F004 itself; there is
  no implementation yet (PUL-F005+ will land one).
- The GSAP timeline engine is decided in
  [ADR-003](003-gsap-timeline-engine.md) but no `gsap` import exists in
  the repo and no master-timeline runner has landed.

The resolver is the single call site for both subsystems. Its shape now
determines how much churn the asset loader and the GSAP runner cause
when they land. It is also the call site for any future presenter-
interrupt or sub-range cut behavior — so we want a shape that does not
have to change every time the runtime gains a new orthogonal concern.

The default temptation is to inline a stub asset loader and a stub GSAP
shim into the resolver "for now" and revisit when the real subsystems
arrive. That conflates the manifest-execution requirement with the
asset/timeline subsystem requirements and welds the resolver to one
particular timeline engine (defeating ADR-003's swappable
`ctx.gsap` decision and ADR-008's "manifests over flow control"
principle).

## Decision

The composition resolver in
[`src/runtime/composition-resolver.ts`](../../src/runtime/composition-resolver.ts)
is a **pure orchestrator**. It owns:

1. The lifecycle order: validate → pre-flight existence → preload →
   create → timeline → cleanup, strictly sequential, in manifest order.
2. The failure rules: missing-id pre-flight aggregates ALL offenders
   into a single error before any side effect; cleanup is mandatory
   whenever a scene was touched (including failure paths after `create`
   or timeline execution); when a lifecycle phase AND cleanup both
   throw, the wrapping error is an `AggregateError` whose `errors`
   array carries both the phase error and the cleanup error in order
   — neither caller-supplied error is mutated and both are
   programmatically recoverable (PUL-Q005 spirit).
3. The boundary defensiveness pattern: the resolver calls
   `assertCompositionManifest` itself, mirroring how
   `createSceneRegistry` calls `assertSceneModule` (PUL-F002 / PUL-F001
   relationship).

The resolver delegates the *work* of preloading and of running a
timeline to **injected callbacks**:

- `AssetPreloader = (scene: SceneModule) => void | Promise<void>`
- `SceneTimelineRunner = (input: SceneTimelineRunInput) => void | Promise<void>`
  where `SceneTimelineRunInput` is `{ scene, timeline, range?, behavior? }`.

The scene `ctx` is opaque to the resolver — it is passed straight
through to every lifecycle hook. The resolver does not depend on,
import, or feature-detect any specific asset library, GSAP, Howler, or
DOM API.

`range` and `behavior` overrides on object entries (PUL-F003) are
accepted at the boundary by `assertCompositionManifest`. The resolver
does NOT read or interpret either field — but it does forward both to
the runner adapter unchanged through `SceneTimelineRunInput`. Carrying
them on the runner input now (rather than only inside the manifest the
resolver consumes) means the future GSAP runner can honor sub-range
cuts and behavior overrides without another resolver-signature change.
The resolver hands `range` / `behavior` to the runner; the runner
decides what to do with them when it is ready to support them.

`scene.timeline(ctx)` is `await`ed before its return value is handed to
the runner so async timeline factories (e.g. ones that load a beat
script before constructing the GSAP timeline) resolve to a concrete
timeline before the runner sees them. Awaiting a non-Promise value is
identity, so synchronous timeline factories are unaffected.

## Consequences

### Positive

- Subsystems stay swappable per ADR-003 / ADR-004. The asset loader
  and the GSAP timeline runner can be implemented, reimplemented, or
  swapped without touching `composition-resolver.ts`.
- PUL-F004 ships without dragging in a stub asset loader or a stub
  GSAP wrapper. The requirement-to-module mapping stays one-to-one.
- Failure semantics are explicit and individually testable. Each
  failure mode (preload reject, create reject, timeline reject,
  cleanup reject, double-fault) has its own test in
  `tests/runtime/composition-resolver.test.ts`.
- Cleanup-mandatory behavior is enforced at the orchestration layer
  rather than re-implemented per scene, satisfying PUL-P001 with one
  audited code path.
- The resolver is a useful primitive for the export pipeline (ADR-006)
  and the workbench (ADR-007) — both can plug their own preloader and
  runner adapters in without forking the lifecycle code.

### Negative

- Callers must wire two callbacks instead of "just calling play". The
  workbench bootstrap and the export pipeline each have a one-time
  wiring cost when they land.
- The resolver does not "know" about GSAP, so error messages from a
  failing timeline are only as informative as the runner adapter's
  error reporting. Mitigated: the resolver wraps with
  `composition resolution failed: scene "<id>" timeline threw: <cause>`
  and preserves the cause chain so the underlying error remains
  inspectable.

### Risks

| Risk | Mitigation |
|------|-----------|
| Future presenter-interrupt support might need state the resolver currently does not own. | The orchestrator's small surface (one async function, two callbacks) is easy to extend; cancellation can land as an `AbortSignal` option without changing the failure semantics. Re-evaluate when PUL-F005+ specifies presenter controls. |
| The "do not interpret `range` / `behavior`" deferral could be missed by future work, leading to silent acceptance of overrides that don't do anything. | Test `'accepts object entries with range / behavior overrides without reading either field'` pins the deferral; any future change that starts interpreting them must adjust this test, surfacing the intent explicitly. |
| Two failing hooks (timeline + cleanup) could surface as a confusing single error. | The wrapping error message names both, and the `AggregateError.errors` array carries both error objects in order for programmatic inspection (no `Error.cause` chain — `errors[]` is the public contract). Neither caller-supplied error is mutated. Tests pin both surfaces. |

## Related ADRs

- [ADR-002](002-scene-registry-and-compositions.md) — defines the
  resolution algorithm this ADR operationalizes.
- [ADR-003](003-gsap-timeline-engine.md) — the timeline engine the
  `SceneTimelineRunner` adapter targets.
- [ADR-004](004-howler-audio-engine.md) — the audio engine handle that
  will arrive on `ctx.audio`; the resolver passes `ctx` through
  unchanged.
- [ADR-008](008-agent-native-authoring.md) — mandatory-cleanup,
  declarative-data, manifests-over-flow-control invariants the
  resolver enforces.
