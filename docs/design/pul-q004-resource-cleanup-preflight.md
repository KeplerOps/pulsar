# PUL-Q004 Resource Cleanup Completeness Preflight

PUL-Q004 is a runtime lifecycle invariant: after `cleanup(ctx)` has
run for a scene, resources created by that scene must not remain
attached to the runtime. The resource classes named by the requirement
are DOM nodes, event listeners, audio handles, and timeline objects.

This is not a new scene model. ADR-002, ADR-008, ADR-025, ADR-028, and
ADR-004 already make the resolver, loader, timeline adapter, and audio
service the lifecycle boundaries. PUL-Q004 should tighten cleanup
completeness inside those boundaries, not add a parallel workflow.

## Boundary

- `src/runtime/scene.ts` remains the scene contract. `cleanup(ctx)` is
  already mandatory through `assertSceneModule()`.
- `src/runtime/composition-resolver.ts` owns `preload -> create ->
  timeline -> cleanup`, reverse-order cleanup, eager cleanup after
  `create` / `timeline` scene failures, and `onSceneCleaned`.
- `src/runtime/scene-loader.ts` owns per-navigation `AbortController`,
  serialized handoff, stage diagnostics, `buildCtx`, per-navigation
  audio service construction, presenter teardown, and prompter dispatch.
- `src/runtime/timeline.ts` owns GSAP object validation,
  master-timeline composition, `MasterTimeline.kill()`, and the
  adapter's abort/completion cleanup.
- `src/runtime/audio.ts` owns Howler handles, per-navigation
  `AudioService.stopAll()`, per-scene `stopGroup(sceneId)`, source
  allowlists, output policy, and non-fatal audio cleanup diagnostics.
- `src/runtime/presenter.ts` owns presenter subscription validation and
  abort-bound unsubscribe. Do not add scene-local presenter listeners.
- `src/runtime/prompter.ts` and the loader's `PrompterRenderer` contract
  own prompter DOM disposal. Prompter mode bypasses scene lifecycle, so
  PUL-Q004 scene cleanup must not be stretched to cover prompter UI.
- `src/runtime/asset-preloader.ts` owns network fetch/drain and abort.
  Asset fetch cleanup is pre-mount lifecycle cleanup, not scene
  `cleanup(ctx)` cleanup.

## Required Reuse

Implementation must build on these incumbents:

- Scene schema and validation: `SceneModule`, `assertSceneModule()`,
  `isSceneModule()`, and `createSceneRegistry()`.
- Composition lifecycle and error envelopes:
  `loadSceneNavigationTarget()`, `resolveComposition()`,
  `onSceneCleaned`, `onSceneFailed`, `describeError()`, `Error.cause`,
  and `AggregateError`.
- Loader lifecycle: `createSceneLoader()`, `AbortController`,
  `isPureAbort()`, `inFlight`, `buildCtx()`, `resetStageAttrs()`, and
  the existing `onError` sink / stage attributes.
- Timeline boundary: `createTimelineEngine()`,
  `createGsapCompositionTimeline()`, `composeMasterTimeline()`,
  `assertSceneTimeline()`, and `MasterTimeline.kill()`.
- Audio boundary: `createAudioService()`, `AudioService.stopGroup()`,
  `AudioService.stopAll()`, `AudioService.isDisposed()`,
  `createHowlerAudioEngine()`, `noopAudioEngine`, and the existing
  `AudioError` hierarchy.
- Presenter boundary: `createPresenterController()` and the
  `AbortSignal`-bound subscription cleanup it already provides.
- Asset policy: `scene.assets`, `scene.audio`, `resolveAssetUrl()`,
  `DEFAULT_ALLOWED_SCHEMES`, and `createAssetPreloader()`. Cleanup
  enforcement must not invent a second asset or audio-source inventory.
- Identifier and object helpers: `isKebabIdentifier()`,
  `KEBAB_IDENTIFIER_FORM`, `isPlainRecord()`, and `deepFreeze()` where
  those concerns arise.
- Tests and gates: Vitest suites under `tests/runtime/*`, policy tests
  under `tests/runtime/policy-*.test.ts`, `pnpm test`,
  `pnpm typecheck`, and `pnpm lint`.

## Cross-Cutting Layers

