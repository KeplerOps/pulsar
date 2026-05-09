# PUL-F018 Screenshot Mode Preflight

PUL-F018 specifies `mode=screenshot`: render the addressed scene at
the addressed beat (or first frame if no beat) with all asset
preloads resolved, no animation in progress, all audio suppressed,
and any randomness sourced from a deterministic seed. This is a
deterministic visual-regression hook for agents and reviewers. It
is not a screenshot export subsystem, persistence feature, or
separate rendering pipeline.

ADR-007 already defines `screenshot` as a workbench mode. ADR-011
already defines the resolver as a lifecycle orchestrator with an
injected timeline runner. The runner-input shape introduced by
ADR-018 (`repeat`), extended by ADR-019 (`hold`), and extended
again by ADR-020 (`cueGate`) is the precedent for adding a new
head-only optional field; ADR-021 records the analogous
`screenshot` field for screenshot capture.

## Sandbox note

The codex preflight tool's sandbox failed to write design files
during this preflight run (`bwrap` setup error: `bwrap: loopback:
Failed RTM_NEWADDR: Operation not permitted`), so this document is
a manual transcription of the preflight tool's returned guardrails
text plus the architecture decisions that follow from it — same
handling pattern as `pul-f015-loop-mode-preflight.md`,
`pul-f016-paused-mode-preflight.md`, and
`pul-f017-scrub-mode-preflight.md`. The structured decisions are
recorded in ADR-021.

## Boundary

`screenshot` selection must reuse the existing navigation path:

- `src/runtime/navigation.ts` owns the `mode` URL grammar and the
  `NAVIGATION_MODES` allowlist.
- `effectiveMode()` owns effective mode derivation.
- `src/runtime/scene-loader.ts` owns per-navigation mode dispatch,
  `ctx.mode` construction, cancellation, stage diagnostics, and
  error surfacing. It is also the dispatch point that maps
  `effectiveMode === 'screenshot'` to `screenshot: 'capture'`.
- `src/runtime/scene-navigation.ts` owns target resolution and
  composition slicing. Its `scene` field is the addressed head
  scene.
- `src/runtime/composition-resolver.ts` owns preload → create →
  timeline → cleanup ordering, abort propagation, and exactly-once
  cleanup. It must remain mode-opaque; `headScreenshot` is plumbed
  the same way `headBeat`, `headRepeat`, `headHold`, and
  `headCueGate` are.
- The timeline runner owns timeline playhead behavior. Under
  `mode=screenshot` the runner reads
  `input.screenshot === 'capture'` and seeks to the addressed
  beat (or frame 0) before pausing the timeline.
- ADR-004's audio engine (when it lands) reads
  `input.screenshot === 'capture'` (or `ctx.mode === 'screenshot'`
  on the scene context) and produces no audio output: no cues, no
  ambient loops, no mixer output.
- A future deterministic-randomness convention (when it lands)
  exposes a stable seed that scenes consume for any random values
  under screenshot.

Do not add a second route, mode enum, `screenshot` boolean, scene
schema field, manifest flag, local URL parser, or
screenshot-specific resolver. URL input remains the only source of
mode selection; `screenshot` must not be recovered from
localStorage, sessionStorage, cookies, `history.state`, or prior
in-memory navigation state.

## Required Reuse

Implementation must reuse these cross-cutting concerns:

- Identifier validation: `src/runtime/identifier.ts`.
- URL and mode validation: `parseNavigationSearch()` and
  `NAVIGATION_MODES`.
- Effective mode derivation: `effectiveMode()`.
- Scene and composition validation:
  `assertSceneModule()`, `createSceneRegistry()`,
  `assertCompositionManifest()`, and `createCompositionRegistry()`.
- Navigation resolution: `resolveSceneNavigation()` and
  `loadSceneNavigationTarget()`.
- Lifecycle orchestration: `resolveComposition()` with injected
  `createPreloader()` and `runTimeline()` adapters.
- Asset handling: `createAssetPreloader()` with the existing
  scheme, redirect, `baseUrl`, and `AbortSignal` rules. Screenshot
  mode does not change preload semantics — the addressed scene's
  assets must still be loaded before `create(ctx)` runs.
  PUL-F018's "all asset preloads resolved" clause is already
  satisfied by the existing PUL-F004 / PUL-F005 invariant.
- Error rendering: `describeError()` plus the existing
  `data-pulsar-navigation-error` stage diagnostic and `onError`
  sink.
- Cancellation and cleanup: one per-navigation `AbortController`,
  forwarded to preload and timeline adapters; cleanup remains
  resolver-owned.
- Slice-truncation helper: the `applySingleSceneSlice` loader-side
  helper and the `truncateToHead` bridge-level helper introduced
  for `standalone` (ADR-017) and extended for `loop` (ADR-018),
  `paused` (ADR-019), and `scrub` (ADR-020) are extended again to
  fire under `screenshot`. The shape transform is shared; the
  predicate widens.
- Beat lookup / naming contract: `beat=` under `mode=screenshot`
  is the captured-frame anchor PUL-F018 names directly. Reuse the
  existing PUL-F011 / ADR-015 forwarding (`headBeat` /
  `onBeatMissing`).

## Scope: single-scene only

