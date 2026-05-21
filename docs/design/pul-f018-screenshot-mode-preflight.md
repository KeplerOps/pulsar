# PUL-F018 Screenshot Mode Preflight

PUL-F018 specifies `mode=screenshot`: render the addressed scene at the
addressed beat, or at frame 0 when no beat is supplied, after declared
preloads have resolved, with the timeline held still, audio suppressed,
and randomness sourced from a deterministic seed.

This is a runtime capture contract for deterministic visual regression.
It is not an export pipeline, image storage feature, screenshot diff
service, new renderer, or scene-authored mode.

## Current Incumbents

As of 2026-05-21, the repository already has most of the required
runtime seams:

- URL mode grammar: `parseNavigationSearch()`, `NAVIGATION_MODES`, and
  `effectiveMode()` in `src/runtime/navigation.ts`.
- Loader mode dispatch: `createSceneLoader()` in
  `src/runtime/scene-loader.ts`, including `ctx.mode`, single-scene
  slice truncation, `headScreenshot: 'capture'` forwarding, stage
  diagnostics, queued navigation, abort, and cleanup-before-handoff.
- Navigation bridge: `resolveSceneNavigation()` and
  `loadSceneNavigationTarget()` in `src/runtime/scene-navigation.ts`,
  including bridge-level head truncation for screenshot direct callers.
- Lifecycle ordering: `resolveComposition()` in
  `src/runtime/composition-resolver.ts`, which awaits the injected
  `preloadAssets(scene)` before `create(ctx)`, collects timelines, runs
  the injected composition timeline adapter, and always cleans touched
  scenes.
- Timeline freeze: `createGsapCompositionTimeline()` in
  `src/runtime/timeline.ts`; `positionMaster()` already treats
  `headScreenshot === 'capture'` as seek-to-head-beat-or-0, pause, and
  held run mode.
- Audio suppression: `audioOutputPolicyFor()` maps screenshot to
  `AudioOutputPolicy: 'silent'`, and `createAudioService()` constructs
  muted sounds under that policy.
- Asset byte readiness: `createAssetPreloader()` validates, fetches, and
  stream-drains declared `scene.assets`; resolver await semantics are the
  capture fence for declared assets.
- Error envelopes: `describeError()`, `describeErrorDetailed()`, stage
  attributes, `onError`, and scene-failure diagnostics are already the
  public error surface.
- Static determinism gate: `tests/runtime/screenshot-determinism-source.test.ts`
  scans `src/**` for ambient entropy, timers, animation APIs, storage,
  cookies, history state, and process/env access.

The remaining architectural gap for PUL-F018 is the deterministic RNG
surface on scene context. Do not reimplement the shipped freeze, preload,
audio, URL, or navigation paths while adding it.

## Boundary

Screenshot mode must stay on the existing workbench navigation path:

- `mode=screenshot` is parsed and validated by the URL grammar. Do not
  infer it from `localStorage`, `sessionStorage`, cookies,
  `history.state`, process state, or prior navigation state.
- The loader is the mode-dispatch boundary. It derives
  `effectiveMode(target)`, builds per-navigation `ctx.mode`, selects the
  audio output policy, truncates composition slices for single-scene
  execution, and forwards `screenshot: 'capture'`.
- The bridge and resolver remain mode-light orchestrators. They forward
  typed head options and preserve manifest entry `range` / `behavior`
  overrides; they do not parse URL strings or inspect scene context.
- The timeline adapter is the GSAP boundary. Screenshot freeze belongs
  there, through `MasterTimeline.seek()` / `pause()`, not in scenes,
  loader timers, or DOM polling.
- The audio service is the Howler boundary. Screenshot silence belongs
  to `AudioOutputPolicy: 'silent'`, not scene-level volume conventions
  or raw `<audio>` exceptions.
- The preloader remains the declared-asset byte-readiness boundary.
  Browser decode-complete readiness, if required later for images,
  fonts, or media posters, must compose on top of `createAssetPreloader`
  instead of mutating its Node-compatible fetch-and-drain contract.

## Seed And RNG Guardrails

Add the deterministic random source at the scene-context seam, not as a
scene schema field and not as a global monkey patch.

Required shape constraints:

- The loader/build-ctx path must create a per-navigation deterministic
  seed and expose a scene-consumable RNG through `WorkbenchSceneCtx`.
  Scenes that need randomness consume that ctx surface; they do not call
  `Math.random`, `crypto.getRandomValues`, time APIs, storage, or process
  state.
- The default seed must derive from bounded, deterministic inputs: the
  normalized navigation target, addressed beat when present, addressed
  composition/index/scene locator, and a bundle/runtime revision literal
  such as `PULSAR_RUNTIME_VERSION`. Do not derive from wall clock,
  browser storage, cookies, `history.state`, `process.env`,
  `process.argv`, or runtime command-line flags.
- If an explicit seed is exposed later, add it through the canonical URL
  grammar with the same repeated-key rejection and bounded validation as
  existing public parameters. Do not let ignored unknown query keys
  affect determinism.
- The RNG algorithm must be deterministic in ordinary JavaScript across
  supported engines. Arithmetic/hash-based PRNG code is acceptable; a
  runtime entropy API is not.
