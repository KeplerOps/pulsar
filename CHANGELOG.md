# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `docs/adrs/023-presenter-controls.md` — records the PUL-F020
  contract layer for presenter input under `mode=present`. Defines
  the workbench-supplied long-lived `PresenterCommandSource`, the
  per-navigation `PresenterController` the loader builds when
  `effectiveMode === 'present'` AND a source is supplied, and the
  forwarding through the bridge → resolver chain to every scene's
  run input (NOT head-only — mode=present runs the full slice and
  presenter commands act on whichever scene is active). Per-handler
  exception isolation, boundary validation against
  `PRESENTER_COMMAND_KINDS`, and abort-tied auto-cleanup are the
  three safety properties pinned in tests today. PUL-F020 stays
  DRAFT until a real presenter UI surface (keyboard listener /
  on-screen controls) and a runner that translates commands into
  GSAP transport calls (ADR-003) land with end-to-end tests. See
  ADR-023 for the loader-side dispatch rationale, the
  not-head-only forwarding decision, the safety-property derivation,
  and the DRAFT → ACTIVE transition criteria. Indexed in
  `docs/adrs/README.md`.
- `src/runtime/presenter.ts` — new module exporting
  `PRESENTER_COMMAND_KINDS`, `PresenterCommand`,
  `PresenterCommandKind`, `PresenterCommandSource`,
  `PresenterController`, `isPresenterCommand`, and
  `createPresenterController`. The factory wraps a long-lived
  source in a per-navigation controller bound to an `AbortSignal`:
  every subscription is tracked so the abort listener detaches
  them all on navigation end, preventing subscription leaks across
  navigations even when a runner forgets to unsubscribe. Validates
  incoming command payloads at the boundary; unknown kinds are
  dropped with an `onError` diagnostic rather than reaching the
  runner. Per-handler exceptions are isolated through the same
  `onError` so a buggy subscriber cannot poison emissions for
  siblings.
- `src/runtime/composition-resolver.ts` — `SceneTimelineRunInput`
  gains optional `presenter?: PresenterController`;
  `ResolveCompositionOptions` gains optional
  `presenter?: PresenterController`. Forwarded to EVERY scene's
  run input (NOT head-only) — `mode=present` is the only mode that
  runs the full composition slice, and presenter commands act on
  whichever scene is currently active. `runScene` wraps the
  navigation-level controller in a per-scene child controller bound
  to a per-scene `AbortController` that fires after the scene's
  `cleanup(ctx)` completes; a runner that subscribes during scene-A
  and forgets to unsubscribe cannot leak its handler into scene-B
  because the per-scene wrapper is torn down before scene-B's
  `runTimeline` is invoked. The wrapper is built only when a
  navigation controller is supplied (no per-scene cost for non-
  present-mode navigations).
- `src/runtime/scene-navigation.ts` —
  `LoadSceneNavigationTargetOptions` gains optional
  `presenter?: PresenterController`. Forwarded to
  `resolveComposition` via the existing spread-when-defined
  pattern. The bridge does NOT truncate the slice when `presenter`
  is supplied — `presenter` is independent of the four head-only
  runner-input hints (`repeat` / `hold` / `cueGate` /
  `screenshot`), and mode=present has no head-only structural
  promise to defend.
- `src/runtime/scene-loader.ts` — `SceneLoaderOptions` gains
  optional `presenterCommands?: PresenterCommandSource`. When
  `effectiveMode(target) === 'present'` AND the source is supplied,
  `buildLoad` constructs a `PresenterController` via
  `createPresenterController(source, controller.signal, onError)`
  and passes it to `loadSceneNavigationTarget` as `presenter`.
  Other modes never see the controller; the source is not
  subscribed under any non-present mode (the loader does not even
  build the controller). Mode-scoping is centralized at this
  single call site so the rule "presenter input only under
  mode=present" has one enforcement point.
- `src/main.ts` — placeholder behavior: `presenterCommands` is
  intentionally OMITTED. Production reaches the loader's
  graceful-degradation path; runners see `input.presenter ===
  undefined`. ADR-023 records the DRAFT → ACTIVE bar (presenter UI
  module + GSAP runner that translates commands to transport
  calls + end-to-end tests).
- `docs/design/pul-f020-presenter-controls-preflight.md` — codex
  preflight design context naming the boundary, required reuse,
  guardrails, non-goals, and anti-patterns for PUL-F020. Authored
  manually (the local-write path of the preflight call failed) but
  carries the architectural guardrails from the codex summary
  verbatim (mode=present scoping, GSAP transport calls, no
  per-scene keyboard listeners, no scrub coupling, no broadening
  hold into pause/resume).
- `tests/runtime/presenter.test.ts` — pure-module tests for the
  new `presenter.ts` module: `PRESENTER_COMMAND_KINDS` shape,
  `isPresenterCommand` validation surface (every kind, every
  rejection case), `createPresenterController` source-forwarding,
  unsubscribe, abort-tied teardown (including pre-aborted signal),
  post-abort no-op subscribe, unknown-kind drop with onError
  diagnostic, no-handler emission, sibling isolation under handler
  exception.
- `tests/runtime/composition-resolver.test.ts` — new
  `'URL present-mode runner presenter forwarding (PUL-F020)'`
  describe block: every-scene forwarding (NOT head-only) for
  multi-scene plans, omission when absent (no `'presenter' in
  input` key), runner-ignores graceful degradation, independence
  from `signal` and the head-only hints (every channel reaches the
  runner without coupling).
- `tests/runtime/scene-navigation.test.ts` — new
  `'URL present-mode presenter forwarding (PUL-F020)'` describe
  block: single-scene + composition forwarding, NOT-head-only
  forwarding across composition entries, no slice truncation when
  `presenter` is supplied, omission when absent.
- `tests/runtime/scene-loader.test.ts` — new
  `'presenter-controls dispatch (PUL-F020 / ADR-023)'` describe
  block: `mode=present` forwarding (single-scene + composition,
  every-scene), absent-mode forwarding (defaults to present per
  PUL-F012 / ADR-007), per-mode negative coverage (every
  non-present mode does not subscribe the source even when one is
  supplied; `prompter` vacuously satisfies via lifecycle bypass),
  no-source graceful degradation, every-kind delivery (advance /
  hold / skip-forward / skip-backward), abort-detaches-subscription
  across a presenter-driven supersede, cleanup-before-handoff
  invariant under presenter-driven supersede (the "interruptible
  without breaking timeline state" clause), unknown-kind drop with
  onError diagnostic, no preemptive `data-pulsar-mode-*`
  attribute under `mode=present` even when a presenter source is
  supplied.
- `docs/adrs/022-workbench-mode-prompter.md` — records the PUL-F019
  contract layer for `mode=prompter`. Structurally distinct from
  the other six workbench modes: the loader BYPASSES the resolver
  lifecycle entirely under `mode=prompter` (no preload, no
  `create`, no `timeline`, no `cleanup`), so visual rendering is
  suppressed by construction rather than by runner conformance.
  The captions data path runs in its place — the loader aggregates
  captions from the addressed scene OR the FULL composition slice
  (NOT truncated to head; the truncation defense F015–F018 use
  does not apply because there is no runner-side promise to
  defend) and hands the resulting `PrompterScript` to a new
  optional `renderPrompter` adapter. PUL-F019 stays DRAFT until a
  captions/script UI surface lands and renders the script visibly
  with end-to-end tests. See ADR-022 for the URL contract, the
  lifecycle-bypass rationale, the captions-aggregation seam, and
  the DRAFT → ACTIVE transition criteria. Indexed in
  `docs/adrs/README.md`.
- `src/runtime/prompter.ts` — new module exporting
  `PrompterScriptEntry`, `PrompterScript`, `PrompterRenderer`, and
  `buildPrompterScript`. Pure function over a
  `SceneNavigationTarget`; reads `scene.captions` from the
  registered scene module (object-form composition entries'
  `range` / `behavior` overrides are runner-side concerns and do
  NOT alter caption content). Returns a deep-frozen script so a
  misbehaving renderer cannot corrupt the next navigation's view.
- `src/runtime/scene-loader.ts` — `SceneLoaderOptions` gains
  optional `renderPrompter?: PrompterRenderer`. When
  `effectiveMode(target) === 'prompter'`, the loader runs a
  separate dispatch path: validates via `resolveSceneNavigation`
  (composition errors still surface — no silent fallback), sets
  `data-pulsar-scene-target` and (composition variants)
  `data-pulsar-composition-target`, builds the
  `PrompterScript`, and hands it to the renderer with the per-
  navigation abort signal. The lifecycle adapters (`createPreloader`,
  `buildCtx`, `runTimeline`) and scene hooks (`create` / `timeline`
  / `cleanup`) are NOT invoked. The slice-truncation helper
  `applySingleSceneSlice` does NOT run under prompter (the captions
  view consumes the full slice). Cleanup-before-handoff and
  latest-event supersession still apply to prompter dispatch via
  the existing serialized queue.
- `src/main.ts` — placeholder `renderPrompter` adapter that parks
  until the per-navigation abort signal fires (mirrors the
  placeholder timeline runner). Until the captions/script UI
  surface lands, the placeholder produces no visible output;
  visual-rendering suppression is delivered structurally by the
  loader's lifecycle bypass, not by this adapter.
- `tests/runtime/prompter.test.ts` — pure-function tests for
  `buildPrompterScript`: single-scene target, full composition
  slice, composition+scene non-head, object-form entry with
  overrides, empty captions, deep-frozen output, no source
  mutation.
- `tests/runtime/scene-loader.test.ts` — new
  `'prompter-mode caption-view dispatch (PUL-F019)'` describe
  block pinning lifecycle suppression (zero preloader / buildCtx /
  runner / scene-hook invocations), full-slice captions
  aggregation (NOT truncated), single-scene + composition variants,
  `renderPrompter` not invoked for non-prompter modes,
  stage-attrs preserved, no `data-pulsar-mode-*` preemptive
  attribute, composition validation errors still surface,
  graceful degradation when `renderPrompter` is omitted, renderer
  abort under supersession, cleanup-before-handoff across the
  present→prompter boundary, and `kind: 'none'` no-renderer
  invariant. Existing PUL-F012 mode-dispatch tests gain a
  complementary `does NOT invoke buildCtx when target.mode is
  "prompter"` case to pin the lifecycle-bypass invariant on
  PUL-F012's seam.
- `docs/adrs/021-workbench-mode-screenshot.md` and
  `docs/design/pul-f018-screenshot-mode-preflight.md` — record the
  PUL-F018 contract layer for `mode=screenshot`. Single-scene
  execution at the addressed head (parallel to `standalone`,
  `loop`, `paused`, and `scrub`); a runner-side capture-bundle
  hint (`screenshot: 'capture'`) for runners that own the timeline,
  audio, and randomness paths to deliver the four-axis bundle —
  frame freeze at `input.beat` (or 0), no animation in progress,
  all audio suppressed, deterministic randomness — under
  screenshot capture. Beat is honored as the captured-frame anchor
  (unlike `mode=paused` where ADR-019 records "first frame wins"),
  matching PUL-F018's "at the addressed beat (or first frame if no
  beat)." See ADR-021 for the URL contract, the runner conformance
  bar, the single-scene scope rationale, the bundle-vs-fragmented-
  fields rationale, and the DRAFT → ACTIVE transition criteria.
  Indexed in `docs/adrs/README.md`.