Screenshot is **single-scene execution at the addressed head**.
PUL-F018's "the addressed scene at the addressed beat" describes
ONE scene, ONE frame; "first frame if no beat" is the fallback
position. There is no composition-wide capture — the runtime has
no cross-scene timeline abstraction or frame-aggregation API, and
PUL-F018 does not call for one. The user (or capture tooling)
addresses a specific scene (directly via
`?scene=x&mode=screenshot`, or within a composition via
`?composition=c&scene=x&mode=screenshot` /
`?composition=c&index=N&mode=screenshot`) and captures that
scene's frame. To capture a different scene in the same
composition, the URL targets that scene. The five
single-scene-execution modes (standalone / loop / paused / scrub
/ screenshot) share the same slice-truncation transform because
they share the same structural "no following entries run"
promise.

## Screenshot Contract

Screenshot mode means: resolve the addressed scene through the
existing URL/registry/composition path, preload declared assets,
run normal `create(ctx)` and `timeline(ctx)`, then seek the
timeline to the addressed beat (or frame 0), pause it, suppress
all audio output, and source any randomness from a deterministic
seed.

- A direct `scene` target captures that scene's frame.
- A `composition` target captures the first scene's frame;
  following composition entries do not run.
- A `composition+scene` or `composition+index` target captures
  the resolved head scene's frame, preserving the head entry's
  `range` / `behavior` overrides; following composition entries
  do not run.
- `beat=<label>` under `mode=screenshot` IS honored as the
  captured-frame anchor. Unlike paused mode (where ADR-019
  records "first frame wins"), screenshot HONORS beat — that is
  literally what PUL-F018 says ("at the addressed beat or first
  frame if no beat"). The runner seeks to the named label, then
  freezes.

The requirement says deterministic visual capture. Do not
implement screenshot by skipping `create(ctx)`, by skipping
`timeline(ctx)`, or by short-circuiting the lifecycle. Scene
setup runs normally; the seek-and-freeze, audio suppression, and
deterministic-seed behaviors are runner-side concerns delivered
by future PRs alongside ADR-003 / ADR-004.

## Required Constraints (preflight guardrails)

These are binding unless they are clearly wrong:

- Treat `mode=screenshot` as a runtime execution mode inside the
  existing browser workbench architecture documented by ADR-007 /
  ADR-008. It is not a screenshot export subsystem, persistence
  feature, or separate rendering pipeline.
- Reuse the existing workbench mode/address parsing path for
  `mode=screenshot`. Do not duplicate the workbench mode enum,
  scene address schema, beat schema, or validation rules.
- Reuse existing scene and beat addressing schemas; do not
  introduce parallel DTOs or ad hoc query parsing.
- Reuse the existing scene loader and asset preload mechanism;
  screenshot readiness must wait on the real preload contract.
- Rendering must be driven to a stable addressed state: addressed
  beat, or first frame if no beat. Do not advance through live
  animation to reach a beat instead of resolving the addressed
  beat state directly.
- Time, animation, audio, and randomness must be controlled at
  runtime boundaries, not patched piecemeal inside individual
  scenes.
- Determinism must be scoped to the screenshot runtime instance
  so normal interactive mode is unaffected.
- Do not add a screenshot-specific exception hierarchy, logger,
  cache, repository, or workflow controller.
- Do not use global monkey patches for `Math.random`, timers,
  audio, or animation that leak into normal mode.
- Suppression of audio is not "set volume to zero" — the audio
  engine must not start playback or emit side effects under
  screenshot.
- Preloads are not done before images, fonts, textures, media
  posters, or other render-critical assets are decoded/ready.
  ADR-012's preloader contract already covers fetch + drain;
  screenshot does not relax it.
- Allow no arbitrary paths, asset URLs, or unsanitized query
  values through screenshot addressing.
- Persisting screenshot mode as user state or changing
  authoring/runtime defaults is forbidden by ADR-007's
  URL-only-source rule.

## Cross-Cutting Concerns To Reuse

- Existing `mode` parsing/routing/validation for `mode=screenshot`.
- Existing scene manifest and beat resolution.
- Existing asset preload/cache/decode readiness.
- Existing timeline, animation frame, tween, and scheduler
  control.
- Existing audio manager/mixer/global mute behavior (when ADR-004
  lands).
- Existing seeded randomness or runtime config injection (when
  established).
- Existing error types and error-response handling.
- Existing logging/diagnostic conventions for runtime readiness
  failures.
- Existing test runner and workbench/visual-regression harness.
- Ground Control traceability: add `IMPLEMENTS` and `TESTS` links
  only after implementation is complete (the `DOCUMENTS` link from
  the issue stays until ACTIVE).

## Gotchas And Anti-Patterns

- Treating "no animation in progress" as "wait a bit and capture"
  needs an explicit stable snapshot state, not a heuristic.
- Considering preloads done before images, fonts, textures, media
  posters, or other render-critical assets are decoded/ready will
  produce non-deterministic captures.
- Suppressing audio by volume alone (volume=0) leaks side
  effects: the engine still starts playback and emits cues.
- Advancing through live animation to reach a beat introduces
  per-run timing variance and breaks determinism.
- Persisting screenshot mode as user state or changing
  authoring/runtime defaults violates ADR-007's URL-only-source
  rule.

## Non-Goals And Boundaries

- No screenshot storage, image diffing, CI artifact upload, new
  authoring schema, editor UI controls, or a second rendering
  engine. The PR ships only the contract layer that lets future
  capture tooling drive the existing runtime to a deterministic
  frame.
- No new persistence format.
- No new timeline, beat, cue, exception, validation, or workflow
  abstraction unless existing contracts are genuinely absent.
- No authoring/editing of beats or seeds.
- No production analytics expansion unless the project already
  has safe telemetry for comparable playback events.
- No GSAP runner, audio engine, or determinism convention in this
  PR — those ship with ADR-003, ADR-004, and a future
  determinism-convention PR. Until all three land, PUL-F018 stays
  DRAFT.
