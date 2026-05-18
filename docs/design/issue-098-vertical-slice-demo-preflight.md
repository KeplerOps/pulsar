# Issue 98 Vertical-Slice Demo Scenes Preflight

Date: 2026-05-18

Issue 98 asks for authored demo content that exercises the existing
runtime seams together. It is not a new scene schema, workbench mode,
asset pipeline, prompter source, router, timeline engine, audio engine,
or browser workflow.

No new ADR is needed. Existing ADRs already decide the boundaries:
scene metadata and compositions (ADR-002), GSAP behind `ctx.gsap`
(ADR-003 / ADR-025 / ADR-026), audio behind `ctx.audio` (ADR-004 /
ADR-029), DOM/CSS as the default surface (ADR-005), URL workbench
navigation (ADR-007 / ADR-013 / ADR-014), asset preload (ADR-012),
prompter mode (ADR-022), validation (ADR-008), scene-level isolation
(ADR-028), browser support (ADR-030), and workbench chrome (ADR-031).

## Boundary

- Add dedicated demo scene modules under `src/scenes/`. Existing
  fixture scenes are not the demo and should not be counted as the
  issue's authored vertical slice.
- Wire the demo through a declarative composition under
  `src/compositions/` and register it from `src/workbench-graph.ts`.
  The workbench URL should address the existing composition grammar,
  for example `?composition=<demo-id>&mode=<mode>`.
- Keep `src/runtime/` untouched unless the demo reveals an actual
  runtime bug. A demo scene should consume runtime seams; it should not
  define new cross-cutting seams.
- Keep the default composition's current semantics unless the issue
  explicitly changes the default route. The demo only needs to be
  reachable by URL.

## Required Reuse

- Scene schema and validation: `SceneModule`, `Caption`,
  `assertSceneModule()`, `sceneDeclaresAudio()`, and
  `createSceneRegistry()`.
- Composition schema and lookup: `CompositionManifest`,
  `assertCompositionManifest()`, `createCompositionRegistry()`,
  `entryId()`, and `findUnregisteredEntries()`.
- Canonical app graph and validation gate: `WORKBENCH_SCENES`,
  `WORKBENCH_COMPOSITIONS`, `validateRuntime()`,
  `assertNoValidationFindings()`, and
  `tests/runtime/workbench-graph.test.ts`.
- Timeline seam: `ctx.gsap.timeline()`, GSAP labels as named beats,
  `assertSceneTimeline()`, `composeMasterTimeline()`,
  `MasterTimeline`, `sceneTimelineLabel()`, and
  `createGsapCompositionTimeline()`. Scenes must not import `gsap`.
- Prompter seam: `scene.captions`, `buildPrompterScript()`,
  `PrompterScript`, `PrompterRenderer`, and loader `mode=prompter`
  lifecycle bypass. Do not add prompter-only text or scripts.
- Asset and audio policy: `scene.assets`, `scene.audio`,
  `createAssetPreloader()`, `resolveAssetUrl()`,
  `DEFAULT_ALLOWED_SCHEMES`, `createAudioService()`, and `ctx.audio`.
  Scenes must not import Howler or construct `Audio` /
  `HTMLAudioElement`.
- DOM authoring: use the injected `ctx.stage` and
  `ctx.stage.ownerDocument` pattern already used by fixture scenes.
  Cleanup removes scene-owned nodes, listeners, timers, and any
  scene-local style nodes.
- Diagnostics: loader `onError`, `data-pulsar-navigation-error`,
  `data-pulsar-validation-failed`, `data-pulsar-scene-target`,
  `data-pulsar-composition-target`, and existing error helpers.
- Workflow: `pnpm test`, `pnpm typecheck`, `pnpm lint`, and
  `pnpm test:browsers` through the existing Vitest, Biome, Vite, and
  Playwright configs. Source/test implementation should add a
  Towncrier fragment; this preflight note alone does not require one.

## Cross-Cutting Layers