- `src/runtime/composition-resolver.ts` —
  `SceneTimelineRunInput` gains optional
  `screenshot?: 'capture'` and `ResolveCompositionOptions` gains
  optional `headScreenshot?: 'capture'`. The resolver forwards
  `headScreenshot` to plan[0]'s run input only (head-only,
  parallel to `headBeat`, `headRepeat`, `headHold`, and
  `headCueGate`); subsequent scenes never receive `screenshot`.
  Literal-typed union for future variant extension.
- `src/runtime/scene-navigation.ts` —
  `LoadSceneNavigationTargetOptions` gains optional
  `screenshot?: 'capture'`; `loadSceneNavigationTarget()` forwards
  it to `resolveComposition` as `headScreenshot`. The bridge
  truncates a composition slice to its addressed head when
  `screenshot` is supplied (the `truncateToHead` predicate widens
  to fire when ANY of `repeat` / `hold` / `cueGate` / `screenshot`
  is supplied), layered with the loader's `applySingleSceneSlice`.
- `src/runtime/scene-loader.ts` — when
  `effectiveMode(target) === 'screenshot'`, the loader passes
  `screenshot: 'capture'` through the bridge; non-screenshot modes
  leave the key absent (key-presence semantics). The single-scene-
  execution helper that landed for `standalone`, `loop`, `paused`,
  and `scrub` is widened to include `screenshot`.
- `src/main.ts` — placeholder timeline runner docstring
  acknowledges `input.screenshot`. The placeholder has no real
  timeline, no audio engine, and no scene-side randomness, so it
  vacuously satisfies the bundle (no animation runs, no audio
  fires, no random source exists).
- `tests/runtime/composition-resolver.test.ts`,
  `tests/runtime/scene-navigation.test.ts`, and
  `tests/runtime/scene-loader.test.ts` — new
  `'... screenshot-mode … capture-hint … forwarding (PUL-F018)'`
  describe blocks pinning the resolver, bridge, and loader
  behavior: head-only delivery, key-presence semantics, no
  contamination under non-screenshot modes, slice truncation,
  cleanup-once, the `ctx.mode === 'screenshot'` seam across all
  four locator shapes, beat / screenshot independence (and
  beat-honoring under screenshot), composition validation
  invariants, stage attribute behavior, and `range` / `behavior`
  preservation through the truncated slice.

PUL-F018 stays DRAFT after this PR; the issue ↔ requirement link
is `DOCUMENTS` per the ADR-016 / ADR-017 / ADR-018 / ADR-019 /
ADR-020 precedent. ACTIVE transitions when ADR-003's GSAP runner
honoring `input.screenshot` + ADR-004's audio engine producing
silence under screenshot + a deterministic-randomness convention
all land with end-to-end tests (see ADR-021).
- `docs/adrs/020-workbench-mode-scrub.md` and
  `docs/design/pul-f017-scrub-mode-preflight.md` — record the
  PUL-F017 contract layer for `mode=scrub`. Single-scene execution
  at the addressed head (parallel to `standalone`, `loop`, and
  `paused`); a runner-side cue-gate hint
  (`cueGate: 'monotonic-forward'`) for runners with an audio-cue
  subsystem to gate cue firing to monotonic forward playback only.
  See ADR-020 for the URL contract, the runner conformance bar,
  the single-scene scope rationale, and the DRAFT → ACTIVE
  transition criteria. Indexed in `docs/adrs/README.md`.
- `src/runtime/composition-resolver.ts` —
  `SceneTimelineRunInput` gains optional
  `cueGate?: 'monotonic-forward'` and `ResolveCompositionOptions`
  gains optional `headCueGate?: 'monotonic-forward'`. The resolver
  forwards `headCueGate` to plan[0]'s run input only (head-only,
  parallel to `headBeat`, `headRepeat`, and `headHold`); subsequent
  scenes never receive `cueGate`. Literal-typed union for future
  variant extension.
- `src/runtime/scene-navigation.ts` —
  `LoadSceneNavigationTargetOptions` gains optional
  `cueGate?: 'monotonic-forward'`;
  `loadSceneNavigationTarget()` forwards it to
  `resolveComposition` as `headCueGate`. The bridge truncates a
  composition slice to its addressed head when `cueGate` is
  supplied (the `truncateToHead` predicate widens to fire when ANY
  of `repeat` / `hold` / `cueGate` is supplied), layered with the
  loader's `applySingleSceneSlice`.
- `src/runtime/scene-loader.ts` — when
  `effectiveMode(target) === 'scrub'`, the loader passes
  `cueGate: 'monotonic-forward'` through the bridge; non-scrub
  modes leave the key absent (key-presence semantics). The
  single-scene-execution helper that landed for `standalone`,
  `loop`, and `paused` is widened to include `scrub`.
- `src/main.ts` — placeholder timeline runner docstring
  acknowledges `input.cueGate`. The placeholder has no audio-cue
  subsystem so it trivially satisfies the gate (no cues to fire).
- `tests/runtime/composition-resolver.test.ts`,
  `tests/runtime/scene-navigation.test.ts`, and
  `tests/runtime/scene-loader.test.ts` — new
  `'... scrub-mode … cue-gate … forwarding (PUL-F017)'` describe
  blocks pinning the resolver, bridge, and loader behavior:
  head-only delivery, key-presence semantics, no contamination
  under non-scrub modes, slice truncation, cleanup-once, the
  `ctx.mode === 'scrub'` seam across all four locator shapes,
  beat / cueGate independence, composition validation invariants,
  stage attribute behavior, and `range` / `behavior` preservation
  through the truncated slice.

PUL-F017 stays DRAFT after this PR; the issue ↔ requirement link
is `DOCUMENTS` per the ADR-016 / ADR-017 / ADR-018 / ADR-019
precedent. ACTIVE transitions when ADR-003's GSAP runner +
ADR-004's audio engine + a workbench scrub-controls UI surface
all land with end-to-end tests (see ADR-020).
- `docs/adrs/019-workbench-mode-paused.md` — records the PUL-F016
  contract: under `mode=paused` the loader truncates the validated
  composition slice to the addressed head entry (parallel to
  `standalone` per ADR-017 and `loop` per ADR-018) and passes
  `hold: 'first-frame'` through the bridge / resolver to that head's
  timeline-runner input, where the runner is responsible for
  pinning the timeline at time 0 (e.g. ADR-003's future GSAP runner
  uses `timeline.seek(0)` + `timeline.pause()`). Slice truncation
  makes "no following entries run" a structural guarantee — a
  runner that ignores the `hold` hint cannot silently degrade
  paused into normal composition playback. The single-scene-execution
  helper ADR-017 introduced and ADR-018 extended is widened again
  (`applySingleSceneSlice`) to fire under `paused`; the SHAPE
  transform is shared between `standalone`, `loop`, and `paused`,
  the runner-side semantic differences (`input.repeat` vs
  `input.hold` vs neither) are what differentiate them. Composition
  validation runs first, so unregistered compositions / unknown
  member scenes / out-of-range indexes still surface as navigation
  errors. The hint is head-only — following composition entries do
  not receive `hold`, parallel to PUL-F011 / ADR-015's `headBeat`
  and PUL-F015 / ADR-018's `headRepeat`. ADR-019 also records the
  runner-side policy that `hold` wins over `beat` when both are
  set under `mode=paused` (paused is layout/styling inspection;
  `mode=scrub` is the appropriate mode for beat-targeted timeline
  inspection); the loader does NOT strip `beat` when `mode=paused`
  is set — the policy is a runner contract, not a loader-side
  filter. The loader → runner contract IS materially shipped; the
  seam (`ctx.mode === 'paused'` reaches every lifecycle hook of the
  head scene) is pinned. The actual hold-at-first-frame behavior
  depends on ADR-003's GSAP runner, which is not yet implemented;
  the placeholder runner has no real timeline and parks until
  abort, vacuously satisfying the requirement. Following the
  ADR-016 / ADR-017 / ADR-018 precedent, PUL-F016 stays DRAFT and
  the issue ↔ requirement link is `DOCUMENTS`; ACTIVE transitions
  when the GSAP runner lands and actively reads `input.hold ===
  'first-frame'`, with an end-to-end test alongside the seam tests
  in this PR. Indexed in `docs/adrs/README.md`.
- `docs/design/pul-f016-paused-mode-preflight.md` — codex
  architecture preflight design context for PUL-F016. Names the
  cross-cutting concerns to reuse (`NAVIGATION_MODES`,
  `effectiveMode()`, `parseNavigationSearch()`,
  `resolveSceneNavigation()`, `loadSceneNavigationTarget()`,
  `resolveComposition()`, `createAssetPreloader()`,
  `describeError()`, the per-navigation `AbortController`, and the
  shared `applySingleSceneSlice` / `truncateToHead` helpers) and
  the anti-patterns to avoid (per-scene `if (mode === 'paused')`
  branches, raw `setTimeout` / `requestAnimationFrame` /
  CSS-keyframe / canvas-loop / autoplay-audio in `create(ctx)`
  that bypass runtime pause control, lifecycle short-circuits that
  skip `create(ctx)` or `timeline(ctx)`, conflating paused with
  screenshot or scrub, persisting paused state outside the URL,
  stripping `beat=` at the loader when `mode=paused` is set). The
  document records that codex's sandbox was unable to write design
  files during preflight (`bwrap: loopback: Failed RTM_NEWADDR`),
  so the guardrails are preserved verbatim from the preflight
  tool's returned summary.
