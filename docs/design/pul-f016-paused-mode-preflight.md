# PUL-F016 Paused Mode Preflight

PUL-F016 specifies `mode=paused`: mount the addressed scene and hold
it at its first frame without advancing the timeline. This is a
layout/styling-inspection mode for visual review without motion. It
is not a presenter transport state, a scrub UI, a deterministic
visual-regression mode, or a new scene model.

ADR-007 already defines `paused` as a workbench mode. ADR-011
already defines the resolver as a lifecycle orchestrator with an
injected timeline runner. The runner-input shape introduced by
ADR-018 (`repeat`) is the precedent for adding a new head-only
optional field; ADR-019 records the analogous `hold` field for
paused.

## Boundary

`paused` selection must reuse the existing navigation path:

- `src/runtime/navigation.ts` owns the `mode` URL grammar and the
  `NAVIGATION_MODES` allowlist.
- `effectiveMode()` owns effective mode derivation.
- `src/runtime/scene-loader.ts` owns per-navigation mode dispatch,
  `ctx.mode` construction, cancellation, stage diagnostics, and
  error surfacing. It is also the dispatch point that maps
  `effectiveMode === 'paused'` to `hold: 'first-frame'`.
- `src/runtime/scene-navigation.ts` owns target resolution and
  composition slicing. Its `scene` field is the addressed head
  scene.
- `src/runtime/composition-resolver.ts` owns preload → create →
  timeline → cleanup ordering, abort propagation, and exactly-once
  cleanup. It must remain mode-opaque; `headHold` is plumbed the
  same way `headBeat` and `headRepeat` are.
- The timeline runner owns timeline playhead behavior. Under
  `mode=paused` the runner reads `input.hold === 'first-frame'`
  and pins the timeline at time 0 (or equivalent native API call).

Do not add a second route, mode enum, `paused` boolean, scene
schema field, manifest flag, local URL parser, or paused-specific
resolver. URL input remains the only source of mode selection;
`paused` must not be recovered from localStorage, sessionStorage,
cookies, `history.state`, or prior in-memory navigation state.

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
  scheme, redirect, `baseUrl`, and `AbortSignal` rules. Paused mode
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
  for `standalone` (ADR-017) and extended for `loop` (ADR-018) are
  extended again to fire under `paused`. The shape transform is
  shared; the predicate widens.

## Paused Contract

Paused mode means: resolve the addressed scene through the existing
URL/registry/composition path, preload declared assets, run normal
`create(ctx)` and `timeline(ctx)`, render the timeline at time `0`,
then hold it there. It is not a resumable presenter transport
state.

- A direct `scene` target holds that scene's timeline at frame 0.
- A `composition` target holds the first scene's timeline at frame
  0; following composition entries do not run.
- A `composition+scene` or `composition+index` target holds the
  resolved head scene's timeline at frame 0, preserving the head
  entry's `range` / `behavior` overrides; following composition
  entries do not run.
- `beat=<label>` must not redefine paused mode. For `mode=paused`,
  first frame wins. The runner SHOULD ignore `input.beat` when
  `input.hold === 'first-frame'`. Use `mode=scrub` for
  beat/timeline inspection and `mode=screenshot` for deterministic
  visual regression.

The requirement says the addressed scene mounts and the timeline
holds at first frame. Do not implement paused by skipping
`create(ctx)`, by skipping `timeline(ctx)`, or by short-circuiting
the lifecycle. Scene setup runs normally; only the timeline's
playhead is pinned.

When the URL used composition context, validation must still happen
before lifecycle effects. Unknown compositions, unknown member
scenes, ambiguous `composition+scene` locators, out-of-range
indexes, empty compositions, unregistered referenced scenes, and
preload failures must surface through the existing diagnostics.
Paused mode must not silently degrade to direct scene lookup.

Missing-beat diagnostics are different under paused. ADR-019's
runner-side "first frame wins" policy means a conformant
hold-first runner does NOT seek to a supplied `beat` label and
therefore does NOT call `input.onBeatMissing` even when the label
is missing — there is no missing-label event because no seek was
attempted. The loader still forwards `beat` and `onBeatMissing` to
the runner unchanged (the loader does not couple `beat` and `mode`
at its layer); whether a missing-label diagnostic surfaces under
paused is the runner's policy. The placeholder runner today does
invoke `onBeatMissing` because it has no real timeline at all,
which is honest within the placeholder world but not the contract
the GSAP runner will follow.