- RNG state is scoped to the navigation/scene activation. It must not be
  a process-global singleton whose draw order can be perturbed by other
  scenes, tests, HMR, or previous navigations.
- The seed may be exposed as bounded diagnostic context if needed, but
  errors must not echo raw URL strings containing credentials or any
  secret-bearing environment/config value.

The extensibility seam is the seed input handed to the ctx builder. A
future explicit `seed=` URL parameter, viewport profile, theme, locale,
or capture variant should populate that seed/options input at the
navigation boundary, then flow through ctx. Do not add per-scene capture
flags or a second screenshot schema.

## Cross-Cutting Layers In Scope

The intended implementation must pass these existing repository layers:

- URL validation: `parseNavigationSearch()`, `NAVIGATION_MODES`,
  `effectiveMode()`, plus loader defense checks for mode and beat. Any
  future seed parameter goes through this layer; unknown query keys stay
  ignored.
- Identifier and beat validation: `isKebabIdentifier()`,
  `assertSceneTimeline()`, `sceneTimelineLabel()`, and
  `resolveHeadBeatLabel()`. Do not add a second beat list or parse
  namespaced labels locally.
- Scene and composition schemas: `assertSceneModule()`,
  `createSceneRegistry()`, `assertCompositionManifest()`,
  `createCompositionRegistry()`, `findUnregisteredEntries()`, and the
  runtime validation pass. No RNG field belongs in `SceneModule`.
- Lifecycle and cleanup: `resolveComposition()` with injected
  `AssetPreloader` and `CompositionTimelineAdapter`. Preload failures
  remain composition-wide; scene `create` / `timeline` / `cleanup`
  failures remain scene failures per ADR-028.
- Asset security: `resolveAssetUrl()`, `DEFAULT_ALLOWED_SCHEMES`,
  post-redirect scheme revalidation, body cancellation, and
  `AssetPreloaderOptions.baseUrl` / `allowedSchemes`. Screenshot mode
  must not widen schemes, inject credentials, or introduce direct file
  or OS path reads.
- Audio security and validation: `createAudioService()`,
  `AudioOutputPolicy`, `scene.audio` / `allowedSources`, group/sound id
  validation, and `stopAll()` / `stopGroup()` cleanup. Screenshot silence
  is `outputPolicy: 'silent'`; do not add raw audio bypasses.
- Error rendering: `describeError()`, `describeErrorDetailed()`,
  `formatSceneContext()`, `data-pulsar-navigation-error`, and `onError`.
  Public diagnostics carry ids, beat, phase, and bounded messages only;
  never serialize raw causes, stacks, scene objects, DOM nodes, headers,
  cookies, auth values, environment, or argv.
- Source policy: `tests/runtime/screenshot-determinism-source.test.ts`.
  New deterministic RNG code must satisfy the ban on ambient entropy and
  timing surfaces.
- Build/workflow: `.ground-control.yaml`, `.gc/plan-rules.md`,
  `pnpm lint`, `pnpm typecheck`, and `pnpm test`. Source changes require
  a changelog fragment per `.gc/plan-rules.md`; docs-only preflight
  updates do not.

No auth layer, secret store, database, repository, persistence layer, or
server API is in scope for PUL-F018. The OS-level exposure to guard is
host/process input: do not read environment variables, argv, filesystem
paths, or shell state to shape screenshot output.

## Gotchas

- Do not treat `await loader.handle(...)` as a screenshot-ready signal
  under the browser loader path. Held modes park until navigation abort;
  if capture tooling later needs an explicit readiness event, it belongs
  at the loader/timeline observability seam after preloads, scene setup,
  timeline composition, seek, and pause have completed.
- Do not advance through animation to reach a beat. Resolve the beat
  label on the master and seek directly.
- Do not conflate paused and screenshot. Paused ignores beat and holds
  frame 0; screenshot honors beat and then holds.
- Do not use `setTimeout`, `requestAnimationFrame`, CSS/Web Animations,
  `Date.now()`, or `performance.now()` as stabilization heuristics.
- Do not change `scene.timeline(ctx)` to async or await it in the
  resolver. Async setup belongs in `create(ctx)`; GSAP timelines are
  thenable and awaiting them changes semantics.
- Do not add a screenshot-only resolver, preloader, exception hierarchy,
  logger, registry, or cache.
- Do not replace slice truncation with direct-scene flattening; object
  entry `range` and `behavior` on the addressed head must survive.
- Do not rely on volume-zero as audio suppression. The runtime audio
  service must construct muted sounds and avoid audible side effects
  under the silent policy.
- Do not patch `Math.random`, GSAP globals, timers, Howler globals, or
  DOM prototypes. Determinism must be explicit and scoped.

## Non-Goals

- No screenshot image capture, file writing, artifact upload, diffing,
  storage, or CI reporting.
- No new scene manifest field, composition field, renderer, export
  pipeline, or persistence format.
- No new URL grammar unless an explicit seed/capture option is actually
  accepted as public API; derived deterministic seeding is enough for
  PUL-F018.
- No decode-complete asset pipeline unless a separate requirement
  expands "preload resolved" beyond the existing fetch-and-drain fence.
- No changes to presenter command semantics, chrome visibility rules, or
  prompter lifecycle bypass.
