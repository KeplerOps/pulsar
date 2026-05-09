# PUL-F017 Scrub Mode Preflight

PUL-F017 specifies `mode=scrub`: display timeline controls allowing
the user to scrub forward, backward, and to named beats; audio cues
SHALL fire only on monotonic forward playback. This is a
timing-and-beat-alignment-inspection mode for runtime review. It is
not a presenter transport state, a paused layout-review mode, a
deterministic visual-regression mode, a screenshot mode, or a new
scene model.

ADR-007 already defines `scrub` as a workbench mode. ADR-011 already
defines the resolver as a lifecycle orchestrator with an injected
timeline runner. The runner-input shape introduced by ADR-018
(`repeat`) and extended by ADR-019 (`hold`) is the precedent for
adding a new head-only optional field; ADR-020 records the
analogous `cueGate` field for scrub.

## Sandbox note

The codex preflight tool's sandbox failed to write design files
during this preflight run (`bwrap` setup error), so this document is
a manual transcription of the preflight tool's returned guardrails
text plus the architecture decisions that follow from it — same
handling pattern as `pul-f015-loop-mode-preflight.md` and
`pul-f016-paused-mode-preflight.md`. The structured decisions are
recorded in ADR-020.

## Boundary

`scrub` selection must reuse the existing navigation path:

- `src/runtime/navigation.ts` owns the `mode` URL grammar and the
  `NAVIGATION_MODES` allowlist.
- `effectiveMode()` owns effective mode derivation.
- `src/runtime/scene-loader.ts` owns per-navigation mode dispatch,
  `ctx.mode` construction, cancellation, stage diagnostics, and
  error surfacing. It is also the dispatch point that maps
  `effectiveMode === 'scrub'` to `cueGate: 'monotonic-forward'`.
- `src/runtime/scene-navigation.ts` owns target resolution and
  composition slicing. Its `scene` field is the addressed head
  scene.
- `src/runtime/composition-resolver.ts` owns preload → create →
  timeline → cleanup ordering, abort propagation, and exactly-once
  cleanup. It must remain mode-opaque; `headCueGate` is plumbed
  the same way `headBeat`, `headRepeat`, and `headHold` are.
- The timeline runner owns timeline playhead behavior. Under
  `mode=scrub` the runner reads `input.cueGate === 'monotonic-forward'`
  and gates audio-cue firing by direction.
- The future workbench scrub-controls UI surface (separate PR)
  owns the forward / backward / named-beat controls. It reads
  `ctx.mode === 'scrub'` (the seam this PR establishes) and drives
  the runner's transport API.

Do not add a second route, mode enum, `scrub` boolean, scene schema
field, manifest flag, local URL parser, or scrub-specific resolver.
URL input remains the only source of mode selection; `scrub` must
not be recovered from localStorage, sessionStorage, cookies,
`history.state`, or prior in-memory navigation state.

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
  scheme, redirect, `baseUrl`, and `AbortSignal` rules. Scrub mode
  does not change preload semantics — the addressed scene's assets
  must still be loaded before `create(ctx)` runs.
- Error rendering: `describeError()` plus the existing
  `data-pulsar-navigation-error` stage diagnostic and `onError`
  sink.
- Cancellation and cleanup: one per-navigation `AbortController`,
  forwarded to preload and timeline adapters; cleanup remains
  resolver-owned.
- Slice-truncation helper: the `applySingleSceneSlice` loader-side
  helper and the `truncateToHead` bridge-level helper introduced
  for `standalone` (ADR-017) and extended for `loop` (ADR-018) and
  `paused` (ADR-019) are extended again to fire under `scrub`. The
  shape transform is shared; the predicate widens.
- Beat lookup / naming contract: `beat=` under `mode=scrub` is the
  natural scrub-to-named-beat path PUL-F017's "to named beats"
  clause anticipates. Reuse the existing PUL-F011 / ADR-015
  forwarding (`headBeat` / `onBeatMissing`).

## Scope: single-scene only

Scrub is **single-scene execution at the addressed head**. PUL-F017's
"timeline controls" are over ONE timeline; "named beats" are
scene-scoped per ADR-015. There is no composition-wide scrubbing —
the runtime has no cross-scene timeline abstraction or transport
API, and PUL-F017 does not call for one. The user addresses a
specific scene (directly via `?scene=x&mode=scrub`, or within a
composition via `?composition=c&scene=x&mode=scrub` /
`?composition=c&index=N&mode=scrub`) and scrubs that scene's
timeline. To scrub a different scene in the same composition, the
user navigates to a fresh URL targeting that scene. The four
single-scene modes (standalone / loop / paused / scrub) share the
same slice-truncation transform because they share the same
structural "no following entries run" promise.

