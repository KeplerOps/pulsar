# Issue 102 Scene Module Trust Boundary Preflight

Date: 2026-05-23

Issue 102 is a documentation/security-boundary change. Scene modules
are executable application code. The implementation should document that
trust model where scene authors and future import/workflow designers will
see it, without changing runtime behavior or implying that current
validation makes untrusted code safe.

This preflight is not the issue-closing trust-boundary documentation. It
is the repo-wide guardrail for that documentation.

## Boundary

- Pulsar scene modules are trusted, repo-owned application code loaded
  through the authored bundle and registered scene/composition graph.
- The current runtime has no sandbox for scene lifecycle hooks. A scene's
  `create(ctx)`, `timeline(ctx)`, and `cleanup(ctx)` execute with the
  privileges of the application context that invoked them.
- Runtime validation checks declarative shape and metadata. It does not
  inspect code safety, execute hooks safely, restrict browser APIs, or
  prove that a module is trustworthy.
- The PUL-Q007 no-remote-code-execution policy prevents runtime string
  execution and unsafe dynamic imports in authored source. It does not
  transform bundled third-party scene code into untrusted-safe code.
- Asset policy governs declared URLs and fetch credentials. It is not a
  code sandbox and must not be presented as one.
- User-submitted, third-party, plugin, marketplace, or shared-scene
  execution is out of scope until a future requirement designs isolation.

## Required Reuse

Implementation guidance must build on these incumbents:

- Scene contract: `SceneModule`, `SceneLifecycleFn`,
  `assertSceneModule()`, and `sceneDeclaresAudio()` in
  `src/runtime/scene.ts`.
- Structural validation: `validateRuntime()`, `ValidationInput`,
  `Finding`, and `assertNoValidationFindings()` in
  `src/runtime/validation.ts`.
- Registry and composition boundaries:
  `createSceneRegistry()`, `createCompositionRegistry()`,
  `assertCompositionManifest()`, and `resolveComposition()`.
- Lifecycle and context seams: `createSceneLoader()`,
  `WorkbenchSceneCtx`, `SceneActivation`, `SceneFailureEvent`,
  `create(ctx)`, `timeline(ctx)`, and `cleanup(ctx)`.
- Scene-facing capabilities exposed through context: `ctx.stage`,
  `ctx.chrome`, `ctx.gsap`, `ctx.audio`, `ctx.presenter`, `ctx.mode`,
  `ctx.rng`, and `ctx.activation`.
- Asset/security docs: `docs/asset-url-policy.md`, ADR-012, and
  `docs/design/issue-101-production-asset-policy-preflight.md`.
- Source execution policy: `tests/runtime/policy-q007-remote-code-execution.test.ts`
  and `docs/design/pul-q007-runtime-code-execution-preflight.md`.
- Error and diagnostic boundaries: `describeError()`,
  `describeErrorDetailed()`, ADR-028, and the PUL-Q006 preflight.

## Cross-Cutting Layers

