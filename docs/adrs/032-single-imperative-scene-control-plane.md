# ADR-032: Single Imperative Scene Control Plane

## Status

Accepted

Supersedes the master-timeline sequencing decisions in
[ADR-003](003-gsap-timeline-engine.md),
[ADR-011](011-composition-resolver-orchestration.md),
[ADR-025](025-timeline-adapter-boundary.md), and the timeline-runner
portions of [ADR-015](015-url-beat-positioning.md),
[ADR-016](016-workbench-mode-present.md) through
[ADR-021](021-workbench-mode-screenshot.md),
[ADR-023](023-presenter-controls.md), [ADR-024](024-presenter-pause-resume.md),
and [ADR-026](026-named-timeline-beats.md).

The scene/composition contracts, registries, URL parsing boundary,
asset policy, validation pass, scene failure isolation, audio unlock
gate, browser-support contract, and workbench chrome ownership decisions
from those ADRs stand unless this ADR explicitly replaces them.

## Date

2026-06-07

## Context

The accepted runtime model made GSAP master timelines the sequencing
spine. Real authored decks then converged on presenter-driven async
scene bodies: loop over beats, sleep on wall-clock timers, react to
presenter advance, and clean up audio/chrome in hand-written `finally`
blocks.

That produced two incompatible execution models:

- The runtime composed scene timelines into a master and paused at
  labels.
- The scene body ran as fire-and-forget async work beside that master.

The resulting three clocks -- master timeline, async sleeps, and Howler
audio -- made teardown author-discipline-dependent. Missing one abort
check or cleanup call could leave a loop, sound, listener, or DOM subtree
alive after navigation.

Issue 162 reverses that architectural direction. The runtime should own
one imperative control plane and keep the L2 scene library
(`src/system/chrome`, `src/system/templates`, `src/system/helpers`) as
the authoring asset.

## Decision

Pulsar uses a single imperative control plane per scene activation.

A scene activation is driven by one runtime-owned controller that owns:

- sleep / pause / resume / advance;
- navigation abort;
- registered timers, listeners, GSAP animations, audio handles, and
  disposable callbacks;
- scene exit teardown.

Scene authors write an async scene body that receives a bounded context
containing the existing scene-facing capabilities: chrome, audio, sleep,
signal, gsap, stage, presenter information where applicable, rng, and
activation identity. The existing `SceneModule` registration contract and
composition manifest remain the registry boundary; L2 templates may adapt
that async body into a `SceneModule`, but implementation must not create
a second scene schema or a parallel registry.

Composition sequencing is a plain ordered loop over the manifest slice:
validate and resolve the target, preload declared assets, activate one
scene, wait for that scene to finish or for presenter advance, tear it
down, then activate the next scene. The runtime no longer composes a GSAP
master timeline to sequence scenes.

GSAP remains available only as a per-scene animation tool through
`ctx.gsap`. Scene code must not import GSAP directly, and no runtime
master timeline owns scene sequencing, presenter advance gates, URL beat
positioning, scrub transport, or inter-scene lifecycle.

Audio remains behind the runtime-owned Howler boundary, but the
scene-facing service is reduced to the deck surface actually needed:
load/play/fade/stop scene cues and beds, validate sources through the
asset policy, and stop/fade/unload on scene exit. The runtime, not the
scene, performs final audio teardown.

The active browser runtime modes are `present` and `prompter`. The
previous speculative execution modes (`standalone`, `loop`, `paused`,
`scrub`, `screenshot`, `rehearsal`) are not part of the active control
plane. If a future requirement reintroduces one, it must extend the
loader/control-plane policy seam deliberately; it must not restore a
master timeline or add scene-local mode branches.

Presenter command validation remains centralized in
`src/runtime/presenter.ts`. Command-to-control-plane behavior belongs to
the runtime controller. Scene bodies must not install their own presenter
command buses, global keyboard listeners, or pause/advance state.

