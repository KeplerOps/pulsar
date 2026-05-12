# PUL-P002 Validation CI Preflight

Date: 2026-05-12

PUL-P002 makes the existing runtime validation pass a CI gate. This is
workflow hardening over PUL-F028 / ADR-008, not a new validation system.
CI must execute the same validation pass over the same scene and
composition declarations the workbench boots, and it must fail when
any finding is reported.

## Boundary

- `src/runtime/validation.ts` remains the validation contract:
  `validateRuntime()` collects findings and
  `assertNoValidationFindings()` converts findings into fail-loud
  behavior. Do not introduce a second validator, exception hierarchy,
  finding schema, or message grammar for CI.
- `src/main.ts` currently declares the workbench graph once and passes
  it to both validation and registry construction. A CI invocation must
  preserve that single-source property. If shared graph declarations
  are needed, extract the declarations to a canonical module consumed by
  both the workbench and CI; do not create CI-only scene or composition
  literals.
- `.github/workflows/ci.yml` is the CI surface. Add the gate there or
  through a package script that the workflow calls; do not create a
  parallel workflow controller.
- ADR-009 remains the toolchain contract: Node 22, pnpm 9.15, Vite,
  Vitest, TypeScript strict mode, and Biome. Reuse existing package
  script and CI setup patterns.
- `.ground-control.yaml` `workflow.*` commands remain the local
  completion-gate vocabulary unless maintainers explicitly widen that
  policy. PUL-P002 itself requires PR CI gating.

## Required Reuse

Implementation must build on these incumbents:

- Validation API: `validateRuntime()`,
  `assertNoValidationFindings()`, `Finding`, and `FindingCode`.
- Runtime graph inputs: the same scene modules and composition entries
  used by `createSceneRegistry()` and `createCompositionRegistry()`.
- Schema and policy gates transitively owned by validation:
  `assertSceneModule()`, `createIdRegistry()`,
  `assertCompositionManifest()`, `findUnregisteredEntries()`,
  `resolveAssetUrl()`, and `DEFAULT_ALLOWED_SCHEMES`.
- Workflow surface: `package.json` scripts, `.github/workflows/ci.yml`,
  `.pre-commit-config.yaml` only if local hooks need to mirror a new
  package script, and `.ground-control.yaml` only if the local
  completion policy changes.
- Test/tooling patterns: Vitest for Node-side assertions, `pnpm
  install --frozen-lockfile`, Node 22, pnpm 9.15, existing CI
  permissions, and short, deterministic job names.

## Cross-Cutting Layers

| Layer | Guardrail |
|-------|-----------|
| Scene schema gate | CI validation must reach `assertSceneModule()` through `validateRuntime()`. It must not re-check scene fields with a CI-only DTO or schema table. |
| Registry uniqueness | Duplicate ids must be surfaced by validation's `createIdRegistry()` path, preserving existing duplicate-id grammar and ordering. |
| Composition schema and references | CI must validate actual composition manifests through `assertCompositionManifest()` and `findUnregisteredEntries()`. Do not validate only the default URL target or only a hand-picked smoke scene. |
| Asset URL policy | CI must inherit `resolveAssetUrl()` and `DEFAULT_ALLOWED_SCHEMES` semantics. Do not add curl, HEAD requests, filesystem probes, CDN health checks, or a second allowlist. |
| Runtime lifecycle | CI validation must not call `scene.create()`, `scene.timeline()`, `scene.cleanup()`, preload assets, build audio services, touch DOM, or start Vite. This remains structural metadata validation. |
| Auth and secrets | No repository secret is required. Do not pass tokens, asset URLs with credentials, captions, scene objects, or registry dumps through shell argv, annotations, or artifacts. |
| Config and env binding | Prefer explicit package-script arguments or typed module inputs. Do not add env vars, hidden config files, or browser storage for this gate. |
| OS/process exposure | Keep validation in-process under Node/Vitest or a package script. If a future CLI wrapper is added, pass non-secret config through typed options, not process argv secrets. |
| Error envelope | Use `assertNoValidationFindings()` or format `Finding` records directly. Diagnostics may name finding code, scene id, composition id, entry index, and asset string; they must not dump raw objects, headers, cookies, auth values, or full captions. |
| Observability | GitHub job failure and normal test/script stderr are enough. Do not add a logging framework, telemetry stream, SARIF upload, or artifact unless a later requirement asks for machine-readable reports. |
| Permissions | The workflow only needs repository read access for this gate. Do not widen GitHub token permissions. |

## Extensibility

The required seam is the repository-graph validation invocation. Keep
collection separate from rendering: `validateRuntime()` returns stable
findings, while CI decides how to fail and print them. A future JSON
report, local `pnpm validate`, or workspace-wide validator should reuse
the same invocation and add output formatting at the edge.

If the repo later promotes to pnpm workspaces, the CI gate should be
parameterized by graph entrypoint or package workspace, not by copying
validation logic into each workflow job.

## Gotchas And Anti-Patterns

- Do not treat `tests/runtime/validation.test.ts` as sufficient by
  itself. Unit tests prove the validator works; PUL-P002 requires
  running it against the repository's actual registered graph.
- Do not create CI-only fixtures that can drift from the workbench
  graph.
- Do not run validation by launching the browser, Vite dev server, or
  scene lifecycle.
- Do not make validation advisory. Any non-empty findings list is a CI
  failure.
- Do not weaken existing CI gates, remove the dependency audit, bypass
  SonarCloud, or fold unrelated workflow changes into this requirement.
- Do not add a new asset inventory, audio inventory, URL grammar,
  config surface, exception type, logging subsystem, or persistence
  mechanism.
- Do not rely on branch protection alone. The workflow itself must exit
  non-zero on validation findings; branch protection only enforces the
  reported check.

## Non-Goals

PUL-P002 does not change scene metadata, composition manifest shape,
validation finding codes, asset policy, URL navigation grammar,
workbench modes, lifecycle ordering, audio behavior, registry
mutability, or error classification.

It does not require a public CLI UX, JSON report, artifact upload,
GitHub annotation parser, local pre-commit hook, Ground Control status
transition, traceability mutation, vulnerability scanning, screenshot
regression, browser smoke test, or Playwright job.