- `src/runtime/composition-resolver.ts` —
  `SceneTimelineRunInput` gains optional `hold?: 'first-frame'` and
  `ResolveCompositionOptions` gains optional `headHold?:
  'first-frame'`. The resolver forwards `headHold` to plan[0]'s
  run input only (head-only, parallel to `headBeat` and
  `headRepeat`); subsequent scenes never receive `hold`. The
  literal-typed union lets future hold semantics extend without
  breaking existing runners.
- `src/runtime/scene-navigation.ts` —
  `LoadSceneNavigationTargetOptions` gains optional `hold?:
  'first-frame'`; `loadSceneNavigationTarget()` forwards the
  option to `resolveComposition` as `headHold` (parallel to how
  `repeat` becomes `headRepeat`). `hold`, `repeat`, and `beat` are
  independent — a programmatic caller can supply any combination,
  and the runner's policy decides which wins when more than one
  reaches its input. The bridge ALSO truncates a composition slice
  to its addressed head when `hold` is supplied (the previous
  `truncateForRepeat` helper is renamed to a shared `truncateToHead`
  predicate that fires when EITHER `repeat` or `hold` is supplied)
  — a structural defense layered with the loader's
  `applySingleSceneSlice` so direct bridge callers (test harnesses,
  future export pipelines) get the same paused-mode single-scene-
  execution guarantee. The two truncations are idempotent.
- `src/runtime/scene-loader.ts` — when
  `effectiveMode(target) === 'paused'`, the loader passes
  `hold: 'first-frame'` through `loadSceneNavigationTarget()`.
  Other modes (and a `mode`-less URL) leave the key absent on the
  runner input — key-presence semantics, parallel to `beat` /
  `repeat` / `range` / `behavior`. Mode dispatch lives at the
  loader, the same place PUL-F012 derives `ctx.mode` and PUL-F015
  derives `repeat`. The single-scene-execution helper that landed
  for `standalone` (ADR-017) and `loop` (ADR-018) is widened to
  also include `paused`, truncating the validated composition
  slice to the addressed head entry under any of the three modes
  (per ADR-019: structural defense against a runner that ignores
  the `hold` hint).
- `src/main.ts` — placeholder timeline runner docstring
  acknowledges `input.hold`. The placeholder ignores the hint;
  parking until abort vacuously satisfies "hold at first frame
  without advancing" because no frame ever advances. ADR-003's
  GSAP runner will read the hint and call `timeline.pause()`.
- `tests/runtime/composition-resolver.test.ts` — new
  `'URL paused-mode runner hold-hint forwarding (PUL-F016)'`
  describe block (4 tests) pinning `headHold` head-only delivery,
  key-presence semantics, resolver no-op on the value, and
  independent forwarding alongside `headBeat` and `headRepeat`.
- `tests/runtime/scene-navigation.test.ts` — new `'URL paused-mode
  hold forwarding (PUL-F016)'` describe block under
  `loadSceneNavigationTarget` (5 tests) pinning the bridge's
  `hold` → `headHold` plumbing for single-scene targets, key
  absence when option omitted, independence from `beat` and
  `repeat`, bridge-level slice truncation under `hold` (the
  structural defense added in response to the same codex pre-push
  review reasoning ADR-018 records for `repeat`), and that
  non-paused composition navigation still runs the full slice.
- `tests/runtime/scene-loader.test.ts` — new `'paused-mode runner
  hold-hint forwarding (PUL-F016)'` describe block pinning every
  clause of PUL-F016 under `mode=paused`:
  - `hold: 'first-frame'` on the head scene's runner input for a
    `scene` target.
  - Slice truncation under `composition` and `composition+scene`
    targets — only the head runs, with `hold: 'first-frame'`
    on its runner input. Non-final-index navigations are used so
    a regression that dropped truncation would observe successor
    entries running.
  - cleanup runs exactly once for the head scene under
    `mode=paused`, never for dropped slice entries (parallel to
    ADR-017 / ADR-018).
  - Key absence on the runner input when `mode` is unset.
  - No `hold` for any non-paused mode (six modes walked from
    `NAVIGATION_MODES`).
  - `ctx.mode === 'paused'` exposed to every lifecycle hook of the
    head scene under all four locator shapes.
  - `beat=` forwarding alongside `hold` under `mode=paused` with
    the non-fatal missing-label diagnostic preserved (the loader
    forwards both; the runner's "first frame wins" policy decides
    which wins at the runner contract).
  - No `data-pulsar-mode-*` suppression attribute is preemptively
    written (parity with ADR-016 / ADR-017 / ADR-018).
  - Stage attrs `data-pulsar-scene-target` AND
    `data-pulsar-composition-target` both set when URL named a
    composition under paused (preserves observability of what the
    URL addressed).
  - Composition-not-registered, composition-member-not-found, and
    index-out-of-range errors STILL surface under `mode=paused`
    (no silent fallback to direct scene lookup).
  - Object-form head entry's `range` and `behavior` overrides reach
    the runner unchanged through the truncated slice alongside
    `hold` — paused is single-scene-mount with held timeline at
    the head, NOT direct-scene flattening.
  - A hold-until-abort runner under `mode=paused` keeps the head
    scene mounted until a new navigation supersedes it; cleanup
    fires only on abort, not on `hold` arrival. Pins the
    runner-side pending-until-abort contract through the
    loader+resolver+navigation flow so a regression that made the
    resolver bypass `runTimeline` under `hold`, or that dropped
    signal forwarding to the runner under paused, would fail
    here. Codex pre-push review (cycle 2) flagged that the
    cleanup-once test alone — using a synchronous `noopRunner` —
    would not catch a runner that resolved immediately after
    `seek(0) + pause()` and unmounted the scene one turn after
    mount; this test is the structural defense for that bug
    class. ADR-019's two-part runner contract (freeze the
    timeline at time 0 AND keep the runner promise pending until
    abort) is what the future GSAP runner PR will additionally
    pin end-to-end against a real timeline.
- `docs/adrs/018-workbench-mode-loop.md` — records the PUL-F015
  contract: under `mode=loop` the loader truncates the validated
  composition slice to the addressed head entry (parallel to
  `standalone` per ADR-017) and passes `repeat: 'until-aborted'`
  through the bridge / resolver to that head's timeline-runner input,
  where the runner is responsible for restarting the timeline on
  completion (e.g. ADR-003's future GSAP runner uses
  `timeline.repeat(-1)`). Slice truncation makes "no following
  entries run" a structural guarantee — a runner that ignores the
  `repeat` hint cannot silently degrade loop into normal composition
  playback. The single-scene-execution helper ADR-017 introduced is
  generalized (`applySingleSceneSlice`); the SHAPE transform is
  shared between `standalone` and `loop`, the runner-side semantic
  difference (`input.repeat`) is what differentiates them.
  Composition validation runs first, so unregistered compositions /
  unknown member scenes / out-of-range indexes still surface as
  navigation errors. The hint is head-only — following composition
  entries do not receive `repeat`, parallel to PUL-F011 / ADR-015's
  `headBeat` plumbing (and structurally vacuous under truncation,
  but pinned in the resolver / bridge tests for layered correctness).
  The loader → runner contract IS materially shipped; the seam
  (`ctx.mode === 'loop'` reaches every lifecycle hook of the head
  scene) is pinned. The actual restart-on-completion behavior depends
  on ADR-003's GSAP runner, which is not yet implemented; the
  placeholder runner has no real timeline and parks until abort,
  vacuously satisfying the requirement. Following the ADR-016 /
  ADR-017 precedent, PUL-F015 stays DRAFT and the issue ↔ requirement
  link is `DOCUMENTS`; ACTIVE transitions when the GSAP runner lands
  and actively reads `input.repeat === 'until-aborted'`, with an
  end-to-end test alongside the seam tests in this PR. Indexed in
  `docs/adrs/README.md`.
- `docs/design/pul-f015-loop-mode-preflight.md` — codex
  architecture preflight design context for PUL-F015. Names the
  cross-cutting concerns to reuse (`NAVIGATION_MODES`,
  `effectiveMode()`, `parseNavigationSearch()`,
  `resolveSceneNavigation()`, `loadSceneNavigationTarget()`,
  `resolveComposition()`, `createAssetPreloader()`,
  `describeError()`, the per-navigation `AbortController`) and the
  anti-patterns to avoid (composition-wide looping, scene-lifecycle
  re-run on iteration, recursive `handle()` from the runner,
  `setInterval` / polling / sleeps, manifest-mutation looping,
  persisting loop state outside the URL).
- `src/runtime/composition-resolver.ts` —
  `SceneTimelineRunInput` gains optional `repeat?: 'until-aborted'`
  and `ResolveCompositionOptions` gains optional
  `headRepeat?: 'until-aborted'`. The resolver forwards `headRepeat`
  to plan[0]'s run input only (head-only, parallel to `headBeat`);
  subsequent scenes never receive `repeat`. The literal-typed union
  lets future repeat semantics extend without breaking existing
  runners.
- `src/runtime/scene-navigation.ts` —
  `LoadSceneNavigationTargetOptions` gains optional `repeat?:
  'until-aborted'`; `loadSceneNavigationTarget()` forwards the
  option to `resolveComposition` as `headRepeat` (parallel to how
  `beat` becomes `headBeat`). `repeat` and `beat` are independent —
  a URL like `?scene=x&mode=loop` (no beat) and
  `?scene=x&beat=hook&mode=loop` (beat + loop) are both valid. The
  bridge ALSO truncates a composition slice to its addressed head
  when `repeat` is supplied (`truncateForRepeat`) — a structural
  defense layered with the loader's `applySingleSceneSlice` so
  direct bridge callers (test harnesses, future export pipelines)
  get the same loop-mode single-scene-execution guarantee. The two
  truncations are idempotent.