## Scrub Contract

Scrub mode means: resolve the addressed scene through the existing
URL/registry/composition path, preload declared assets, run normal
`create(ctx)` and `timeline(ctx)`, then hand control of the
timeline's playhead to the workbench scrub-controls UI surface.
Audio cues fire only when the user's interaction produces monotonic
forward time progression; backwards scrub, jump-to-beat, hydration,
and direct seek do not fire cues.

- A direct `scene` target presents that scene's timeline for
  scrubbing.
- A `composition` target presents the first scene's timeline;
  following composition entries do not run.
- A `composition+scene` or `composition+index` target presents the
  resolved head scene's timeline, preserving the head entry's
  `range` / `behavior` overrides; following composition entries do
  not run.
- `beat=<label>` under `mode=scrub` IS honored as the initial
  cursor position. Unlike paused mode (where ADR-019 records "first
  frame wins"), scrub explicitly names beats as a navigation
  target ("to named beats"). The initial seek to the beat label
  is a direct seek, not monotonic forward play, so no cues fire
  for crossings during that initial seek; subsequent forward
  scrubbing past those crossings DOES fire cues.

The requirement says timeline controls and audio cues. Do not
implement scrub by skipping `create(ctx)`, by skipping
`timeline(ctx)`, or by short-circuiting the lifecycle. Scene setup
runs normally; the timeline-controls UI and the cue gate are
runner-side concerns delivered by future PRs alongside ADR-003 /
ADR-004.

## Required Constraints (preflight guardrails)

These are binding unless they are clearly wrong:

- Treat `mode=scrub` as a browser workbench/runtime mode under
  ADR-007, not a new authoring workflow.
- Scrub controls are UI over the existing timeline/beat/cue model.
  Do not create duplicate beat, marker, cue, or mode schemas.
- Audio cue eligibility belongs in the existing playback/cue
  scheduling layer (when ADR-004 lands), not in timeline control
  components.
- Cues fire only for normalized monotonic forward playback
  intervals. Reverse scrub, direct seek, jump-to-beat, drag
  preview, hydration, and resync must be silent.
- Scrub state is transient runtime state. Do not persist cursor,
  hover, selected beat, or inspection direction into authored
  performance data.

## Cross-Cutting Concerns To Reuse

- Existing `mode` parsing/routing/validation for `mode=scrub`.
- Existing timeline duration/time normalization and boundary
  clamping (when ADR-003's GSAP runner lands).
- Existing beat lookup/naming contract for named beat navigation.
- Existing playback clock/state machine and cue scheduler/audio
  service (when ADR-003 / ADR-004 land).
- Existing browser-safe error handling for invalid beat targets,
  invalid time values, and unavailable audio.
- Existing logging/observability conventions; avoid high-volume
  pointer-move logs.
- Existing frontend test harness for controls and playback
  behavior.
- Repo workflow: update `CHANGELOG.md` only when source changes,
  and create IMPLEMENTS/TESTS traceability links only after
  implementation satisfies PUL-F017.

## Gotchas And Anti-Patterns

- Do not fire cues from React/component event handlers (when a
  controls UI lands).
- Do not scatter `if (mode === 'scrub')` cue suppression across
  unrelated code.
- Do not treat beat labels as separate UI-only data.
- Do not replay skipped cues after a seek or beat jump.
- Do not rebuild the audio graph on every scrub movement (when
  ADR-004 lands).
- Use epsilon-aware time comparisons when the GSAP runner lands;
  floating point jitter must not create duplicate cue fires.
- Throttle pointer-driven timeline updates through existing UI
  patterns to avoid render storms (when a controls UI lands).

## Non-Goals And Boundaries

- No new persistence format.
- No new timeline, beat, cue, exception, validation, or workflow
  abstraction unless existing contracts are genuinely absent.
- No authoring/editing of beats or cues.
- No production analytics expansion unless the project already has
  safe telemetry for comparable playback events.
- No timeline-controls UI in this PR — that surface ships with
  ADR-003's GSAP runner and a transport API on the runner.
- No real audio cue gating in this PR — that ships with ADR-004's
  audio engine.
