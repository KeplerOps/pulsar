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

## Runner-Phase Addendum (2026-05-21)

ADR-025 has since landed the GSAP-backed composition timeline adapter.
Current PUL-F016 work must therefore treat
`createGsapCompositionTimeline()` and the `MasterTimeline` transport
surface as the canonical runtime seam for the actual first-frame hold.
Do not add a second paused-mode path in the loader, resolver, scene
schema, composition schema, or workbench chrome.

The intended runner behavior is narrow: when the adapter receives
`headHold === 'first-frame'`, it positions the composed master at time
0, pauses it, does not resolve while a navigation `AbortSignal` is
live, and kills the master on abort. With no signal, resolving after
the held frame is positioned is acceptable for direct test/export
callers because no runtime navigation is waiting to keep the scene
mounted. `headHold` wins over `headBeat` and `headRepeat`; the runner
does not attempt beat lookup and does not invoke `onBeatMissing` for
a beat ignored by the first-frame policy.

The current repo also has the audio service from ADR-004. Paused mode
audible-output suppression belongs to
`scene-loader.ts`'s mode-to-`AudioOutputPolicy` mapping and the
`ctx.audio` service, not to the timeline adapter. The timeline adapter
freezes timeline transport only.

Cross-cutting layers in scope for runner-phase work:

- URL and mode input still pass only through `parseNavigationSearch()`,
  `NAVIGATION_MODES`, `effectiveMode()`, and the loader's
  defense-in-depth mode grammar check. No storage, cookies,
  `history.state`, environment variables, process argv, or prior
  in-memory state may select paused behavior.
- Scene and composition shape still pass through
  `assertSceneModule()`, `createSceneRegistry()`,
  `assertCompositionManifest()`, `createCompositionRegistry()`,
  `resolveSceneNavigation()`, and `loadSceneNavigationTarget()`.
  Paused mode does not add scene fields, composition fields, DTOs, or
  validation rules.
- Asset security still passes through `createAssetPreloader()` with
  its scheme allowlist, redirect re-check, `baseUrl`, declared
  `scene.assets`, and `AbortSignal` wiring. Paused mode does not turn
  query values into paths, dynamic imports, or network URLs.
- Audio suppression still passes through `audioOutputPolicyFor()`,
  `createAudioService()`, declared `scene.audio` / composition-bed
  sources, source allowlists, and service cleanup. Do not import Howler
  in scenes or mute a global engine for paused mode.
- Timeline validation and transport still pass through
  `assertSceneTimeline()`, `composeMasterTimeline()`,
  `MasterTimeline.seek(0)`, `MasterTimeline.pause()`,
  `runMasterUntilDone()`, and `MasterTimeline.kill()`. Do not
  manipulate raw GSAP timelines outside `src/runtime/timeline.ts`.
- Error surfacing keeps the existing envelopes:
  `navigation grammar is invalid:`, `scene navigation failed:`,
  `composition resolution failed:`, `composition timeline failed:`,
  and non-fatal `beat positioning failed:` where a beat lookup is
  actually attempted. Do not add paused-specific exception classes,
  logger paths, telemetry, or public diagnostics that serialize raw
  GSAP objects, DOM nodes, stacks, scene objects, headers, cookies,
  env, or argv.

The extension seam is the existing literal runner hint:
`headHold?: 'first-frame'`. A future hold variant should extend that
union and the adapter's positioning decision at the timeline boundary.
It should not become a boolean, a generic `ModePolicy`, a manifest
behavior key, a scene metadata flag, or a second URL-derived workflow.

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
  preload and `CompositionTimelineAdapter` adapters.
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
paused is the runner's policy. The older placeholder runner invoked
`onBeatMissing` because it had no real timeline at all, which was
honest within the placeholder world but is not the contract the GSAP
adapter follows.

## Guardrails

- Keep `paused` mode behavior at the loader / runner seam. The
  resolver must remain mode-opaque and must not learn about
  hold-at-first-frame semantics.
- Use the runner's native pause controls (`MasterTimeline.seek(0)`,
  `MasterTimeline.pause()`, backed by GSAP). Do not
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
  `<audio>` behavior. Audio suppression under paused is now an
  audio-service-surface concern: the loader maps `mode=paused` to the
  silent `AudioOutputPolicy`, and scenes reach sound through
  `ctx.audio`. Do not duplicate that policy in the timeline adapter,
  in scene code, or through global Howler / DOM audio state.

## Non-Goals

PUL-F016 should not implement `present`, `standalone`, `loop`,
`scrub`, `screenshot`, or `prompter`; presenter controls
(advance / hold / skip / pause / resume / mute); authoring UI;
export behavior; decode-complete asset semantics; new scene
metadata; new composition metadata; persistence; or a generic
mode-policy framework. It should not make paused imply chrome
suppression, deterministic rendering, or visible scrub controls, and
it should not add audio behavior beyond the existing silent
`AudioOutputPolicy` for paused. It should not implement transport
controls, scrub UI, screenshot determinism, or presenter resume
behavior.

Earlier contract-layer work kept PUL-F016 DRAFT until implementation
included tests proving first-frame mount without timeline advancement
against a real timeline runner. That historical blocker is no longer
the architectural dependency in the current repo: ADR-025 supplies the
GSAP adapter. New work must preserve the ACTIVE semantics and add or
maintain tests at the runner seam when changing hold behavior.

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