| Layer | Guardrail |
|-------|-----------|
| Source execution policy | Keep Q007's scope precise: no `eval`, `Function`, unsafe dynamic import, or remote code execution outside the bundle. Do not claim Q007 makes arbitrary bundled scene modules safe. |
| Scene schema gate | `assertSceneModule()` validates required fields, captions, ids, assets, audio membership, and lifecycle function presence. It is a shape gate only. Do not add `trusted`, `sandboxed`, `origin`, or `author` fields to `SceneModule` for this issue. |
| Runtime validation | `validateRuntime()` remains pure structural metadata validation. It must not execute lifecycle hooks, scan code trust, fetch assets, read files, or emit "safe to run" claims. |
| Registry/composition graph | Registries remain the static authored graph. Do not add plugin discovery, remote registry import, marketplace loading, or user-uploaded scene ingestion under this issue. |
| Lifecycle hooks | The docs must name the authority of `create(ctx)`, `timeline(ctx)`, and `cleanup(ctx)`: they can mutate mounted DOM through context, create timelines, use audio, subscribe to presenter state, and allocate resources that cleanup must release. Lifecycle failure isolation is reliability behavior, not security isolation. |
| Scene context | `WorkbenchSceneCtx` is the capability surface. Current scenes receive full application context for the active navigation. Do not document it as a reduced-permission or sandboxed capability set. |
| Asset/network policy | Declared assets and audio sources pass through `scene.assets`, `scene.audio`, `resolveAssetUrl()`, `createAssetPreloader()`, `baseUrl`, and `allowedSchemes`. These govern resource URLs and credentials, not arbitrary code behavior inside a trusted scene module. |
| Auth and secrets | The browser runtime should not require secrets for scene execution. Docs and examples must not put credentials in scene modules, asset URLs, validation findings, shell commands, or committed config. |
| Config/env/OS exposure | No env var, argv flag, browser storage toggle, or hidden config should mark third-party scene code as safe. Future isolation must be an explicit runtime/import architecture, not a deployment switch. |
| Error envelope | Diagnostics may name scene ids, lifecycle phases, asset strings, and policy names. Do not dump raw scene objects, captions, DOM, stacks, request headers, cookies, env, auth values, or serialized causes. |
| Observability/workflow | Existing docs, tests, source-policy scans, `pnpm test`, `pnpm typecheck`, and `pnpm lint` are enough. Do not add telemetry, SARIF, audit logs, or a separate security workflow for a documentation-only boundary. |
| Persistence | No persistence is required. Do not add trust allowlists in localStorage, files, caches, or committed registries. |

## Intended Design

The user-facing documentation should state the trust model in the same
vocabulary as the runtime:

- scene modules execute as trusted application code;
- validation checks schema/metadata only, not code safety;
- third-party or user-submitted scene execution is not sandboxed by
  default;
- lifecycle hooks and `WorkbenchSceneCtx` are the API surface through
  which scene code affects the runtime;
- asset policy and no-remote-code-execution policy are related
  guardrails with narrower scopes, not substitutes for sandboxing.

Prefer one canonical trust-boundary section, cross-linked from related
docs, over scattered warnings. Do not bury the boundary only in a
preflight note or test comment.

## Extensibility

The future sandbox seam belongs outside the current scene schema. If a
future requirement accepts untrusted or third-party scene execution, it
must define a separate import/execution model and a capability-reduced
context at the runtime entrypoint that chooses which scene catalog is
loaded.

That future design must be parameterized by execution profile and
granted capabilities, not by ad hoc per-scene booleans. It must also
cover module loading, DOM authority, network and asset policy, audio,
timelines, presenter/control surfaces, cleanup guarantees, diagnostics,
and host/browser isolation. Until then, the documented position is
"trusted application code only."

## Gotchas And Anti-Patterns

- Do not write "validated scene" as shorthand for "safe scene."
- Do not conflate "untrusted scene metadata" in the asset policy with
  untrusted executable scene modules.
- Do not describe Q007 as a sandbox. It is a source-policy gate against
  executing code outside the published bundle.
- Do not add a `trusted: true` or `sandboxed: false` field to every
  scene. The trust boundary is a runtime/documentation invariant, not
  per-scene metadata.
- Do not add plugin import, remote module loading, user upload,
  marketplace, code-signing, CSP, iframe, worker, SES, or permission
  systems as part of the documentation issue.
- Do not rely on lifecycle cleanup, scene failure isolation, or
  `ctx.audio` group teardown as security containment. They are
  reliability and resource-management contracts.
- Do not create a duplicate validator, exception hierarchy, source
  scanner, logging surface, config loader, or policy file.
- Do not include a future-work promise unless the project accepts a
  requirement or ADR for sandbox design.

## Non-Goals

Issue 102 does not implement a sandbox, plugin system, third-party scene
marketplace, upload workflow, import resolver, code signing,
permissions model, CSP generator, iframe/worker isolation, dependency
audit, telemetry, persistence, or a new CI gate.

It should not change scene metadata shape, composition manifest shape,
registry behavior, URL grammar, workbench modes, asset preloading,
audio/timeline APIs, lifecycle ordering, validation categories, error
classification, logging, or package dependencies.