## Guardrails

- Keep `paused` mode behavior at the loader / runner seam. The
  resolver must remain mode-opaque and must not learn about
  hold-at-first-frame semantics.
- Prefer the runner's native pause controls once ADR-003's GSAP
  runner lands (`timeline.pause()`, `timeline.seek(0)`). Do not
  build hold loops with `setTimeout`,
  `requestAnimationFrame` checks that gate themselves on a paused
  flag, CSS / keyframe animation suppression layers, canvas loops
  guarded by `if (paused)`, or per-scene `if (mode === 'paused')`
  branches in `create(ctx)`.
- Preserve runner input semantics: `range`, `behavior`, `beat`,
  `onBeatMissing`, `repeat`, and `signal` keep their existing
  meanings. The new `hold` field is optional and discriminated by
  literal type so future variants can extend the union without
  breaking existing runners.
- Honor `AbortSignal` promptly. A held timeline that ignores abort
  will block navigation handoff and delay resolver-owned cleanup.
- Do not call scene `cleanup()` from runner, chrome, audio, or
  workbench controls. Drive exit through the existing navigation
  abort path.
- Do not add duplicate exception hierarchies. Navigation failures
  keep the `scene navigation failed:` surface; lifecycle failures
  keep the `composition resolution failed:` surface; missing beats
  keep the non-fatal `beat positioning failed:` diagnostic.
- Do not preemptively write `data-pulsar-mode-*` attributes unless
  a concrete workbench surface needs them. Stage diagnostics should
  keep describing the addressed scene / composition and navigation
  errors.
- Paused mode should not trigger autoplay audio or scene-local raw
  `<audio>` behavior. Audio suppression under paused is a future
  audio-service-surface concern (ADR-004) — when the audio service
  lands it will read `ctx.mode === 'paused'` at its own seam and
  suppress the audio bed; today there is no audio service to
  suppress.

## Non-Goals

PUL-F016 should not implement `present`, `standalone`, `loop`,
`scrub`, `screenshot`, or `prompter`; presenter controls
(advance / hold / skip / pause / resume / mute); authoring UI;
export behavior; decode-complete asset semantics; new scene
metadata; new composition metadata; persistence; or a generic
mode-policy framework. It should not make paused imply chrome
suppression, audio suppression, deterministic rendering, or
visible scrub controls. It should not implement transport
controls, scrub UI, screenshot determinism, or presenter resume
behavior.

PUL-F016 should not transition to ACTIVE until implementation
includes tests proving first-frame mount without timeline
advancement against a real timeline runner. The placeholder runner
in `src/main.ts` has no real timeline, so PUL-F016 stays DRAFT
after the contract-layer PR; the GSAP runner (ADR-003) is the
natural trigger to revisit the status.

## Anti-Patterns

- Duplicating `NAVIGATION_MODES` or validating mode strings with a
  local enum.
- Reading `window.location` from a scene to detect paused mode.
- Per-scene `if (mode === 'paused')` branches that skip work the
  scene's `create(ctx)` would otherwise do.
- Raw `setTimeout`, `requestAnimationFrame`, CSS / keyframe
  animation, canvas loops, or autoplay audio inside `create(ctx)`
  that bypass runtime pause control.
- Calling `loader.handle(target)` from inside the runner to
  re-render the held frame.
- Flattening a composition target to direct scene lookup and losing
  range / behavior overrides for the addressed entry.
- Conflating `paused` with `screenshot`: paused is layout/styling
  inspection at frame 0; screenshot is deterministic regression
  output at a chosen frame; scrub is beat-targeted timeline
  inspection.
- Encoding paused behavior in scene metadata, composition entries,
  sentinel scenes, fake transitions, or mutable manifest rewrites.
- Persisting the last paused target, paused state, or mode outside
  the URL.
- Stripping `beat=` at the loader when `mode=paused` is set —
  paused vs beat preference is the runner's policy contract, not a
  loader-side filter; coupling them at the loader prevents authors
  from reusing the same beat parameter across modes.