- `src/runtime/scene-loader.ts` — when
  `effectiveMode(target) === 'loop'`, the loader passes
  `repeat: 'until-aborted'` through `loadSceneNavigationTarget()`.
  Other modes (and a `mode`-less URL) leave the key absent on the
  runner input — key-presence semantics, parallel to `beat` /
  `range` / `behavior`. Mode dispatch lives at the loader, the same
  place PUL-F012 derives `ctx.mode`. The single-scene-execution
  helper that landed for `standalone` (ADR-017) is generalized to
  `applySingleSceneSlice` and now runs for both `standalone` and
  `loop`, truncating the validated composition slice to the
  addressed head entry under either mode (per ADR-018: structural
  defense against a runner that ignores the `repeat` hint).
- `src/main.ts` — placeholder timeline runner docstring
  acknowledges `input.repeat`. The placeholder ignores the hint;
  parking until abort vacuously satisfies "restart on completion"
  because no completion ever fires. ADR-003's GSAP runner will read
  the hint and apply native repeat semantics.
- `tests/runtime/composition-resolver.test.ts` — new
  `'URL loop-mode runner repeat-hint forwarding (PUL-F015)'`
  describe block (4 tests) pinning `headRepeat` head-only delivery,
  key-presence semantics, resolver no-op on the value, and
  independent forwarding alongside `headBeat`.
- `tests/runtime/scene-navigation.test.ts` — new `'URL loop-mode
  repeat forwarding (PUL-F015)'` describe block under
  `loadSceneNavigationTarget` pinning the bridge's `repeat` →
  `headRepeat` plumbing for single-scene targets, key absence when
  option omitted, independence from `beat`, bridge-level slice
  truncation under `repeat` (the structural defense added in
  response to codex pre-push review), and that non-loop composition
  navigation still runs the full slice.
- `tests/runtime/scene-loader.test.ts` — new `'loop-mode runner
  repeat-hint forwarding (PUL-F015)'` describe block pinning every
  clause of PUL-F015 under `mode=loop`:
  - `repeat: 'until-aborted'` on the head scene's runner input for
    a `scene` target.
  - Slice truncation under `composition` and `composition+scene`
    targets — only the head runs, with `repeat: 'until-aborted'`
    on its runner input. Non-final-index navigations are used so
    a regression that dropped truncation would observe successor
    entries running.
  - cleanup runs exactly once for the head scene under `mode=loop`,
    never for dropped slice entries (parallel to ADR-017).
  - Key absence on the runner input when `mode` is unset.
  - No `repeat` for any non-loop mode (six modes walked).
  - `ctx.mode === 'loop'` exposed to every lifecycle hook of the
    head scene under all four locator shapes.
  - `beat=` forwarding alongside `repeat` under `mode=loop` with
    the non-fatal missing-label diagnostic preserved.
  - No `data-pulsar-mode-*` suppression attribute is preemptively
    written (parity with ADR-016 / ADR-017).
  - Composition-not-registered, composition-member-not-found, and
    index-out-of-range errors STILL surface under `mode=loop` (no
    silent fallback to direct scene lookup).
  - Object-form head entry's `range` and `behavior` overrides reach
    the runner unchanged through the truncated slice alongside
    `repeat` — loop is single-scene-timeline repeat at the head,
    NOT direct-scene flattening.
- `docs/adrs/017-workbench-mode-standalone.md` — records the
  PUL-F014 contract: under `mode=standalone` the loader truncates
  the validated composition slice from `resolveSceneNavigation()`
  to a one-entry slice (the addressed head, preserved verbatim
  including object-form `range` / `behavior` overrides) and runs
  only the head scene's lifecycle. Composition validation still
  runs first, so unregistered compositions / unknown member scenes
  / out-of-range indexes still surface as navigation errors. The
  single-scene execution mechanism is materially shipped; the seam
  (`ctx.mode === 'standalone'` reaches every lifecycle hook of the
  head scene) is pinned. Surrounding chrome, audio-bed, and
  inter-scene-transition suppression — the three named surfaces
  that don't exist in the repo today — are deferred to the future
  workbench-shell / audio-service / GSAP runner requirements that
  will land them. Following the ADR-016 precedent, PUL-F014 stays
  DRAFT and the issue ↔ requirement link is `DOCUMENTS`; ACTIVE
  transitions when each surface actively reads
  `ctx.mode === 'standalone'` and suppresses, with end-to-end
  tests alongside the seam tests in this PR. Indexed in
  `docs/adrs/README.md`.
- `docs/design/pul-f014-standalone-mode-preflight.md` — codex
  architecture preflight design context for PUL-F014. Names the
  cross-cutting concerns to reuse (`NAVIGATION_MODES`,
  `effectiveMode()`, `parseNavigationSearch()`,
  `resolveSceneNavigation()`, `loadSceneNavigationTarget()`,
  `resolveComposition()`, `createAssetPreloader()`,
  `describeError()`, the per-navigation `AbortController`) and the
  anti-patterns to avoid (second mode enum, `standalone` boolean,
  manifest-mutation slicing, CSS-hide-after-the-fact, all-audio
  suppression, persisting standalone state outside the URL).
- `tests/runtime/scene-loader.test.ts` — new
  `'standalone-mode single-scene execution (PUL-F014)'` describe
  block (13 tests) pinning every clause of PUL-F014 under
  `mode=standalone`:
  - Single-scene execution at the addressed head scene for
    `composition`, `composition+scene`, and `composition+index`
    locators (no following composition entries fire).
  - Direct `scene` target baseline parity (no slice to drop).
  - `beat=` forwarding to the head scene's runner with the
    non-fatal missing-label diagnostic preserved.
  - `ctx.mode === 'standalone'` exposed to every lifecycle hook of
    the head scene under all four locator shapes.
  - Stage attributes communicate what the URL ADDRESSED:
    `data-pulsar-scene-target` AND `data-pulsar-composition-target`
    are both set when the URL named a composition under standalone.
  - No `data-pulsar-mode-*` suppression attribute is preemptively
    written (parity with ADR-016 invariant for `present`).
  - Composition-not-registered, composition-member-not-found, and
    index-out-of-range errors STILL surface under `mode=standalone`
    (no silent fallback to direct scene lookup).
  - Object-form head entry's `range` and `behavior` overrides reach
    the runner unchanged — standalone is single-scene EXECUTION,
    not direct-scene flattening.
  - Cleanup runs exactly once for the head scene, never for dropped
    slice entries.
- `.github/workflows/ci.yml` — `osv-scan` blocking job. Installs
  the OSV-Scanner CLI binary directly (release `v2.3.8`, pinned by
  SHA256 against `osv-scanner_SHA256SUMS`), scans the root
  `pnpm-lock.yaml`, emits JSON, and uploads it as the `osv-results`
  workflow artifact (7-day retention). Vulnerability findings are
  a hard gate: exit code 1 (vulns found) emits a GitHub `::error::`
  annotation and fails the job. Scanner/tooling errors (any other
  non-zero exit) also fail. The artifact is uploaded on every
  outcome so triage can proceed from the failed run. Permissions
  are scoped to `contents: read` only — JSON output avoids the
  `security-events: write` expansion SARIF would require. Coexists
  with `dependency-audit` (`pnpm audit --prod`), `gitleaks`, and
  SonarCloud; none are weakened. Boundary and guardrails captured
  in `docs/design/issue-078-osv-scanner-preflight.md`. To enforce
  the gate at merge time, mark the `OSV-Scanner` check as required
  on `main` and `dev` branch protection rules.

### Changed

- `tests/runtime/scene-loader.test.ts` — F015 / F016 / F017 / F018
  negative-mode loops (`does not set <hint> for any non-<mode>
  mode`) renamed `... lifecycle-running mode` and scoped to
  exclude `prompter` alongside the target mode. PUL-F019's
  loader-side lifecycle bypass means the runner is not invoked
  under `mode=prompter`, so prompter cannot appear in a runner-
  observation array. Behavior is unchanged for the six lifecycle-
  running modes; the rename plus inline comment makes the scope
  deliberate so a future maintainer does not reflexively add
  `prompter` back.
- `src/runtime/scene-loader.ts` — `runTarget` truncates the validated
  composition slice to a single entry — the addressed head — when
  `effectiveMode(target) === 'standalone'` AND
  `resolved.composition !== undefined`. The truncation preserves the
  head entry verbatim (object-form `{ id, range, behavior }` entries
  stay object-form), so the runner receives `range` / `behavior`
  overrides unchanged; following entries are dropped, so no
  inter-scene transition runs and no later scene's lifecycle fires.
  Validation still runs first via `resolveSceneNavigation()`, so a
  malformed standalone target surfaces as a navigation error, not a
  silent direct scene fallback. Stage attrs continue to record both
  `data-pulsar-scene-target` and `data-pulsar-composition-target` to
  preserve observability of what the URL addressed (PUL-F014 /
  ADR-017).
- `src/runtime/scene-loader.ts` — `SceneLoaderOptions.ctx: unknown`
  replaced with `SceneLoaderOptions.buildCtx: (mode: NavigationMode)
  => unknown`. The loader now derives the effective workbench mode
  per navigation via `effectiveMode(target)` and calls `buildCtx` to
  assemble the per-navigation scene context, so mode dispatch lives
  at the runtime-core seam ADR-007 names (PUL-F012). `WorkbenchSceneCtx`
  gained a `readonly mode: NavigationMode` field; the workbench's
  `buildCtx` populates it. Constructing ctx per navigation is the
  structural defense against ADR-007's "previous non-`present` mode
  leaks into a `mode`-less URL" risk: there is no long-lived ctx slot
  for mode to linger in. `buildCtx` is not invoked when the locator
  is `kind: 'none'`, on parse-error events, or when scene resolution
  fails — those paths run no lifecycle.
- `src/main.ts` — workbench bootstrap now passes `buildCtx: (mode) =>
  ({ stage, mode })` instead of a static ctx object. Type-checked
  against the updated `WorkbenchSceneCtx` so a missing `mode` field
  on a real ctx fails at compile time.
- `docs/adrs/007-browser-workbench.md` — added the URL-only-source
  invariant ("when `mode` is absent, the runtime selects the
  effective mode `present`; it must not recover mode from
  localStorage, sessionStorage, cookies, `history.state`, or prior
  in-memory navigation state") and the matching risk-table row for
  the leak case. PUL-F012 implementation expectation.
- `docs/adrs/013-url-navigation-grammar-boundary.md` — added the
  PUL-F012 paragraph spelling out the boundary contract: the parser
  preserves absent `mode` as absent on `NavigationTarget`; the
  runtime core derives effective `present` before dispatching mode
  behavior or exposing `ctx.mode` to scenes. Corresponding risk-table
  row added.
- `src/runtime/composition-resolver.ts` / `src/runtime/scene-navigation.ts`
  — both now reject `headBeat` / `beat` supplied without a paired
  `onBeatMissing` callback. PUL-F011 / ADR-015 makes the callback the
  runner's only error channel for missing labels (the runner MUST NOT
  throw — that triggers cleanup), so a beat without the diagnostic
  surface would silently lose missing-label errors. The resolver and
  bridge now fail fast at the boundary rather than running a doomed
  lifecycle. The error message names which option is missing.
