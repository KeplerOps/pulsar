# PUL-F022 Timeline Orchestration Preflight

PUL-F022 is the requirement that replaces the placeholder timeline
runner with the real composition timing spine. Each scene still
produces its own timeline; the runtime owns composition into the
active composition's master timeline and exposes transport behavior:
play, pause, seek, speed change, and named labels.

ADR-003 is the binding engine decision: GSAP is the timeline engine
and scenes receive it through `ctx.gsap`, not by importing GSAP
directly. ADR-011 is the binding lifecycle decision: the composition
resolver is an orchestrator with injected adapters, not a GSAP-aware
module.

## Boundary

Implementation must reuse the current runtime path:

- `src/runtime/scene.ts` owns the scene module schema. The
  `timeline(ctx)` hook remains the scene-owned timeline factory.
- `src/runtime/composition.ts` owns composition entry format,
  `range`, and `behavior`. It does not become a timeline script.
- `src/runtime/registry.ts` and `src/runtime/composition-registry.ts`
  own registry validation, duplicate-id rejection, and immutable
  snapshots.
- `src/runtime/navigation.ts` owns URL grammar and workbench mode
  validation. PUL-F022 adds no URL query key by itself.
- `src/runtime/scene-loader.ts` owns per-navigation mode dispatch,
  `ctx.mode`, abort lifecycle, stage diagnostics, and workbench error
  surfacing.
- `src/runtime/scene-navigation.ts` owns target resolution and
  composition-slice snapshots.
- `src/runtime/composition-resolver.ts` owns preload -> create ->
  timeline -> cleanup ordering, cleanup on failure, and error
  envelopes. It must not import GSAP.
- The timeline adapter owns GSAP-specific timeline validation,
  master-timeline composition, label lookup, seeking, play/pause, and
  speed control.

If PUL-F022 needs a wider adapter than today's per-scene
`SceneTimelineRunner`, widen the existing loader / bridge / resolver
seam deliberately. Do not create a parallel composition lifecycle that
bypasses the resolver, registries, asset preloader, abort signal, or
cleanup invariants.

## Required Reuse

Implementation must build on these incumbents:

- Scene shape and validation: `SceneModule`, `assertSceneModule()`,
  and `createSceneRegistry()`.
- Composition shape and validation: `CompositionManifest`,
  `assertCompositionManifest()`, `entryId()`,
  `findUnregisteredEntries()`, and `createCompositionRegistry()`.
- Identifier rules: `isKebabIdentifier()` and
  `KEBAB_IDENTIFIER_FORM`; do not copy the regex.
- Navigation and mode gates: `parseNavigationSearch()`,
  `NAVIGATION_MODES`, `effectiveMode()`, plus loader-side defensive
  validation for hand-built `NavigationTarget` values.
- Lifecycle orchestration: `loadSceneNavigationTarget()` and
  `resolveComposition()`. Cleanup remains exactly-once per activated
  scene.
- Asset security and cancellation: `createAssetPreloader()` with its
  scheme allowlist, redirect re-check, `baseUrl`, and
  `AbortSignal` wiring.
- Presenter command seam: `PresenterCommandSource`,
  `PresenterController`, `createPresenterController()`, and
  `PRESENTER_COMMAND_KINDS`. Live pause/resume are presenter
  transport commands under `mode=present`, not URL modes.
- Error rendering: `describeError()`, existing stage attributes
  (`data-pulsar-scene-target`, `data-pulsar-composition-target`,
  `data-pulsar-navigation-error`), and the loader `onError` sink.
- Test style: Vitest under `tests/runtime/*`, seam tests at loader /
  bridge / resolver boundaries, and behavior tests for the real GSAP
  adapter.
- Tooling: `pnpm` scripts from `.ground-control.yaml` and
  `package.json`; strict TypeScript and Biome remain the source and
  formatting gates.

## Cross-Cutting Layers

