# PUL-A001 Timeline Library Encapsulation Preflight

Date: 2026-05-12

PUL-A001 is a structural architecture policy: scene modules must not
import the timeline library directly. Scenes construct timelines through
the timeline utilities exposed on the scene context, currently
`ctx.gsap`, so the runtime can keep GSAP behind ADR-003 / ADR-025's
adapter boundary.

The enforcement shape matches the PUL-Q007 static-policy gate: a
Vitest source scan over authored runtime source, not a new scene schema,
runtime validator, loader hook, or bundle audit.

## Boundary

- Scan authored scene source modules under `src/scenes/` for direct
  imports or dynamic imports of `gsap` and GSAP subpaths.
- Treat `src/runtime/timeline.ts` as the canonical GSAP boundary. It may
  import `gsap`, exposes `createTimelineEngine()`, validates returned
  timelines with `assertSceneTimeline()`, composes masters with
  `composeMasterTimeline()`, and exports the `MasterTimeline` transport
  surface.
- Scene modules may read `ctx.gsap` after narrowing their local context
  shape. They must not import `gsap`, instantiate a parallel timeline
  engine, or reach into `gsap.core` directly.
- Tests may import GSAP where they exercise the adapter boundary or
  scene fixtures. The production policy is about scene modules.
- Do not scan generated output, `dist/`, `coverage/`, docs, configs, or
  package lockfiles unless a future requirement widens the source-policy
  surface.
- Exemptions, if unavoidable, must be line-scoped, reasoned, and named
  for this policy (`PUL-A001-allow: <reason>`). A file-level scene
  allowlist defeats the requirement.

## Required Reuse

Implementation must build on these incumbents:

- Timeline boundary: `src/runtime/timeline.ts`,
  `createTimelineEngine()`, `TimelineEngine`, `assertSceneTimeline()`,
  `composeMasterTimeline()`, `MasterTimeline`, `sceneTimelineLabel()`,
  and `parseSceneTimelineLabel()`.
- Scene contract: `SceneModule`, `SceneLifecycleFn`, and
  `assertSceneModule()` in `src/runtime/scene.ts`. Do not add a
  second scene type just to express timeline-capable scenes.
- Loader context wiring: `WorkbenchSceneCtx` and the loader / main-path
  context builder that supplies `ctx.gsap` from `createTimelineEngine()`.
- Source-policy scanner precedent:
  `tests/runtime/screenshot-determinism-source.test.ts` for AST
  traversal and diagnostics, plus `docs/design/pul-q007-runtime-code-
  execution-preflight.md` for the shared forbidden-surface table seam.
- CI gate style: Vitest under `tests/runtime/*`, reached by existing
  `pnpm test` / `pnpm test:coverage` and `.github/workflows/ci.yml`.
- Existing error/rendering surfaces: policy failures should be test
  assertion failures with bounded file / line diagnostics, not runtime
  `describeError()` envelopes or stage attributes.

## Cross-Cutting Layers

| Layer | Guardrail |
|-------|-----------|
| Source policy gate | The A001 ban belongs in the shared Vitest static-policy suite. It should reuse the Q007 scanner walker, exemption parser, and finding renderer rather than adding a second scanner. |
| Scene schema gate | `assertSceneModule()` validates shape only. Do not add import-policy checks, package-specifier lists, or `FindingCode`s to scene validation. |
| Timeline adapter | `src/runtime/timeline.ts` remains the only production module allowed to import `gsap`. Adapter tests may exercise it directly; scenes consume only `ctx.gsap` / runtime timeline utilities. |
| Loader context | The implementation must preserve the existing `ctx.gsap` injection path. Do not create scene-local factories, globals, service locators, or fallback imports when `ctx.gsap` is absent. |
| Build and dependency graph | Keep GSAP as the existing dependency in `package.json` / `pnpm-lock.yaml`. PUL-A001 does not add plugins, subpackages, bundler aliases, or tree-shaking exceptions. |
| Auth, secrets, and env binding | No token, secret, env var, or config file is needed. The scan must not read credentials or accept policy from process env. |
| OS/process exposure | The scan runs in-process under Vitest. Findings may report relative path, line, and import specifier; do not pass source snippets or policy state through shell argv. |
| Error envelope | Runtime errors keep their current resolver / loader envelopes. A001 violations fail before boot as test diagnostics, not as scene navigation failures. |
| Observability | CI failure output is sufficient. Do not add per-scene logging, telemetry, SARIF, artifacts, or a logging framework for this ban. |
| Persistence | No persisted allowlist, cache, registry, or browser storage is required. |

## Extensibility

The seam is a parameterized forbidden-import policy table in the shared
source scanner. A001 contributes a rule shaped like:

- scope: source modules under `src/scenes/`;
- forbidden module specifiers: `gsap` and `gsap/*`;
- allowed production boundary: `src/runtime/timeline.ts`;
- exemption tag: `PUL-A001-allow`.

The same scanner should later accept A002 / A003 / A004 / A006 entries
with different scopes and specifiers. Do not bake "timeline" into the
walker, diagnostics, or exemption parser.

If a future engine swap replaces GSAP, the source policy should update
the forbidden specifier table and the adapter implementation, not scene
modules. Scene authoring remains context-driven.

## Gotchas And Anti-Patterns

- Do not flag type-only imports from Pulsar runtime modules. The ban is
  direct timeline-library imports from scenes, not imports of
  `SceneModule` or context types.
- Do not flag the string `gsap` in comments, docs, test names, labels,
  or ordinary object keys. Use AST import / dynamic-import detection.
- Do not allow `import('gsap')`, `import('gsap/Draggable')`, or computed
  variants in scenes. A scene must not lazy-load around the boundary.
- Do not let scenes import a local wrapper that itself imports GSAP
  unless that wrapper is the runtime adapter boundary and scene-facing
  access still arrives through context.
- Do not create a second exception hierarchy, validation finding schema,
  import resolver, package allowlist config, or runtime plugin system.
- Do not conflate scene-local optional rendering libraries with the
  timeline engine. A003 owns PixiJS / Three.js / Phaser policy.
- Do not use this requirement to forbid GSAP in adapter tests or to
  remove the existing runtime dependency.

## Non-Goals

PUL-A001 does not change scene metadata, composition manifests, URL
grammar, timeline label grammar, master-timeline transport, audio APIs,
asset policy, dependency versions, CI workflow topology, logging,
persistence, or runtime error classification.

It does not implement the A002-A006 bans, transition requirement
status, create traceability links, or rewrite scene timelines. The
implementation should only add the structural policy gate and tests
needed to prove scene modules cannot import the timeline library
directly.
