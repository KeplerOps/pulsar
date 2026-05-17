# PUL-F031 Workbench Chrome Surface Preflight

PUL-F031 is a workbench-shell requirement. Chrome is persistent UI
owned by the browser workbench around the scene stage. It is not a
scene lifecycle hook, not scene metadata, not a workbench-mode system,
and not a presenter-controls implementation.

The implementation must land the smallest chrome surface that satisfies
the requirement while reusing the existing URL, mode, lifecycle,
diagnostic, validation, and source-policy boundaries.

## Boundary

Chrome belongs at the workbench bootstrap / loader boundary:

- `src/main.ts` owns browser DOM bootstrapping. It already finds the
  scene `#stage`, runs the runtime validation gate, builds registries,
  wires adapters, creates the loader, and starts URL navigation.
  Chrome must mount from this workbench-owned path before the first
  navigation can activate a scene.
- `src/runtime/navigation.ts` owns `mode=` parsing,
  `NAVIGATION_MODES`, and `effectiveMode()`. Chrome visibility must
  read the effective mode from this canonical boundary. Do not parse
  `window.location`, duplicate the mode list, or add a second query
  key.
- `src/runtime/scene-loader.ts` owns serialized navigation,
  per-navigation mode validation, stage diagnostics, abort, cleanup,
  presenter scoping, audio policy, and lifecycle handoff. Chrome must
  not bypass or replace that queue.
- `src/runtime/scene-navigation.ts` owns target resolution and
  composition slicing. If chrome displays target context, it should
  consume bounded identifiers or existing read-only metadata from the
  resolved target path; it must not re-resolve targets, mutate
  registries, or flatten composition context.
- `src/runtime/composition-resolver.ts` remains mode-opaque and
  chrome-opaque. It must not mount, hide, update, or tear down
  workbench chrome.
- Scene modules own only scene content under `ctx.stage`. They must not
  create, query, retain, style, hide, or mutate chrome nodes.

Chrome persistence is structural: mount one workbench-owned controller
or DOM root for the workbench session, then update its visibility /
content across navigations. Scene `cleanup(ctx)` and resolver cleanup
must not remove chrome.

## Required Reuse

Implementation must build on these canonical incumbents:

- URL and mode grammar: `parseNavigationSearch()`,
  `NAVIGATION_MODES`, `NavigationMode`, and `effectiveMode()` in
  `src/runtime/navigation.ts`.
- Loader orchestration: `createSceneLoader()`, its serialized queue,
  `validateModeGrammar()` defense-in-depth, one per-navigation
  `AbortController`, and existing stage diagnostic attributes.
- Navigation resolution: `resolveSceneNavigation()` and
  `loadSceneNavigationTarget()` for scene/composition identity and
  range / behavior preservation.
- Scene/composition schemas and registries:
  `assertSceneModule()`, `createSceneRegistry()`,
  `assertCompositionManifest()`, `createCompositionRegistry()`, and
  the canonical `src/workbench-graph.ts` declarations.
- Runtime validation: `validateRuntime()` /
  `assertNoValidationFindings()` must still run before navigation and
  before any scene lifecycle effect. Chrome must not add a parallel
  graph validator or schema.
- Error and observability: `describeErrorDetailed()`,
  `formatSceneContext()`, `data-pulsar-navigation-error`,
  `data-pulsar-scene-target`, `data-pulsar-composition-target`,
  `data-pulsar-scene-failures`, and the loader `onError` sink.
- Existing mode guardrails: ADR-007, ADR-013, ADR-014, ADR-016,
  ADR-017, ADR-021, and
  `docs/design/pul-a008-mode-dispatch-core-preflight.md`.
- Source-policy tests: especially
  `tests/runtime/policy-a008-mode-dispatch.test.ts`; scene modules
  must remain barred from mode dispatch except narrow allowed
  scene-owned hints.

Do not create duplicate schemas, duplicate validators, duplicate mode
enums, duplicate exception hierarchies, or a generic `ModePolicy`.

## Cross-Cutting Layers