| Layer | PUL-F022 guardrail |
|-------|--------------------|
| Dependency / supply chain | Add GSAP through `package.json` and `pnpm-lock.yaml` only. Stay on core GSAP unless a separate ADR approves plugin use. Do not smuggle Club GSAP or paid plugins through scene code. |
| Scene schema gate | `assertSceneModule()` remains the only scene-shape validator. Do not add a second `TimelineScene` schema or make `timeline` optional. |
| Composition schema gate | `assertCompositionManifest()` remains the only manifest validator. `range` keeps its current shape; `behavior` stays opaque until the runner consumes a specific key and validates that key at the runner boundary. |
| Label identity | Scene labels, URL `beat`, composition `range`, and master-timeline labels are related but not interchangeable. URL `beat` stays head-scene scoped per ADR-015. Master labels need deterministic collision handling; repeated scene entries cannot share one ambiguous global label namespace. |
| URL grammar | No new query key for play, pause, speed, or master seek in PUL-F022. Existing `beat=` remains the URL label path. Unknown query keys stay ignored. |
| Mode dispatch | `effectiveMode()` remains URL-only. Do not recover timeline mode or transport state from localStorage, sessionStorage, cookies, `history.state`, or prior in-memory state. |
| Lifecycle / cleanup | Timeline composition must preserve preload -> create -> timeline -> cleanup. Pause, seek, speed change, and labels are transport operations; they do not abort navigation or trigger cleanup. |
| Cancellation | `AbortSignal` means navigation supersession / dispose / composition abort. It is not play/pause. The GSAP adapter must stop its own timeline work when the signal aborts and let resolver cleanup run. |
| Asset security | Timeline code must not fetch undeclared scene assets to satisfy callbacks or labels. Asset loading continues through `scene.assets` and `createAssetPreloader()`. Credentialed preload must keep ADR-012's cross-origin caveat. |
| Presenter input | Presenter commands are accepted only under effective `present` when the loader was given a source. Pause/resume reuse ADR-024; speed controls, if exposed to presenters later, extend the same command seam rather than adding a second input bus. |
| Error envelope | Resolver failures keep the `composition resolution failed:` prefix and preserve causes / `AggregateError.errors`. Navigation failures keep `scene navigation failed:`. Missing labels use the non-fatal `onBeatMissing` path, not runner rejection. |
| Config / env / OS | No env vars, config files, process argv tokens, shell commands, or persisted browser storage are needed for PUL-F022 transport state. Do not put timeline state or credentials in URLs beyond the existing `beat=` grammar. |
| Observability | Reuse stage diagnostics and `onError`. Do not add high-volume playhead logging, per-frame console output, or analytics before the repo has a telemetry policy. |

## Guardrails

- Scene modules construct scene timelines with `ctx.gsap`; they do not
  import GSAP directly and they do not create the master timeline.
- The runtime, not the manifest, composes scene timelines. Do not turn
  composition manifests into imperative timeline programs.
- Do not hand-roll timers, `setTimeout` chains, polling loops, or
  `sleep()` helpers to satisfy transport controls. Use GSAP timeline
  transport.
- Master-timeline labels must not flatten scene labels in a way that
  loses scene / entry identity. Repeated scene ids in one composition
  are valid today; label addressing must remain unambiguous.
- `speed change` is runtime transport state. Do not conflate it with
  `SceneModule.duration`, composition `behavior`, or permanent scene
  metadata unless a future requirement explicitly defines authored
  speed overrides.
- Validate public speed values at the boundary that accepts them:
  finite numeric multiplier, explicit handling for zero / negative /
  NaN / Infinity, and no stringly-typed rates leaking into GSAP.
- `pause` is not `mode=paused`; presenter `hold` is not runtime pause;
  `seek` is not navigation abort; `range` is not URL `beat`.
- If a label is missing, report through the existing non-fatal
  missing-beat path when the request came from URL beat positioning.
  Reserve runner rejection for real timeline construction or transport
  failures.
- Do not pre-mount every scene merely to assemble a static master
  timeline if that bypasses per-scene cleanup or leaks DOM, listeners,
  audio, or animation handles across scene boundaries.
- Audio cues should hang off timeline callbacks and the future
  ADR-004 audio service. Do not introduce a parallel cue scheduler in
  the timeline runner.

## Extensibility

The extension seam is the runtime timeline adapter / controller that
owns the active master timeline. Future transport variations should
extend that seam, not scene schemas or composition manifests.

The scene-facing engine seam is `ctx.gsap` plus any small runtime
wrapper ADR-003 requires. The workbench-facing transport seam should
be one controller for the active timeline, with speed as a parameter
on transport state and labels resolved through the timeline label API.
Future mode-specific hints should follow the existing literal-field
pattern (`repeat`, `hold`, `cueGate`, `screenshot`) only when the mode
is a loader-dispatched concern.

## Non-Goals

PUL-F022 does not need a new URL grammar, new registry type, duplicate
beat metadata, scene-local transport API, persistence format, timeline
authoring UI, remote presenter protocol, audio engine, export pipeline,
analytics system, or requirement status transition.

PUL-F022 should not transition to ACTIVE until a real GSAP-backed
runtime path proves master timeline composition plus play, pause,
seek, speed change, and named-label behavior end to end, with
IMPLEMENTS / TESTS traceability links.

## Anti-Patterns

- Importing `gsap` from scene modules.
- Adding `beats` or `labels` arrays to scene metadata as a second
  source of truth.
- Validating labels in the URL parser, registries, or manifest
  validator.
- Creating a second exception hierarchy for timeline errors.
- Swallowing GSAP errors or replacing them with generic strings.
- Returning synchronously from a paused / held runner path that should
  keep the scene mounted until abort or transport completion.
- Treating all workbench modes as master-composition controls; the
  existing single-scene mode contracts for `standalone`, `loop`,
  `paused`, `scrub`, and `screenshot` still stand unless their ADRs
  are superseded.