| Layer | PUL-Q004 guardrail |
|-------|--------------------|
| Scene schema gate | `assertSceneModule()` remains the only scene-shape validator. Do not add `CleanupScene`, `DisposableScene`, a second lifecycle hook, or a cleanup capability table. |
| Registry / composition gates | Cleanup enforcement must run after normal registry and manifest validation. It must not bypass `createSceneRegistry()`, `assertCompositionManifest()`, `findUnregisteredEntries()`, or composition-slice snapshots. |
| Navigation / mode gates | Mode and target validation stay in `navigation.ts` plus loader defense-in-depth. Cleanup state is not URL state and must not read localStorage, sessionStorage, cookies, `history.state`, or cached mode. |
| Lifecycle / cancellation | One navigation signal drives preloader, timeline adapter, audio service, presenter controller, and prompter disposal. `AbortSignal` still means supersession / dispose, not pause/resume or scene failure. |
| DOM surface | Scenes should mutate the injected `ctx.stage` or a runtime-provided activation surface, not `document` globals. Any DOM cleanup tracking belongs to the scene activation scope so cleanup can detach only nodes created by that activation. |
| Event listeners | Listener cleanup should be signal-bound or activation-scope-owned. Do not rely on author memory to pair every `addEventListener` with local `removeEventListener`, and do not monkey-patch global event targets. |
| Timeline objects | Scene-authored GSAP timelines enter the runtime only through `timeline(ctx)` and `assertSceneTimeline()`. The adapter must kill rejected, aborted, completed, and observer-failure masters through the existing `kill()` path. |
| Audio handles | Scenes reach audio only through `ctx.audio`. Per-scene cleanup uses `onSceneCleaned -> audio.stopGroup(sceneId)` and navigation cleanup uses `audio.stopAll()`. No scene imports Howler, constructs `<audio>`, or keeps raw handles. |
| Presenter input | Presenter subscriptions already auto-detach on presenter abort. Cleanup completeness must reuse that controller instead of adding scene-level keyboard / pointer listeners for presenter state. |
| Prompter UI | Prompter mode is not scene lifecycle. Persistent prompter DOM must keep the renderer promise pending and return `PrompterDispose`; the loader abort path drives disposal. |
| Asset / network security | Cleanup enforcement must not fetch, probe, or decode assets. If it touches asset strings for diagnostics, reuse `resolveAssetUrl()` and do not print headers, cookies, auth values, or raw response payloads. |
| OS / process exposure | No env vars, process argv, shell commands, temp files, persisted browser storage, or URL tokens are needed to track cleanup resources. Resource ownership should stay in memory. |
| Error envelope | Resolver failures keep `composition resolution failed:` and scene failures keep the ADR-028 event surface. Public diagnostics may include ids, phase, mode, composition/index, and bounded messages; never serialize DOM nodes, listeners, Howler handles, GSAP objects, raw `cause`, stacks, captions, headers, cookies, env, or auth values. |
| Observability | Use `onError`, stage attributes, and targeted tests. Do not add per-frame logs, resource dumps, telemetry, or high-cardinality diagnostics before a telemetry policy exists. |

## Extensibility

The extension seam is a per-scene activation resource owner/facade
threaded through the existing lifecycle context. It belongs at the
loader / resolver `ctx` boundary where the active scene id, navigation
signal, stage, `ctx.gsap`, and `ctx.audio` are all in scope.

The key parameter is scene activation identity, not just scene id. The
resolver currently rejects repeated scene ids in one active slice
because both occurrences would share DOM, listener, audio, timeline,
and cleanup ownership. PUL-Q004 should preserve that constraint or
introduce an activation token at the same seam; it should not spread
ownership across unrelated registries or global maps.

Future variations should extend this activation facade with resource
families as parameters: DOM mount root, event listener target/options,
timeline handle, audio group/scope, and explicit disposable callbacks.
That keeps cleanup completeness extensible without changing scene
schema, composition manifests, URL grammar, or presenter command
schemas.

## Gotchas

- `cleanup(ctx)` can throw. ADR-028 requires the resolver to surface
  the scene failure and still continue sibling cleanup. PUL-Q004
  cleanup enforcement must not let one resource-disposal failure stop
  later disposals from being attempted.
- `create(ctx)` can partially attach resources before throwing. The
  resolver already pushes a scene onto the cleanup list before
  `create`; cleanup completeness must preserve that partial-create
  path.
- `timeline(ctx)` can return a default-playing GSAP timeline. The
  timeline adapter already pauses, nests, and kills invalid or
  completed masters; do not bypass that path.
- `onSceneCleaned` can throw. It is a workbench hook failure, not a
  scene failure; keep the existing aggregation policy.
- Audio groups are only complete when scenes use the group convention.
  Ordinary audio must still route through `ctx.audio`; raw Howler or
  `<audio>` usage defeats the runtime cleanup boundary.
- Event listeners added with mismatched capture/options are difficult
  to remove manually. Prefer activation-owned registration so removal
  does not depend on recreating options exactly.
- DOM cleanup must avoid deleting runtime chrome or sibling scene DOM.
  Track ownership per activation; do not clear the whole stage as a
  substitute for scene cleanup.
- `mode=prompter` mounts no scene, so there is no scene cleanup call.
  Do not make PUL-Q004 depend on prompter behavior or vice versa.

## Anti-Patterns

- Adding a second cleanup registry disconnected from
  `resolveComposition()` and the loader's navigation signal.
- Adding `dispose`, `destroy`, `resources`, `listeners`, or `domNodes`
  fields to `SceneModule` as parallel lifecycle schema.
- Monkey-patching `document`, `EventTarget.prototype`, GSAP, or Howler
  globally to infer resource ownership.
- Importing GSAP or Howler in scenes to work around the runtime seams.
- Treating cleanup completeness as an authoring lint only. The
  requirement is runtime behavior after `cleanup(ctx)` runs.
- Making cleanup diagnostics dump resource objects, DOM subtrees,
  event listener callbacks, source URLs with secrets, or internal
  engine handles.
- Using URL parameters, storage, process argv, environment variables,
  or filesystem artifacts to carry resource ownership.

## Non-Goals

PUL-Q004 does not require new URL grammar, new workbench mode,
composition manifest changes, scene metadata changes, asset decoding,
network probing, presenter command changes, prompter UI changes,
telemetry, persistence, or a new exception hierarchy.

It also does not require transitioning the Ground Control requirement
to ACTIVE during preflight. ACTIVE should wait until implementation
proves DOM node, listener, audio-handle, and timeline-object cleanup
through source/test traceability.
