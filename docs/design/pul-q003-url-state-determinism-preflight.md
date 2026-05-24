# PUL-Q003 URL State Determinism Preflight

PUL-Q003 is a runtime targeting rule: URL parameters fully determine
which scene, beat, composition, and mode the workbench targets.
Persisted browser or host state must not participate in target
selection. The repo already has the right architecture for this:
URL parsing is a boundary adapter, target resolution is registry based,
and mode dispatch is per navigation.

This preflight records guardrails for implementing the enforcement
without creating a second router, persistence policy, validator, or
workflow layer.

## Boundary

- `src/runtime/navigation.ts` remains the only URL grammar parser.
  `parseNavigationSearch()`, `NavigationTarget`, `NAVIGATION_MODES`,
  and `effectiveMode()` are the canonical targeting contract.
- `bootstrapNavigation()` and `subscribeNavigation()` remain the only
  startup and `popstate` parsing path. `popstate` must read
  `location.search`, not `history.state`.
- `src/runtime/scene-navigation.ts` remains the only URL-target
  resolver. It consumes `NavigationTarget` and resolves against
  `SceneRegistry` and `CompositionRegistry`.
- `src/runtime/scene-loader.ts` remains the mode-dispatch and
  per-navigation lifecycle boundary. It derives mode from
  `effectiveMode(target)` for each navigation and builds fresh
  per-navigation context.
- Source-policy enforcement belongs in a Vitest static policy over
  authored source modules under `src/`, using `tests/runtime/source-policy.ts` and
  the screenshot-determinism source scan precedent. Do not add a
  browser runtime validator for persisted-state targeting.

## Required Reuse

Implementation must build on these incumbents:

- URL grammar and validation: `parseNavigationSearch()`,
  `NavigationTarget`, `NavigationLocator`, `NAVIGATION_MODES`, and
  `effectiveMode()`.
- Identifier validation: `isKebabIdentifier()` and
  `KEBAB_IDENTIFIER_FORM`; no URL-specific scene, composition, or beat
  regex.
- Navigation events and workflow: `bootstrapNavigation()`,
  `subscribeNavigation()`, `PULSAR_NAVIGATE_EVENT_TYPE`, and
  `PULSAR_NAVIGATE_ERROR_EVENT_TYPE`.
- Target resolution: `resolveSceneNavigation()` and
  `loadSceneNavigationTarget()`, backed by `createSceneRegistry()` and
  `createCompositionRegistry()`.
- Mode/lifecycle dispatch: `createSceneLoader()`, its
  `validateBeatGrammar()` / `validateModeGrammar()` defense-in-depth
  checks, `buildLoad()`, `applySingleSceneSlice()`, and
  `buildPrompterLoad()`.
- Runtime validation: `validateRuntime()` remains structural
  scene/composition/asset validation. PUL-Q003 must not add
  `FindingCode`s there.
- Static source-policy infrastructure:
  `tests/runtime/source-policy.ts` for file walking, TypeScript AST
  parsing, access-path resolution, line-scoped exemptions, bounded
  findings, and fail-loud Vitest reporting. The older
  `tests/runtime/screenshot-determinism-source.test.ts` is the
  precedent for forbidding `localStorage`, `sessionStorage`,
  `document.cookie`, `history.state`, `process.env`, and
  `process.argv` in `src`.
- Error rendering and observability: `describeError()`, loader
  `onError`, and `data-pulsar-navigation-error`.

## Cross-Cutting Layers

