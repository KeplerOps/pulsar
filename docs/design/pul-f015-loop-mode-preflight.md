# PUL-F015 Loop Mode Preflight

PUL-F015 specifies `mode=loop`: run the addressed scene's timeline and
restart it on completion. This is a scene-inspection mode for visual
and audio tuning. It is not a new scene model, composition model,
router, lifecycle, or persistence feature.

ADR-007 already defines `loop` as a workbench mode. ADR-011 already
defines the resolver as a lifecycle orchestrator with an injected
timeline runner. No new ADR is needed unless implementation discovers
that multiple runner/workbench surfaces need a shared mode-policy
representation that cannot be expressed through the existing runner
input and `ctx.mode` seams.

## Boundary

`loop` selection must reuse the existing navigation path:

- `src/runtime/navigation.ts` owns the `mode` URL grammar and the
  `NAVIGATION_MODES` allowlist.
- `effectiveMode()` owns effective mode derivation.
- `src/runtime/scene-loader.ts` owns per-navigation mode dispatch,
  `ctx.mode` construction, cancellation, stage diagnostics, and error
  surfacing.
- `src/runtime/scene-navigation.ts` owns target resolution and
  composition slicing. Its `scene` field is the addressed head scene.
- `src/runtime/composition-resolver.ts` owns preload -> create ->
  timeline -> cleanup ordering, abort propagation, and exactly-once
  cleanup.
- The timeline runner owns timeline playhead behavior, completion
  detection, label seeking, and restart / repeat mechanics.

Do not add a second route, mode enum, `loop` boolean, scene schema
field, manifest flag, local URL parser, or loop-specific resolver.
URL input remains the only source of mode selection; `loop` must not be
recovered from localStorage, sessionStorage, cookies, `history.state`,
or prior in-memory navigation state.

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
- Asset handling: `createAssetPreloader()` with the existing scheme,
  redirect, `baseUrl`, and `AbortSignal` rules.
- Error rendering: `describeError()` plus the existing
  `data-pulsar-navigation-error` stage diagnostic and `onError` sink.
- Cancellation and cleanup: one per-navigation `AbortController`,
  forwarded to preload and timeline adapters; cleanup remains
  resolver-owned.

## Loop Contract

Looping applies to the addressed head scene's timeline:

- A direct `scene` target loops that scene's timeline.
- A `composition` target loops the first scene's timeline.
- A `composition+scene` or `composition+index` target loops the
  resolved head scene's timeline, preserving the head entry's `range`
  / `behavior` overrides.
- `beat` remains scoped to the addressed head scene per ADR-015. If a
  beat is valid, the first loop starts from that position; subsequent
  restarts return to the loop start chosen by the runner contract, not
  to a parser-owned bookmark.

The requirement says the timeline restarts, not that the scene
lifecycle restarts. Do not implement loop by repeatedly running
`create(ctx)` / `timeline(ctx)` / `cleanup(ctx)` for the same scene.
Scene setup should occur once for the active navigation, the runner
should repeat the timeline until the navigation is aborted or disposed,
and resolver-owned cleanup should run once when the scene exits.

When the URL used composition context, validation must still happen
before lifecycle effects. Unknown compositions, unknown member scenes,
ambiguous `composition+scene` locators, out-of-range indexes, empty
compositions, unregistered referenced scenes, preload failures, and
missing beats must surface through the existing diagnostics. Loop mode
must not silently degrade to direct scene lookup.

## Guardrails

- Keep `loop` mode behavior at the loader / runner seam. The resolver
  must remain mode-opaque and must not learn about repeat semantics.
- Prefer the runner's native repeat / restart controls once ADR-003's
  GSAP runner lands. Do not build timing loops with `setInterval`,
  polling, sleeps, or recursive `handle()` calls.
- Preserve runner input semantics: `range`, `behavior`, `beat`,
  `onBeatMissing`, and `signal` keep their existing meanings. If loop
  needs an additional runner hint, extend the runner input deliberately
  rather than smuggling behavior through manifest metadata or scene
  fields.
- Honor `AbortSignal` promptly. A loop that ignores abort will block
  navigation handoff and delay resolver-owned cleanup.
- Do not call scene `cleanup()` from runner, chrome, audio, or
  workbench controls. Drive exit through the existing navigation abort
  path.
- Do not add duplicate exception hierarchies. Navigation failures keep
  the `scene navigation failed:` surface; lifecycle failures keep the
  `composition resolution failed:` surface; missing beats keep the
  non-fatal `beat positioning failed:` diagnostic.
- Do not preemptively write `data-pulsar-mode-*` attributes unless a
  concrete workbench surface needs them. Stage diagnostics should keep
  describing the addressed scene / composition and navigation errors.

## Non-Goals

PUL-F015 should not implement `present`, `standalone`, `paused`,
`scrub`, `screenshot`, or `prompter`; presenter controls; authoring UI;
export behavior; decode-complete asset semantics; new scene metadata;
new composition metadata; persistence; or a generic mode-policy
framework. It should not make loop imply chrome suppression, audio
suppression, deterministic rendering, or visible scrub controls.

## Anti-Patterns

- Duplicating `NAVIGATION_MODES` or validating mode strings with a
  local enum.
- Reading `window.location` from a scene to detect loop mode.
- Looping an entire composition when the requirement names the
  addressed scene's timeline.
- Re-running scene lifecycle hooks on each iteration.
- Calling `loader.handle(target)` from inside the runner to restart
  playback.
- Flattening a composition target to direct scene lookup and losing
  range / behavior overrides for the addressed entry.
- Encoding loop behavior in scene metadata, composition entries,
  sentinel scenes, fake transitions, or mutable manifest rewrites.
- Persisting the last loop target, loop state, or mode outside the URL.
