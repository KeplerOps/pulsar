# PUL-A008 Mode Dispatch In Core Preflight

PUL-A008 is an architectural constraint: workbench mode dispatch belongs
in the runtime core. Scene modules must not contain mode-specific
branches except for narrow mode hints that affect scene-owned behavior
after the core has selected the mode, such as suppressing scene-local
audio or deterministic randomness under `mode=screenshot`.

ADR-007 already defines the public mode contract. ADR-013 fixes the URL
grammar boundary. ADR-014 fixes scene target resolution. ADR-016 through
ADR-022 record the mode-specific seams. This preflight consolidates the
repo-wide guardrails for implementation; it does not create a new mode
system.

## Boundary

Mode dispatch must reuse the existing runtime path:

- `src/runtime/navigation.ts` owns `mode=` parsing, the
  `NAVIGATION_MODES` allowlist, and `effectiveMode()`.
- `src/runtime/scene-loader.ts` owns per-navigation mode dispatch:
  fresh mode derivation, `ctx.mode`, runner-input hints, prompter
  bypass, presenter scoping, audio output policy, stage diagnostics,
  queueing, abort, and cleanup-before-handoff.
- `src/runtime/scene-navigation.ts` owns target resolution, composition
  membership/index validation, immutable slice snapshots, and the
  bridge into lifecycle execution.
- `src/runtime/composition-resolver.ts` owns lifecycle orchestration,
  mandatory cleanup, abort propagation, per-scene failure isolation,
  and head-scoped runner hints. It stays mode-opaque.
- `src/runtime/timeline.ts` owns timeline positioning, play/hold/loop,
  master transport, beat lookup, and runner interpretation of head
  hints.
- `src/runtime/audio.ts` owns audio output policy, source allowlists,
  Howler encapsulation, cue logging, master mute, and service cleanup.
- `src/runtime/prompter.ts` owns captions-only script construction for
  `mode=prompter`; the loader owns deciding when that path runs.
- `src/runtime/presenter.ts` owns presenter command normalization; the
  loader owns exposing it only under `mode=present`.

Do not add a second router, mode enum, local query parser, scene schema
field, composition flag, manifest behavior key, exception hierarchy, or
workflow controller for mode dispatch.

## Required Reuse

Implementation must build on these canonical incumbents:

- Identifier grammar: `isKebabIdentifier()` and
  `KEBAB_IDENTIFIER_FORM` in `src/runtime/identifier.ts`.
- URL/mode validation: `parseNavigationSearch()`,
  `NAVIGATION_MODES`, `effectiveMode()`, and loader-side
  `validateModeGrammar()` defense in depth.
- Scene/composition schemas:
  `assertSceneModule()`, `createSceneRegistry()`,
  `assertCompositionManifest()`, and `createCompositionRegistry()`.
- Navigation and lifecycle:
  `resolveSceneNavigation()`, `loadSceneNavigationTarget()`,
  `resolveComposition()`, one per-navigation `AbortController.signal`,
  and resolver-owned cleanup.
- Single-scene mode shape transform: the loader's
  `applySingleSceneSlice()` and the bridge-level `truncateToHead()`.
  They preserve the addressed head entry's `range` / `behavior`
  overrides.
- Runner hints: `headBeat`, `headRepeat`, `headHold`,
  `headCueGate`, `headScreenshot`, and `presenter` on the existing
  resolver/adapter seam.
- Timeline contract: `createGsapCompositionTimeline()`,
  `MasterTimeline`, `composeMasterTimeline()`, beat labels, seek,
  pause, repeat, and abort-to-kill behavior.
- Audio contract: `createAudioService()`, `AudioOutputPolicy`,
  `allowedSources`, `scene.audio`, cue logging, `stopGroup()`, and
  `stopAll()`.
- Asset policy: `createAssetPreloader()`, `resolveAssetUrl()`,
  `DEFAULT_ALLOWED_SCHEMES`, redirect re-checks, `baseUrl`, declared
  `scene.assets`, and fetch `AbortSignal` wiring.
- Error/observability: `describeErrorDetailed()`, `formatSceneContext()`,
  `data-pulsar-navigation-error`, `data-pulsar-scene-target`,
  `data-pulsar-composition-target`, `data-pulsar-scene-failures`, and
  the loader `onError` sink.
- Testing patterns: existing `scene-loader-*` mode seam tests,
  `navigation.test.ts`, `timeline.test.ts`, `audio.test.ts`, and source
  policy tests. Add focused tests at the same seams; do not create a
  parallel mode harness.

## Cross-Cutting Layers

