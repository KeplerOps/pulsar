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
- Error rendering: `describeError()` / `describeErrorDetailed()` plus
  the existing `data-pulsar-navigation-error` stage diagnostic and
  `onError` sink.
- Cancellation and cleanup: one per-navigation `AbortController`,
  forwarded to preload and timeline adapters; cleanup remains
  resolver-owned.

## Cross-Cutting Layers

The actual runner-repeat pass must satisfy every layer below. Passing
the local `timeline.ts` style is not enough if one of these outer
contracts is bypassed.

| Layer | Guardrail |
|-------|-----------|
| URL grammar / public input | `mode=loop` is accepted only through `parseNavigationSearch()` and `NAVIGATION_MODES`. Unknown or repeated `mode` values keep failing through `navigation grammar is invalid:`. Unknown query keys must not influence loop behavior. |
| Programmatic navigation | Hand-built `NavigationTarget` objects still pass the loader's `validateModeGrammar()` defense before `effectiveMode()` reaches `buildCtx()` or runner-hint dispatch. |
| Source of truth | The URL-derived `effectiveMode(target)` remains the only selector. Do not read localStorage, sessionStorage, cookies, `history.state`, env vars, process argv, files, or prior in-memory navigation state to recover loop. |
| Workbench graph validation | Browser boot and CI keep using `validateRuntime()` over `WORKBENCH_SCENES` and `WORKBENCH_COMPOSITIONS` before lifecycle effects. Loop fixtures must be registered in `src/workbench-graph.ts`; no test-only registry path. |
| Scene and composition schemas | No scene field, composition manifest key, `behavior` key, sentinel scene, fake transition, or mutable manifest rewrite may become the loop selector. Existing `assertSceneModule()`, `assertCompositionManifest()`, `createSceneRegistry()`, and `createCompositionRegistry()` stay authoritative. |
| Navigation and slicing | `resolveSceneNavigation()` must validate composition membership, indexes, empty manifests, and referenced scene ids before any truncation. `applySingleSceneSlice()` and `truncateToHead()` preserve the addressed head entry's `range` / `behavior` overrides. |
| Resolver lifecycle | `resolveComposition()` remains mode-opaque. It forwards `headRepeat` as an optional head hint and keeps preload, create, timeline, abort, scene-failure isolation, and cleanup ownership unchanged. |
| Timeline adapter | `createGsapCompositionTimeline()` is the canonical runner boundary. It should interpret `headRepeat === 'until-aborted'` through the existing `MasterTimeline.repeat(-1)` transport, then run until the navigation `AbortSignal` resolves and kills the master. |
| Asset policy | Loop does not relax asset validation or preload. Declared assets still flow through `createAssetPreloader()`, `resolveAssetUrl()`, scheme allowlists, redirect re-checks, `baseUrl`, and fetch abort wiring. |
| Audio policy | Loop keeps the normal audible policy unless a separate mode says otherwise. Do not conflate timeline repeat with Howler loop flags, global mute, rehearsal cue logging, paused silence, or screenshot silence. |
| Error envelopes | Keep existing public envelopes: `navigation grammar is invalid:`, `scene navigation failed:`, `composition resolution failed:`, `beat positioning failed:`, and scene-failure diagnostics through `formatSceneContext()`. Do not introduce `LoopError` or serialize raw causes, stacks, DOM, captions, headers, cookies, env, auth values, or credentialed URLs. |
| OS / config exposure | No loop token, target, or secret-bearing URL belongs in process argv, environment bindings, local files, cookies, browser storage, or persisted history state. Playwright/Vite config may carry only non-secret host, port, path, and project values. |
| Browser evidence | Browser e2e proof must use the existing Playwright stack (`tests-e2e/`, `playwright.config.ts`, `pnpm test:browsers`, CI `browser-support` job). A sticky terminal state such as `data-pulsar-fixture-state="ran"` proves one completion only; loop acceptance needs an observable counter, toggle, or callback evidence for at least two iterations. |

## Workflow Note

The issue text may still mention a DRAFT -> ACTIVE transition from the
first seam-only delivery. Follow the current Ground Control requirement
state. If PUL-F015 is already ACTIVE, do not attempt another status
transition; reconcile `IMPLEMENTS` / `TESTS` traceability after the
source and acceptance tests land.

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

For the current GSAP adapter, the intended design is the narrow runner
interpretation of the already-plumbed hint: `headRepeat ===
'until-aborted'` sets the composed master to repeat indefinitely, then
normal playback starts. The loop resolves only on the navigation abort
path so the resolver can run the usual cleanup. This must not restart
the loader, rebuild scene ctx, remount DOM, replay preload, or create a
parallel lifecycle controller.

When the URL used composition context, validation must still happen
before lifecycle effects. Unknown compositions, unknown member scenes,
ambiguous `composition+scene` locators, out-of-range indexes, empty
compositions, unregistered referenced scenes, preload failures, and
missing beats must surface through the existing diagnostics. Loop mode
must not silently degrade to direct scene lookup.

## Guardrails

- Keep `loop` mode behavior at the loader / runner seam. The resolver
  must remain mode-opaque and must not learn about repeat semantics.
- Use the runner's native repeat / restart controls. Do not build
  timing loops with `setInterval`, polling, sleeps, or recursive
  `handle()` calls.
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
- Keep `headHold` and `headScreenshot` precedence intact. First-frame
  hold and screenshot capture are non-playing modes; they must not also
  loop if a direct adapter caller supplies conflicting hints.
- Preserve key-presence semantics for optional runner hints. Non-loop
  modes omit `headRepeat`; do not pass `undefined` as a semantic value
  or add a second boolean such as `loop: true`.
- Verify real iteration, not just durable final state. Unit tests should
  observe at least two completions/cycles on the master or a scene-owned
  callback target, then abort and assert settlement. Browser tests
  should observe the same through public DOM state, not internal GSAP
  handles.

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
- Treating the browser-support fixture's durable `"ran"` attribute as
  proof of restart-on-completion. It is a good "timeline ran once"
  smoke signal, not a loop acceptance signal.