| Layer | Guardrail |
|-------|-----------|
| URL grammar gate | `parseNavigationSearch()` is the only parser for `scene`, `composition`, `index`, `beat`, and `mode`. Unknown query keys remain ignored and repeated grammar keys remain invalid. Do not add aliases such as `lastScene`, `savedMode`, or state restored from storage. |
| Startup / popstate workflow | Startup and browser back/forward must flow through `bootstrapNavigation()` / `subscribeNavigation()`. The event handler reads `location.search` every time. `history.state` is not a target input. |
| Programmatic target boundary | Because `NavigationTarget` is exported, the loader keeps parser-equivalent defense-in-depth checks for `beat` and `mode`. Any future public programmatic navigation helper must call `parseNavigationSearch()` or construct the same typed shape and pass the same loader checks. |
| Registry and composition resolution | Resolve target ids only through `SceneRegistry` and `CompositionRegistry`. URL values are ids, not file paths, module specifiers, inline manifests, dynamic imports, or network resources. |
| Mode dispatch | Mode is derived with `effectiveMode(target)` for each navigation. Omitted `mode` selects fresh `present`; it must not reuse a previous mode from memory or storage. |
| Scene context | `ctx.mode` is a derived hint from the current target only. Scenes may branch on `ctx.mode`; they must not parse query strings or read storage/cookies/history to determine target or mode. |
| Runtime validation | `validateRuntime()` stays graph-shape validation. Q003 enforcement is source-policy plus existing URL/parser/loader tests, not scene metadata validation. |
| Source policy gate | Add or extend a Vitest policy scan across source modules under `src/`. Reuse `source-policy.ts`; do not create regex-only scans or duplicate walkers. Any exemption must be line-scoped and reasoned, e.g. `PUL-Q003-allow: <reason>`, and must not apply to target selection. |
| Auth, secrets, and env binding | Target selection needs no auth, secrets, env vars, `.env`, or host config. `process.env`, `import.meta.env`, and `process.argv` must not determine scene, beat, composition, or mode. |
| OS/process exposure | Do not pass target state, secret-bearing URLs, cookies, or env-derived values through shell argv. Tests should run in-process under Vitest and report relative path, line, label, and trimmed line text only. |
| Error envelope | Navigation failures use existing `navigation grammar is invalid:`, `scene navigation failed:`, `composition resolution failed:`, and `data-pulsar-navigation-error` surfaces. Diagnostics may name ids, modes, indexes, and bounded messages; never dump cookies, headers, env, argv, raw scene objects, or full credential-bearing URLs. |
| Observability | Stage attributes remain `data-pulsar-scene-target`, `data-pulsar-composition-target`, `data-pulsar-navigation-error`, and existing mode-specific surfaces. Do not add telemetry, storage-backed breadcrumbs, or a logging framework. |
| Persistence | Browser persistence APIs are out of scope for target selection: `localStorage`, `sessionStorage`, `document.cookie`, `history.state`, IndexedDB, Cache Storage, service-worker state, and persisted in-memory snapshots across reloads must not determine target. |

## Intended Design

The intended design is a small policy layer around the existing URL
architecture. Runtime targeting semantics stay in `NavigationTarget`
and the existing parser/resolver/loader path. Source-policy coverage
keeps persisted-state reads from entering authored runtime source as
target inputs. Behavioral coverage should prove startup and `popstate`
ignore storage/cookie/history fixtures when deriving the parsed target,
effective mode, stage target attributes, and navigation errors.

The seam for future extension is the source-policy forbidden-surface
table and matcher functions. If future requirements add a permitted
non-target use of a persistence API, keep that as an explicit
line-scoped exemption or narrow wrapper whose name makes the non-target
purpose obvious. Do not weaken the canonical parser or let the wrapper
return scene, beat, composition, index, or mode.

## Gotchas And Anti-Patterns

- Do not implement a "remember last scene/mode/beat" feature behind a
  missing URL parameter. Missing `mode` already means fresh `present`;
  missing target means the current `kind: 'none'` placeholder behavior.
- Do not put target defaults in `localStorage`, `sessionStorage`,
  cookies, `history.state`, IndexedDB, service workers, env vars, or
  process argv.
- Do not duplicate URL parsing in scenes, workbench controls, tests,
  validation, presenter code, or audio/prompter adapters.
- Do not make query keys accept resource locators. `scene` and
  `composition` are ids only.
- Do not add a second mode enum, `isScreenshot` flag, `paused`
  boolean, `targetState` DTO, or persistence policy module.
- Do not silently fall back to a default scene when a URL target is
  invalid. Surface the existing navigation error.
- Do not allow static-policy exemptions for code that influences
  `NavigationTarget`, `effectiveMode()`, `resolveSceneNavigation()`,
  `createSceneLoader()`, or scene `ctx.mode`.
- Do not reclassify this as a runtime validation finding. The runtime
  validator inspects declarative graph inputs; Q003 is about target
  input provenance and source structure.

## Non-Goals

PUL-Q003 does not add URL parameters, workbench modes, scene metadata,
composition manifest fields, presenter commands, auth, telemetry,
storage sync, browser history mutation, routing libraries, config
files, environment binding, or a CLI report format.

It does not change scene/composition schemas, asset preloading,
timeline orchestration, audio policy, prompter rendering, validation
scope, or requirement status. It should not transition to ACTIVE until
implementation includes source-policy coverage and behavioral tests
showing that persisted browser or host state cannot alter the targeted
scene, beat, composition, or mode.