| Layer | Guardrail |
|-------|-----------|
| URL grammar / public input | Only `mode=<NAVIGATION_MODES member>` controls chrome visibility. Unknown and repeated `mode` values keep failing through the existing navigation grammar envelope. Unknown query keys must not influence chrome. |
| Programmatic navigation | Hand-built targets still pass the loader's mode defense before chrome state is trusted. Do not let a forged string reach chrome as an unchecked mode. |
| Source of truth | Omitted `mode` derives to `present` through `effectiveMode()` on every navigation. Do not recover mode from localStorage, sessionStorage, cookies, `history.state`, previous in-memory state, env vars, argv, files, or host config. |
| DOM ownership | Chrome nodes are outside scene ownership. Scenes receive `ctx.stage`; they do not receive a chrome handle, selector, event bus, or mutation API. Scene cleanup must be incapable of tearing down chrome. |
| Scene/composition schema | Do not add `chrome`, `hideChrome`, `standaloneChrome`, or similar fields to scene modules or composition manifests. Existing scene metadata may be read for display only if it has already passed the canonical schema. |
| Resolver lifecycle | The resolver stays chrome-opaque. Chrome visibility and content updates belong before/around loader dispatch, not in `resolveComposition()` or lifecycle hooks. |
| Error envelope | Chrome-related failures use the existing `onError` / `data-pulsar-navigation-error` surface and bounded messages. Do not serialize raw scene objects, DOM nodes, stacks, full URLs with credentials, headers, cookies, env, auth values, or asset payloads. |
| Asset security | Chrome must not turn query values into paths, dynamic imports, style URLs, or network requests. Workbench-owned chrome assets, if any, are static bundled workbench assets, not scene-declared or query-derived assets. |
| Validation | The existing runtime validation remains about scene/composition graph structure. Chrome must not be represented as a fake scene or manifest entry to satisfy validation. |
| Accessibility / DOM-CSS | Chrome must preserve browser text selection, focus order, and ARIA semantics per the existing DOM/CSS accessibility preflight and Playwright gate. Hidden chrome in suppressing modes must not trap focus or cover the stage. |
| Observability | Stage attributes continue to describe navigation target and errors. Chrome may render bounded target/status text derived from the same canonical data but must not become the source of truth for navigation state. |
| OS / config exposure | No chrome mode, target, token, or user URL belongs in process argv, environment bindings, browser storage, cookies, or local files. A future export/screenshot wrapper may load a URL; the runtime still receives mode through the URL grammar. |

## Visibility Seam

The required extensibility seam is chrome-specific, not generic mode
policy. A small workbench-owned visibility decision should map
`NavigationMode` to a literal chrome state such as visible/hidden.

The initial policy is:

- `present` renders full chrome.
- `standalone` hides chrome.
- `screenshot` hides chrome.
- Other modes keep their existing ADR-defined behavior unless their
  own requirement explicitly suppresses chrome.

Keep this decision parameterized at the chrome adapter boundary so a
future mode can request hidden, compact, reviewer, or presenter chrome
without editing scene modules, registries, composition manifests,
resolver logic, or the URL parser beyond adding the mode itself.

## Gotchas And Anti-Patterns

- Mounting chrome from a scene `create(ctx)` hook or removing it from
  a scene `cleanup(ctx)` hook.
- Passing `ctx.chrome`, a global chrome controller, or a chrome DOM
  selector to scene modules.
- Treating CSS hiding after scene lifecycle effects as ownership:
  `standalone` and `screenshot` must not depend on scene code to hide
  workbench UI.
- Duplicating `NAVIGATION_MODES` or implementing a local
  `isChromeMode()` over string literals in scene code.
- Encoding chrome behavior in composition `behavior`, fake transition
  scenes, sentinel manifest entries, or scene metadata fields.
- Re-parenting `#stage` in a way that breaks the loader's stage handle
  or lets scene cleanup clear chrome.
- Making chrome persistence depend on composition resolver mount/run/
  cleanup phases.
- Using browser storage to remember whether chrome was hidden.
- Logging high-volume chrome telemetry or dumping raw target objects
  for visible status text.

## Non-Goals

PUL-F031 should not implement presenter controls, presenter command
transport, audio chrome, inter-scene transitions, screenshot capture,
prompter UI, a new workbench mode, a design system, persistence,
authentication, telemetry, export behavior, or a generic mode-policy
framework.

It should not transition PUL-F013 to ACTIVE by itself unless the full
PUL-F013 statement is satisfied at the same time: chrome, audio,
inter-scene transitions, and presenter input all rendered / accepted
end to end under `mode=present` with their own tests and traceability.