Automatic teardown is a runtime invariant. Scene bodies should not
hand-poll an abort flag between beats, hand-thread a controller into
every sleep, or hand-write `try/finally` solely to clean runtime-owned
timers, audio, chrome, and animations. A scene may still use `finally`
for scene-local state that is not expressible through the runtime
disposal registry, but that is an escape hatch, not the normal lifecycle.

## Consequences

### Positive

- There is one clock and one owner of scene lifecycle.
- Advance and navigation teardown can be tested against rendered DOM and
  audible/registered audio state, not internal timeline contracts.
- The L2 chrome/template/helper layer remains the authoring leverage,
  while the L1 runtime stops forcing it through a mismatched master
  timeline model.
- Scene authors get a smaller surface: async body plus runtime-owned
  sleep/teardown instead of timeline labels, advance gates, controller
  threading, and manual abort polling.
- The scene registry, composition manifest, validation, asset policy,
  URL parser, presenter command validator, and workbench chrome boundary
  remain reusable.

### Negative

- Existing timeline-runner tests and mode-specific tests that assert the
  deleted master-timeline layer must be removed or rewritten as rendered
  lifecycle tests.
- URL beat positioning, scrub transport, screenshot mode, loop mode,
  paused inspection, and rehearsal cue logging are no longer active
  runtime contracts.
- Scenes that encoded useful per-scene GSAP animation in `timeline(ctx)`
  must migrate that animation into the async body or an L2 helper without
  using a master timeline for scene sequencing.

### Risks

| Risk | Mitigation |
|------|------------|
| The implementation keeps both models alive during migration | Delete or quarantine master sequencing entrypoints as part of the runtime change; tests must prove no master timeline sequences scenes. |
| A disposal registry becomes a new hidden framework | Keep it activation-scoped and concrete: timers, listeners, animations, audio, DOM/chrome cleanup, and explicit disposables. Do not add a generic plugin lifecycle. |
| `SceneModule` and async-body authoring become duplicate schemas | Keep `SceneModule` as the registry/validation contract. Put async-body ergonomics in L2 templates or a single runtime adapter, not a second registry type. |
| Source-policy scans miss deck-local scenes | Apply the same scene-module policy to `src/decks/**/scenes/**` or add targeted deck tests for the proof deck. |
| Public diagnostics leak raw scene state during teardown failures | Reuse `describeError`, `describeErrorDetailed`, `formatSceneContext`, `onError`, and stage attributes; never serialize raw causes, DOM, audio handles, headers, cookies, env, or stacks. |
| Future work reintroduces scrub/screenshot by restoring the master timeline | Reintroduce modes only through a new ADR/requirement that defines a control-plane policy seam and rendered behavior tests. |

## Related ADRs

- [ADR-001](001-custom-experience-runtime.md) -- runtime ownership of
  scene lifecycle remains.
- [ADR-002](002-scene-registry-and-compositions.md) -- scene registry and
  composition manifests remain the core abstraction.
- [ADR-004](004-howler-audio-engine.md) -- Howler remains the engine
  boundary, but the scene-facing surface is slimmed and teardown is
  control-plane-owned.
- [ADR-008](008-agent-native-authoring.md) -- small scene contract,
  stable ids, manifests, and mandatory cleanup remain binding.
- [ADR-012](012-asset-preloader-fetch-and-drain.md) -- asset URL policy
  remains the security boundary for asset and audio sources.
- [ADR-013](013-url-navigation-grammar-boundary.md) and
  [ADR-014](014-url-scene-target-selection.md) -- URL parsing and target
  resolution remain before lifecycle execution.
- [ADR-028](028-scene-level-error-isolation.md) -- lifecycle failures
  remain runtime-owned diagnostics, not scene-local recovery workflows.
- [ADR-029](029-present-mode-audio-unlock-gate.md) -- present-mode audio
  unlock remains a loader/workbench gate before audio-bearing playback.
- [ADR-031](031-workbench-chrome-surface.md) -- chrome remains
  workbench-owned and scene-accessed only through slots.