| Layer | Guardrail |
|-------|-----------|
| URL grammar / public input | Only `mode=<NAVIGATION_MODES member>` selects mode. Unknown and repeated mode parameters fail through the existing navigation grammar envelope. Unknown query keys remain ignored by the parser and must not influence dispatch. |
| Programmatic navigation | The loader must continue rejecting hand-built targets whose `mode` or `beat` would not pass the parser before `effectiveMode()` reaches `buildCtx()`. |
| Source of truth | `effectiveMode(target)` is pure and URL-derived. Do not read localStorage, sessionStorage, cookies, `history.state`, prior in-memory state, env vars, process argv, files, or host config for mode. |
| Scene schema | No scene field may become the mode selector. Scenes may read `ctx.mode` only as a hint for scene-owned side effects that cannot be enforced earlier, such as screenshot deterministic randomness. |
| Composition schema | Do not encode mode behavior in manifest entries, `range`, `behavior`, sentinel scenes, fake transitions, or mutated registry manifests. Selection slices are per-navigation snapshots only. |
| Resolver lifecycle | The resolver remains mode-opaque. It forwards head hints and presenter input but does not branch on workbench modes, chrome, audio, prompter, storage, or URL details. |
| Timeline runner | Runner behavior is selected through typed optional fields on the existing run input. Literal unions (`'until-aborted'`, `'first-frame'`, `'monotonic-forward'`, `'capture'`) remain the extension pattern, not booleans or ad hoc option objects. |
| Audio service | Mode-dependent audio output is a per-navigation `AudioOutputPolicy`. Do not import Howler in scenes, mute the engine globally for per-navigation modes, or bypass `allowedSources`. |
| Asset security | Mode dispatch never turns query values into paths, dynamic imports, or network URLs. Declared assets and declared audio sources still pass the same scheme, redirect, and abort checks in every lifecycle-running mode. |
| Presenter input | Presenter commands are exposed only under `mode=present` through the existing per-navigation controller. Do not make presenter commands a second mode selector. |
| Prompter | `mode=prompter` bypasses preload, `buildCtx`, scene hooks, and timeline execution structurally. It still resolves the target through the existing navigation layer and surfaces the same navigation errors. |
| Error envelopes | Keep existing public envelopes: `navigation grammar is invalid:`, `scene navigation failed:`, `composition resolution failed:`, `beat positioning failed:`, and scene-failure diagnostics via `formatSceneContext()`. Do not serialize raw causes, stacks, scene objects, DOM, captions, headers, cookies, env, auth values, or source URLs into public diagnostics. |
| OS / config exposure | No mode token belongs in process argv, environment bindings, local files, cookies, browser storage, or persisted history state. A future CLI/export wrapper may choose a URL to load; the runtime still receives mode via the URL grammar. |

## Extensibility

The extension seam for future mode behavior is a small, typed parameter
on the existing owner of the affected subsystem:

- URL-addressable modes extend `NAVIGATION_MODES` and parser tests.
- Lifecycle-running single-scene modes extend the loader and bridge
  head-only slice predicate, then add one optional runner hint if the
  timeline adapter needs a behavior change.
- Audio-only variations extend `AudioOutputPolicy` and the loader's
  mode-to-policy mapping.
- Presenter variations extend presenter commands and runner transport,
  still scoped to `mode=present`.
- Captions-only variations extend `PrompterScript` / `PrompterRenderer`
  only if they keep visual lifecycle suppression explicit.

If a future requirement needs a shared mode policy object, it must be
introduced only at the concrete adapter boundary with multiple real
consumers. Do not pre-land a generic `ModePolicy` or suppression
framework for speculative reuse.

## Gotchas And Anti-Patterns

- Reading `window.location`, cookies, storage, env, or argv from scenes
  to detect mode.
- Adding per-scene `if (mode === ...)` branches for behavior the loader,
  runner, audio service, presenter controller, or prompter renderer can
  enforce centrally.
- Duplicating `NAVIGATION_MODES`, `AudioOutputPolicy`, identifier
  regexes, beat parsing, asset scheme checks, or error envelopes.
- Flattening composition targets to direct scene lookup and losing
  membership validation or head-entry overrides.
- Treating CSS hiding as mode dispatch when lifecycle side effects still
  run, especially for `prompter`.
- Letting single-scene modes advance into following composition entries
  if a runner ignores a hint.
- Persisting the last mode or defaulting omitted `mode` from anything
  except fresh `effectiveMode()` derivation.
- Logging high-volume mode telemetry or dumping raw scene/assets into
  diagnostics.

## Non-Goals

PUL-A008 should not implement a new workbench mode, UI controls,
export path, screenshot tool, rehearsal cue UI, prompter renderer,
audio backend, persistence feature, auth surface, CLI flag, or generic
mode-policy framework. It should not transition any feature-mode
requirement to ACTIVE by itself. It should only ensure mode selection
and dispatch stay centralized in the runtime core and that scene
modules remain consumers of bounded mode hints rather than mode
dispatchers.