| Layer | Guardrail |
|-------|-----------|
| URL grammar | Use `parseNavigationSearch()` grammar only: `scene`, `composition`, `index`, `beat`, and `mode`. The demo URL names ids; it must not carry file paths, module specifiers, inline manifests, asset URLs, or script payloads. |
| Workbench graph validation | Register demo scenes and the demo composition once in `src/workbench-graph.ts`; boot and CI validation must see the same graph. Do not add a test-only registry path or bypass `validateRuntime()`. |
| Scene schema gate | Every demo scene satisfies `SceneModule` exactly. Captions use `Caption.at` as a non-negative integer or kebab beat label; audio entries, if any, must be members of `scene.assets`. Do not add duplicate DTOs or local validators. |
| Composition schema gate | The demo composition remains a static `CompositionManifest`. Do not build it with functions, conditionals, env vars, or runtime discovery. The existing PUL-A005 policy gate should continue to classify it as declarative. |
| Identifier grammar | Scene ids, composition id, beat labels, sound ids, and audio groups use the shared kebab-case rule. Do not copy the regex or invent a relaxed demo-only grammar. |
| Timeline validation | Named beats are GSAP labels on the scene timeline returned by `timeline(ctx)`. They must be finite, non-negative, within the scene timeline duration, and kebab-case. Do not add a `beats` field to scene metadata. |
| Prompter data path | Caption acceptance is proven by routing a scene or composition through `mode=prompter` / `buildPrompterScript()`. The prompter path must not mount scene DOM, run timelines, preload assets, or read a second script source. |
| Asset security | Demo assets should be committed static same-origin assets, preferably served from Vite's public asset surface and referenced with root-relative paths such as `/assets/...`. Avoid `http:`, `https:`, `data:`, `blob:`, `file:`, and protocol-relative URLs unless a specific asset-policy decision is recorded. |
| Fetch/preload | Asset preload remains `createAssetPreloader({ init: { signal } })` through the loader. Do not preload by constructing `Image`, `<link>`, Howler, or scene-local fetches that bypass resolver ordering and error surfacing. |
| Audio policy | Audio is optional. If included, declare sources in both `scene.assets` and `scene.audio`, call `ctx.audio.load()` / `play()` from lifecycle or timeline callbacks, and test through the existing unlock/rehearsal/silent policies. Do not add composition-level audio manifests or direct media elements. |
| Source-policy security | Existing source scans must keep passing: no scene `gsap` imports, no scene Howler imports or `Audio()` construction, no dynamic remote imports, no `eval` / `Function`, no parallel caption source, and no imperative composition dispatch. |
| Error envelope | Demo failures should surface through existing validation, navigation, resolver, asset, audio, and scene-failure envelopes. Do not log raw scene objects, full scripts, DOM nodes, headers, cookies, env, auth values, or stacks as public diagnostics. |
| Config/env/OS exposure | The demo needs no auth, secrets, `.env`, `process.env`, `import.meta.env`, `process.argv`, cookies, localStorage, sessionStorage, or history-state fallback. Do not put asset paths or demo selection behind shell flags or secret-bearing URLs. |
| Persistence/observability | URL remains the only workbench target/mode source. Observability stays DOM attributes, Playwright artifacts, and bounded `onError` diagnostics; no telemetry, analytics, browser storage, or persistent cue logs. |

## Extensibility

The extension seam is the demo composition id plus its manifest. A
future shorter demo, trailer demo, or alternate ordering should be a
new composition manifest or a manifest edit, not runtime routing logic
or scene-level flow control.

Keep per-scene constants for repeated beat names, selectors, and asset
paths. Promote a shared scene helper only when multiple demo scenes
need the same non-trivial DOM/context narrowing; do not introduce a
demo framework on the first pass.

Asset location should be parameterized by a stable same-origin path
prefix if a scene uses more than one asset. That keeps future asset
replacement local to the scene metadata and DOM authoring without
changing the preloader, Vite config, or URL grammar.

## Gotchas

- `assets/` at repo root is not automatically a production Vite static
  surface. Root-relative demo asset URLs must resolve in `pnpm build`
  + `pnpm preview`, not only under the dev server.
- Relative assets with no `baseUrl` pass static scheme validation by
  design; a browser/e2e check or fetch-backed runtime test should prove
  the committed path is actually served.
- Present-mode composition with declared audio triggers the audio
  unlock gate. Browser tests must satisfy the user gesture flow or use
  a mode whose audio policy is intentionally silent/logged.
- `mode=prompter` intentionally bypasses preload, `create`, `timeline`,
  and `cleanup`. Use it to prove caption aggregation, not visual scene
  rendering or asset preload.
- `mode=loop`, `paused`, `scrub`, `screenshot`, and `standalone`
  truncate composition execution to the head scene. Use `mode=present`
  or a runtime-boundary composition test when the full demo sequence
  must run end to end.
- Composition slices cannot currently repeat the same scene id because
  activation context is scene-id scoped. Do not repeat demo scene ids
  in the composition until per-entry activation contexts exist.
- Existing fixture scenes are intentionally narrow testing surfaces;
  folding them into the demo would blur fixture coverage with authored
  demo content.

## Tests

Coverage should sit at runtime boundaries, not inside scene internals:

- A registered-graph validation assertion should stay covered by
  `tests/runtime/workbench-graph.test.ts`.
- Add runtime-boundary coverage that resolves the demo composition and
  observes preload, timeline segments, named beats, captions via
  `buildPrompterScript()` or a `renderPrompter` spy, and cleanup through
  existing loader/resolver seams.
- Playwright is available. Add browser coverage under `tests-e2e/` for
  at least the reachable demo URL and the public observables needed to
  prove it mounted without validation/navigation errors and rendered
  meaningful DOM.

Do not add Puppeteer/Selenium, a second browser command, baseline image
management, or test-only runtime attributes when existing observables
or scene-owned `data-pulsar-*` markers can prove the behavior.

## Non-Goals

Issue 98 does not require polished presentation content, new runtime
features, new workbench modes, presenter UI, visible prompter UI,
caption editing, export support, dependency upgrades, a new styling
system, new asset policy, audio mixing, remote asset hosting,
telemetry, persistence, accessibility expansion beyond existing DOM
contracts, or requirement status/traceability transitions.

It should not change scene metadata shape, composition manifest shape,
URL grammar, validation finding codes, exception hierarchy, logging
framework, navigation lifecycle, asset preloader semantics, audio
source policy, timeline adapter semantics, browser matrix, or CI
workflow topology unless the implementation uncovers a real runtime
defect that must be fixed separately.