- `src/runtime/scene-loader.ts` — `runTarget` refactored: the
  beat-grammar defense-in-depth check, the missing-beat callback
  builder, and the in-flight-load builder are now extracted helpers
  (`validateBeatGrammar`, `buildOnBeatMissing`, `buildLoad`).
  Behavior is unchanged; the function reads as a linear pipeline of
  `validate → resolve → mark-stage → build-load → await`. Reduces
  cognitive complexity below SonarCloud's 15-token cap.

### Added

- `docs/adrs/016-workbench-mode-present.md` — records the PUL-F013
  contract boundary and the seams future rendering / input surfaces
  will plug into. None of the four facets PUL-F013 names — render
  full chrome, audio, inter-scene transitions, and respond to
  presenter input — has a corresponding rendering / input surface in
  the repo today (chrome, audio, GSAP runner, presenter UI are all
  future deliverables). PUL-F013 today lands the contract layer plus
  test pinning of the seams those surfaces will plug into; ACTIVE
  transition is gated on every facet PUL-F013's statement names
  landing as a real rendering / input surface AND adding its own
  end-to-end test (chrome, audio, inter-scene transitions, presenter
  input — all four). Mirrors the ADR-015 / PUL-F011 precedent.
  Indexed in `docs/adrs/README.md`.
- `docs/design/pul-f013-present-mode-preflight.md` — codex
  architecture preflight design context for PUL-F013. Names the
  cross-cutting concerns to reuse (`NAVIGATION_MODES`,
  `effectiveMode()`, `loadSceneNavigationTarget()`,
  `createAssetPreloader()`, `describeError()`, the per-navigation
  `AbortController`) and the anti-patterns to avoid (duplicate mode
  enums, scene-owned chrome, transitions encoded as fake scenes,
  presenter UI calling scene `cleanup()` directly, persisting
  mode/target state outside the URL).
- `tests/runtime/scene-loader.test.ts` — new
  `'present-mode adapter seams (PUL-F013 boundary, NOT a PUL-F013
  implementation)'` describe block (6 tests) pinning the adapter
  seams the four future rendering / input surfaces will plug into:
  - Multi-scene composition under `mode=present` runs every scene's
    `create → timeline → cleanup` with cleanup-before-next-create
    ordering — the lifecycle hook ADR-003's GSAP runner will hang
    inter-scene transition rendering off (NOT transition rendering
    itself).
  - Identical multi-scene behavior when `mode` is absent — pins
    "present is the default."
  - Every lifecycle hook in two consecutive multi-scene navigations
    sees `ctx.mode === 'present'` — pins the mode hint chrome /
    audio surfaces will read.
  - Per-scene `AbortSignal` reaches the runner's `input.signal`
    under `mode=present` — pins the seam PUL-F020 will drive (NOT
    presenter input itself).
  - An in-flight abort under `mode=present` flips `signal.aborted`
    and triggers `cleanup(ctx)` on the active scene — pins the
    abort-to-cleanup connectedness end to end. The runner's
    signal-presence assertion runs before parking on the abort gate
    so a regression that drops signal forwarding fails fast with an
    assertion rather than via the test-runner timeout.
  - No `data-pulsar-mode-*` suppression attribute is preemptively
    written under `mode=present`. Scoped to the
    `data-pulsar-mode-*` namespace only so unrelated future
    diagnostics / observability attributes do not break the test.
- `src/runtime/navigation.ts` — `effectiveMode(target?:
  NavigationTarget): NavigationMode` pure helper that returns
  `target?.mode ?? 'present'`. The single dispatch point for
  PUL-F012's "URL parameter selects the mode; absent defaults to
  `present`" rule. Pure function — depends only on its argument so
  the ADR-007 invariant "URL is the only source of mode" is enforced
  by construction (no `localStorage` / `sessionStorage` / cookie /
  `history.state` access).
- `src/runtime/composition-resolver.ts` — `headBeat?: string` and
  `onBeatMissing?: () => void` fields on `ResolveCompositionOptions`,
  paired with `beat?: string` and `onBeatMissing?: () => void` on
  `SceneTimelineRunInput`. Implements PUL-F011's URL-beat forwarding
  in line with ADR-015: when the caller supplies `headBeat`, the
  resolver attaches `beat` (and the paired `onBeatMissing`) to the
  FIRST plan step's run input only — subsequent scenes never receive
  them, because ADR-015 scopes URL beat to the active head scene
  (no search through later composition entries). Both fields are
  omitted from the run input object when absent (the same `range` /
  `behavior` precedent — `'beat' in input === false`), so the
  runner's branching can rely on key presence. The resolver itself
  does not interpret labels — that responsibility belongs to the
  timeline runner per ADR-015.
- `src/runtime/scene-navigation.ts` — `beat?: string` and
  `onBeatMissing?: () => void` on `LoadSceneNavigationTargetOptions`.
  The bridge forwards both to `resolveComposition` as `headBeat` /
  `onBeatMissing`, omitting whichever the caller did not supply so
  the resolver does not see spurious `undefined` keys.
- `src/runtime/scene-loader.ts` — when the parsed `NavigationTarget`
  carries `target.beat`, the loader extracts it, builds an
  `onBeatMissing` closure that calls the existing `surfaceError(...)`
  with `Error('beat positioning failed: beat "<beat>" does not exist
  in scene "<head-scene-id>"')`, and forwards both to the bridge.
  The closure does NOT short-circuit the lifecycle: missing-label
  diagnostics write `data-pulsar-navigation-error` and invoke the
  configured `onError` sink while the active scene stays mounted at
  its initial timeline position (PUL-F011 clause 2's "remain at the
  scene's first beat", per ADR-015's "do not reject through
  `resolveComposition` for missing labels — that triggers cleanup
  and unmounts the scene"). The error grammar uses the stable prefix
  `beat positioning failed:` so callers can pattern-match on origin.
- `src/main.ts` — placeholder timeline runner invokes
  `input.onBeatMissing?.()` once when `input.beat !== undefined`.
  The placeholder timeline returns `null` (no labels), so any URL
  beat is a missing-label diagnostic by definition. The runner does
  not throw — it surfaces the diagnostic via the loader's callback
  and continues normally so the scene stays mounted. ADR-003's GSAP
  runner replaces this stand-in with `timeline.labels[input.beat]`-
  style seeking when the engine lands.
- `docs/adrs/015-url-beat-positioning.md` — records ADR-015's
  decisions: `beat` is timeline-runner state (not parser, dispatcher,
  registry, or manifest state); URL beat targets the active head
  scene only; an unknown beat is a non-fatal navigation-positioning
  diagnostic surfaced through the existing
  `data-pulsar-navigation-error` + `onError` surface; missing-label
  rejection through `resolveComposition` is forbidden because it
  triggers PUL-F006 cleanup and would unmount the scene; valid beat
  seeking uses the timeline engine's label API (no parallel beat
  schema in scene metadata, manifests, URL parsing, or registries).
  Indexed in `docs/adrs/README.md`.
- `tests/runtime/composition-resolver.test.ts` — new
  `'URL beat positioning forwarding (PUL-F011)'` describe block (5
  tests): `headBeat` reaches plan[0]'s run input only and subsequent
  scenes get no `beat` key; `onBeatMissing` follows the same head-
  scope semantics; absence of either option leaves the run input
  free of `beat` / `onBeatMissing` keys; an `onBeatMissing` supplied
  without `headBeat` is dropped (paired contract); a runner that
  silently consumes `headBeat` does not cause the resolver to throw
  or skip cleanup (resolver delegates label-existence to the runner).
- `tests/runtime/scene-navigation.test.ts` — new
  `'URL beat forwarding (PUL-F011)'` describe block (5 tests):
  `beat` reaches the runner for a single-scene target; in a
  `composition-index` slice, `beat` reaches the head scene only;
  `onBeatMissing` follows the same head-only forwarding;
  `onBeatMissing` supplied without `beat` is dropped (paired
  contract); omitted `beat` produces no `beat` key on the run input.
- `tests/runtime/scene-loader.test.ts` — new
  `'beat positioning (PUL-F011)'` describe block (8 tests):
  the loader extracts `target.beat` and forwards it to the runner;
  a runner that invokes `onBeatMissing` writes
  `data-pulsar-navigation-error='beat positioning failed: beat
  "<beat>" does not exist in scene "<head-scene-id>"'` AND calls
  `onError` while the scene stays mounted (proven via a pending
  runner that holds the gate open: cleanup has NOT fired during
  the diagnostic — only after the runner naturally exits); a
  diagnostic surfaced after the load was disposed/aborted is
  suppressed (parallel to `isPureAbort`); the diagnostic is
  fired only once per navigation even if the runner calls
  `onBeatMissing` repeatedly; a hand-built target with a
  non-kebab `beat` value is rejected with the parser's grammar
  message; a successful beat (runner does not invoke
  `onBeatMissing`) leaves the error attribute absent; a
  hand-built `composition`-only target with `beat` is rejected
  with the parser's "beat requires a scene-like target" message
  (defense-in-depth for ADR-013); targets without `beat` carry
  no `beat` / `onBeatMissing` keys on the run input.
- `tests/runtime/scene-loader.test.ts` — two PUL-F010 regression
  anchors under a new `'composition + index positions playback
  (PUL-F010)'` describe block: `?composition=trailer&index=2` against
  a 4-entry manifest records `data-pulsar-scene-target='scene-c'` and
  plays only `scene-c → scene-d` (proves zero-based positional
  semantics for N > 1 and that the slice continues from the index to
  the end), and two sequential navigations on the same loader instance
  with `index=0` then `index=2` against the same composition resolve
  to different head scenes (proves the `index` parameter — not the
  composition id — decides where in the composition playback starts).
  PUL-F010's parser, dispatcher, and loader chain shipped as part of
  PUL-F008 (PR #70) and PUL-F009 (PR #72); these tests pin PUL-F010's
  canonical statement — "when `index` is present alongside
  `composition`, the runtime positions playback at the given
  zero-based index" — at the loader boundary so a future refactor
  cannot silently collapse `composition-index` to a head-of-manifest
  load, off-by-one the index, or single-load `manifest[index]` and
  drop trailing entries.
- `docs/adrs/013-url-navigation-grammar-boundary.md` /
  `docs/adrs/014-url-scene-target-selection.md` — extend the existing
  ADRs to name PUL-F010 explicitly: ADR-013 records that `index` is
  not scene identity, an id alias, or a persistent bookmark
  independent of composition order, and adds a "PUL-F010 forks from
  composition path" risk + mitigation to keep positional dispatch in
  the existing `composition-index` locator; ADR-014 records that
  `composition` + `index` is PUL-F010's positional navigation
  behavior, that the head scene is `manifest[index]` with the slice
  continuing in manifest order, and adds an "index handling creates
  a second playback state machine" risk + mitigation.
- `tests/runtime/scene-loader.test.ts` — two PUL-F009 regression
  anchors in the "happy path" describe block: the canonical
  `?composition=full-talk` case (`kind: 'composition'` — head scene
  is `manifest[0]`, `data-pulsar-composition-target` records the
  composition id, lifecycle runs through the existing dispatch
  chain) and the `?composition=full-talk&index=1` case
  (`kind: 'composition-index'` — head scene is the addressed entry).
  PUL-F009's parser, dispatcher, and loader chain shipped as part of
  PUL-F008 (PR #70); these tests pin PUL-F009's canonical statement —
  "the composition URL parameter resolves the addressed manifest and
  uses it as the navigation context" — at the loader boundary so a
  future refactor cannot silently break the composition-only or
  composition-index path while keeping the composition+scene path
  green.

- `src/runtime/scene-navigation.ts` — `SceneNavigationTarget` /
  `SceneNavigationCompositionContext` interfaces,
  `resolveSceneNavigation` dispatcher, and
  `loadSceneNavigationTarget` lifecycle bridge. Implements PUL-F008
  on top of PUL-F007's `parseNavigationSearch` parser
  (`./navigation.ts`): consumes the parser's `NavigationTarget`,
  resolves the locator (`kind: 'scene' | 'composition' |
  'composition-scene' | 'composition-index' | 'none'`) against the
  scene + composition registries, snapshots the manifest slice +
  matching scene modules, and surfaces every miss (unknown scene,
  unknown composition, scene-not-in-composition, index out of
  range, empty composition, references to unregistered scenes) as a
  `scene navigation failed: …` error before any lifecycle hook
  runs. The lifecycle bridge plays the snapshot through
  `resolveComposition` so the URL path inherits PUL-F004's preload
  → create → timeline → cleanup ordering and PUL-F006's
  mandatory-cleanup invariant. Per-entry `range` and `behavior`
  overrides survive slicing intact and forward to the runner
  adapter unchanged (ADR-011). The bridge de-duplicates scene
  modules by id when synthesizing its scene registry so manifests
  with repeated scene ids (which `resolveComposition` legitimately
  supports) are not rejected by the registry's duplicate-id guard.
- `src/runtime/scene-navigation.ts` — `composition+scene` resolution
  rejects ambiguous locators: when the addressed scene id appears
  more than once in the named composition, the resolver throws
  `scene navigation failed: scene "<id>" appears <N> times in
  composition "<id>" — use composition+index for ambiguous locators`
  per ADR-013. Without the count check, `findIndex` silently picks
  the first occurrence and a later occurrence with different
  `range` / `behavior` overrides would load a slice that does not
  match what the URL named.
- `src/runtime/scene-loader.ts` — `createSceneLoader(options)`
  factory plus `WorkbenchSceneCtx` and `StageElement` shapes.
  Encapsulates the navigation state machine that consumes PUL-F007's
  `pulsar:navigate` / `pulsar:navigate-error` events: serializes
  navigations through a queue so concurrent calls don't race on
  stage attributes, eagerly aborts any in-flight load when a new
  navigation is enqueued (so back/forward doesn't wait for the
  current scene to drain naturally), drops superseded queued
  events via a per-event generation counter (so a rapid
  `handle(B)` → `handle(C)` while A is in flight skips B and runs
  only C, instead of running A → B → C), routes parse errors
  (`handleError`) through the same queue so a malformed URL aborts
  the active scene before the error attribute is set, runs the
  previous scene's `cleanup(ctx)` before the next preload begins,
  and writes
  `data-pulsar-scene-target` / `data-pulsar-composition-target` /
  `data-pulsar-navigation-error` so reviewers, agents, and
  screenshot automation can verify the runtime honored the URL —
  including malformed URLs, which set
  `data-pulsar-navigation-error` rather than silently no-op-ing.
  `dispose()` aborts any in-flight load silently and prevents
  future navigations. Errors flow through an optional `onError`
  hook (defaults to `console.error`) so headless harnesses observe
  failures without monkey-patching `console`. The loader depends
  only on injected registries / adapters / stage, which keeps the
  entire state machine unit-testable in Node's vitest environment
  without DOM polyfills. `WorkbenchSceneCtx` is the scene-context
  shape the workbench passes to every lifecycle hook (`{ stage:
  StageElement | null }`); future requirements extend it with
  `gsap`, `audio`, and `mode` per ADR-003 / ADR-004 / ADR-007.
- `src/runtime/composition-registry.ts` — `CompositionRegistry`
  interface, `CompositionRegistryEntry` shape, and
  `createCompositionRegistry` factory. Mirrors PUL-F002's scene
  registry contract for compositions: id-keyed lookup
  (`get` / `has` / `ids` / `size`), validation delegated to
  `assertCompositionManifest` (PUL-F003), kebab-case ids enforced
  via `isKebabIdentifier`, duplicate-id rejection, and the returned
  registry is frozen with no add / remove / positional API.
  Manifests are deep-frozen on registration (array, each
  object-form entry, and any nested `range` tuple / `behavior`
  record) so callers cannot mutate stored compositions after
  validation, and the registry stores a defensive copy so caller-
  side mutation of the original array does not leak into the
  registry. The composition registry is the addressability path
  the `?composition=X` URL parameter consults.
- `src/scenes/placeholder.ts` — first registered scene in the
  workbench. Minimal scene module that satisfies the PUL-F001
  contract (id, title, duration, tags, assets, captions,
  defaultNext, standalone, trailerSafe, create / timeline / cleanup)
  and tags `#stage` with `data-pulsar-scene-lifecycle` so reviewers
  and screenshot tests can verify each lifecycle phase ran.
  Lifecycle hooks guard against `document` being undefined so the
  module is also safe to import in Node-side tests.
- `src/compositions/default.ts` — first registered composition,
  containing only the placeholder scene. Gives `?composition=default`
  a registered target and gives `?composition=default&scene=
  placeholder` an end-to-end membership-validated path.
- `src/main.ts` — workbench entry wires PUL-F007's URL navigation
  parser to PUL-F008's scene loader. Builds the scene registry from
  `placeholderScene` and the composition registry from
  `defaultComposition`, instantiates a `SceneLoader` with the
  PUL-F005 asset preloader + a placeholder timeline runner, and
  subscribes the loader's `handle` / `handleError` to the
  `pulsar:navigate` / `pulsar:navigate-error` events that
  `bootstrapNavigation` dispatches. The loader honors URL
  parameters at startup and on every `popstate`, runs the active
  scene's `cleanup(ctx)` before the next scene's preload, and
  records both successful targets and parse / lookup / lifecycle
  errors on `#stage` via `data-pulsar-scene-target` /
  `data-pulsar-composition-target` /
  `data-pulsar-navigation-error`. The Vite HMR `dispose` hook
  removes the popstate listener AND disposes the loader so
  re-evaluation does not stack duplicate listeners or strand a
  half-loaded scene.
- `src/runtime/composition.ts` — exported `findUnregisteredEntries`
  helper (returns `MissingEntry[]` in iteration order). Centralizes
  the "report every missing scene id, not just the first"
  preflight-aggregation pattern that the composition resolver and
  URL navigation slice snapshot both consume; reduces duplication
  and keeps the report-every-gap behavior uniform across
  subsystems.
- `src/runtime/id-registry.ts` — generic `createIdRegistry<T>`
  factory plus `IdRegistry<T>` and `IdRegistryEntry<T>` shapes.
  Centralizes the id-keyed plumbing both `createSceneRegistry`
  (PUL-F002) and `createCompositionRegistry` (PUL-F008's companion)
  share: Map + insertion-order array, duplicate-id rejection,
  miss-throws, frozen `ids()` snapshot, frozen registry surface.
  Per-domain concerns (id-shape validation, value-shape validation,
  defensive transforms like manifest deep-freeze) plug in via
  `validateId` and `transform` hooks. The two existing registries
  become thin wrappers (~30 LOC each) that delegate plumbing here
  and keep their domain-specific error grammars.
- `src/runtime/error.ts` — shared `describeError(value)` helper.
  Folds an unknown thrown value into a human-readable string for
  diagnostic messages (`Error.message` for native errors, `String()`
  otherwise). Replaces three local copies (`composition-resolver.ts`'s
  `describe`, `asset-preloader.ts`'s `describeFailure`,
  `workbench-navigator.ts`'s local `describeError`) so any future
  rendering rule (truncation, redaction, structured-cause unwrap)
  lands once.
- `tests/runtime/scene-navigation.test.ts` — 29-test Vitest spec
  covering every PUL-F008 dispatch path: each `NavigationLocator`
  kind (none, scene, composition, composition-scene,
  composition-index) for happy paths and error paths (unknown
  scene / composition, non-member scene, out-of-range index, empty
  composition, scenes referenced by composition not in scene
  registry); manifest-slice snapshot freezing; per-entry override
  preservation; repeated-scene-id slices; lifecycle never touched
  on any error path; lifecycle integration via
  `loadSceneNavigationTarget` × `resolveComposition` covering
  preload → create → timeline → cleanup ordering for both
  single-scene and composition paths, identity guarantee against
  decoy registries, mandatory cleanup on create-throws,
  preload-aborts-before-create, ctx pass-through, and override
  forwarding to the runner adapter.
- `tests/runtime/scene-loader.test.ts` — 11-test Vitest spec
  pinning the loader state machine: handle() for single-scene and
  composition+scene targets, no-op on `kind: 'none'`,
  stale-attribute reset between navigations, error surfacing
  through the injected `onError` hook AND the
  `data-pulsar-navigation-error` stage attribute (unregistered
  scene, lifecycle-throw), `handleError(parseErr)` clearing stale
  scene attrs while recording the error, mid-lifecycle abort with
  cleanup invariant preserved, silent dispose, and post-dispose
  no-op.
- `tests/runtime/composition-registry.test.ts` — 13-test Vitest spec
  covering empty / single / multi composition construction; generator
  inputs; id-shape validation (kebab-case, empty, whitespace);
  manifest-shape delegation to `assertCompositionManifest`; duplicate-
  id rejection; lookup hits and misses; `has` semantics; insertion-
  order listing with frozen-snapshot detachment; and registry
  frozenness.
- `src/runtime/composition.ts` — exported `entryId` helper centralizes
  "extract the scene id from a composition entry" (bare string vs.
  `{ id, ... }` object). Single source of truth for composition-entry
  identity, reused by the resolver and the URL navigation slice
  builder.
- `docs/adrs/014-url-scene-target-selection.md` — records PUL-F008's
  scene navigation dispatch decisions: consume PUL-F007's parsed
  `NavigationTarget` (no parallel parser), resolve the locator
  against the scene + composition registries, snapshot the
  manifest slice + matching scene modules to defend against
  mid-flight registry substitution, fail before any lifecycle hook
  runs, route through the existing composition resolver lifecycle.
  Indexed in `docs/adrs/README.md`.

- `src/runtime/composition-resolver.ts` — `signal?: AbortSignal`
  field on both `ResolveCompositionOptions` and
  `SceneTimelineRunInput`. Implements PUL-F006's "skip rest of
  composition" (composition-level abort) exit path. Distinct from
  the "skip current scene, advance to next" shape, which is the
  cooperative runner-returns-void path the resolver already
  supports without special handling (per ADR-011: the resolver
  does not interpret runner intent). When the caller supplies a
  signal, `resolveComposition` checks `signal.aborted` at three
  checkpoints: pre-iteration, post-preload (so an abort observed
  mid-preload prevents scene activation), and inside the runner
  via the forwarded `SceneTimelineRunInput.signal` (so a runner
  that calls `signal.throwIfAborted()` mid-timeline still routes
  through the cleanup-always path for the active scene). Error
  messages name the precise checkpoint: `aborted before any scene
  was visited`, `aborted after preloading "<id>", before scene
  activation`, or `aborted between scenes after "<id>"`.
  `signal.reason` is forwarded as `Error.cause`. The seam ADR-011
  anticipated for the wave-1 PUL-F020 presenter-controls work,
  landed early because PUL-F006 needs it for testable coverage of
  the composition-abort exit path.
- `tests/runtime/composition-resolver.test.ts` — new
  `describe('per-scene cleanup invocation (PUL-F006)')` block (10
  tests) anchoring PUL-F006 to the resolver's cleanup-always
  invariant and the new signal contract. Pins the four exit paths
  PUL-F006 enumerates: normal advance; presenter skip via
  AbortSignal (four shapes — mid-scene runner abort, inter-scene
  abort, post-preload abort, pre-start abort); runtime error
  during create / timeline factory / runner; composition end.
  Also pins the codex-preflight axis "cleanup invoked exactly
  once per scene activation" — not asserted directly by PUL-F004's
  ordering tests. The "skip current scene, advance to next" shape
  is satisfied by the existing PUL-F004 happy-path tests because
  at the resolver level a cooperative runner early-return is
  contractually identical to ordinary completion.
- `src/runtime/composition-resolver.ts` — module-header
  documentation block enumerating the four PUL-F006 exit paths
  and routing them to the existing `runScene` finalization,
  including the explicit "do NOT add a parallel cleanup path"
  invariant.

- `src/runtime/asset-preloader.ts` — `createAssetPreloader` factory,
  `AssetPreloaderOptions` interface, and `DEFAULT_ALLOWED_SCHEMES`
  constant. Implements PUL-F005 clause (b): per scene, validate every
  declared asset URL against a scheme allowlist, optionally resolve
  relative paths against a configured `baseUrl`, fetch every URL in
  parallel, stream-drain each successful response body via
  `body.getReader()`, and re-validate the post-redirect URL against
  the allowlist. Failures aggregate into a single `AggregateError`
  whose `errors` array carries every failure in declaration order;
  per-asset messages name the offending URL (and the resolved URL when
  `baseUrl` differs) so multi-asset failures stay distinguishable.
  Configurable via `AssetPreloaderOptions.{fetch, init, baseUrl,
  allowedSchemes}`. Function signature
  `(scene: SceneModule) => Promise<void>` plugs straight into PUL-F004's
  `AssetPreloader` adapter slot — workbench bootstrap will pass
  `createAssetPreloader()` to `resolveComposition({ preloadAssets, ... })`.
  Clause (a) is satisfied by PUL-F001's `SceneModule.assets`. See
  ADR-012 for the byte-warming-vs-decode-complete boundary, the SSRF
  posture, and the cross-origin credential caveat.
- `tests/runtime/asset-preloader.test.ts` — 34-case Vitest spec for
  the preloader behaviors above; tests inject a fake `fetch` per case
  (no global mutation, no MSW).
- `docs/adrs/012-asset-preloader-fetch-and-drain.md` (also registered
  in Ground Control via `gc_create_adr`); `docs/adrs/README.md` —
  adds the ADR-012 row.

- `src/runtime/composition-resolver.ts` — `resolveComposition` async
  function plus `ResolveCompositionOptions`, `AssetPreloader`,
  `SceneTimelineRunInput`, and `SceneTimelineRunner` types. Implements
  PUL-F004 (composition resolution): given a `SceneRegistry` and a
  `CompositionManifest`, the runtime (a) calls
  `assertCompositionManifest` defensively then aggregates every missing
  scene id into a single actionable error before any side effect; (b)
  per scene, `await`s the injected `preloadAssets(scene)` adapter; (c)
  `await`s `scene.create(ctx)`; (d) `await`s the value of
  `scene.timeline(ctx)` (so async timeline factories resolve to a
  concrete timeline) then `await`s
  `runTimeline({ scene, timeline, range?, behavior? })` — `range` and
  `behavior` overrides from object entries flow through the runner
  input unchanged so the future GSAP runner can honor sub-range cuts
  and behavior overrides without another resolver-signature change;
  (e) always `await`s `scene.cleanup(ctx)` whenever the scene was
  touched (mandatory cleanup per ADR-008 / PUL-P001 — runs after
  `create` failure when resources may have been partially acquired,
  and after timeline failure). Errors carry a `composition resolution
  failed:` prefix; single-failure errors preserve the original as
  `Error.cause`; combined lifecycle-phase + cleanup failures throw an
  `AggregateError` whose `errors` array carries both errors in order
  (the resolver does not mutate caller-supplied errors). Scene `ctx`
  is opaque to the resolver and passed straight through.
- `tests/runtime/composition-resolver.test.ts` — 27-test Vitest spec
  covering every clause of PUL-F004: manifest-defense boundary;
  clause-(a) pre-flight existence with single, multiple, and object-
  entry missing ids plus the "no side effect before pre-flight"
  invariant; clause-(b) preload order, async-await ordering, and abort
  semantics; clause-(c) `create(ctx)` ordering plus the "still calls
  cleanup when create rejects" rule; clause-(d) timeline-value
  pass-through, async-await ordering, and the timeline-throws-cleanup-
  still-runs rule (separately for `scene.timeline(ctx)` itself
  throwing and for the runner adapter rejecting); clause-(e) cleanup
  ordering across a 3-scene happy path, cleanup-only failures,
  combined timeline+cleanup failures with cause chaining, and combined
  create+cleanup failures; sync vs async lifecycle hook handling; the
  range/behavior pass-through deferral; the codex-preflight no-dedup
  invariant for repeated scene ids; and the ADR-002 `trailer` fixture
  driven end-to-end with mixed bare-string and object entries.
- `docs/adrs/011-composition-resolver-orchestration.md` — records the
  decision that the composition resolver is a pure orchestrator that
  owns lifecycle order, mandatory-cleanup invariant, and aggregated
  failure semantics, while delegating asset preloading and timeline
  execution to injected callbacks (`AssetPreloader`,
  `SceneTimelineRunner`). Documents the deferral of `range` /
  `behavior` interpretation to the timeline runner adapter so the
  resolver does not weld itself to one timeline engine (keeping
  ADR-003's swappable `ctx.gsap` decision intact). ADR-011 is
  registered in Ground Control via `gc_create_adr`.
- `docs/adrs/README.md` index — backfills missing rows for ADR-010
  (Issue Tag Taxonomy) and ADR-011 (Composition Resolver
  Orchestration) so the table stays in sync with the files on disk.
- `src/runtime/composition.ts` — `CompositionManifest`,
  `CompositionEntry`, `CompositionEntryOverride`, `SubRange`, and
  `BehaviorOverride` types plus `assertCompositionManifest` runtime
  validator and `isCompositionManifest` predicate. Implements
  PUL-F003 (the composition manifest format): a manifest is an
  ordered array of entries; each entry is a bare kebab-case scene id
  string or an object with `id` plus optional `range` (single beat
  label or `[start, end]` label pair, per ADR-003 §Labels) and
  `behavior` (per-entry override blob). Unknown override keys are
  rejected so typos surface immediately. The validator owns the
  *format* only — registry-existence and timeline-label-existence
  checks belong to a later resolution requirement. Errors identify
  the entry index and offending field/condition, matching the
  `assertSceneModule` error grammar (PUL-Q005 spirit).
- `src/runtime/identifier.ts` — `KEBAB_IDENTIFIER_PATTERN` and
  `isKebabIdentifier`. Single source of truth for the kebab-case
  identifier rule that ADR-008 #1 makes binding on scenes,
  compositions, beats, and assets. Reused by `scene.ts` (scene id
  validation) and `composition.ts` (entry id and beat label
  validation).
- `src/runtime/object.ts` — `isPlainRecord` predicate. Accepts only
  `{ ... }` and `Object.create(null)` literals; rejects class
  instances such as `Date`, `Map`, `Set`, `RegExp`, `Error`, and
  user classes. Per ADR-008 #1 ("manifests are declarative data
  only"), runtime payload validation must reject opaque object
  instances that cannot be safely serialized, diffed, or treated as
  records of keyed fields. Reused by both `scene.ts` (scene module
  shape + caption shape) and `composition.ts` (entry shape +
  behavior override).
- `tests/runtime/composition.test.ts` — 103-test Vitest spec covering
  every PUL-F003 clause (top-level array shape, bare-string entries
  with kebab-case rule, object entries with `id` + `range` +
  `behavior` overrides, unknown-key rejection per the codex
  preflight guardrail), the AC1 mixed-entry contract using ADR-002's
  literal `fullTalk` / `shortTalk` / `trailer` examples as fixtures,
  AC2 actionable-error checks, and the `isCompositionManifest`
  predicate.

### Changed

- `src/runtime/registry.ts` — `createSceneRegistry` is now a thin
  wrapper over the new generic `createIdRegistry<T>` from
  `./id-registry.ts`. Public surface (`SceneRegistry`,
  `createSceneRegistry`) and error grammar (`scene registry: ...`)
  are unchanged; the change is internal plumbing share with the
  composition registry.
- `src/runtime/composition-registry.ts` — `createCompositionRegistry`
  now delegates to `createIdRegistry<T>` and consumes the shared
  `deepFreeze` from `./object.ts`. Public surface
  (`CompositionRegistry`, `CompositionRegistryEntry`,
  `createCompositionRegistry`) and error grammar
  (`composition registry: ...`, `composition manifest is invalid: ...`)
  are unchanged.
- `src/runtime/object.ts` — adds `deepFreeze<T>(value)` next to
  `isPlainRecord` so the recursive-freeze utility lives with the
  other "what counts as a plain structure" predicates rather than
  hidden inside `composition-registry.ts`.

- `src/runtime/scene.ts` — sources the kebab-case identifier
  predicate from the new `src/runtime/identifier.ts` instead of
  carrying its own `SCENE_ID_PATTERN` constant. Object-shape
  validation now uses the shared `isPlainRecord` predicate from
  `src/runtime/object.ts`, which tightens the previous loose check
  to reject class instances (`Date`, `Map`, `Set`, etc.) — same
  ADR-008 #1 declarative-data invariant the composition validator
  enforces. Existing scene fixtures (object literals) remain valid;
  the change rejects opaque object instances that should never have
  satisfied the scene contract.

- `docs/adrs/010-issue-tag-taxonomy.md` — defines a five-dimension,
  namespaced GitHub issue label taxonomy: type (`requirement` /
  `bug` / `enhancement` / `documentation` / `chore`),
  `series:<functional|quality|architecture|policy>`,
  `priority:<must|should|could|wont>`, `wave:<N>`, and `area:<...>`
  (12 subsystem labels). Mirrors Ground Control's `requirement_type`,
  `priority`, and `wave` fields onto labels so triage and filtering
  work in GitHub's UI without round-tripping through Ground Control.
  ADR-010 is registered in Ground Control via `gc_create_adr`. Labels
  applied to all 55 existing requirement-derived issues
  (#6, #8, #10, #12–#63).

### Changed

- `src/runtime/scene.ts` — `assertSceneModule` now enforces strict
  kebab-case format on `scene.id`: non-empty lowercase ASCII segments
  (`[a-z0-9]+`) joined by single hyphens, rejecting empty strings,
  uppercase, underscores, leading/trailing/consecutive hyphens,
  whitespace, punctuation, and non-ASCII. The same predicate is also
  applied to `defaultNext` (which holds a scene id reference) so the
  validator's notion of "scene id" is consistent across every field
  that carries one. Implements clause C1 of PUL-A007 (ADR-002 §Scene
  shape, ADR-008 #1 "stable, kebab-case ids"). Clause C2 (no id reuse
  across scenes) is already enforced by `createSceneRegistry`
  (PUL-F002). Existing scene fixtures (`'scene-a'`, `'next-scene'`,
  etc.) remain valid; the change tightens what the validator rejects,
  not what it accepts in current use.
- `tests/runtime/scene.test.ts` — adds a `scene id format (PUL-A007)`
  describe block (32 tests): 8 valid kebab-case ids, 22 invalid id
  shapes covering every rejection class, and 2 error-message format
  tests confirming the offending value is surfaced verbatim. Adds 9
  more cases under field types covering kebab-case enforcement on
  `defaultNext`.

### Added

- `src/runtime/registry.ts` — `SceneRegistry` interface and
  `createSceneRegistry` factory. Builds a single in-memory registry
  keyed by `scene.id`, delegating per-scene shape validation to
  `assertSceneModule` (PUL-F001) and rejecting duplicate ids on
  construction. The returned registry is frozen and exposes only
  id-based lookup (`get`, `has`, `ids`, `size`) — no positional or
  mutation API by design. Implements PUL-F002 (and ADR-002 §Scene
  registry / §Navigation, ADR-008 #2 "manifests over flow control"):
  scene id is the source of truth for addressability and the registry
  is the only navigation lookup path.
- `tests/runtime/registry.test.ts` — 35-test Vitest spec covering both
  clauses of PUL-F002: registry construction (happy paths over arrays,
  generators, sets), validation delegation to PUL-F001, duplicate-id
  rejection, lookup hits and misses, `has` semantics, insertion-order
  listing with caller-side mutation isolation, registry frozenness, and
  structural absence of positional / mutation methods.
- `src/runtime/scene.ts` — `SceneModule`, `Caption`, `SceneContext`,
  `SceneLifecycleFn` types plus `assertSceneModule` runtime validator
  and `isSceneModule` predicate. Implements the canonical scene-module
  contract per PUL-F001 (and ADR-002 / ADR-008): presence + shape of
  the 12 fields, `duration` strict (non-negative integer ms or `null`,
  rejecting `undefined`, `NaN`, `Infinity`, floats, negatives, strings,
  booleans). Errors identify the scene id and offending field/condition,
  laying the foundation for PUL-Q005 (validation actionability).
- `tests/runtime/scene.test.ts` — 62-test Vitest spec covering every
  clause of PUL-F001 (presence, duration rules, field types, caption
  element shape, happy paths, `isSceneModule` predicate, and error
  message format).
- `src/runtime/version.ts` exporting `PULSAR_RUNTIME_VERSION` plus a
  Vitest spec covering it. First runtime symbol the test runner exercises.
- Toolchain scaffold per ADR-009: TypeScript (strict), ESM, pnpm 9.15,
  Vite 6, Vitest 3 (`@vitest/coverage-v8` for lcov), Biome 1.9, Node 22
  LTS pinned via `.nvmrc` and `package.json` `engines` /
  `packageManager`.
- `package.json` scripts: `dev`, `build`, `preview`, `test`,
  `test:watch`, `test:coverage`, `lint`, `format`, `typecheck`.
- Source skeleton: `src/runtime/`, `src/scenes/`, `src/compositions/`,
  `tests/`, `assets/` (all empty with `.gitkeep` except for the
  workbench entry `src/main.ts` and a sentinel `tests/toolchain.test.ts`).
- `index.html` workbench entry that Vite's dev server and bundler
  consume.
- Configs: `tsconfig.json` (strict, ESNext + Bundler resolution),
  `vite.config.ts`, `vitest.config.ts`, `biome.json`.
- Pre-commit additions: `actionlint` for workflow YAML; local `biome-check`,
  `typecheck`, and `vitest` hooks gated by file regex (mirror CI).
- CI workflow rewritten as six required-status-check jobs (`pre-commit`,
  `typecheck`, `test`, `build`, `dependency-audit`, `sonarcloud`) on
  Node 22 + pnpm 9.15, with pnpm caching via `actions/setup-node`.
- SonarCloud wiring: `sonar-project.properties` and the `sonarcloud`
  block in `.ground-control.yaml`. The `sonarcloud` CI job runs with
  `-Dsonar.qualitygate.wait=true` so a RED gate fails the PR.
- `.ground-control.yaml` `workflow.*` commands populated so
  `/implement` exercises a real completion gate.

## [0.1.0] - 2026-04-30

### Added

- Initial repository scaffold from `KeplerOps/keplerops-template`.
- `.ground-control.yaml` configured with `pulsar` project identifier and
  `KeplerOps/pulsar` GitHub repo.
- `.mcp.json` wired to the local Ground Control MCP server with
  `GH_REPO=KeplerOps/pulsar`.
- `docs/adrs/` seeded with foundational ADRs covering the custom
  runtime decision, scene/composition model, timeline engine, audio
  engine, default rendering surface, export path, browser workbench,
  and agent-native authoring constraint.
- `docs/design/` seeded with architecture recommendations and a
  positioning/landscape doc that motivate the ADRs.
- `docs/requirements/` scaffolded with conventions (UID `PUL-`,
  F/Q/A/P series, RFC 2119 statements, status/priority/wave) and
  placeholders for personas, use cases, and user stories.
- `AGENTS.md` rewritten for this repo (replaces template residue).
- Personas, use cases, and user stories for Scene Author, Coding Agent,
  Presenter, and Reviewer under `docs/requirements/`.
- 55 requirements created in Ground Control: 30 functional (PUL-F001
  through PUL-F030), 10 quality (PUL-Q001 through PUL-Q010), 10
  architectural constraints (PUL-A001 through PUL-A010), 5 policy/process
  (PUL-P001 through PUL-P005). All requirements are `DRAFT` and carry
  priority + wave. Inter-requirement relations (DEPENDS_ON, REFINES,
  RELATED) and ADR traceability links (DOCUMENTS, CONSTRAINS) added.
- `.claude/skills/`: `implement`, `ship`, `stage`, `review-tests`, and
  `gh-workflow-monitor` skills imported and adapted from
  `KeplerOps/Ground-Control`. The end-of-flow Codex cross-model review
  step is removed in this repo's `/implement` and `/ship`; test-quality
  review still runs.
- `.claude/hooks/`: `git-merge-guard.py` (blocks merges/force-push),
  `log-skill-call.sh` (records skill invocations for the stop hook),
  `verify-implementation.sh` (stop hook enforcing CHANGELOG when
  `/implement` was used).
- `.claude/settings.json`: registered the new hooks (PreToolUse Bash,
  PostToolUse Skill, Stop).
